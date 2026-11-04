import { Injectable } from '@nestjs/common';
import { Db } from '../../common/db';
import { Clock, HOUR } from '../../common/clock';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { FakeKms, commitmentOf, openBid } from '../../adapters/kms';
import { NotifyService } from '../notifications/notify.service';
import { phrase } from '../notifications/templates';
import { RiskService } from '../risk/risk.service';
import { DepositsService } from '../deposits/deposits.service';
import { Lang, fmtAmd, fmtYerevan } from '../../common/format';

export interface RankRow {
  place: number;
  amount: number;
  at: string;
  bidId: string;
  commitment: string;
  salt: string;
  userId: number; // v0.2: публичный ID участника (показывается после итога)
}

/** SC-11…SC-13: вскрытие, итог, письма. */
@Injectable()
export class RevealService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private kms: FakeKms,
    private notify: NotifyService,
    private risk: RiskService,
    private deposits: DepositsService,
  ) {}

  /** Лоты, чей конец уже наступил. Лоты, затронутые неподтверждённым сбоем (SC-18), ждут решения администратора. */
  async due() {
    return this.db.q<{ id: number; closes_at: Date }>(
      `SELECT l.id, l.closes_at FROM lots l WHERE l.status IN ('scheduled','live','revealing') AND l.closes_at <= $1
       AND NOT EXISTS (SELECT 1 FROM outages o WHERE o.status='detected' AND o.lot_ids @> to_jsonb(l.id))
       ORDER BY l.closes_at`,
      [this.clock.now()],
    );
  }

  async revealDue() {
    const lots = await this.due();
    const s = await this.settings.all();
    for (const l of lots) {
      try {
        await this.reveal(l.id);
      } catch (e: any) {
        console.error('[reveal] lot', l.id, e?.code || e?.message);
        // после 5 мин без итога — тревога администратору
        if (this.clock.ms() - new Date(l.closes_at).getTime() > s.reveal_alarm_min * 60_000) {
          await this.notify.alarmAdmins(`Reveal failed for lot #${l.id}`, String(e?.message ?? e), `reveal_alarm:${l.id}`);
        }
      }
    }
    if (lots.length) await this.deposits.processReleases();
    return lots.length;
  }

  /**
   * Вскрытие одного лота — одна транзакция. Повтор после сбоя даёт тот же результат:
   * сортировка детерминирована (сумма ↓, время сервера ↑, id ↑), итог пишется один раз.
   */
  async reveal(lotId: number) {
    return this.db.tx(async (t) => {
      const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 FOR UPDATE`, [lotId]);
      if (!lot || !['scheduled', 'live', 'revealing'].includes(lot.status)) return { skipped: true };
      const now = this.clock.now();
      if (now.getTime() < new Date(lot.closes_at).getTime()) return { skipped: true };
      const s = await this.settings.all(t);
      const bids = await t.q<{ id: string; user_id: number; ciphertext: string; commitment: string; server_received_at: Date }>(
        `SELECT id, user_id, ciphertext, commitment, server_received_at FROM bids WHERE lot_id=$1`,
        [lotId],
      );
      const opened: (RankRow & { userId: number; ms: number })[] = [];
      if (bids.length) {
        // закрытый ключ разворачивается KMS только после closes_at
        const priv = this.kms.unwrap(lotId, lot.private_key_wrapped, new Date(lot.closes_at), now);
        for (const b of bids) {
          const { amount, salt } = openBid(priv, b.ciphertext);
          if (commitmentOf(amount, salt, b.id) !== b.commitment) throw new Error('COMMITMENT_MISMATCH bid ' + b.id);
          opened.push({ place: 0, amount, salt, at: new Date(b.server_received_at).toISOString(), bidId: b.id, commitment: b.commitment, userId: b.user_id, ms: new Date(b.server_received_at).getTime() });
        }
      }
      // R-10: побеждает самая высокая ставка; при равных — пришедшая раньше по времени сервера
      opened.sort((a, b) => b.amount - a.amount || a.ms - b.ms || a.bidId.localeCompare(b.bidId));
      opened.forEach((r, i) => (r.place = i + 1));
      for (const r of opened) await t.q('UPDATE bids SET amount=$2, salt=$3 WHERE id=$1', [r.bidId, r.amount, r.salt]);
      const ranking: RankRow[] = opened.map(({ place, amount, at, bidId, commitment, salt, userId }) => ({ place, amount, at, bidId, commitment, salt, userId }));
      const winner = opened[0] ?? null;
      await t.q(`INSERT INTO lot_results(lot_id, ranking, winner_user_id, revealed_at) VALUES ($1,$2,$3,$4)`, [lotId, JSON.stringify(ranking), winner?.userId ?? null, now]);
      const web = process.env.WEB_URL || 'http://localhost:3000';
      if (winner) {
        await t.q(`UPDATE lots SET status='finished', winner_bid_id=$2, private_key_wrapped=NULL WHERE id=$1`, [lotId, winner.bidId]);
        await t.q(`INSERT INTO deals(lot_id, winner_user_id, seller_id, amount, confirm_deadline, status) VALUES ($1,$2,$3,$4,$5,'awaiting_confirm')`, [
          lotId,
          winner.userId,
          lot.seller_id,
          winner.amount,
          new Date(now.getTime() + s.deal_confirm_hours * HOUR),
        ]);
        // проигравшим и тем, кто внёс депозит без ставки, депозит освобождается сразу; у победителя — держится до сделки.
        // PRD v2 решение 8: взнос держат первые chain_places мест — сделка может перейти к ним по очереди
        const keep = opened.slice(0, Math.max(1, Number(s.chain_places ?? 1))).map((o) => o.userId);
        await this.deposits.markReleasing(`lot_id=$1 AND NOT (user_id = ANY($2)) AND status IN ('pending','held')`, [lotId, keep], t);
      } else {
        // R-12 / SC-13: ставок нет — аукцион без победителя
        await t.q(`UPDATE lots SET status='no_sale', ended_reason='no_bids', private_key_wrapped=NULL WHERE id=$1`, [lotId]);
        await this.deposits.markReleasing(`lot_id=$1 AND status IN ('pending','held')`, [lotId], t);
      }
      await this.audit.log(null, 'lot.revealed', 'lot', lotId, null, { bids: ranking.length, winnerBid: winner?.bidId ?? null }, t);

      // SC-12: письма участникам и продавцу на языке пользователя + SMS-дубль
      const users = await t.q<{ id: number; lang: Lang }>('SELECT id, lang FROM users WHERE id = ANY($1)', [[...opened.map((o) => o.userId), lot.seller_id]]);
      const langOf = (id: number) => users.find((u) => u.id === id)?.lang ?? 'hy';
      const table = (lang: Lang, me?: string) =>
        ranking
          .map((r) => `${r.place}. ${fmtAmd(r.amount)} — ${s.results_show_user_ids ? 'ID ' + r.userId : phrase('participant', lang) + ' ' + r.place} — ${fmtYerevan(r.at, true)}${r.place === 1 ? ' (' + phrase('winner', lang) + ')' : ''}${r.bidId === me ? ' ← ' + phrase('you', lang) : ''}`)
          .join('\n');
      const dealLink = `${web}/deals/${lotId}`;
      if (!winner) {
        await this.notify.queue(lot.seller_id, 'email', 'results_no_bids', { lotId }, { dedupeKey: `results:${lotId}:${lot.seller_id}` }, t);
      } else {
        for (const o of opened) {
          const lang = langOf(o.userId);
          const extra =
            o.place === 1
              ? phrase('extra_winner', lang, { hours: s.deal_confirm_hours, link: dealLink })
              : o.place <= Math.max(1, Number(s.chain_places ?? 1))
                ? phrase('extra_chain', lang, { place: o.place, hours: s.deal_confirm_hours })
                : phrase('extra_loser', lang);
          await this.notify.queue(
            o.userId,
            'email',
            'results',
            { lotId, intro: phrase('intro_participant', lang, { amount: fmtAmd(o.amount), place: o.place, total: ranking.length, commitment: o.commitment }), table: table(lang, o.bidId), extra },
            { dedupeKey: `results:${lotId}:${o.userId}` },
            t,
          );
          await this.notify.queue(o.userId, 'sms', 'results_sms', { lotId }, { dedupeKey: `results_sms:${lotId}:${o.userId}` }, t);
        }
        const sl = langOf(lot.seller_id);
        await this.notify.queue(
          lot.seller_id,
          'email',
          'results',
          { lotId, intro: phrase('intro_seller', sl, { amount: fmtAmd(winner.amount) }), table: table(sl), extra: phrase('extra_seller', sl, { hours: s.deal_confirm_hours, link: dealLink }) },
          { dedupeKey: `results:${lotId}:${lot.seller_id}` },
          t,
        );
        await this.notify.queue(lot.seller_id, 'sms', 'results_sms', { lotId }, { dedupeKey: `results_sms:${lotId}:${lot.seller_id}` }, t);
        await this.risk.checkAfterResult(lotId, t);
      }
      return { winner: winner ? { userId: winner.userId, amount: winner.amount } : null, bids: ranking.length };
    });
  }

  /** Сторож: лоты без итога дольше reveal_alarm_min — тревога (SC-11). */
  async watchdog() {
    const s = await this.settings.all();
    const stuck = await this.db.q<{ id: number }>(`SELECT id FROM lots WHERE status IN ('scheduled','live','revealing') AND closes_at < $1`, [new Date(this.clock.ms() - s.reveal_alarm_min * 60_000)]);
    for (const l of stuck) await this.notify.alarmAdmins(`Lot #${l.id} has no result`, 'Reveal not completed within the alarm window', `reveal_alarm:${l.id}`);
    return stuck.length;
  }
}
