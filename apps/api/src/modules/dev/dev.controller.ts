import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Db } from '../../common/db';
import { Clock } from '../../common/clock';
import { fail } from '../../common/errors';
import { totp } from '../../common/totp';
import { FakeGateway } from '../../adapters/gateway';
import { KycService } from '../kyc/kyc.service';
import { NotifyService, notificationBody } from '../notifications/notify.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { Audit } from '../../common/audit';

const devOnly = () => {
  if (process.env.DEV_TOOLS !== 'true' && process.env.NODE_ENV !== 'test') fail('NOT_FOUND', 404);
};

/**
 * Песочницы внешних сервисов (банк ArCa, KYC) и инструменты тестировщика.
 * Работают только при DEV_TOOLS=true. В бою их нет.
 */
@Controller()
export class DevController {
  constructor(private db: Db, private clock: Clock, private gw: FakeGateway, private kyc: KycService, private notify: NotifyService, private scheduler: SchedulerService, private audit: Audit) {}

  // ---- песочница банка (страница оплаты/привязки) ----
  @Get('sandbox/bank/:orderId')
  async bankOrder(@Param('orderId') id: string) {
    devOnly();
    const o = await this.gw.getOrderStatus(id);
    if (!o) fail('ORDER_NOT_FOUND', 404);
    return { orderId: o!.orderId, amount: o!.amount, status: o!.status, returnUrl: o!.returnUrl };
  }
  @Post('sandbox/bank/:orderId')
  bankSubmit(@Param('orderId') id: string, @Body() b: any) {
    devOnly();
    const v = z.object({ pan: z.string(), holderName: z.string().optional(), pass3ds: z.boolean().default(true) }).parse(b);
    const o = this.gw.submitCardForm(id, v.pan, v.holderName, v.pass3ds);
    if (!o) fail('ORDER_NOT_FOUND', 404);
    return { status: o!.status, returnUrl: `${o!.returnUrl}?orderId=${id}` };
  }

  // ---- песочница KYC ----
  @Post('sandbox/kyc/complete')
  kycComplete(@Body() b: any) {
    devOnly();
    const v = z
      .object({
        sessionId: z.string(),
        decision: z.enum(['approved', 'rejected', 'manual']),
        fullName: z.string().optional(),
        birthDate: z.string().optional(),
        docNumber: z.string().optional(),
        reason: z.string().optional(),
      })
      .parse(b);
    return this.kyc.handleResult(v);
  }

  // ---- инструменты ----
  @Get('dev/outbox')
  async outbox(@Query('to') to?: string) {
    devOnly();
    const rows = await this.db.q(
      `SELECT n.id, n.channel, n.to_addr, n.template, n.subject, n.body, n.sealed, n.status, n.last_error, n.created_at, u.full_name FROM notifications n LEFT JOIN users u ON u.id=n.user_id
       WHERE ($1::text IS NULL OR n.to_addr ILIKE $1) ORDER BY n.id DESC LIMIT 200`,
      [to ? `%${to}%` : null],
    );
    return rows.map((r) => ({ ...r, body: notificationBody(r) }));
  }
  @Get('dev/totp')
  async totpCodes() {
    devOnly();
    const staff = await this.db.q(`SELECT username, role, totp_secret FROM users WHERE role IN ('moderator','admin') AND totp_secret IS NOT NULL`);
    return { serverTime: this.clock.now(), staff: staff.map((s) => ({ username: s.username, role: s.role, secret: s.totp_secret, code: totp(s.totp_secret, this.clock.ms()) })) };
  }
  @Post('dev/tick')
  async tick() {
    devOnly();
    await this.scheduler.tick();
    return { ok: true, serverTime: this.clock.now() };
  }
  /** Сдвинуть время лота относительно «сейчас» — чтобы не ждать неделю. Отмечается в журнале. */
  @Post('dev/lots/:id/times')
  async shift(@Param('id', ParseIntPipe) id: number, @Body() b: any) {
    devOnly();
    const v = z.object({ opensInSec: z.number().optional(), closesInSec: z.number() }).parse(b);
    const now = this.clock.ms();
    const lot = await this.db.maybe(`SELECT status, opens_at FROM lots WHERE id=$1`, [id]);
    if (!lot || !['scheduled', 'live'].includes(lot.status)) fail('LOT_NOT_ACTIVE');
    const opens = v.opensInSec !== undefined ? new Date(now + v.opensInSec * 1000) : new Date(Math.min(new Date(lot.opens_at).getTime(), now));
    const closes = new Date(now + v.closesInSec * 1000);
    await this.db.q(`UPDATE lots SET opens_at=$2::timestamptz, closes_at=$3::timestamptz, status=CASE WHEN $2::timestamptz <= $4::timestamptz THEN 'live' ELSE 'scheduled' END WHERE id=$1`, [id, opens, closes, new Date(now)]);
    await this.audit.log(null, 'dev.lot_times_shifted', 'lot', id, null, { opens, closes });
    return { ok: true, opensAt: opens, closesAt: closes };
  }
  /** «Машина времени» для проверки сроков (48 ч, напоминания). Сдвигает часы всего сервера. */
  @Post('dev/clock')
  clock_(@Body() b: any, @Req() _r: Request) {
    devOnly();
    const v = z.object({ advanceHours: z.number().optional(), reset: z.boolean().optional() }).parse(b);
    if (v.reset) this.clock.reset();
    else if (v.advanceHours) this.clock.advance(v.advanceHours * 3600_000);
    return { serverTime: this.clock.now(), offsetHours: this.clock.getOffset() / 3600_000 };
  }
}
