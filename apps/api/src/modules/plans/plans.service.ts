import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { Audit } from '../../common/audit';
import { FakeGateway } from '../../adapters/gateway';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { fmtAmd, fmtYerevan } from '../../common/format';

export interface Plan {
  id: number;
  code: string;
  name_i18n: Record<string, string>;
  price: number;
  duration_days: number;
  max_start_price: number | null;
  is_active: boolean;
}
export interface Subscription {
  id: number;
  user_id: number;
  plan_id: number;
  plan_code: string;
  name_i18n: Record<string, string>;
  price_paid: number;
  max_start_price: number | null;
  starts_at: Date;
  ends_at: Date;
  source: string;
}

export const covers = (maxStart: number | null, startPrice: number) => maxStart === null || maxStart >= startPrice;

/** 6.5 Годовой доступ к участию (SC-21, R-18). */
@Injectable()
export class PlansService {
  constructor(private db: Db, private clock: Clock, private gw: FakeGateway, private auth: AuthService, private audit: Audit, private notify: NotifyService) {}

  plans(onlyActive = true) {
    return this.db.q<Plan>(`SELECT * FROM plans ${onlyActive ? 'WHERE is_active' : ''} ORDER BY price`);
  }

  /** Действующие доступы: starts_at ≤ сейчас < ends_at. */
  async active(userId: number, t: Queryable = this.db, at = this.clock.now()) {
    return t.q<Subscription>(
      `SELECT s.*, p.code AS plan_code, p.name_i18n FROM subscriptions s JOIN plans p ON p.id=s.plan_id
       WHERE s.user_id=$1 AND s.status='active' AND s.starts_at <= $2 AND s.ends_at > $2 ORDER BY s.ends_at DESC`,
      [userId, at],
    );
  }
  async all(userId: number) {
    return this.db.q<Subscription>(
      `SELECT s.*, p.code AS plan_code, p.name_i18n FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.starts_at DESC`,
      [userId],
    );
  }
  /** Подходящий действующий доступ для лота с такой начальной ценой (R-18). */
  async coveringFor(userId: number, startPrice: number, t: Queryable = this.db) {
    return (await this.active(userId, t)).find((s) => covers(s.max_start_price, startPrice)) ?? null;
  }
  /** Самый дешёвый активный тариф, покрывающий лот — его сайт подсказывает сразу. */
  async suggestFor(startPrice: number) {
    return (await this.plans()).find((p) => covers(p.max_start_price, startPrice)) ?? null;
  }

  private async charge(user: User, cardId: number | undefined, amount: number, kind: 'subscription' | 'upgrade', t: Queryable) {
    const card = await t.maybe<{ id: number; binding_id: string }>(
      `SELECT id, binding_id FROM cards WHERE user_id=$1 AND status='active' ${cardId ? 'AND id=$2' : ''} ORDER BY id LIMIT 1`,
      cardId ? [user.id, cardId] : [user.id],
    );
    if (!card) fail('CARD_REQUIRED');
    const key = `${kind}:${user.id}:${crypto.randomUUID()}`;
    const pay = await t.one<{ id: number }>(`INSERT INTO payments(kind, user_id, amount, idempotency_key, status, created_at) VALUES ($1,$2,$3,$4,'pending',$5) RETURNING id`, [
      kind,
      user.id,
      amount,
      key,
      this.clock.now(),
    ]);
    const order = await this.gw.payByBinding(card!.binding_id, amount, key);
    // доступ активируется только после того, как сервер сам проверил статус оплаты в шлюзе
    const st = await this.gw.getOrderStatus(order.orderId);
    if (!st || st.status !== 'deposited') {
      await t.q(`UPDATE payments SET status='failed', gateway_order_id=$2 WHERE id=$1`, [pay.id, order.orderId]);
      return { ok: false as const, paymentId: pay.id };
    }
    const receipt = 'R-' + pay.id.toString().padStart(6, '0');
    await t.q(`UPDATE payments SET status='paid', gateway_order_id=$2, receipt_no=$3 WHERE id=$1`, [pay.id, order.orderId, receipt]);
    return { ok: true as const, paymentId: pay.id, receipt };
  }

