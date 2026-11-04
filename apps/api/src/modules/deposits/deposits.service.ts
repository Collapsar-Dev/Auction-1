import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import { Db, Queryable } from '../../common/db';
import { Clock, HOUR } from '../../common/clock';
import { fail } from '../../common/errors';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { FakeGateway } from '../../adapters/gateway';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { PlansService } from '../plans/plans.service';
import { EligibilityService } from '../lots/eligibility.service';
import { fmtAmd } from '../../common/format';
import { RiskService } from '../risk/risk.service';

/** 6.3 Жизнь депозита (SC-07). Блокировка суммы без списания. */
@Injectable()
export class DepositsService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private gw: FakeGateway,
    private auth: AuthService,
    private notify: NotifyService,
    private elig: EligibilityService,
    private risk: RiskService,
    private plans: PlansService,
  ) {}

  async place(user: User, lotId: number, cardId: number | undefined, stepUp: string | undefined, fp: { ua: string; ip: string }) {
    const now = this.clock.now();
    const prep = await this.db.tx(async (t) => {
      const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 FOR SHARE`, [lotId]);
      if (!lot) fail('LOT_NOT_FOUND', 404);
      // можно заранее, пока лот «Скоро»
      if (!['scheduled', 'live'].includes(lot.status) || now.getTime() >= new Date(lot.closes_at).getTime()) fail('LOT_NOT_OPEN_FOR_DEPOSIT');
      // PRD v2 решение 11: регистрация открывается в свою дату; во время торгов — если продавец разрешил
      if (lot.registration_opens_at && now.getTime() < new Date(lot.registration_opens_at).getTime()) fail('REGISTRATION_NOT_OPEN', 409, { opensAt: lot.registration_opens_at });
      if (!lot.allow_late_registration && now.getTime() >= new Date(lot.opens_at).getTime()) fail('REGISTRATION_CLOSED', 409);
      await this.elig.assertCanParticipate(user, lot, t, { needDeposit: false });
      const ex = await t.maybe(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2 AND status IN ('pending','held','releasing','disputed')`, [lotId, user.id]);
      if (ex) fail('DEPOSIT_EXISTS');
      const card = await t.maybe<{ id: number; binding_id: string; mask: string }>(
        `SELECT id, binding_id, mask FROM cards WHERE user_id=$1 AND status='active' ${cardId ? 'AND id=$2' : ''} ORDER BY id LIMIT 1`,
        cardId ? [user.id, cardId] : [user.id],
      );
      if (!card) fail('CARD_REQUIRED');
      await this.auth.consumeStepUp(user, 'deposit', stepUp, t);
      const d = await t.one(`INSERT INTO deposits(lot_id, user_id, card_id, amount, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'pending',$5,$5) RETURNING id`, [
        lotId,
        user.id,
        card!.id,
        lot.deposit_amount,
        now,
      ]);
      // PRD v2: «Участвовать» = 1 попытка тарифа (повторно за тот же лот не списывается)
      await this.plans.spend(user, lot, t);
      return { depositId: d.id as number, card: card!, amount: lot.deposit_amount as number };
    });
    await this.risk.recordFingerprint(user.id, fp.ua, fp.ip);
    const s = await this.settings.all();
    const order = await this.gw.holdByBinding(prep.card.binding_id, prep.amount, `deposit:${prep.depositId}`, s.hold_days, now);
    const st = await this.gw.getOrderStatus(order.orderId); // проверяем статус у шлюза сами
    if (!st || st.status !== 'approved') {
      await this.db.tx(async (t) => {
        await t.q(`UPDATE deposits SET status='failed', gateway_order_id=$2, fail_reason='BANK_DECLINED', updated_at=$3 WHERE id=$1`, [prep.depositId, order.orderId, this.clock.now()]);
        await this.plans.refund(user.id, lotId, 'BANK_DECLINED', null, t); // банк отказал — попытка не сгорает
      });
      fail('DEPOSIT_DECLINED', 402, { canChooseAnotherCard: true });
    }
    await this.db.q(`UPDATE deposits SET status='held', gateway_order_id=$2, hold_expires_at=$3, updated_at=$4 WHERE id=$1`, [prep.depositId, order.orderId, st!.holdExpiresAt, this.clock.now()]);
    await this.audit.log(user.id, 'deposit.held', 'deposit', prep.depositId, null, { lotId, amount: prep.amount });
    await this.notify.queue(user.id, 'email', 'deposit_held', { lotId, amount: fmtAmd(prep.amount), mask: prep.card.mask });
    return { id: prep.depositId, status: 'held', amount: prep.amount, holdExpiresAt: st!.holdExpiresAt };
  }

  /** Освобождение: отмена блокировки в шлюзе, повторы до успеха (статус releasing). */
  async processReleases() {
    const rows = await this.db.q<{ id: number; lot_id: number; user_id: number; amount: number; gateway_order_id: string | null }>(
      `SELECT id, lot_id, user_id, amount, gateway_order_id FROM deposits WHERE status='releasing' ORDER BY id LIMIT 200`,
    );
    for (const d of rows) {
      const ok = d.gateway_order_id ? await this.gw.reverse(d.gateway_order_id).catch(() => false) : true;
      if (!ok) continue;
      const upd = await this.db.q(`UPDATE deposits SET status='released', updated_at=$2 WHERE id=$1 AND status='releasing' RETURNING id`, [d.id, this.clock.now()]);
      if (upd.length && d.gateway_order_id) {
        await this.notify.queue(d.user_id, 'email', 'deposit_released', { lotId: d.lot_id, amount: fmtAmd(d.amount) }, { dedupeKey: `dep_rel:${d.id}` });
      }
    }
    return rows.length;
  }

  async markReleasing(where: string, params: unknown[], t: Queryable) {
    await t.q(`UPDATE deposits SET status='releasing', updated_at=$${params.length + 1} WHERE ${where}`, [...params, this.clock.now()]);
  }

  /** Раз в час: до истечения блокировки < 72 ч, а депозит ещё нужен → новая блокировка, потом отмена старой. */
  async renewHolds() {
    const s = await this.settings.all();
    const rows = await this.db.q<{ id: number; gateway_order_id: string; amount: number; binding_id: string }>(
      `SELECT d.id, d.gateway_order_id, d.amount, c.binding_id FROM deposits d JOIN cards c ON c.id=d.card_id
       WHERE d.status IN ('held','disputed') AND d.hold_expires_at < $1`,
      [new Date(this.clock.ms() + s.hold_renew_hours * HOUR)],
    );
    for (const d of rows) {
      const o = await this.gw.holdByBinding(d.binding_id, d.amount, `renew:${d.id}:${crypto.randomUUID()}`, s.hold_days, this.clock.now());
      if (o.status !== 'approved') {
        await this.notify.alarmAdmins('Hold renewal failed', `deposit ${d.id}`, `renew_fail:${d.id}:${this.clock.now().toISOString().slice(0, 10)}`);
        continue;
      }
      await this.gw.reverse(d.gateway_order_id);
      await this.db.q('UPDATE deposits SET gateway_order_id=$2, hold_expires_at=$3, updated_at=$4 WHERE id=$1', [d.id, o.orderId, o.holdExpiresAt, this.clock.now()]);
      await this.audit.log(null, 'deposit.renewed', 'deposit', d.id);
    }
    return rows.length;
  }

  /** Решение администратора по спорному депозиту (SC-16, Q-01). */
  async decideDisputed(admin: User, depositId: number, action: 'release' | 'charge', reason: string) {
    if (!reason) fail('REASON_REQUIRED');
    const d = await this.db.maybe(`SELECT * FROM deposits WHERE id=$1`, [depositId]);
    if (!d || d.status !== 'disputed') fail('DEPOSIT_NOT_DISPUTED');
    if (action === 'release') {
      await this.db.q(`UPDATE deposits SET status='releasing', updated_at=$2 WHERE id=$1`, [depositId, this.clock.now()]);
      await this.processReleases();
    } else {
      const ok = await this.gw.deposit(d.gateway_order_id);
      if (!ok) fail('CHARGE_FAILED', 402);
      await this.db.q(`UPDATE deposits SET status='charged', updated_at=$2 WHERE id=$1`, [depositId, this.clock.now()]);
    }
    await this.audit.log(admin.id, 'deposit.' + action, 'deposit', depositId, { status: 'disputed' }, { reason });
    return { ok: true };
  }

  mine(userId: number) {
    return this.db.q(
      `SELECT d.id, d.lot_id, d.amount, d.status, d.hold_expires_at, d.created_at, c.mask FROM deposits d LEFT JOIN cards c ON c.id=d.card_id WHERE d.user_id=$1 ORDER BY d.id DESC`,
      [userId],
    );
  }
}
