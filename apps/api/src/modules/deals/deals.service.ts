import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY, HOUR } from '../../common/clock';
import { fail } from '../../common/errors';
import { SettingsService, commissionFor } from '../../common/settings';
import { Audit } from '../../common/audit';
import { Storage } from '../../adapters/storage';
import { FakeGateway } from '../../adapters/gateway';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { RiskService } from '../risk/risk.service';
import { DepositsService } from '../deposits/deposits.service';
import { fmtAmd, fmtYerevan } from '../../common/format';

const NOTARY_DOCS = ['passport', 'cadastral_certificate', 'ownership_documents', 'co_owners_consent', 'bank_consent_if_mortgage'];

/** SC-14…SC-17: подтверждение сделки, контакты, «Продано», комиссия, отказы. */
@Injectable()
export class DealsService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private storage: Storage,
    private gw: FakeGateway,
    private auth: AuthService,
    private notify: NotifyService,
    private risk: RiskService,
    private deposits: DepositsService,
  ) {}

  private async dealFor(user: User, lotId: number, t: Queryable = this.db, lock = false) {
    const d = await t.maybe(`SELECT * FROM deals WHERE lot_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [lotId]);
    if (!d || (d.winner_user_id !== user.id && d.seller_id !== user.id)) fail('DEAL_NOT_FOUND', 404);
    return { d, role: d.winner_user_id === user.id ? ('buyer' as const) : ('seller' as const) };
  }

  async view(user: User, lotId: number) {
    const { d, role } = await this.dealFor(user, lotId);
    const s = await this.settings.all();
    const out: any = {
      lotId,
      role,
      amount: d.amount,
      status: d.status,
      confirmDeadline: d.confirm_deadline,
      sellerConfirmedAt: d.seller_confirmed_at,
      buyerConfirmedAt: d.buyer_confirmed_at,
      extractUploadedAt: d.extract_uploaded_at,
      closedAt: d.closed_at,
      failReason: d.fail_reason,
      round: d.round,
      commission: role === 'seller' ? commissionFor(d.amount, s) : 0,
      notaryDays: s.notary_days,
    };
    // контакты — только когда оба подтвердили
    if (d.seller_confirmed_at && d.buyer_confirmed_at) {
      const other = await this.db.one('SELECT full_name, phone FROM users WHERE id=$1', [role === 'buyer' ? d.seller_id : d.winner_user_id]);
      out.counterparty = { name: other.full_name, phone: other.phone };
      out.notaryDocuments = NOTARY_DOCS;
    }
    return out;
  }

  async mine(user: User) {
    return this.db.q(
      `SELECT d.lot_id, d.status, d.amount, d.confirm_deadline, CASE WHEN d.winner_user_id=$1 THEN 'buyer' ELSE 'seller' END AS role, p.settlement, p.street, p.property_type
       FROM deals d JOIN lots l ON l.id=d.lot_id JOIN properties p ON p.id=l.property_id WHERE d.winner_user_id=$1 OR d.seller_id=$1 ORDER BY d.lot_id DESC`,
      [user.id],
    );
  }

  async confirm(user: User, lotId: number, stepUp: string | undefined) {
    const res = await this.db.tx(async (t) => {
      const { d, role } = await this.dealFor(user, lotId, t, true);
      if (d.status !== 'awaiting_confirm') fail('DEAL_NOT_AWAITING');
      if (this.clock.ms() > new Date(d.confirm_deadline).getTime()) fail('DEAL_DEADLINE_PASSED');
      await this.auth.consumeStepUp(user, 'deal_confirm', stepUp, t);
      const col = role === 'buyer' ? 'buyer_confirmed_at' : 'seller_confirmed_at';
      const nd = await t.one(`UPDATE deals SET ${col}=coalesce(${col}, $2) WHERE lot_id=$1 RETURNING *`, [lotId, this.clock.now()]);
      await this.audit.log(user.id, 'deal.confirmed', 'deal', lotId, null, { role }, t);
      if (nd.buyer_confirmed_at && nd.seller_confirmed_at) {
        await t.q(`UPDATE deals SET status='confirmed' WHERE lot_id=$1`, [lotId]);
        const s = await this.settings.all(t);
        const [b, sl] = await Promise.all([
          t.one('SELECT full_name, phone FROM users WHERE id=$1', [nd.winner_user_id]),
          t.one('SELECT full_name, phone FROM users WHERE id=$1', [nd.seller_id]),
        ]);
        await this.notify.queue(nd.winner_user_id, 'email', 'deal_confirmed', { lotId, otherName: sl.full_name, otherPhone: sl.phone, notaryDays: s.notary_days }, {}, t);
        await this.notify.queue(nd.seller_id, 'email', 'deal_confirmed', { lotId, otherName: b.full_name, otherPhone: b.phone, notaryDays: s.notary_days }, {}, t);
        return 'confirmed';
      }
      return 'awaiting_confirm';
    });
    return { status: res };
  }

  async decline(user: User, lotId: number, reason: string) {
    await this.db.tx(async (t) => {
      const { d, role } = await this.dealFor(user, lotId, t, true);
      if (!['awaiting_confirm', 'confirmed'].includes(d.status)) fail('DEAL_NOT_ACTIVE');
      await this.audit.log(user.id, 'deal.declined', 'deal', lotId, null, { role, reason }, t);
      if (role === 'buyer') await this.buyerFailed(d, 'declined: ' + (reason || '—'), t);
      else await this.sellerFailed(d, 'declined: ' + (reason || '—'), t);
    });
    await this.deposits.processReleases();
    return { ok: true };
  }

  /**
   * SC-16: победитель отказался или молчит. Депозит — спорный до решения администратора (Q-01).
   * v0.2 «второй шанс»: если отказ случился в течение second_chance_days после итога и у участника
   * со 2-го места ещё заблокирован депозит — лот переходит к нему по его ставке.
   */
  async buyerFailed(d: any, reason: string, t: Queryable) {
    const now = this.clock.now();
    await t.q(`UPDATE deposits SET status='disputed', updated_at=$3 WHERE lot_id=$1 AND user_id=$2 AND status='held'`, [d.lot_id, d.winner_user_id, now]);
    await this.risk.strike(d.winner_user_id, d.lot_id, 'winner refused or silent: ' + reason, t);
    const runner = d.round === 1 ? await this.runnerUp(d.lot_id, t) : null;
    if (runner) {
      const s = await this.settings.all(t);
      const web = process.env.WEB_URL || 'http://localhost:3000';
      await t.q(
        `UPDATE deals SET winner_user_id=$2, amount=$3, round=2, prev_winner_user_id=$4, transferred_at=$5, confirm_deadline=$6,
           seller_confirmed_at=NULL, buyer_confirmed_at=NULL, status='awaiting_confirm', fail_reason=$7, new_extract_key=NULL, extract_uploaded_at=NULL WHERE lot_id=$1`,
        [d.lot_id, runner.userId, runner.amount, d.winner_user_id, now, new Date(now.getTime() + s.deal_confirm_hours * HOUR), 'round 1: ' + reason],
      );
      await t.q(`UPDATE lots SET winner_bid_id=$2 WHERE id=$1`, [d.lot_id, runner.bidId]);
      await this.audit.log(null, 'deal.second_chance', 'deal', d.lot_id, { winner: d.winner_user_id }, { winner: runner.userId, amount: runner.amount }, t);
      const payload = { lotId: d.lot_id, amount: fmtAmd(runner.amount), hours: s.deal_confirm_hours, link: `${web}/deals/${d.lot_id}` };
      await this.notify.queue(runner.userId, 'email', 'lot_offered_second', payload, { dedupeKey: `second:${d.lot_id}:${runner.userId}` }, t);
      await this.notify.queue(runner.userId, 'sms', 'lot_offered_second', payload, { dedupeKey: `second_sms:${d.lot_id}:${runner.userId}` }, t);
      await this.notify.queue(d.seller_id, 'email', 'lot_passed_second_seller', payload, { dedupeKey: `second_seller:${d.lot_id}` }, t);
      await this.notify.queue(d.winner_user_id, 'email', 'deal_failed', { lotId: d.lot_id, reason: 'Вы отказались от сделки. Лот передан участнику со 2-го места. Ваш депозит остаётся заблокированным до решения администратора.' }, {}, t);
      return 'transferred';
    }
    await t.q(`UPDATE deals SET status='buyer_failed', fail_reason=$2, closed_at=$3 WHERE lot_id=$1`, [d.lot_id, reason, now]);
    await t.q(`UPDATE lots SET status='no_sale', ended_reason='buyer_failed' WHERE id=$1`, [d.lot_id]);
    await this.notify.queue(d.winner_user_id, 'email', 'deal_failed', { lotId: d.lot_id, reason: 'Сделка не состоялась по стороне покупателя. Депозит остаётся заблокированным до решения администратора.' }, {}, t);
    await this.notify.queue(d.seller_id, 'email', 'deal_failed', { lotId: d.lot_id, reason: 'Победитель отказался или не подтвердил сделку. Вы можете перезапустить лот.' }, {}, t);
    return 'failed';
  }

  /** Участник со 2-го места, если «второй шанс» ещё действует и его депозит заблокирован. */
  private async runnerUp(lotId: number, t: Queryable) {
    const s = await this.settings.all(t);
    if (!s.second_chance_days) return null;
    const r = await t.maybe<{ ranking: any[]; revealed_at: Date }>('SELECT ranking, revealed_at FROM lot_results WHERE lot_id=$1', [lotId]);
    if (!r || this.clock.ms() - new Date(r.revealed_at).getTime() > s.second_chance_days * DAY) return null;
    const second = r.ranking.find((x: any) => x.place === 2);
    if (!second) return null;
    const bid = await t.maybe<{ user_id: number }>('SELECT user_id FROM bids WHERE id=$1', [second.bidId]);
    if (!bid) return null;
    const dep = await t.maybe(`SELECT 1 FROM deposits WHERE lot_id=$1 AND user_id=$2 AND status='held'`, [lotId, bid.user_id]);
    if (!dep) return null;
    return { userId: bid.user_id, amount: second.amount as number, bidId: second.bidId as string };
  }

  /** Когда «второй шанс» больше невозможен — освободить депозит 2-го места. */
  async releaseRunnerUps() {
    const s = await this.settings.all();
    const rows = await this.db.q<{ lot_id: number; ranking: any[]; revealed_at: Date; winner_user_id: number; status: string; round: number }>(
      `SELECT r.lot_id, r.ranking, r.revealed_at, d.winner_user_id, d.status, d.round FROM lot_results r JOIN deals d ON d.lot_id=r.lot_id`,
    );
    for (const r of rows) {
      const second = r.ranking.find((x: any) => x.place === 2);
      if (!second) continue;
      const bid = await this.db.maybe<{ user_id: number }>('SELECT user_id FROM bids WHERE id=$1', [second.bidId]);
      if (!bid || bid.user_id === r.winner_user_id) continue; // 2-е место само стало покупателем
      const windowOver = this.clock.ms() - new Date(r.revealed_at).getTime() > s.second_chance_days * DAY;
      const dealOver = ['sold', 'seller_failed', 'invalidated'].includes(r.status);
      if (windowOver || dealOver || r.round === 2) {
        await this.deposits.markReleasing(`lot_id=$1 AND user_id=$2 AND status='held'`, [r.lot_id, bid.user_id], this.db);
      }
    }
  }

  /** SC-17: продавец отказался или молчит → депозит победителя освобождается, продавец блокируется. */
  async sellerFailed(d: any, reason: string, t: Queryable) {
    await t.q(`UPDATE deals SET status='seller_failed', fail_reason=$2, closed_at=$3 WHERE lot_id=$1`, [d.lot_id, reason, this.clock.now()]);
    await t.q(`UPDATE lots SET status='no_sale', ended_reason='seller_failed' WHERE id=$1`, [d.lot_id]);
    await this.deposits.markReleasing(`lot_id=$1 AND user_id=$2 AND status='held'`, [d.lot_id, d.winner_user_id], t);
    await t.q(`UPDATE users SET seller_blocked=true, seller_block_reason='SELLER_FAILED_DEAL' WHERE id=$1`, [d.seller_id]);
    await this.audit.log(null, 'seller.blocked', 'user', d.seller_id, null, { lotId: d.lot_id, reason }, t);
    await this.notify.queue(d.winner_user_id, 'email', 'deal_failed', { lotId: d.lot_id, reason: 'Продавец отказался или не подтвердил сделку. Ваш депозит освобождается.' }, {}, t);
    await this.notify.queue(d.seller_id, 'email', 'deal_failed', { lotId: d.lot_id, reason: 'Сделка не подтверждена вами. Создание новых лотов заблокировано до решения администратора.' }, {}, t);
  }

  /** Фон: срок 48 ч, напоминания через 24 ч и за 2 ч (SC-14); нотариус — 10 дней (SC-15). */
  async tick() {
    const now = this.clock.ms();
    const web = process.env.WEB_URL || 'http://localhost:3000';
    const open = await this.db.q(`SELECT * FROM deals WHERE status='awaiting_confirm'`);
    for (const d of open) {
      const deadline = new Date(d.confirm_deadline).getTime();
      if (now > deadline) {
        await this.db.tx(async (t) => {
          const cur = await t.one(`SELECT * FROM deals WHERE lot_id=$1 FOR UPDATE`, [d.lot_id]);
          if (cur.status !== 'awaiting_confirm') return;
          if (!cur.buyer_confirmed_at) {
            const r = await this.buyerFailed(cur, 'silent 48h', t);
            if (r === 'failed' && !cur.seller_confirmed_at) {
              await t.q(`UPDATE users SET seller_blocked=true, seller_block_reason='SELLER_FAILED_DEAL' WHERE id=$1`, [cur.seller_id]);
            }
          } else await this.sellerFailed(cur, 'silent 48h', t);
        });
        continue;
      }
      for (const [k, at] of [
        ['24h', deadline - 24 * HOUR],
        ['2h', deadline - 2 * HOUR],
      ] as const) {
        if (now >= at) {
          for (const [uid, done] of [
            [d.winner_user_id, d.buyer_confirmed_at],
            [d.seller_id, d.seller_confirmed_at],
          ]) {
            if (!done) await this.notify.queue(uid, 'email', 'deal_reminder', { lotId: d.lot_id, deadline: fmtYerevan(d.confirm_deadline), link: `${web}/deals/${d.lot_id}` }, { dedupeKey: `deal_rem:${d.lot_id}:${uid}:${k}` });
          }
        }
      }
    }
    const s = await this.settings.all();
    const late = await this.db.q(`SELECT lot_id FROM deals WHERE status='confirmed' AND buyer_confirmed_at < $1 AND seller_confirmed_at < $1`, [new Date(now - s.notary_days * DAY)]);
    for (const d of late) await this.notify.alarmAdmins(`Deal #${d.lot_id}: no extract after ${s.notary_days} days`, 'Contact the parties (SC-15)', `notary_late:${d.lot_id}`);
    await this.processCommissions();
    await this.releaseRunnerUps();
    await this.deposits.processReleases();
  }

  async uploadExtract(user: User, lotId: number, file: { buffer: Buffer; mimetype: string }) {
    const { d } = await this.dealFor(user, lotId);
    if (!['confirmed', 'extract_uploaded'].includes(d.status)) fail('DEAL_NOT_CONFIRMED');
    if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.mimetype)) fail('FILE_TYPE');
    const key = this.storage.put(file.buffer, file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1], true);
    await this.db.q(`UPDATE deals SET new_extract_key=$2, extract_uploaded_at=$3, status='extract_uploaded' WHERE lot_id=$1`, [lotId, key, this.clock.now()]);
    await this.audit.log(user.id, 'deal.extract_uploaded', 'deal', lotId);
    return { ok: true };
  }

  /** SC-15: администратор нажимает «Продано» → депозит победителя освобождается, списывается комиссия. */
  async markSold(admin: User, lotId: number) {
    await this.db.tx(async (t) => {
      const d = await t.maybe(`SELECT * FROM deals WHERE lot_id=$1 FOR UPDATE`, [lotId]);
      if (!d) fail('DEAL_NOT_FOUND', 404);
      if (d.status !== 'extract_uploaded') fail('EXTRACT_REQUIRED');
      const s = await this.settings.all(t);
      await t.q(`UPDATE deals SET status='sold', closed_at=$2 WHERE lot_id=$1`, [lotId, this.clock.now()]);
      await t.q(`UPDATE lots SET status='sold' WHERE id=$1`, [lotId]);
      await this.deposits.markReleasing(`lot_id=$1 AND user_id=$2 AND status='held'`, [lotId, d.winner_user_id], t);
      await t.q(`INSERT INTO payments(kind, lot_id, user_id, amount, idempotency_key, status, next_attempt_at, created_at) VALUES ('commission',$1,$2,$3,$4,'pending',$5,$5)`, [
        lotId,
        d.seller_id,
        commissionFor(d.amount, s),
        'commission:' + lotId,
        this.clock.now(),
      ]);
      await this.audit.log(admin.id, 'deal.sold', 'deal', lotId, { status: d.status }, { status: 'sold' }, t);
      await this.notify.queue(d.winner_user_id, 'email', 'deal_sold', { lotId, extra: 'Ваш депозит освобождается.' }, {}, t);
      await this.notify.queue(d.seller_id, 'email', 'deal_sold', { lotId, extra: `Комиссия ${fmtAmd(commissionFor(d.amount, s))} будет списана с привязанной карты.` }, {}, t);
    });
    await this.processCommissions();
    await this.releaseRunnerUps();
    await this.deposits.processReleases();
    return { ok: true };
  }

  /** 6.4: списание комиссии; не прошло → 3 повтора за 3 дня, потом ссылка на оплату и блокировка новых лотов. */
  async processCommissions() {
    const s = await this.settings.all();
    const due = await this.db.q(`SELECT * FROM payments WHERE kind='commission' AND status='pending' AND next_attempt_at <= $1`, [this.clock.now()]);
    for (const p of due) {
      const ok = await this.chargeCommission(p, undefined);
      if (ok) continue;
      const attempts = p.attempts + 1;
      if (attempts > s.commission_retry_days) {
        await this.db.q(`UPDATE payments SET status='failed', attempts=$2 WHERE id=$1`, [p.id, attempts]);
        await this.db.q(`UPDATE users SET seller_blocked=true, seller_block_reason='COMMISSION_UNPAID' WHERE id=$1`, [p.user_id]);
        const web = process.env.WEB_URL || 'http://localhost:3000';
        await this.notify.queue(p.user_id, 'email', 'commission_failed', { amount: fmtAmd(p.amount), link: `${web}/account?tab=payments` }, { dedupeKey: 'com_fail:' + p.id });
      } else {
        await this.db.q(`UPDATE payments SET attempts=$2, next_attempt_at=$3 WHERE id=$1`, [p.id, attempts, new Date(this.clock.ms() + DAY)]);
      }
    }
  }

  private async chargeCommission(p: any, cardId: number | undefined) {
    const card = await this.db.maybe(`SELECT binding_id FROM cards WHERE user_id=$1 AND status='active' ${cardId ? 'AND id=$2' : ''} ORDER BY id LIMIT 1`, cardId ? [p.user_id, cardId] : [p.user_id]);
    if (!card) return false;
    const o = await this.gw.payByBinding(card.binding_id, p.amount, `${p.idempotency_key}:${p.attempts}:${cardId ?? 'auto'}:${crypto.randomUUID()}`);
    const st = await this.gw.getOrderStatus(o.orderId);
    if (!st || st.status !== 'deposited') return false;
    const receipt = 'C-' + String(p.id).padStart(6, '0');
    await this.db.q(`UPDATE payments SET status='paid', gateway_order_id=$2, receipt_no=$3, attempts=attempts+1 WHERE id=$1`, [p.id, o.orderId, receipt]);
    await this.db.q(`UPDATE users SET seller_blocked=false, seller_block_reason=NULL WHERE id=$1 AND seller_block_reason='COMMISSION_UNPAID'`, [p.user_id]);
    await this.notify.queue(p.user_id, 'email', 'commission_charged', { lotId: p.lot_id, amount: fmtAmd(p.amount), receiptNo: receipt });
    await this.audit.log(null, 'commission.charged', 'payment', p.id);
    return true;
  }

  /** Оплата комиссии по ссылке (после неудачных повторов). */
  async payCommission(user: User, paymentId: number, cardId?: number) {
    const p = await this.db.maybe(`SELECT * FROM payments WHERE id=$1 AND user_id=$2 AND kind='commission' AND status IN ('pending','failed')`, [paymentId, user.id]);
    if (!p) fail('PAYMENT_NOT_FOUND', 404);
    const ok = await this.chargeCommission(p, cardId);
    if (!ok) fail('PAYMENT_DECLINED', 402);
    return { ok: true };
  }
}
