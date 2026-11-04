import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { Db } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { randomToken } from '../../common/hash';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { Storage } from '../../adapters/storage';
import { AuthService } from '../auth/auth.service';
import { NotifyService, notificationBody } from '../notifications/notify.service';
import { PlansService } from '../plans/plans.service';
import { EligibilityService } from '../lots/eligibility.service';
import { DepositsService } from '../deposits/deposits.service';
import { BidsService } from '../bids/bids.service';
import { LotsService } from '../lots/lots.service';
import { DealsService } from '../deals/deals.service';

@Controller('me')
export class MeController {
  constructor(
    private db: Db,
    private clock: Clock,
    private auth: AuthService,
    private notify: NotifyService,
    private plans: PlansService,
    private elig: EligibilityService,
    private deposits: DepositsService,
    private bids: BidsService,
    private lots: LotsService,
    private deals: DealsService,
    private storage: Storage,
    private settings: SettingsService,
    private audit: Audit,
  ) {}

  @Get()
  async me(@Req() req: Request) {
    const u = await this.auth.user(req, { allowNoConsent: true });
    const needsConsents = u.session_kind === 'user' ? await this.auth.missingConsents(u.id) : [];
    const limits = await this.elig.limitsOf(u.id);
    const exposure = await this.elig.exposure(u.id, null);
    const sanction = await this.elig.activeSanction(u);
    return {
      id: u.id,
      phone: u.phone,
      email: u.email,
      emailVerified: !!u.email_verified_at,
      lang: u.lang,
      kycStatus: u.kyc_status,
      kycRejectReason: u.kyc_reject_reason,
      level: u.kyc_status === 'verified' && u.email_verified_at ? 2 : u.email_verified_at ? 1 : 0,
      fullName: u.full_name,
      role: u.role,
      staff: u.session_kind === 'staff',
      username: u.username,
      sellerBlocked: u.seller_blocked,
      sellerBlockReason: u.seller_block_reason,
      needsConsents,
      consentVersions: await this.settings.get('consent_versions'),
      limits,
      exposure: { activeBids: exposure.activeBids.map((b) => b.lot_id), openDeals: exposure.openDeals.map((d) => d.lot_id) },
      sanction,
      phoneChangedAt: u.phone_changed_at,
    };
  }

