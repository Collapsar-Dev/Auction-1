import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { AdminService } from './admin.service';
import { LotsService } from '../lots/lots.service';
import { DealsService } from '../deals/deals.service';
import { DepositsService } from '../deposits/deposits.service';
import { RiskService } from '../risk/risk.service';
import { PlansService } from '../plans/plans.service';
import { SchedulerService } from '../scheduler/scheduler.service';

/** /admin/* — модератор и администратор (AU-05: вход по паролю + TOTP, сессия 8 ч, всё в журнал). */
@Controller('admin')
export class AdminController {
  constructor(
    private auth: AuthService,
    private admin: AdminService,
    private lots: LotsService,
    private deals: DealsService,
    private deposits: DepositsService,
    private risk: RiskService,
    private plans: PlansService,
    private scheduler: SchedulerService,
  ) {}

  @Get('overview')
  async overview(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.overview();
  }

  // Модерация (SC-05)
  @Get('lots')
  async lotsList(@Req() r: Request, @Query('status') status?: string) {
    await this.auth.staff(r);
    return this.admin.lots(status);
  }
  @Get('lots/:id')
  async lot(@Param('id', ParseIntPipe) id: number, @Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.lot(id);
  }
  @Post('lots/:id/moderate')
  async moderate(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r);
    const v = z
      .object({ decision: z.enum(['approve', 'return', 'reject']), comment: z.string().max(2000).optional().default(''), checklist: z.record(z.string(), z.boolean()).optional().default({}) })
      .parse(b);
    return this.lots.moderate(s, id, v.decision, v.comment, v.checklist);
  }
  @Post('lots/:id/withdraw')
  async withdraw(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    return this.lots.withdraw(s, id, z.object({ reason: z.string().min(3) }).parse(b).reason, true);
  }
  @Post('lots/:id/invalidate')
  async invalidate(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    return this.admin.invalidateLot(s, id, z.object({ reason: z.string().min(3) }).parse(b).reason);
  }

  // Пользователи
  @Get('users')
  async users(@Req() r: Request, @Query('q') q?: string) {
    await this.auth.staff(r);
    return this.admin.users(q);
  }
  @Get('users/:id')
  async user(@Param('id', ParseIntPipe) id: number, @Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.user(id);
  }
  @Post('users/:id/status')
  async userStatus(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    const v = z.object({ status: z.enum(['active', 'blocked']), reason: z.string() }).parse(b);
    return this.admin.setUserStatus(s, id, v.status, v.reason);
  }
  @Post('users/:id/seller-unblock')
  async sellerUnblock(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    return this.admin.sellerUnblock(s, id, String(b?.reason || ''));
  }
  @Post('users/:id/kyc')
  async kyc(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r);
    return this.admin.kycManual(s, id, b);
  }
  /** PRD v2 решение 5: модератор возвращает попытку за лот или начисляет попытку (с причиной). */
  @Post('users/:id/participations')
  async participation(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r);
    const v = z.object({ reason: z.string().min(3).max(500), lotId: z.number().int().positive().optional() }).parse(b ?? {});
    return this.plans.grantCredit(s, id, v.reason, v.lotId);
  }

  @Post('users/:id/grant-access')
  async grant(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    const v = z.object({ plan: z.string(), reason: z.string().min(3), days: z.number().int().positive().optional() }).parse(b);
    return this.plans.grant(s.id, id, v.plan, v.reason, v.days);
  }

  // Депозиты и сделки
  @Get('deposits')
  async deps(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.deposits_();
  }
  @Post('deposits/:id/decide')
  async decide(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    const v = z.object({ action: z.enum(['release', 'charge']), reason: z.string().min(3) }).parse(b);
    return this.deposits.decideDisputed(s, id, v.action, v.reason);
  }
  @Get('deals')
  async dealsList(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.deals();
  }
  @Post('deals/:lotId/sold')
  async sold(@Param('lotId', ParseIntPipe) id: number, @Req() r: Request) {
    return this.deals.markSold(await this.auth.staff(r, 'admin'), id);
  }

  // Настройки, тарифы, журнал, уведомления
  @Get('settings')
  async settings(@Req() r: Request) {
    await this.auth.staff(r, 'admin');
    return this.admin.settingsAll();
  }
  @Put('settings/:key')
  async setSetting(@Param('key') key: string, @Body() b: any, @Req() r: Request) {
    return this.admin.settingsSet(await this.auth.staff(r, 'admin'), key, b?.value);
  }
  @Get('plans')
  async plansList(@Req() r: Request) {
    await this.auth.staff(r, 'admin');
    return this.admin.plans();
  }
  @Put('plans/:id')
  async planUpdate(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    return this.admin.planUpdate(await this.auth.staff(r, 'admin'), id, b);
  }
  @Get('audit')
  async audit(@Req() r: Request) {
    await this.auth.staff(r, 'admin');
    return this.admin.audit_();
  }
  @Get('notifications')
  async notifications(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.notifications();
  }

  // Риски (6A)
  @Get('risk')
  async riskList(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.risk();
  }
  @Post('risk/:id/action')
  async riskAct(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r);
    const v = z
      .object({ action: z.enum(['clear', 'request_funds', 'set_limit', 'block', 'to_lawyer']), comment: z.string().min(1), buyingPower: z.number().optional(), days: z.number().optional() })
      .parse(b);
    return this.risk.act(s, id, v);
  }
  @Get('funds-proofs')
  async proofs(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.fundsProofs();
  }
  @Post('funds-proofs/:id/decide')
  async proofDecide(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r);
    const v = z.object({ approve: z.boolean(), buyingPower: z.number().optional(), days: z.number().optional(), comment: z.string().optional() }).parse(b);
    return this.risk.decideFundsProof(s, id, v);
  }
  @Get('sanctions')
  async sanctions(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.sanctions();
  }
  @Post('sanctions/:id/void')
  async voidSanction(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    return this.risk.voidSanction(await this.auth.staff(r, 'admin'), id, String(b?.comment || ''));
  }

  // Споры (SC-19) и сбои (SC-18)
  @Get('disputes')
  async disputes(@Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.disputes();
  }
  @Get('disputes/:id/verify')
  async verify(@Param('id', ParseIntPipe) id: number, @Req() r: Request) {
    await this.auth.staff(r);
    return this.admin.verifyDispute(id);
  }
  @Post('disputes/:id/reply')
  async reply(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    return this.admin.replyDispute(await this.auth.staff(r), id, String(b?.reply || ''));
  }
  @Get('outages')
  async outages(@Req() r: Request) {
    await this.auth.staff(r, 'admin');
    return this.admin.outages();
  }
  @Post('outages')
  async outageCreate(@Body() b: any, @Req() r: Request) {
    const s = await this.auth.staff(r, 'admin');
    const v = z.object({ startedAt: z.string(), endedAt: z.string() }).parse(b);
    return this.admin.createOutage(s, v.startedAt, v.endedAt, (a, e, id) => this.scheduler.recordOutage(a, e, id));
  }
  @Post('outages/:id/decide')
  async outageDecide(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() r: Request) {
    return this.admin.applyOutage(await this.auth.staff(r, 'admin'), id, !!b?.apply);
  }
}
