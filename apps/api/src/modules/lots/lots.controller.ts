import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { Db } from '../../common/db';
import { Clock, HOUR } from '../../common/clock';
import { fail } from '../../common/errors';
import { SettingsService } from '../../common/settings';
import { AuthService } from '../auth/auth.service';
import { LotsService, REGIONS } from './lots.service';
import { DepositsService } from '../deposits/deposits.service';
import { BidsService } from '../bids/bids.service';
import { PlansService } from '../plans/plans.service';

const fp = (req: Request) => ({ ua: String(req.headers['user-agent'] || ''), ip: req.ip || '' });
const stepUp = (req: Request) => (req.headers['x-step-up'] as string | undefined) || undefined;

@Controller()
export class LotsController {
  constructor(
    private db: Db,
    private clock: Clock,
    private auth: AuthService,
    private lots: LotsService,
    private deposits: DepositsService,
    private bids: BidsService,
    private plans: PlansService,
    private settings: SettingsService,
  ) {}

  @Get('time')
  time() {
    return { serverTime: this.clock.now().toISOString() };
  }

  @Get('meta')
  async meta() {
    const s = await this.settings.all();
    return {
      regions: REGIONS,
      plans: await this.plans.plans(),
      rules: {
        min_start_price: s.min_start_price,
        duration_min_hours: s.duration_min_hours,
        duration_max_hours: s.duration_max_hours,
        start_delay_hours: s.start_delay_hours,
        deposit_bp: s.deposit_bp,
        deposit_min: s.deposit_min,
        deposit_max: s.deposit_max,
        commission_bp: s.commission_bp,
        commission_min: s.commission_min,
        deal_confirm_hours: s.deal_confirm_hours,
        notary_days: s.notary_days,
        photos_min: s.photos_min,
        photos_max: s.photos_max,
        standard_max_active_bids: s.standard_max_active_bids,
        standard_max_open_deals: s.standard_max_open_deals,
      },
      devTools: process.env.DEV_TOOLS === 'true',
    };
  }

  @Get('plans')
  plansList() {
    return this.plans.plans();
  }

  @Get('lots')
  catalog(@Query() q: Record<string, string>) {
    return this.lots.catalog(q);
  }

  @Get('lots/:id')
  async card(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.lots.card(id, await this.auth.optionalUser(req));
  }

  @Get('lots/:id/result')
  async result(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const r = await this.lots.result(id, await this.auth.optionalUser(req));
    if (!r) fail('RESULT_NOT_READY', 404);
    return r;
  }

  // ----- продавец -----
  @Post('lots')
  async create(@Req() req: Request) {
    return this.lots.createDraft(await this.auth.user(req));
  }
  @Get('lots/:id/draft')
  async draft(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.lots.draft(await this.auth.user(req), id);
  }
  @Patch('lots/:id')
  async save(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    const { step, data } = z.object({ step: z.number().int().min(1).max(5), data: z.any() }).parse(b);
    return this.lots.saveStep(await this.auth.user(req), id, step, data ?? {});
  }
  @Post('lots/:id/media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async media(@Param('id', ParseIntPipe) id: number, @Query('kind') kind: string, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) fail('FILE_REQUIRED');
    return this.lots.addMedia(await this.auth.user(req), id, kind === 'extract' ? 'extract' : 'photo', file);
  }
  @Delete('lots/:id/media/:mid')
  async delMedia(@Param('id', ParseIntPipe) id: number, @Param('mid', ParseIntPipe) mid: number, @Req() req: Request) {
    return this.lots.removeMedia(await this.auth.user(req), id, mid);
  }
  @Post('lots/:id/valuations')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async valuation(@Param('id', ParseIntPipe) id: number, @Body() b: any, @UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    return this.lots.addValuation(await this.auth.user(req), id, b ?? {}, file);
  }
  @Delete('lots/:id/valuations/:vid')
  async delValuation(@Param('id', ParseIntPipe) id: number, @Param('vid', ParseIntPipe) vid: number, @Req() req: Request) {
    return this.lots.removeValuation(await this.auth.user(req), id, vid);
  }
  @Post('lots/:id/submit')
  async submit(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.lots.submit(await this.auth.user(req), id, !!b?.acceptRules);
  }
  @Post('lots/:id/withdraw')
  async withdraw(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.lots.withdraw(await this.auth.user(req), id, String(b?.reason || ''), false);
  }
  @Post('lots/:id/relaunch')
  async relaunch(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.lots.relaunch(await this.auth.user(req), id);
  }

  // ----- участник -----
  @Post('lots/:id/deposit')
  async deposit(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    return this.deposits.place(await this.auth.user(req), id, b?.cardId ? Number(b.cardId) : undefined, stepUp(req), fp(req));
  }
  @Post('lots/:id/bids')
  async bid(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    const key = (req.headers['idempotency-key'] as string) || b?.idempotencyKey;
    return this.bids.place(await this.auth.user(req), id, { amount: b?.amount, idempotencyKey: key, acceptRules: !!b?.acceptRules }, stepUp(req), fp(req));
  }
  @Get('lots/:id/my-bids')
  async myBid(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return { bid: await this.bids.mine(await this.auth.user(req), id) };
  }

  /** SC-19: спор об итоге — в течение 48 ч. */
  @Post('lots/:id/disputes')
  async dispute(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    const v = z.object({ message: z.string().min(5).max(5000), receiptNo: z.string().max(100).optional(), commitment: z.string().max(100).optional() }).parse(b);
    const r = await this.db.maybe('SELECT revealed_at FROM lot_results WHERE lot_id=$1', [id]);
    if (!r) fail('RESULT_NOT_READY');
    const hours = await this.settings.get('dispute_hours');
    if (this.clock.ms() - new Date(r!.revealed_at).getTime() > hours * HOUR) fail('DISPUTE_WINDOW_CLOSED');
    const bid = await this.db.maybe('SELECT 1 FROM bids WHERE lot_id=$1 AND user_id=$2', [id, u.id]);
    if (!bid) fail('NOT_A_PARTICIPANT', 403);
    return this.db.one(`INSERT INTO disputes(lot_id, user_id, receipt_no, commitment, message, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`, [
      id,
      u.id,
      v.receiptNo ?? null,
      v.commitment ?? null,
      v.message,
      this.clock.now(),
    ]);
  }
}