  @Post('consents')
  async consents(@Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req, { allowNoConsent: true });
    const { kinds } = z.object({ kinds: z.array(z.string()).min(1) }).parse(b);
    await this.auth.accept(u.id, kinds);
    return { ok: true, needsConsents: await this.auth.missingConsents(u.id) };
  }

  @Put('profile')
  async profile(@Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    const v = z.object({ email: z.string().email().max(200).optional(), lang: z.enum(['hy', 'ru', 'en']).optional() }).parse(b);
    if (v.lang) await this.db.q('UPDATE users SET lang=$2 WHERE id=$1', [u.id, v.lang]);
    let devLink: string | undefined;
    if (v.email && v.email.toLowerCase() !== (u.email || '').toLowerCase()) {
      const token = randomToken(24);
      await this.db.q('UPDATE users SET email=$2, email_verified_at=NULL, email_token=$3 WHERE id=$1', [u.id, v.email.toLowerCase(), token]);
      const web = process.env.WEB_URL || 'http://localhost:3000';
      const link = `${web}/verify-email?token=${token}`;
      await this.notify.queue(u.id, 'email', 'email_verify', { link }, { toAddr: v.email.toLowerCase(), lang: v.lang ?? u.lang });
      if (this.auth.devCodes()) devLink = link;
    }
    return { ok: true, ...(devLink ? { devLink } : {}) };
  }

  @Post('verify-email')
  async verifyEmail(@Body() b: any) {
    const { token } = z.object({ token: z.string().min(10) }).parse(b);
    const r = await this.db.q('UPDATE users SET email_verified_at=$2, email_token=NULL, kyc_level=GREATEST(kyc_level,1) WHERE email_token=$1 RETURNING id', [token, this.clock.now()]);
    if (!r.length) fail('TOKEN_INVALID');
    return { ok: true };
  }

  @Post('phone/start')
  async phoneStart(@Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    return this.auth.phoneChangeStart(u, z.object({ phone: z.string() }).parse(b).phone, req.ip || '');
  }
  @Post('phone/confirm')
  async phoneConfirm(@Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    const v = z.object({ phone: z.string(), codeOld: z.string(), codeNew: z.string() }).parse(b);
    return this.auth.phoneChangeConfirm(u, v.phone, v.codeOld, v.codeNew);
  }

  @Get('subscription')
  async subscription(@Req() req: Request) {
    const u = await this.auth.user(req);
    return { active: await this.plans.active(u.id), history: await this.plans.all(u.id) };
  }

  @Get('bids')
  async myBids(@Req() req: Request) {
    return this.bids.allMine(await this.auth.user(req));
  }
  @Get('lots')
  async myLots(@Req() req: Request) {
    return this.lots.myLots((await this.auth.user(req)).id);
  }
  @Get('deposits')
  async myDeposits(@Req() req: Request) {
    return this.deposits.mine((await this.auth.user(req)).id);
  }
  @Get('deals')
  async myDeals(@Req() req: Request) {
    return this.deals.mine(await this.auth.user(req));
  }
  @Get('payments')
  async payments(@Req() req: Request) {
    const u = await this.auth.user(req);
    return this.db.q('SELECT id, kind, lot_id, amount, status, attempts, receipt_no, created_at FROM payments WHERE user_id=$1 ORDER BY id DESC', [u.id]);
  }
  @Post('payments/:id/pay')
  async payCommission(@Param('id', ParseIntPipe) id: number, @Body() b: any, @Req() req: Request) {
    const u = await this.auth.user(req);
    return this.deals.payCommission(u, id, b?.cardId);
  }

  @Get('favorites')
  async favorites(@Req() req: Request) {
    const u = await this.auth.user(req);
    return this.db.q(
      `SELECT l.id, l.status, l.start_price, l.opens_at, l.closes_at, p.property_type, p.settlement, p.street FROM favorites f JOIN lots l ON l.id=f.lot_id JOIN properties p ON p.id=l.property_id WHERE f.user_id=$1 ORDER BY f.created_at DESC`,
      [u.id],
    );
  }
  @Put('favorites/:lotId')
  async addFav(@Param('lotId', ParseIntPipe) lotId: number, @Req() req: Request) {
    const u = await this.auth.user(req);
    await this.db.q('INSERT INTO favorites(user_id, lot_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [u.id, lotId]);
    return { ok: true };
  }
  @Delete('favorites/:lotId')
  async delFav(@Param('lotId', ParseIntPipe) lotId: number, @Req() req: Request) {
    const u = await this.auth.user(req);
    await this.db.q('DELETE FROM favorites WHERE user_id=$1 AND lot_id=$2', [u.id, lotId]);
    return { ok: true };
  }

  @Get('notifications')
  async notifications(@Req() req: Request) {
    const u = await this.auth.user(req);
    const rows = await this.db.q('SELECT id, channel, template, subject, body, sealed, status, created_at FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [u.id]);
    return rows.map((r) => ({ ...r, body: notificationBody(r), sealed: undefined }));
  }

  /** Pop-up в кабинете (PRD v2: возврат попытки и т. п.) — непрочитанные inapp-уведомления. */
  @Get('popups')
  async popups(@Req() req: Request) {
    const u = await this.auth.user(req);
    return this.db.q(`SELECT id, template, subject, body, payload, created_at FROM notifications WHERE user_id=$1 AND channel='inapp' AND read_at IS NULL ORDER BY id`, [u.id]);
  }
  @Post('popups/:id/read')
  async popupRead(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const u = await this.auth.user(req);
    await this.db.q(`UPDATE notifications SET read_at=$3 WHERE id=$1 AND user_id=$2 AND channel='inapp'`, [id, u.id, this.clock.now()]);
    return { ok: true };
  }

  // SC-23 Статус «Инвестор»
  @Post('funds-proof')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async fundsProof(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    const u = await this.auth.user(req);
    if (!file) fail('FILE_REQUIRED');
    if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.mimetype)) fail('FILE_TYPE');
    const keep = await this.settings.get('funds_proof_keep_days');
    const key = this.storage.put(file.buffer, file.mimetype === 'application/pdf' ? 'pdf' : file.mimetype.split('/')[1], true);
    const now = this.clock.now();
    const r = await this.db.one(`INSERT INTO funds_proofs(user_id, storage_key, delete_after, created_at) VALUES ($1,$2,$3,$4) RETURNING id, status`, [u.id, key, new Date(now.getTime() + keep * DAY), now]);
    await this.audit.log(u.id, 'funds_proof.uploaded', 'funds_proof', r.id);
    return r;
  }
  @Get('funds-proofs')
  async myProofs(@Req() req: Request) {
    const u = await this.auth.user(req);
    return this.db.q('SELECT id, status, comment, decided_at, created_at FROM funds_proofs WHERE user_id=$1 ORDER BY id DESC', [u.id]);
  }

  @Get('disputes')
  async myDisputes(@Req() req: Request, @Query('lotId') lotId?: string) {
    const u = await this.auth.user(req);
    return this.db.q('SELECT * FROM disputes WHERE user_id=$1 AND ($2::bigint IS NULL OR lot_id=$2) ORDER BY id DESC', [u.id, lotId ? Number(lotId) : null]);
  }
}
