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
  /** PRD v2: сколько участий даёт тариф; null = без лимита */
  participation_limit: number | null;
  sees_valuation_amount: boolean;
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
  participation_limit: number | null;
  participations_used: number;
}

export const covers = (maxStart: number | null, startPrice: number) => maxStart === null || maxStart >= startPrice;
/** Сколько попыток осталось; null = без лимита */
export const participationsLeft = (s: Pick<Subscription, 'participation_limit' | 'participations_used'>) =>
  s.participation_limit === null || s.participation_limit === undefined ? null : Math.max(0, s.participation_limit - s.participations_used);
const hasLeft = (s: Subscription) => { const l = participationsLeft(s); return l === null || l > 0; };

const CREDIT_TEXT: Record<string, Record<string, string>> = {
  refunded: { ru: 'Попытка возвращена', en: 'Participation returned', hy: 'Մասնակցության փորձը վերադարձվեց' },
  granted: { ru: 'Начислена попытка участия', en: 'Participation added', hy: 'Ավելացվեց մասնակցության փորձ' },
};

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
  /** Попытка, уже списанная за этот лот и не возвращённая (повторно не списывается). */
  async spentFor(userId: number, lotId: number, t: Queryable = this.db) {
    return t.maybe<{ subscription_id: number }>(
      `SELECT subscription_id FROM participation_credits WHERE user_id=$1 AND lot_id=$2
       GROUP BY subscription_id HAVING sum(CASE type WHEN 'spent' THEN 1 WHEN 'refunded' THEN -1 ELSE 0 END) > 0 LIMIT 1`,
      [userId, lotId],
    );
  }

  /**
   * Подходящий действующий доступ для лота (R-18 по цене + PRD v2 по числу участий).
   * Если за этот лот попытка уже списана — тот же доступ, даже если попыток больше нет.
   */
  async coveringFor(userId: number, startPrice: number, t: Queryable = this.db, lotId?: number) {
    const subs = (await this.active(userId, t)).filter((s) => covers(s.max_start_price, startPrice));
    if (lotId) {
      const spent = await this.spentFor(userId, lotId, t);
      if (spent) return subs.find((s) => s.id === spent.subscription_id) ?? null;
    }
    return subs.find(hasLeft) ?? null;
  }
  /** Есть доступ по цене, но попытки кончились — для понятной ошибки. */
  async exhaustedFor(userId: number, startPrice: number, t: Queryable = this.db) {
    return (await this.active(userId, t)).some((s) => covers(s.max_start_price, startPrice) && !hasLeft(s));
  }

  /** PRD v2: «Участвовать» = 1 попытка. Вызывается внутри транзакции регистрации на лот. */
  async spend(user: User, lot: { id: number; start_price: number }, t: Queryable) {
    if (await this.spentFor(user.id, lot.id, t)) return null; // уже участвует
    const sub = await this.coveringFor(user.id, lot.start_price, t);
    if (!sub) fail('SUBSCRIPTION_REQUIRED', 403);
    const locked = await t.one<Subscription>('SELECT * FROM subscriptions WHERE id=$1 FOR UPDATE', [sub!.id]);
    if (!hasLeft(locked)) fail('PARTICIPATIONS_EXHAUSTED', 403);
    await t.q('UPDATE subscriptions SET participations_used = participations_used + 1 WHERE id=$1', [sub!.id]);
    await t.q(`INSERT INTO participation_credits(subscription_id, user_id, lot_id, type, created_at) VALUES ($1,$2,$3,'spent',$4)`, [sub!.id, user.id, lot.id, this.clock.now()]);
    await this.audit.log(user.id, 'participation.spent', 'subscription', sub!.id, null, { lotId: lot.id }, t);
    return sub;
  }

  /** Вернуть попытку за лот (отмена лота, отказ банка, решение модератора) + pop-up пользователю. */
  async refund(userId: number, lotId: number, reason: string, actorId: number | null, t: Queryable) {
    const spent = await this.spentFor(userId, lotId, t);
    if (!spent) return false;
    await t.q('UPDATE subscriptions SET participations_used = GREATEST(participations_used - 1, 0) WHERE id=$1', [spent.subscription_id]);
    await t.q(`INSERT INTO participation_credits(subscription_id, user_id, lot_id, type, reason, actor_id, created_at) VALUES ($1,$2,$3,'refunded',$4,$5,$6)`, [
      spent.subscription_id, userId, lotId, reason, actorId, this.clock.now(),
    ]);
    await this.audit.log(actorId, 'participation.refunded', 'subscription', spent.subscription_id, null, { userId, lotId, reason }, t);
    await this.popup(userId, 'refunded', { lotId, reason }, t);
    return true;
  }

  /** Модератор начисляет попытку без привязки к лоту (с причиной в журнале). */
  async grantCredit(admin: User, userId: number, reason: string, lotId?: number) {
    if (!reason) fail('REASON_REQUIRED');
    return this.db.tx(async (t) => {
      if (lotId && (await this.refund(userId, lotId, reason, admin.id, t))) return { refunded: true };
      const sub = (await this.active(userId, t)).find((s) => s.participation_limit !== null);
      if (!sub) fail('NO_LIMITED_SUBSCRIPTION');
      await t.q('UPDATE subscriptions SET participations_used = participations_used - 1 WHERE id=$1', [sub!.id]);
      await t.q(`INSERT INTO participation_credits(subscription_id, user_id, lot_id, type, reason, actor_id, created_at) VALUES ($1,$2,$3,'granted',$4,$5,$6)`, [
        sub!.id, userId, lotId ?? null, reason, admin.id, this.clock.now(),
      ]);
      await this.audit.log(admin.id, 'participation.granted', 'subscription', sub!.id, null, { userId, lotId, reason }, t);
      await this.popup(userId, 'granted', { lotId, reason }, t);
      return { granted: true };
    });
  }

  /** История попыток для «Мой тариф» (F3.2). */
  credits(userId: number) {
    return this.db.q(
      `SELECT c.id, c.lot_id, c.type, c.reason, c.created_at, s.plan_id FROM participation_credits c JOIN subscriptions s ON s.id=c.subscription_id
       WHERE c.user_id=$1 ORDER BY c.id DESC LIMIT 200`,
      [userId],
    );
  }

  /** Pop-up в кабинете: уведомление inapp, непрочитанное, пока пользователь его не закроет. */
  private async popup(userId: number, kind: 'refunded' | 'granted', p: { lotId?: number; reason: string }, t: Queryable) {
    const u = await t.maybe<{ lang: string }>('SELECT lang FROM users WHERE id=$1', [userId]);
    const lang = u?.lang ?? 'hy';
    const subs = await this.active(userId, t);
    const left = subs.map(participationsLeft).find((x) => x !== null);
    const title = CREDIT_TEXT[kind][lang] ?? CREDIT_TEXT[kind].ru;
    const body = `${title}${p.lotId ? ` · #${p.lotId}` : ''}${p.reason ? ` — ${p.reason}` : ''}${left !== undefined && left !== null ? ` · ${left}` : ''}`;
    await t.q(
      `INSERT INTO notifications(user_id, channel, template, lang, subject, body, payload, status, sent_at, created_at) VALUES ($1,'inapp',$2,$3,$4,$5,$6,'sent',$7,$7)`,
      [userId, 'participation_' + kind, lang, title, body, JSON.stringify({ ...p, left: left ?? null }), this.clock.now()],
    );
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
        `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, payment_id, source, created_at, participation_limit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9) RETURNING *`,
        [user.id, plan!.id, plan!.price, plan!.max_start_price, starts, ends, pay.paymentId, now, plan!.participation_limit],
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
        `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, payment_id, source, created_at, participation_limit, participations_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10) RETURNING *`,
        [user.id, to!.id, diff, to!.max_start_price, now, cur!.ends_at, pay.paymentId, now, to!.participation_limit, cur!.participations_used],
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
      `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, source, grant_reason, created_at, participation_limit)
       VALUES ($1,$2,0,$3,$4,$5,'admin_grant',$6,$4,$7) RETURNING *`,
      [userId, plan!.id, plan!.max_start_price, now, new Date(now.getTime() + (days ?? plan!.duration_days) * DAY), reason, plan!.participation_limit],
    );
    await this.audit.log(adminId, 'subscription.granted', 'subscription', sub.id, null, { userId, plan: planCode, reason });
    return sub;
  }
}
