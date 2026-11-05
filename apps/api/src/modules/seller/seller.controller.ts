import { Body, Controller, Get, Param, ParseIntPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AuthService } from '../auth/auth.service';
import { Db } from '../../common/db';
import { SellerService } from './seller.service';

const stepUp = (req: Request) => (req.headers['x-step-up'] as string | undefined) || undefined;

/** PRD v2 решения 16–17 (F3.3, F8.2): тарифы продавца и его взносы. */
@Controller()
export class SellerController {
  constructor(private auth: AuthService, private seller: SellerService, private db: Db) {}

  @Get('seller/plans')
  plans() {
    return this.seller.plans();
  }
  @Get('me/seller')
  async mine(@Req() req: Request) {
    const u = await this.auth.user(req);
    const deposits = await this.db.q(`SELECT lot_id, amount, status, charged_amount, reason, updated_at FROM seller_deposits WHERE user_id=$1 ORDER BY updated_at DESC`, [u.id]);
    return { ...(await this.seller.mine(u)), deposits };
  }
  @Post('seller/subscriptions')
  async buy(@Body() b: any, @Req() req: Request) {
    const v = z.object({ plan: z.string(), cardId: z.number().int().optional() }).parse(b);
    return this.seller.buy(await this.auth.user(req), v.plan, v.cardId, stepUp(req));
  }
  /** Сколько составит взнос продавца для лота (для мастера и карточки). */
  @Get('lots/:id/seller-deposit')
  async deposit(@Param('id', ParseIntPipe) id: number) {
    return (await this.db.maybe(`SELECT amount, status, charged_amount FROM seller_deposits WHERE lot_id=$1`, [id])) ?? { status: 'none' };
  }
}
