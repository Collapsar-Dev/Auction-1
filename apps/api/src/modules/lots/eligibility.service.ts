import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { Clock } from '../../common/clock';
import { AppError } from '../../common/errors';
import { SettingsService } from '../../common/settings';
import { PlansService } from '../plans/plans.service';
import { User } from '../auth/auth.service';

export interface LotLite {
  id: number;
  seller_id: number;
  start_price: number;
  status: string;
}

export type Step = { key: 'login' | 'email' | 'kyc' | 'subscription' | 'deposit'; done: boolean; data?: Record<string, unknown> };

/**
 * Допуск к участию: R-13 (email, личность, доступ, депозит), R-14 (свой лот), R-18 (тариф),
 * R-19…R-22 (лимиты), активные блокировки 6A.3. Всё проверяется до блокировки депозита и до приёма ставки.
 */
@Injectable()
export class EligibilityService {
  constructor(private db: Db, private clock: Clock, private settings: SettingsService, private plans: PlansService) {}

  async activeSanction(user: Pick<User, 'id' | 'doc_hash'>, t: Queryable = this.db) {
    return t.maybe<{ id: number; kind: string; ends_at: Date | null; reason: string }>(
      `SELECT id, kind, ends_at, reason FROM sanctions
       WHERE (user_id=$1 OR ($2::text IS NOT NULL AND doc_hash=$2)) AND voided_at IS NULL AND starts_at <= $3 AND (ends_at IS NULL OR ends_at > $3)
       ORDER BY ends_at DESC NULLS FIRST LIMIT 1`,
      [user.id, user.doc_hash, this.clock.now()],
    );
  }

  async limitsOf(userId: number, t: Queryable = this.db) {
    const s = await this.settings.all(t);
    const row = await t.maybe<{ tier: string; max_active_bids: number; max_open_deals: number; buying_power: number | null; valid_until: Date | null }>(
      'SELECT * FROM buyer_limits WHERE user_id=$1',
      [userId],
    );
    if (row && row.tier === 'investor' && row.valid_until && new Date(row.valid_until).getTime() > this.clock.ms()) {
      return { tier: 'investor', maxActiveBids: row.max_active_bids, maxOpenDeals: row.max_open_deals, buyingPower: row.buying_power, validUntil: row.valid_until };
    }
    return { tier: 'standard', maxActiveBids: s.standard_max_active_bids, maxOpenDeals: s.standard_max_open_deals, buyingPower: null as number | null, validUntil: null };
  }

  /** Лоты со ставкой без итога и открытые сделки (R-19, R-20). Сумма ставки для этого не нужна (R-22). */
  async exposure(userId: number, exceptLotId: number | null, t: Queryable = this.db) {
    const activeBids = await t.q<{ lot_id: number; start_price: number }>(
      `SELECT b.lot_id, l.start_price FROM bids b JOIN lots l ON l.id=b.lot_id WHERE b.user_id=$1 AND l.status IN ('scheduled','live','revealing') AND l.id <> $2`,
      [userId, exceptLotId ?? 0],
    );
    const openDeals = await t.q<{ lot_id: number; amount: number }>(
      `SELECT lot_id, amount FROM deals WHERE winner_user_id=$1 AND status IN ('awaiting_confirm','confirmed','extract_uploaded')`,
      [userId],
    );
    return { activeBids, openDeals };
  }

  /** Бросает ошибку с понятным кодом, если лимиты не позволяют участвовать в этом лоте. */
  async checkLimits(user: User, lot: LotLite, t: Queryable = this.db) {
    const lim = await this.limitsOf(user.id, t);
    const ex = await this.exposure(user.id, lot.id, t);
    const lots = [...ex.activeBids.map((b) => b.lot_id), ...ex.openDeals.map((d) => d.lot_id)];
    if (ex.openDeals.length >= lim.maxOpenDeals) throw new AppError('LIMIT_OPEN_DEALS', 403, { lots: ex.openDeals.map((d) => d.lot_id), limit: lim.maxOpenDeals });
    if (ex.activeBids.length + ex.openDeals.length >= lim.maxActiveBids) throw new AppError('LIMIT_ACTIVE_BIDS', 403, { lots, limit: lim.maxActiveBids });
    if (lim.tier === 'investor' && lim.buyingPower !== null) {
      const used = ex.activeBids.reduce((a, b) => a + b.start_price, 0) + ex.openDeals.reduce((a, d) => a + d.amount, 0);
      if (used + lot.start_price > lim.buyingPower) throw new AppError('LIMIT_BUYING_POWER', 403, { lots, buyingPower: lim.buyingPower, used });
    }
  }

  /** Шаги для блока ставки (3.3) — выполненные отмечаются галочкой. */
  async steps(user: User | null, lot: LotLite & { deposit_amount: number }): Promise<Step[]> {
    const suggested = await this.plans.suggestFor(lot.start_price);
    if (!user) {
      return [
        { key: 'login', done: false },
        { key: 'email', done: false },
        { key: 'kyc', done: false },
        { key: 'subscription', done: false, data: { plan: suggested?.code } },
        { key: 'deposit', done: false, data: { amount: lot.deposit_amount } },
      ];
    }
    const sub = await this.plans.coveringFor(user.id, lot.start_price);
    const dep = await this.db.maybe(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2 AND status IN ('pending','held')`, [lot.id, user.id]);
    return [
      { key: 'login', done: true },
      { key: 'email', done: !!user.email_verified_at },
      { key: 'kyc', done: user.kyc_status === 'verified' },
      { key: 'subscription', done: !!sub, data: { plan: suggested?.code, has: sub?.plan_code ?? null } },
      { key: 'deposit', done: dep?.status === 'held', data: { amount: lot.deposit_amount, status: dep?.status ?? null } },
    ];
  }

  /** Общая проверка для депозита и ставки. */
  async assertCanParticipate(user: User, lot: LotLite, t: Queryable, opts: { needDeposit: boolean }) {
    if (lot.seller_id === user.id) throw new AppError('OWN_LOT', 403);
    if (!user.email_verified_at) throw new AppError('EMAIL_REQUIRED', 403);
    if (user.kyc_status !== 'verified') throw new AppError('KYC_REQUIRED', 403);
    const sanction = await this.activeSanction(user, t);
    if (sanction) throw new AppError(sanction.kind === 'funds_request' ? 'FUNDS_PROOF_REQUESTED' : 'BIDDING_BLOCKED', 403, { until: sanction.ends_at, kind: sanction.kind });
    const sub = await this.plans.coveringFor(user.id, lot.start_price, t);
    if (!sub) {
      const p = await this.plans.suggestFor(lot.start_price);
      throw new AppError('SUBSCRIPTION_REQUIRED', 403, { suggestedPlan: p?.code ?? null });
    }
    await this.checkLimits(user, lot, t);
    if (opts.needDeposit) {
      const dep = await t.maybe(`SELECT id FROM deposits WHERE lot_id=$1 AND user_id=$2 AND status='held'`, [lot.id, user.id]);
      if (!dep) throw new AppError('DEPOSIT_REQUIRED', 403);
    }
    return sub;
  }
}
