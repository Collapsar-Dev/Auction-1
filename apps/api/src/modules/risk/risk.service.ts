import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { sha256 } from '../../common/hash';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { NotifyService } from '../notifications/notify.service';
import { User } from '../auth/auth.service';
import { fmtAmd, fmtYerevan } from '../../common/format';

/** 6A. Серийные победы: сигналы для модератора, лимиты, лестница мер. */
@Injectable()
export class RiskService {
  constructor(private db: Db, private clock: Clock, private settings: SettingsService, private audit: Audit, private notify: NotifyService) {}

  async recordFingerprint(userId: number, ua: string, ip: string) {
    const now = this.clock.now();
    await this.db.q(
      `INSERT INTO device_fingerprints(user_id, fingerprint_hash, ip_hash, first_seen, last_seen) VALUES ($1,$2,$3,$4,$4)
       ON CONFLICT (user_id, fingerprint_hash, ip_hash) DO UPDATE SET last_seen=EXCLUDED.last_seen`,
      [userId, sha256('fp:' + (ua || '')), sha256('ip:' + (ip || '')), now],
    );
  }

  private async flag(t: Queryable, userId: number, lotId: number, signal: string, details: Record<string, unknown>) {
    await t.q(`INSERT INTO risk_flags(user_id, lot_id, signal, details, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [userId, lotId, signal, JSON.stringify(details), this.clock.now()]);
  }

  /** Фоновая проверка после каждого итога (6A.2). Сигнал — не наказание. */
  async checkAfterResult(lotId: number, t: Queryable = this.db) {
    const s = await this.settings.all(t);
    const res = await t.maybe<{ ranking: any[]; winner_user_id: number | null }>('SELECT ranking, winner_user_id FROM lot_results WHERE lot_id=$1', [lotId]);
    if (!res?.winner_user_id) return [];
    const lot = await t.one('SELECT * FROM lots WHERE id=$1', [lotId]);
    const w = res.winner_user_id;
    const now = this.clock.ms();
    const signals: string[] = [];
    const wins = await t.q<{ lot_id: number; amount: number; revealed_at: Date }>(
      `SELECT r.lot_id, d.amount, r.revealed_at FROM lot_results r JOIN deals d ON d.lot_id=r.lot_id WHERE r.winner_user_id=$1`,
      [w],
    );
    const recent = wins.filter((x) => now - new Date(x.revealed_at).getTime() <= s.s1_days * DAY);
    if (recent.length >= s.s1_wins) signals.push('S-1'), await this.flag(t, w, lotId, 'S-1', { wins: recent.length, days: s.s1_days });
    const [first, second] = res.ranking;
    const gap = second ? (first.amount - second.amount) / second.amount : 0;
    if ((second && gap * 100 > s.s2_gap_pct) || first.amount > lot.start_price * s.s2_start_mult) {
      signals.push('S-2');
      await this.flag(t, w, lotId, 'S-2', { winning: first.amount, second: second?.amount ?? null, start: lot.start_price });
    }
    const refusals = await t.one<{ c: number }>(
      `SELECT count(*)::int c FROM sanctions WHERE user_id=$1 AND strike_no IS NOT NULL AND voided_at IS NULL AND created_at > $2`,
      [w, new Date(now - s.s3_months * 30 * DAY)],
    );
    if (refusals.c >= 1) signals.push('S-3'), await this.flag(t, w, lotId, 'S-3', { refusals: refusals.c });
    const vol = wins.filter((x) => now - new Date(x.revealed_at).getTime() <= s.s6_days * DAY).reduce((a, x) => a + Number(x.amount), 0);
    if (vol > s.s6_sum) signals.push('S-6'), await this.flag(t, w, lotId, 'S-6', { sum: vol, days: s.s6_days });
    // S-4: связь с продавцом — общее устройство/IP, карта, фамилия, или победы подряд у одного продавца
    const shared = await t.maybe(
      `SELECT 1 FROM device_fingerprints a JOIN device_fingerprints b ON (a.fingerprint_hash=b.fingerprint_hash OR a.ip_hash=b.ip_hash) WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1`,
      [w, lot.seller_id],
    );
    const names = await t.q<{ id: number; full_name: string | null }>('SELECT id, full_name FROM users WHERE id = ANY($1)', [[w, lot.seller_id]]);
    const surname = (n: string | null) => (n || '').trim().split(/\s+/).slice(-1)[0]?.toLowerCase() || null;
    const sameSurname = names.length === 2 && surname(names[0].full_name) && surname(names[0].full_name) === surname(names[1].full_name);
    const sameCard = await t.maybe(`SELECT 1 FROM cards a JOIN cards b ON a.binding_id=b.binding_id WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1`, [w, lot.seller_id]);
    const prevFromSeller = await t.one<{ c: number }>(`SELECT count(*)::int c FROM lot_results r JOIN lots l ON l.id=r.lot_id WHERE r.winner_user_id=$1 AND l.seller_id=$2`, [w, lot.seller_id]);
    if (shared || sameSurname || sameCard || prevFromSeller.c >= 2) {
      signals.push('S-4');
      await this.flag(t, w, lotId, 'S-4', { sharedDevice: !!shared, sameSurname: !!sameSurname, sameCard: !!sameCard, winsFromSeller: prevFromSeller.c });
    }
    // S-5: одно устройство или карта у нескольких участников одного лота
    const linked = await t.q<{ a: number; b: number }>(
      `WITH p AS (SELECT DISTINCT user_id FROM bids WHERE lot_id=$1)
       SELECT DISTINCT x.user_id a, y.user_id b FROM device_fingerprints x JOIN device_fingerprints y ON x.fingerprint_hash=y.fingerprint_hash AND x.ip_hash=y.ip_hash AND x.user_id<y.user_id
       WHERE x.user_id IN (SELECT user_id FROM p) AND y.user_id IN (SELECT user_id FROM p)
       UNION
       SELECT DISTINCT x.user_id, y.user_id FROM cards x JOIN cards y ON x.binding_id=y.binding_id AND x.user_id<y.user_id
       WHERE x.user_id IN (SELECT user_id FROM p) AND y.user_id IN (SELECT user_id FROM p)`,
      [lotId],
    );
    for (const pair of linked) {
      signals.push('S-5');
      await this.flag(t, pair.a, lotId, 'S-5', { linkedWith: pair.b });
      await this.flag(t, pair.b, lotId, 'S-5', { linkedWith: pair.a });
    }
    return signals;
  }

  /** 6A.3: лестница мер за отказ или молчание победителя. */
  async strike(userId: number, lotId: number, reason: string, t: Queryable) {
    const s = await this.settings.all(t);
    const now = this.clock.now();
    const prev = await t.one<{ c: number }>(
      `SELECT count(*)::int c FROM sanctions WHERE user_id=$1 AND strike_no IS NOT NULL AND voided_at IS NULL AND created_at > $2`,
      [userId, new Date(now.getTime() - 365 * DAY)],
    );
    const n = prev.c + 1;
    const u = await t.one<{ doc_hash: string | null }>('SELECT doc_hash FROM users WHERE id=$1', [userId]);
    const kind = n >= 3 ? 'permanent' : 'bid_block';
    const ends = n === 1 ? new Date(now.getTime() + s.sanction_days_1 * DAY) : n === 2 ? new Date(now.getTime() + s.sanction_days_2 * DAY) : null;
    await t.q(`INSERT INTO sanctions(user_id, doc_hash, kind, starts_at, ends_at, reason, strike_no, lot_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$4)`, [
      userId,
      u.doc_hash,
      kind,
      now,
      ends,
      reason,
      n,
      lotId,
    ]);
    // статус «Инвестор» снимается
    await t.q(`DELETE FROM buyer_limits WHERE user_id=$1`, [userId]);
    await this.audit.log(null, 'sanction.strike', 'user', userId, null, { strike: n, kind, ends, lotId }, t);
    const details = n >= 3 ? 'Бессрочная блокировка участия.' : `Блокировка ставок до ${fmtYerevan(ends!)}.` + (n === 2 ? ' Далее — только с подтверждением средств.' : '');
    await this.notify.queue(userId, 'email', 'sanction', { details }, {}, t);
    return { strike: n, kind, ends };
  }

  /** Модератор может не засчитывать случай при уважительной причине. */
  async voidSanction(staff: User, sanctionId: number, comment: string) {
    if (!comment) fail('COMMENT_REQUIRED');
    await this.db.q('UPDATE sanctions SET voided_at=$2 WHERE id=$1', [sanctionId, this.clock.now()]);
    await this.audit.log(staff.id, 'sanction.voided', 'sanction', sanctionId, null, { comment });
    return { ok: true };
  }

  /** Действия модератора по сигналу (6A.2, SC-24). Комментарий обязателен. */
  async act(staff: User, flagId: number, body: { action: 'clear' | 'request_funds' | 'set_limit' | 'block' | 'to_lawyer'; comment: string; buyingPower?: number; days?: number }) {
    if (!body.comment) fail('COMMENT_REQUIRED');
    const f = await this.db.maybe('SELECT * FROM risk_flags WHERE id=$1', [flagId]);
    if (!f) fail('NOT_FOUND', 404);
    const now = this.clock.now();
    await this.db.tx(async (t) => {
      if (body.action === 'request_funds') {
        await t.q(`INSERT INTO sanctions(user_id, kind, starts_at, reason, created_by, created_at) VALUES ($1,'funds_request',$2,$3,$4,$2)`, [f.user_id, now, body.comment, staff.id]);
        await this.notify.queue(f.user_id, 'email', 'risk_action', { details: 'Запрошены документы, подтверждающие средства. До ответа новые ставки недоступны; уже сделанные действуют.' }, {}, t);
      } else if (body.action === 'set_limit') {
        await this.setInvestor(t, staff.id, f.user_id, body.buyingPower ?? 0, body.days, body.comment);
      } else if (body.action === 'block') {
        await this.strike(f.user_id, f.lot_id, 'moderator: ' + body.comment, t);
      }
      await t.q(`UPDATE risk_flags SET status=$2, reviewed_by=$3, comment=$4 WHERE id=$1`, [flagId, body.action === 'clear' ? 'cleared' : 'actioned', staff.id, body.comment]);
      await this.audit.log(staff.id, 'risk.' + body.action, 'risk_flag', flagId, { status: f.status }, body, t);
    });
    return { ok: true };
  }

  async setInvestor(t: Queryable, staffId: number, userId: number, buyingPower: number, days: number | undefined, reason: string) {
    const s = await this.settings.all(t);
    const until = new Date(this.clock.ms() + (days ?? s.investor_days) * DAY);
    await t.q(
      `INSERT INTO buyer_limits(user_id, tier, max_active_bids, max_open_deals, buying_power, valid_until, set_by, reason) VALUES ($1,'investor',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET tier='investor', max_active_bids=EXCLUDED.max_active_bids, max_open_deals=EXCLUDED.max_open_deals, buying_power=EXCLUDED.buying_power, valid_until=EXCLUDED.valid_until, set_by=EXCLUDED.set_by, reason=EXCLUDED.reason`,
      [userId, s.investor_max_active_bids, s.investor_max_open_deals, buyingPower, until, staffId, reason],
    );
    // подтверждение средств снимает запрос документов
    await t.q(`UPDATE sanctions SET voided_at=$2 WHERE user_id=$1 AND kind='funds_request' AND voided_at IS NULL`, [userId, this.clock.now()]);
    return until;
  }

  /** SC-23: подтверждение средств — решение модератора. */
  async decideFundsProof(staff: User, proofId: number, body: { approve: boolean; buyingPower?: number; days?: number; comment?: string }) {
    const p = await this.db.maybe('SELECT * FROM funds_proofs WHERE id=$1', [proofId]);
    if (!p || p.status !== 'pending') fail('NOT_FOUND', 404);
    if (!body.approve && !body.comment) fail('COMMENT_REQUIRED');
    await this.db.tx(async (t) => {
      let details = body.comment || '';
      if (body.approve) {
        if (!body.buyingPower || body.buyingPower <= 0) fail('BUYING_POWER_REQUIRED');
        const until = await this.setInvestor(t, staff.id, p.user_id, body.buyingPower!, body.days, body.comment || 'funds proof');
        details = `Покупательский лимит: ${fmtAmd(body.buyingPower!)}, до ${fmtYerevan(until)}.`;
      }
      await t.q(`UPDATE funds_proofs SET status=$2, reviewed_by=$3, comment=$4, decided_at=$5 WHERE id=$1`, [proofId, body.approve ? 'approved' : 'rejected', staff.id, body.comment ?? null, this.clock.now()]);
      await this.audit.log(staff.id, 'funds_proof.' + (body.approve ? 'approved' : 'rejected'), 'funds_proof', proofId, null, { buyingPower: body.buyingPower }, t);
      await this.notify.queue(p.user_id, 'email', 'funds_proof_decided', { result: body.approve ? '✓' : '✗', details }, {}, t);
    });
    return { ok: true };
  }
}