  /** Покупка или продление (новые 365 дней начинаются после окончания текущего доступа того же тарифа). */
  async buy(user: User, planCode: string, cardId: number | undefined, stepUp: string | undefined) {
    const plan = await this.db.maybe<Plan>('SELECT * FROM plans WHERE code=$1 AND is_active', [planCode]);
    if (!plan) fail('PLAN_NOT_FOUND', 404);
    const result = await this.db.tx(async (t) => {
      await this.auth.consumeStepUp(user, 'subscription', stepUp, t);
      await t.q('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      const now = this.clock.now();
      const same = await t.maybe<{ ends_at: Date }>(
        `SELECT ends_at FROM subscriptions WHERE user_id=$1 AND plan_id=$2 AND status='active' AND ends_at > $3 ORDER BY ends_at DESC LIMIT 1`,
        [user.id, plan!.id, now],
      );
      const pay = await this.charge(user, cardId, plan!.price, 'subscription', t);
      if (!pay.ok) return pay;
      const starts = same ? new Date(same.ends_at) : now;
      const ends = new Date(starts.getTime() + plan!.duration_days * DAY);
      const sub = await t.one(
        `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, payment_id, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8) RETURNING *`,
        [user.id, plan!.id, plan!.price, plan!.max_start_price, starts, ends, pay.paymentId, now],
      );
      return { ...pay, sub, renewal: !!same };
    });
    if (!result.ok) fail('PAYMENT_DECLINED');
    const r = result as any;
    await this.audit.log(user.id, 'subscription.bought', 'subscription', r.sub.id, null, { plan: planCode, renewal: r.renewal });
    await this.notify.queue(user.id, 'email', 'subscription_paid', { plan: plan!.name_i18n[user.lang] ?? plan!.code, endsAt: fmtYerevan(r.sub.ends_at), amount: fmtAmd(plan!.price), receiptNo: r.receipt });
    return { subscription: r.sub, receiptNo: r.receipt, renewal: r.renewal };
  }

  /** Повышение Базовый → Полный: доплата разницы цен на момент повышения, срок не меняется. */
  async upgrade(user: User, toCode: string, cardId: number | undefined, stepUp: string | undefined) {
    const to = await this.db.maybe<Plan>('SELECT * FROM plans WHERE code=$1 AND is_active', [toCode]);
    if (!to) fail('PLAN_NOT_FOUND', 404);
    const result = await this.db.tx(async (t) => {
      await this.auth.consumeStepUp(user, 'subscription', stepUp, t);
      const cur = (await this.active(user.id, t)).find((s) => s.plan_id !== to!.id);
      if (!cur) fail('NOTHING_TO_UPGRADE');
      const from = await t.one<Plan>('SELECT * FROM plans WHERE id=$1', [cur!.plan_id]);
      if (to!.price <= from.price) fail('NOT_AN_UPGRADE');
      const diff = to!.price - from.price;
      const pay = await this.charge(user, cardId, diff, 'upgrade', t);
      if (!pay.ok) return pay;
      const now = this.clock.now();
      await t.q(`UPDATE subscriptions SET status='upgraded' WHERE id=$1`, [cur!.id]);
      const sub = await t.one(
        `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, payment_id, source, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8) RETURNING *`,
        [user.id, to!.id, diff, to!.max_start_price, now, cur!.ends_at, pay.paymentId, now],
      );
      return { ...pay, sub, diff };
    });
    if (!result.ok) fail('PAYMENT_DECLINED');
    const r = result as any;
    await this.audit.log(user.id, 'subscription.upgraded', 'subscription', r.sub.id, null, { to: toCode, paid: r.diff });
    await this.notify.queue(user.id, 'email', 'subscription_paid', { plan: to!.name_i18n[user.lang] ?? to!.code, endsAt: fmtYerevan(r.sub.ends_at), amount: fmtAmd(r.diff), receiptNo: r.receipt });
    return { subscription: r.sub, paid: r.diff, receiptNo: r.receipt };
  }

  /** 6.5.8: во время пилота администратор выдаёт доступ бесплатно (с причиной в журнале). */
  async grant(adminId: number, userId: number, planCode: string, reason: string, days?: number) {
    if (!reason) fail('REASON_REQUIRED');
    const plan = await this.db.maybe<Plan>('SELECT * FROM plans WHERE code=$1', [planCode]);
    if (!plan) fail('PLAN_NOT_FOUND', 404);
    const now = this.clock.now();
    const sub = await this.db.one(
      `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, source, grant_reason, created_at)
       VALUES ($1,$2,0,$3,$4,$5,'admin_grant',$6,$4) RETURNING *`,
      [userId, plan!.id, plan!.max_start_price, now, new Date(now.getTime() + (days ?? plan!.duration_days) * DAY), reason],
    );
    await this.audit.log(adminId, 'subscription.granted', 'subscription', sub.id, null, { userId, plan: planCode, reason });
    return sub;
  }
}
