import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { CardsService } from './cards.service';
import { PlansService } from '../plans/plans.service';
import { KycService } from '../kyc/kyc.service';
import { Db } from '../../common/db';
import { fail } from '../../common/errors';
import { hmac } from '../../common/hash';

const stepUp = (req: Request) => (req.headers['x-step-up'] as string | undefined) || undefined;

@Controller()
export class AccountController {
  constructor(private db: Db, private auth: AuthService, private cards: CardsService, private plans: PlansService, private kyc: KycService) {}

  @Get('cards')
  async list(@Req() req: Request) {
    return this.cards.list((await this.auth.user(req)).id);
  }
  @Post('cards/bind')
  async bind(@Req() req: Request) {
    return this.cards.startBind(await this.auth.user(req), stepUp(req));
  }
  @Post('cards/bind/complete')
  async complete(@Body() b: any, @Req() req: Request) {
    return this.cards.completeBind(await this.auth.user(req), z.object({ orderId: z.string() }).parse(b).orderId);
  }
  @Delete('cards/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.cards.remove(await this.auth.user(req), id, stepUp(req));
  }

  @Post('subscriptions')
  async buy(@Body() b: any, @Req() req: Request) {
    const v = z.object({ plan: z.string(), cardId: z.number().optional() }).parse(b);
    return this.plans.buy(await this.auth.user(req), v.plan, v.cardId, stepUp(req));
  }
  @Post('subscriptions/upgrade')
  async upgrade(@Body() b: any, @Req() req: Request) {
    const v = z.object({ plan: z.string().default('full'), cardId: z.number().optional() }).parse(b);
    return this.plans.upgrade(await this.auth.user(req), v.plan, v.cardId, stepUp(req));
  }

  @Post('kyc/session')
  async kycStart(@Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    if (!u.email_verified_at) fail('EMAIL_REQUIRED', 403);
    return this.kyc.start(u, !!b?.acceptBiometrics);
  }
  /** Вебхук KYC-сервиса: подпись HMAC в заголовке X-Signature. */
  @Post('kyc/webhook')
  async kycWebhook(@Body() b: any, @Req() req: Request) {
    const sig = String(req.headers['x-signature'] || '');
    const good = hmac(process.env.KYC_WEBHOOK_SECRET || 'kyc-dev-secret', JSON.stringify(b));
    if (sig !== good) fail('BAD_SIGNATURE', 401);
    return this.kyc.handleResult(b);
  }
  @Post('payments/webhook')
  async paymentsWebhook(@Body() b: any, @Req() req: Request) {
    // 6.6: подпись уведомлений шлюза проверяется; статус всё равно запрашивается у шлюза отдельно
    const sig = String(req.headers['x-signature'] || '');
    const good = hmac(process.env.GATEWAY_WEBHOOK_SECRET || 'gw-dev-secret', JSON.stringify(b));
    if (sig !== good) fail('BAD_SIGNATURE', 401);
    void this.db;
    return { ok: true };
  }
}
