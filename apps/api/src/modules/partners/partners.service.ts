import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { fail } from '../../common/errors';
import { Audit } from '../../common/audit';
import { SettingsService } from '../../common/settings';
import { Storage } from '../../adapters/storage';
import { User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';

type File = { buffer: Buffer; mimetype: string };
const KINDS = ['notary', 'insurance', 'appraisal', 'lawyer'] as const;
const SLOTS = ['catalog', 'lot', 'partners'] as const;

/** PRD v2 решения 13–14 (F10, F11.4): партнёры, заявки на услуги, реклама. */
@Injectable()
export class PartnersService {
  constructor(private db: Db, private clock: Clock, private audit: Audit, private settings: SettingsService, private storage: Storage, private notify: NotifyService) {}

  private publicFields(p: any) {
    return { id: p.id, kind: p.kind, name: p.name, city: p.city, description: p.description, price_from: p.price_from, licensed: p.status === 'active', verified_at: p.verified_at };
  }

  // ---------- Справочник ----------
  async list(kind?: string) {
    const rows = await this.db.q(`SELECT * FROM partners WHERE status='active' ${kind ? 'AND kind=$1' : ''} ORDER BY name`, kind ? [kind] : []);
    return rows.map((p) => this.publicFields(p));
  }

  // ---------- Кабинет партнёра ----------
  async apply(user: User, body: any, file?: File) {
    if (user.kyc_status !== 'verified') fail('KYC_REQUIRED', 403);
    const v = z
      .object({ kind: z.enum(KINDS), name: z.string().trim().min(2).max(200), city: z.string().trim().min(2).max(100), description: z.string().max(2000).default(''), price_from: z.string().max(100).optional(), license_no: z.string().trim().min(2).max(100) })
      .parse(body ?? {});
    if (!file) fail('LICENSE_REQUIRED');
    if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file!.mimetype)) fail('FILE_TYPE');
    const ex = await this.db.maybe<{ id: number; status: string }>('SELECT id, status FROM partners WHERE user_id=$1', [user.id]);
    if (ex && ex.status !== 'rejected') fail('PARTNER_EXISTS', 409);
    const key = this.storage.put(file!.buffer, file!.mimetype === 'application/pdf' ? 'pdf' : file!.mimetype.split('/')[1], true);
    const now = this.clock.now();
    const p = ex
      ? await this.db.one(`UPDATE partners SET kind=$2, name=$3, city=$4, description=$5, price_from=$6, license_no=$7, license_key=$8, status='pending', reject_reason=NULL WHERE id=$1 RETURNING *`, [ex.id, v.kind, v.name, v.city, v.description, v.price_from ?? null, v.license_no, key])
      : await this.db.one(`INSERT INTO partners(user_id, kind, name, city, description, price_from, license_no, license_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [user.id, v.kind, v.name, v.city, v.description, v.price_from ?? null, v.license_no, key, now]);
    await this.audit.log(user.id, 'partner.applied', 'partner', p.id, null, { kind: v.kind });
    return { id: p.id, status: p.status };
  }

  async mine(user: User) {
    const p = await this.db.maybe('SELECT * FROM partners WHERE user_id=$1', [user.id]);
    if (!p) return { partner: null };
    const requests = await this.db.q(
      `SELECT r.id, r.service, r.comment, r.status, r.reply, r.lot_id, r.created_at, u.full_name AS client_name, u.email AS client_email, u.phone AS client_phone
       FROM service_requests r JOIN users u ON u.id=r.user_id WHERE r.partner_id=$1 ORDER BY r.id DESC LIMIT 200`,
      [p.id],
    );
    const ads = await this.db.q(`SELECT id, slot, title, url, starts_on, ends_on, price, status, reject_reason, impressions, clicks FROM ad_requests WHERE partner_id=$1 ORDER BY id DESC`, [p.id]);
    return { partner: { ...this.publicFields(p), status: p.status, reject_reason: p.reject_reason, license_no: p.license_no }, requests, ads };
  }
  private async myActive(user: User) {
    const p = await this.db.maybe('SELECT * FROM partners WHERE user_id=$1', [user.id]);
    if (!p || p.status !== 'active') fail('PARTNER_NOT_ACTIVE', 403);
    return p;
  }

  // ---------- Заявки на услуги ----------
  async request(user: User, partnerId: number, body: any) {
    const v = z.object({ service: z.string().trim().min(2).max(100), comment: z.string().max(2000).default(''), lotId: z.number().int().positive().optional() }).parse(body ?? {});
    const p = await this.db.maybe('SELECT * FROM partners WHERE id=$1', [partnerId]);
    if (!p || p.status !== 'active') fail('PARTNER_NOT_FOUND', 404);
    if (p.user_id === user.id) fail('OWN_PARTNER', 400);
    const now = this.clock.now();
    const r = await this.db.one(`INSERT INTO service_requests(partner_id, user_id, lot_id, service, comment, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id, status`, [
      partnerId,
      user.id,
      v.lotId ?? null,
      v.service,
      v.comment,
      now,
    ]);
    await this.notify.queue(p.user_id, 'email', 'partner_request_new', { id: r.id, service: v.service, comment: v.comment.slice(0, 500) }, { dedupeKey: `sr_new:${r.id}` });
    await this.audit.log(user.id, 'service_request.created', 'service_request', r.id, null, { partnerId, service: v.service });
    return r;
  }
  myRequests(user: User) {
    return this.db.q(
      `SELECT r.id, r.service, r.comment, r.status, r.reply, r.lot_id, r.created_at, r.updated_at, p.name AS partner_name, p.kind AS partner_kind
       FROM service_requests r JOIN partners p ON p.id=r.partner_id WHERE r.user_id=$1 ORDER BY r.id DESC`,
      [user.id],
    );
  }
  async answer(user: User, requestId: number, body: any) {
    const p = await this.myActive(user);
    const v = z.object({ status: z.enum(['accepted', 'rejected', 'done']), reply: z.string().max(2000).optional() }).parse(body ?? {});
    if (v.status === 'rejected' && !(v.reply ?? '').trim()) fail('REASON_REQUIRED');
    const r = await this.db.maybe('SELECT * FROM service_requests WHERE id=$1 AND partner_id=$2', [requestId, p.id]);
    if (!r) fail('NOT_FOUND', 404);
    await this.db.q('UPDATE service_requests SET status=$2, reply=$3, updated_at=$4 WHERE id=$1', [requestId, v.status, v.reply ?? null, this.clock.now()]);
    await this.notify.queue(r.user_id, 'email', 'partner_request_answer', { id: requestId, partner: p.name, status: v.status, reply: v.reply ?? '' }, { dedupeKey: `sr_ans:${requestId}:${v.status}` });
    await this.audit.log(user.id, 'service_request.' + v.status, 'service_request', requestId);
    return { ok: true };
  }

  // ---------- Реклама ----------
  async adPrice(slot: string, starts: string, ends: string) {
    const s: any = await this.settings.all();
    const perMonth = Number(s['ad_price_' + slot] ?? 0);
    const days = Math.round((new Date(ends + 'T00:00:00Z').getTime() - new Date(starts + 'T00:00:00Z').getTime()) / DAY) + 1;
    return Math.ceil((perMonth * days) / 30);
  }
  async submitAd(user: User, body: any, file?: File) {
    const p = await this.myActive(user);
    const v = z
      .object({ slot: z.enum(SLOTS), title: z.string().trim().min(2).max(120), url: z.string().url().max(500).refine((u) => /^https?:\/\//.test(u)), starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
      .parse(body ?? {});
    if (v.ends_on < v.starts_on) fail('DATES_INVALID');
    if (!file) fail('CREATIVE_REQUIRED');
    // требования к креативу проверяет модератор (качество, содержание); здесь — формат и размер
    if (!/^image\/(jpeg|png|webp)$/.test(file!.mimetype)) fail('FILE_TYPE');
    if (file!.buffer.length > 500 * 1024) fail('FILE_TOO_LARGE', 400, { maxKb: 500 });
    const key = this.storage.put(file!.buffer, file!.mimetype.split('/')[1].replace('jpeg', 'jpg'), false);
    const price = await this.adPrice(v.slot, v.starts_on, v.ends_on);
    const a = await this.db.one(`INSERT INTO ad_requests(partner_id, slot, title, url, creative_key, starts_on, ends_on, price, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status, price`, [
      p.id,
      v.slot,
      v.title,
      v.url,
      key,
      v.starts_on,
      v.ends_on,
      price,
      this.clock.now(),
    ]);
    await this.audit.log(user.id, 'ad.submitted', 'ad', a.id, null, { slot: v.slot, price });
    return a;
  }
  /** Активная реклама для места показа; каждый ответ — +1 показ. */
  async adsFor(slot: string) {
    const today = this.clock.now().toISOString().slice(0, 10);
    const rows = await this.db.q(
      `UPDATE ad_requests a SET impressions=impressions+1 FROM partners p
       WHERE p.id=a.partner_id AND p.status='active' AND a.slot=$1 AND a.status='approved' AND a.starts_on <= $2 AND a.ends_on >= $2
       RETURNING a.id, a.title, a.creative_key, p.name AS partner_name`,
      [slot, today],
    );
    return rows.map((r) => ({ id: r.id, title: r.title, partner: r.partner_name, image: this.storage.publicUrl(r.creative_key), href: `/api/ads/${r.id}/click` }));
  }
  async click(id: number) {
    const r = await this.db.maybe<{ url: string }>(`UPDATE ad_requests SET clicks=clicks+1 WHERE id=$1 AND status='approved' RETURNING url`, [id]);
    if (!r) fail('NOT_FOUND', 404);
    return r!.url;
  }

  // ---------- Модерация (F11.4) ----------
  async adminPartners() {
    const now = this.clock.now();
    const rows = await this.db.q(`SELECT p.*, u.full_name AS owner_name, u.kyc_status FROM partners p JOIN users u ON u.id=p.user_id ORDER BY (p.status='pending') DESC, p.id DESC`);
    return rows.map((p) => ({ ...p, license_url: this.storage.signedUrl(p.license_key, now), license_key: undefined }));
  }
  async decidePartner(staff: User, id: number, body: any) {
    const v = z.object({ action: z.enum(['approve', 'reject', 'block']), reason: z.string().max(500).optional() }).parse(body ?? {});
    if (v.action !== 'approve' && !(v.reason ?? '').trim()) fail('REASON_REQUIRED');
    const p = await this.db.maybe('SELECT * FROM partners WHERE id=$1', [id]);
    if (!p) fail('NOT_FOUND', 404);
    const status = v.action === 'approve' ? 'active' : v.action === 'reject' ? 'rejected' : 'blocked';
    await this.db.q('UPDATE partners SET status=$2, reject_reason=$3, verified_by=$4, verified_at=$5 WHERE id=$1', [id, status, v.reason ?? null, staff.id, this.clock.now()]);
    await this.notify.queue(p.user_id, 'email', 'partner_decision', { name: p.name, status, reason: v.reason ?? '' });
    await this.audit.log(staff.id, 'partner.' + v.action, 'partner', id, { status: p.status }, { status, reason: v.reason });
    return { ok: true, status };
  }
  async adminAds() {
    const rows = await this.db.q(`SELECT a.*, p.name AS partner_name FROM ad_requests a JOIN partners p ON p.id=a.partner_id ORDER BY (a.status='pending') DESC, a.id DESC`);
    return rows.map((a) => ({ ...a, image: this.storage.publicUrl(a.creative_key), creative_key: undefined }));
  }
  async decideAd(staff: User, id: number, body: any) {
    const v = z.object({ action: z.enum(['approve', 'reject', 'stop']), reason: z.string().max(500).optional(), price: z.number().int().nonnegative().optional() }).parse(body ?? {});
    if (v.action !== 'approve' && !(v.reason ?? '').trim()) fail('REASON_REQUIRED');
    const a = await this.db.maybe('SELECT a.*, p.user_id FROM ad_requests a JOIN partners p ON p.id=a.partner_id WHERE a.id=$1', [id]);
    if (!a) fail('NOT_FOUND', 404);
    const status = v.action === 'approve' ? 'approved' : v.action === 'reject' ? 'rejected' : 'stopped';
    await this.db.q('UPDATE ad_requests SET status=$2, reject_reason=$3, decided_by=$4, decided_at=$5, price=coalesce($6, price) WHERE id=$1', [id, status, v.reason ?? null, staff.id, this.clock.now(), v.price ?? null]);
    await this.notify.queue(a.user_id, 'email', 'ad_decision', { id, title: a.title, status, reason: v.reason ?? '' });
    await this.audit.log(staff.id, 'ad.' + v.action, 'ad', id, { status: a.status }, { status, reason: v.reason, price: v.price });
    return { ok: true, status };
  }
}
