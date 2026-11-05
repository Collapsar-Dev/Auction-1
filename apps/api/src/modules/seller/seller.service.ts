import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { Audit } from '../../common/audit';
import { SettingsService, guaranteeFor } from '../../common/settings';
import { FakeGateway } from '../../adapters/gateway';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { fmtAmd } from '../../common/format';

/** PRD v2 решения 16–17: тарифы продавца и возвратный взнос продавца. */
@Injectable()
export class SellerService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private gw: FakeGateway,
    private auth: AuthService,
    private notify: NotifyService,
  ) {}

  // ================= Тарифы продавца =================
  plans() {
    return this.db.q(`SELECT * FROM seller_plans WHERE is_active ORDER BY price`);
  }

  private activeSubs(userId: number, t: Queryable = this.db) {
    return t.q(
      `SELECT s.*, p.code FROM seller_subscriptions s JOIN seller_plans p ON p.id=s.seller_plan_id
       WHERE s.user_id=$1 AND s.starts_at <= $2 AND (s.ends_at IS NULL OR s.ends_at > $2) ORDER BY s.ends_at NULLS LAST, s.id`,
      [userId, this.clock.now()],
    );
  }
  private left(s: any) {
    return s.listing_limit === null ? null : Math.max(0, s.listing_limit - s.listings_used);
  }
  private async activeLots(userId: number, t: Queryable) {
    return (await t.one<{ c: number }>(`SELECT count(*)::int c FROM lots WHERE seller_id=$1 AND status IN ('moderation','scheduled','live','revealing','finished')`, [userId])).c;
  }

  async mine(user: User) {
    const subs = await this.activeSubs(user.id);
    return {
      subscriptions: subs.map((s: any) => ({ id: s.id, plan: s.code, limit: s.listing_limit, used: s.listings_used, left: this.left(s), maxActive: s.max_active, endsAt: s.ends_at })),
      activeLots: await this.activeLots(user.id, this.db),
      history: await this.db.q(`SELECT id, lot_id, type, reason, created_at FROM listing_credits WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [user.id]),
    };
  }

  async buy(user: User, code: string, cardId: number | undefined, stepUp: string | undefined) {
    if (user.kyc_status !== 'verified') fail('KYC_REQUIRED', 403);
    const plan = await this.db.maybe('SELECT * FROM seller_plans WHERE code=$1 AND is_active', [code]);
    if (!plan) fail('PLAN_NOT_FOUND', 404);
    return this.db.tx(async (t) => {
      await this.auth.consumeStepUp(user, 'subscription', stepUp, t);
      const card = await t.maybe<{ id: number; binding_id: string }>(
        `SELECT id, binding_id FROM cards WHERE user_id=$1 AND status='active' ${cardId ? 'AND id=$2' : ''} ORDER BY id LIMIT 1`,
        cardId ? [user.id, cardId] : [user.id],
      );
      if (!card) fail('CARD_REQUIRED');
      const now = this.clock.now();
      const key = `seller_plan:${user.id}:${crypto.randomUUID()}`;
      const pay = await t.one<{ id: number }>(`INSERT INTO payments(kind, user_id, amount, idempotency_key, status, created_at) VALUES ('seller_plan',$1,$2,$3,'pending',$4) RETURNING id`, [user.id, plan.price, key, now]);
      const order = await this.gw.payByBinding(card!.binding_id, Number(plan.price), key);
      const st = await this.gw.getOrderStatus(order.orderId);
      if (!st || st.status !== 'deposited') {
        await t.q(`UPDATE payments SET status='failed', gateway_order_id=$2 WHERE id=$1`, [pay.id, order.orderId]);
        fail('PAYMENT_DECLINED', 402);
      }
      const receipt = 'R-' + pay.id.toString().padStart(6, '0');
      await t.q(`UPDATE payments SET status='paid', gateway_order_id=$2, receipt_no=$3 WHERE id=$1`, [pay.id, order.orderId, receipt]);
      const sub = await t.one(
        `INSERT INTO seller_subscriptions(user_id, seller_plan_id, price_paid, listing_limit, max_active, starts_at, ends_at, payment_id, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'paid',$6) RETURNING *`,
        [user.id, plan.id, plan.price, plan.listing_limit, plan.max_active, now, plan.period_days ? new Date(now.getTime() + plan.period_days * DAY) : null, pay.id],
      );
      await this.audit.log(user.id, 'seller_plan.bought', 'seller_subscription', sub.id, null, { plan: code }, t);
      return { subscription: sub, receiptNo: receipt };
    });
  }

  /**
   * При отправке лота на модерацию: зарезервировать размещение. Повторная отправка того же лота — без нового списания.
   * Перезапуск лота, который «не состоялся» не по вине продавца, — один раз бесплатно.
   */
  async reserve(user: User, lot: { id: number; relaunched_from: number | null }, t: Queryable) {
    const s = await this.settings.all(t);
    if (!s.seller_plans_enabled) return null;
    const held = await t.maybe(
      `SELECT 1 FROM listing_credits WHERE lot_id=$1 GROUP BY lot_id
       HAVING sum(CASE type WHEN 'reserved' THEN 1 WHEN 'free_relist' THEN 1 WHEN 'released' THEN -1 ELSE 0 END) > 0`,
      [lot.id],
    );
    if (held) return null;
    const now = this.clock.now();
    if (lot.relaunched_from) {
      const prev = await t.maybe<{ status: string; ended_reason: string | null }>('SELECT status, ended_reason FROM lots WHERE id=$1', [lot.relaunched_from]);
      const used = await t.maybe(`SELECT 1 FROM listing_credits c JOIN lots l ON l.id=c.lot_id WHERE c.type='free_relist' AND l.relaunched_from=$1`, [lot.relaunched_from]);
      if (prev?.status === 'no_sale' && prev.ended_reason !== 'seller_failed' && !used) {
        await t.q(`INSERT INTO listing_credits(user_id, lot_id, type, reason, created_at) VALUES ($1,$2,'free_relist',$3,$4)`, [user.id, lot.id, 'relist of ' + lot.relaunched_from, now]);
        return { free: true };
      }
    }
    const subs = await this.activeSubs(user.id, t);
    const active = await this.activeLots(user.id, t);
    const sub = subs.find((x: any) => (this.left(x) === null || this.left(x)! > 0) && (x.max_active === null || active < x.max_active));
    if (!sub) {
      const unlimited = subs.find((x: any) => x.max_active !== null);
      if (unlimited) fail('SELLER_ACTIVE_LIMIT', 403, { max: unlimited.max_active });
      fail('SELLER_PLAN_REQUIRED', 403);
    }
    await t.q('UPDATE seller_subscriptions SET listings_used = listings_used + 1 WHERE id=$1', [sub.id]);
    await t.q(`INSERT INTO listing_credits(seller_subscription_id, user_id, lot_id, type, created_at) VALUES ($1,$2,$3,'reserved',$4)`, [sub.id, user.id, lot.id, now]);
    return { subscriptionId: sub.id };
  }

  /** Решение модератора: одобрен — размещение потрачено; отклонён — возвращается. «Вернуть на доработку» — остаётся в резерве. */
  async onModeration(lotId: number, decision: 'approve' | 'return' | 'reject', t: Queryable) {
    const r = await t.maybe<{ seller_subscription_id: number | null; user_id: number; type: string }>(
      `SELECT seller_subscription_id, user_id, type FROM listing_credits WHERE lot_id=$1 AND type IN ('reserved','free_relist') ORDER BY id DESC LIMIT 1`,
      [lotId],
    );
    if (!r || decision === 'return') return;
    const now = this.clock.now();
    if (decision === 'approve') {
      await t.q(`INSERT INTO listing_credits(seller_subscription_id, user_id, lot_id, type, created_at) VALUES ($1,$2,$3,'spent',$4)`, [r.seller_subscription_id, r.user_id, lotId, now]);
    } else {
      if (r.seller_subscription_id) await t.q('UPDATE seller_subscriptions SET listings_used = GREATEST(listings_used - 1, 0) WHERE id=$1', [r.seller_subscription_id]);
      await t.q(`INSERT INTO listing_credits(seller_subscription_id, user_id, lot_id, type, reason, created_at) VALUES ($1,$2,$3,'released','rejected',$4)`, [r.seller_subscription_id, r.user_id, lotId, now]);
    }
  }

  // ================= Взнос продавца =================
  amountFor(lot: { start_price: number; guarantee_bp: number | null }, s: any) {
    return Math.max(Number(s.seller_deposit_min ?? 0), guaranteeFor(Number(lot.start_price), lot.guarantee_bp, s));
  }

  /** Блокировка взноса продавца, когда открылась регистрация. Идемпотентно. Возвращает true, если взнос заблокирован. */
  async ensureHold(lotId: number): Promise<boolean> {
    const s = await this.settings.all();
    if (!s.seller_deposit_enabled) return true;
    const ex = await this.db.maybe<{ status: string; updated_at: Date }>('SELECT status, updated_at FROM seller_deposits WHERE lot_id=$1', [lotId]);
    if (ex && ex.status !== 'failed') return ex.status === 'held';
    if (ex && this.clock.ms() - new Date(ex.updated_at).getTime() < 3600_000) return false; // повтор после отказа — не чаще раза в час
    const lot = await this.db.maybe(`SELECT * FROM lots WHERE id=$1 AND status IN ('scheduled','live')`, [lotId]);
    if (!lot) return false;
    const now = this.clock.now();
    const card = await this.db.maybe<{ id: number; binding_id: string }>(`SELECT id, binding_id FROM cards WHERE user_id=$1 AND status='active' ORDER BY id LIMIT 1`, [lot.seller_id]);
    const amount = this.amountFor(lot, s);
    let status: 'held' | 'failed' = 'failed';
    let orderId: string | null = null;
    if (card) {
      const o = await this.gw.holdByBinding(card.binding_id, amount, `seller_deposit:${lotId}:${now.getTime()}`, s.hold_days, now);
      const st = await this.gw.getOrderStatus(o.orderId);
      orderId = o.orderId;
      if (st?.status === 'approved') status = 'held';
    }
    await this.db.q(
      `INSERT INTO seller_deposits(lot_id, user_id, card_id, amount, status, gateway_order_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (lot_id) DO UPDATE SET status=EXCLUDED.status, gateway_order_id=EXCLUDED.gateway_order_id, card_id=EXCLUDED.card_id, amount=EXCLUDED.amount, updated_at=EXCLUDED.updated_at`,
      [lotId, lot.seller_id, card?.id ?? null, amount, status, orderId, now],
    );
    await this.audit.log(null, status === 'held' ? 'seller_deposit.held' : 'seller_deposit.failed', 'lot', lotId, null, { amount });
    if (status === 'failed') {
      await this.notify.queue(lot.seller_id, 'email', 'seller_deposit_failed', { lotId, amount: fmtAmd(amount) }, { dedupeKey: `sd_fail:${lotId}:${now.toISOString().slice(0, 13)}` });
    }
    return status === 'held';
  }

  /** Фон: лоты с открытой регистрацией — блокировка; завершённые не по вине продавца — возврат. */
  async tick() {
    const s = await this.settings.all();
    if (!s.seller_deposit_enabled) return;
    const now = this.clock.now();
    const due = await this.db.q<{ id: number }>(
      `SELECT l.id FROM lots l LEFT JOIN seller_deposits d ON d.lot_id=l.id
       WHERE l.status IN ('scheduled','live') AND coalesce(l.registration_opens_at, l.published_at, l.approved_at) <= $1 AND (d.lot_id IS NULL OR d.status='failed')`,
      [now],
    );
    for (const l of due) await this.ensureHold(l.id);
    const done = await this.db.q<{ lot_id: number }>(
      `SELECT d.lot_id FROM seller_deposits d JOIN lots l ON l.id=d.lot_id
       WHERE d.status='held' AND (l.status='sold' OR (l.status='no_sale' AND coalesce(l.ended_reason,'') <> 'seller_failed'))`,
    );
    for (const d of done) await this.release(d.lot_id, 'lot_closed');
  }

  async release(lotId: number, reason: string, t: Queryable = this.db) {
    const d = await t.maybe('SELECT * FROM seller_deposits WHERE lot_id=$1', [lotId]);
    if (!d || d.status !== 'held') return false;
    if (d.gateway_order_id) await this.gw.reverse(d.gateway_order_id).catch(() => false);
    await t.q(`UPDATE seller_deposits SET status='released', reason=$2, updated_at=$3 WHERE lot_id=$1`, [lotId, reason, this.clock.now()]);
    await this.audit.log(null, 'seller_deposit.released', 'lot', lotId, null, { reason }, t);
    return true;
  }

  /**
   * Удержать часть или весь взнос продавца. Из удержанного seller_forfeit_buyer_bp — победителю (если есть)
   * или поровну участникам, остаток — платформе (выплаты фиксируются в payouts).
   */
  async forfeit(lotId: number, bp: number, reason: string, winnerId: number | null, t: Queryable) {
    const d = await t.maybe('SELECT * FROM seller_deposits WHERE lot_id=$1', [lotId]);
    if (!d || d.status !== 'held') return null;
    const s = await this.settings.all(t);
    const charged = Math.floor((Number(d.amount) * bp) / 10_000);
    if (d.gateway_order_id) {
      const ok = await this.gw.deposit(d.gateway_order_id, charged);
      if (!ok) {
        await this.notify.alarmAdmins('Seller deposit charge failed', `lot ${lotId}`, `sd_charge:${lotId}`);
        return null;
      }
    }
    const now = this.clock.now();
    await t.q(`UPDATE seller_deposits SET status='charged', charged_amount=$2, reason=$3, updated_at=$4 WHERE lot_id=$1`, [lotId, charged, reason, now]);
    const toBuyers = Math.floor((charged * Number(s.seller_forfeit_buyer_bp ?? 0)) / 10_000);
    const recipients = winnerId
      ? [winnerId]
      : (await t.q<{ user_id: number }>(`SELECT DISTINCT user_id FROM deposits WHERE lot_id=$1 AND status <> 'failed'`, [lotId])).map((r) => Number(r.user_id));
    const each = recipients.length ? Math.floor(toBuyers / recipients.length) : 0;
    for (const uid of recipients) {
      await t.q(`INSERT INTO payouts(lot_id, seller_lot_id, recipient, user_id, amount, reason, created_at) VALUES ($1,$1,'buyer',$2,$3,'seller_forfeit_compensation',$4)`, [lotId, uid, each, now]);
      await this.notify.queue(uid, 'email', 'seller_forfeit_compensation', { lotId, amount: fmtAmd(each) }, { dedupeKey: `sd_comp:${lotId}:${uid}` }, t);
    }
    await t.q(`INSERT INTO payouts(lot_id, seller_lot_id, recipient, user_id, amount, reason, created_at) VALUES ($1,$1,'platform',NULL,$2,'seller_forfeit',$3)`, [lotId, charged - each * recipients.length, now]);
    await this.audit.log(null, 'seller_deposit.charged', 'lot', lotId, null, { charged, bp, reason, recipients: recipients.length }, t);
    return { charged, perRecipient: each, recipients: recipients.length };
  }
}
