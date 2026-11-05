import { FakeCadastre } from '../../adapters/cadastre';
import { SellerService } from '../seller/seller.service';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY, HOUR } from '../../common/clock';
import { AppError, fail } from '../../common/errors';
import { SettingsService, commissionFor, depositFor, guaranteeFor } from '../../common/settings';
import { Audit } from '../../common/audit';
import { Storage } from '../../adapters/storage';
import { FakeKms, generateLotKeys } from '../../adapters/kms';
import { AuthService, User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { PlansService } from '../plans/plans.service';
import { EligibilityService } from './eligibility.service';
import { fmtYerevan } from '../../common/format';

export const REGIONS = ['Yerevan', 'Aragatsotn', 'Ararat', 'Armavir', 'Gegharkunik', 'Kotayk', 'Lori', 'Shirak', 'Syunik', 'Tavush', 'Vayots Dzor'];

const step1 = z.object({
  property_type: z.enum(['house', 'apartment']),
  region: z.enum(REGIONS as [string, ...string[]]),
  settlement: z.string().min(2).max(100),
  street: z.string().min(2).max(150),
  cadastral_no: z.string().regex(/^[0-9][0-9\-./]{5,30}$/, 'cadastral'),
  geo_lat: z.number().min(38.8).max(41.4).optional().nullable(),
  geo_lng: z.number().min(43.4).max(46.7).optional().nullable(),
});
const desc = z.object({ hy: z.string().max(5000).optional(), ru: z.string().max(5000).optional(), en: z.string().max(5000).optional() });
const step2Common = z.object({
  area_m2: z.number().positive().max(100000),
  rooms: z.number().int().min(1).max(50),
  bathrooms: z.number().int().min(0).max(20),
  year_built: z.number().int().min(1800).max(2100),
  heating: z.enum(['central', 'gas', 'electric', 'none', 'other']),
  condition: z.enum(['new', 'renovated', 'good', 'needs_repair', 'shell']),
  description_i18n: desc,
});
const step2House = step2Common.extend({
  land_area_m2: z.number().positive().max(10_000_000),
  floors: z.number().int().min(1).max(10),
  wall_material: z.enum(['stone', 'tuff', 'brick', 'concrete', 'wood', 'other']),
  gas: z.boolean(),
  water: z.boolean(),
  sewage: z.boolean(),
});
const step2Apt = step2Common.extend({
  floor: z.number().int().min(-2).max(100),
  building_floors: z.number().int().min(1).max(100),
  building_type: z.enum(['stone', 'panel', 'monolith', 'brick', 'other']),
  has_elevator: z.boolean(),
  has_balcony: z.boolean(),
  parking: z.boolean(),
});
const step4 = z.object({
  start_price: z.number().int(),
  opens_at: z.string().datetime({ offset: true }),
  closes_at: z.string().datetime({ offset: true }),
  // PRD v2 решение 11: отдельные даты показа и регистрации (необязательны)
  published_at: z.string().datetime({ offset: true }).nullish(),
  registration_opens_at: z.string().datetime({ offset: true }).nullish(),
  allow_late_registration: z.boolean().optional(),
  // PRD v2 решение 6: взнос участника в % (0–10, шаг 0,1); не передан — по умолчанию из настроек
  guarantee_percent: z.number().min(0).max(10).optional(),
  // PRD v2 (F9.3): страховка — есть полис / заказать у партнёра / без страховки
  insurance: z
    .object({ mode: z.enum(['have', 'order', 'none']), insurer: z.string().max(200).optional(), policy_no: z.string().max(100).optional(), valid_until: z.string().optional() })
    .optional(),
});

export const PHOTO_ROOMS = ['facade', 'living', 'kitchen', 'bedroom', 'bathroom', 'view', 'plan', 'yard', 'other'] as const;
export const DOC_TYPES = ['encumbrance', 'tech_passport', 'co_owner_consent', 'power_of_attorney', 'insurance_policy'] as const;

/** PRD v2 §2: статусы лота для покупателя и порядок в каталоге. */
export const STAGE_ORDER = ['in_progress', 'registration_open', 'upcoming', 'awaiting_contract', 'finished', 'no_sale', 'cancelled'] as const;
export type Stage = (typeof STAGE_ORDER)[number];

const PROPERTY_COLS = [
  'property_type', 'cadastral_no', 'region', 'settlement', 'street', 'geo_lat', 'geo_lng', 'area_m2', 'rooms', 'bathrooms', 'year_built', 'heating', 'condition',
  'description_i18n', 'land_area_m2', 'floors', 'wall_material', 'gas', 'water', 'sewage', 'floor', 'building_floors', 'building_type', 'has_elevator', 'has_balcony', 'parking',
];

/** Что модератор отмечает при одобрении (SC-05). */
export const VERIFICATION_KEYS = ['extract', 'owner_match', 'no_encumbrance', 'photos_match', 'valuation'] as const;
export type VerificationKey = (typeof VERIFICATION_KEYS)[number];

const PUBLIC_STATUSES = ['scheduled', 'live', 'revealing', 'finished', 'no_sale', 'sold'];

@Injectable()
export class LotsService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private storage: Storage,
    private kms: FakeKms,
    private cadastre: FakeCadastre,
    private auth: AuthService,
    private notify: NotifyService,
    private plans: PlansService,
    private elig: EligibilityService,
    private seller: SellerService,
  ) {}

  // ---------------- Мастер создания лота (SC-04) ----------------
  async createDraft(user: User) {
    if (!user.email_verified_at) fail('EMAIL_REQUIRED', 403); // L1: черновик лота
    if (user.seller_blocked) fail('SELLER_BLOCKED', 403, { reason: user.seller_block_reason });
    return this.db.tx(async (t) => {
      const p = await t.one('INSERT INTO properties(owner_id) VALUES ($1) RETURNING id', [user.id]);
      const lot = await t.one(`INSERT INTO lots(property_id, seller_id, status, created_at) VALUES ($1,$2,'draft',$3) RETURNING id`, [p.id, user.id, this.clock.now()]);
      return { id: lot.id };
    });
  }

  private async ownDraft(user: User, lotId: number, t: Queryable = this.db) {
    const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 AND seller_id=$2`, [lotId, user.id]);
    if (!lot) fail('LOT_NOT_FOUND', 404);
    if (!['draft', 'needs_changes'].includes(lot.status)) fail('LOT_NOT_EDITABLE'); // R-15
    return lot;
  }

  /** Сохранение шага черновика. Черновик сохраняется на каждом шаге. */
  async saveStep(user: User, lotId: number, step: number, data: any) {
    const lot = await this.ownDraft(user, lotId);
    const prop = await this.db.one('SELECT * FROM properties WHERE id=$1', [lot.property_id]);
    let fields: Record<string, unknown> = {};
    if (step === 1) fields = step1.parse(data);
    else if (step === 2) fields = (prop.property_type === 'house' ? step2House : step2Apt).parse(data);
    else if (step === 4) {
      const v = step4.parse(data);
      await this.validateTerms(v.start_price, new Date(v.opens_at), new Date(v.closes_at), null);
      LotsService.validateDates(v.published_at, v.registration_opens_at, v.opens_at);
      const s = await this.settings.all();
      const bp = v.guarantee_percent === undefined ? Number(s.guarantee_default_bp ?? 100) : Math.round(v.guarantee_percent * 100);
      if (bp > Number(s.guarantee_max_bp ?? 1000)) fail('GUARANTEE_TOO_HIGH', 400, { maxPercent: Number(s.guarantee_max_bp ?? 1000) / 100 });
      await this.db.q(
        `UPDATE lots SET start_price=$2, opens_at=$3, closes_at=$4, deposit_amount=$5, published_at=$6, registration_opens_at=$7, allow_late_registration=$8, guarantee_bp=$9, insurance=coalesce($10, insurance), draft_step=GREATEST(draft_step,5) WHERE id=$1`,
        [lotId, v.start_price, v.opens_at, v.closes_at, guaranteeFor(v.start_price, bp, s), v.published_at ?? null, v.registration_opens_at ?? null, v.allow_late_registration ?? true, bp, v.insurance ? JSON.stringify(v.insurance) : null],
      );
      return this.draft(user, lotId);
    } else if (step !== 3 && step !== 5) fail('STEP_INVALID');
    if (Object.keys(fields).length) {
      const keys = Object.keys(fields).filter((k) => PROPERTY_COLS.includes(k));
      const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
      await this.db.q(`UPDATE properties SET ${sets} WHERE id=$1`, [prop.id, ...keys.map((k) => (k === 'description_i18n' ? JSON.stringify(fields[k]) : fields[k]))]);
    }
    if (step === 1 && fields.cadastral_no) {
      // PRD v2 (F9.1): проверка по кадастру — найден ли объект, совпадает ли собственник, нет ли ареста или ипотеки
      const r = await this.cadastre.lookup(String(fields.cadastral_no), this.clock.now());
      const check = { ...r, ownerMatches: r.found && r.ownerIsApplicant };
      await this.db.q('UPDATE lots SET cadastre_check=$2 WHERE id=$1', [lotId, JSON.stringify(check)]);
    }
    await this.db.q('UPDATE lots SET draft_step=GREATEST(draft_step,$2) WHERE id=$1', [lotId, Math.min(5, step + 1)]);
    return this.draft(user, lotId);
  }

  /** PRD v2 (F9.5): переписка продавца и модератора по лоту. */
  async messages(lotId: number, viewer: User, asStaff: boolean) {
    const lot = await this.db.maybe<{ seller_id: number }>('SELECT seller_id FROM lots WHERE id=$1', [lotId]);
    if (!lot || (!asStaff && lot.seller_id !== viewer.id)) fail('LOT_NOT_FOUND', 404);
    return this.db.q(
      `SELECT m.id, m.author_role, m.text, m.created_at, CASE WHEN m.author_role='staff' THEN u.full_name ELSE NULL END AS staff_name
       FROM lot_messages m JOIN users u ON u.id=m.author_id WHERE m.lot_id=$1 ORDER BY m.id`,
      [lotId],
    );
  }
  async postMessage(lotId: number, author: User, asStaff: boolean, text: string) {
    const lot = await this.db.maybe<{ seller_id: number; status: string }>('SELECT seller_id, status FROM lots WHERE id=$1', [lotId]);
    if (!lot || (!asStaff && lot.seller_id !== author.id)) fail('LOT_NOT_FOUND', 404);
    const body = String(text ?? '').trim();
    if (!body || body.length > 2000) fail('MESSAGE_INVALID');
    const m = await this.db.one(`INSERT INTO lot_messages(lot_id, author_id, author_role, text, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`, [
      lotId,
      author.id,
      asStaff ? 'staff' : 'seller',
      body,
      this.clock.now(),
    ]);
    if (asStaff) await this.notify.queue(lot!.seller_id, 'email', 'lot_message', { lotId, text: body.slice(0, 500), link: `${process.env.WEB_URL || 'http://localhost:3000'}/sell/${lotId}` });
    await this.audit.log(author.id, 'lot.message', 'lot', lotId, null, { role: asStaff ? 'staff' : 'seller' });
    return m;
  }

  /** PRD v2 (F9.4): что мешает отправить лот на модерацию — для экрана «Проверка и отправка» и для submit. */
  async readiness(lot: any, media: { kind: string; room: string | null; doc_type: string | null }[]) {
    const s = await this.settings.all();
    const out: { code: string; data?: any }[] = [];
    const c = lot.cadastre_check;
    if (!c || !c.found) out.push({ code: 'CADASTRE_NOT_FOUND' });
    else {
      if (c.encumbrance === 'arrest') out.push({ code: 'CADASTRE_ARREST' });
      if (!c.ownerMatches && !media.some((m) => m.doc_type === 'power_of_attorney')) out.push({ code: 'OWNER_MISMATCH', data: { need: 'power_of_attorney' } });
    }
    if (!media.some((m) => m.doc_type === 'encumbrance')) out.push({ code: 'DOCUMENT_REQUIRED', data: { doc: 'encumbrance' } });
    const need = String(s.photo_rooms_required ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const missing = need.filter((r) => !media.some((m) => m.kind === 'photo' && (m.room === r || (r === 'living' && m.room === 'bedroom'))));
    if (missing.length) out.push({ code: 'PHOTOS_ROOMS_MISSING', data: { missing } });
    if (lot.insurance?.mode === 'have' && !media.some((m) => m.doc_type === 'insurance_policy')) out.push({ code: 'DOCUMENT_REQUIRED', data: { doc: 'insurance_policy' } });
    return out;
  }

  /** PRD v2: показ ≤ регистрация ≤ начало торгов. */
  static validateDates(published?: string | null, registration?: string | null, opens?: string) {
    const ms = (x?: string | null) => (x ? new Date(x).getTime() : null);
    const [p, r, o] = [ms(published), ms(registration), ms(opens)];
    if (p !== null && r !== null && r < p) fail('REGISTRATION_BEFORE_PUBLISH');
    if (r !== null && o !== null && r > o) fail('REGISTRATION_AFTER_START');
    if (p !== null && o !== null && p > o) fail('PUBLISH_AFTER_START');
  }

  /** R-01, R-02. approvedAt — момент одобрения (для правила 24 ч). */
  async validateTerms(startPrice: number, opensAt: Date, closesAt: Date, approvedAt: Date | null, t: Queryable = this.db) {
    const s = await this.settings.all(t);
    if (!Number.isInteger(startPrice) || startPrice < s.min_start_price) fail('START_PRICE_TOO_LOW', 400, { min: s.min_start_price });
    const dur = closesAt.getTime() - opensAt.getTime();
    if (dur < s.duration_min_hours * HOUR || dur > s.duration_max_hours * HOUR) fail('DURATION_INVALID', 400, { minHours: s.duration_min_hours, maxHours: s.duration_max_hours });
    const base = approvedAt ?? this.clock.now();
    const minOpen = base.getTime() + s.start_delay_hours * HOUR;
    if (opensAt.getTime() < minOpen) fail('START_TOO_SOON', 400, { minOpensAt: new Date(minOpen).toISOString() });
  }

  async addMedia(user: User, lotId: number, kind: 'photo' | 'extract' | 'document', file: { buffer: Buffer; mimetype: string; originalname: string }, opts: { room?: string; docType?: string } = {}) {
    if (kind === 'photo' && opts.room && !(PHOTO_ROOMS as readonly string[]).includes(opts.room)) fail('ROOM_INVALID', 400, { rooms: PHOTO_ROOMS });
    if (kind === 'document' && !(DOC_TYPES as readonly string[]).includes(opts.docType ?? '')) fail('DOC_TYPE_INVALID', 400, { types: DOC_TYPES });
    const lot = await this.ownDraft(user, lotId);
    const s = await this.settings.all();
    if (kind === 'photo') {
      // SVG принимается только в dev-режиме (демо-фото); в бою — только растровые форматы
      const svgOk = process.env.DEV_TOOLS === 'true' || process.env.NODE_ENV === 'test';
      if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype) && !(svgOk && file.mimetype === 'image/svg+xml')) fail('FILE_TYPE');
      const c = await this.db.one<{ c: number }>(`SELECT count(*)::int c FROM property_media WHERE property_id=$1 AND kind='photo'`, [lot.property_id]);
      if (c.c >= s.photos_max) fail('PHOTOS_TOO_MANY', 400, { max: s.photos_max });
    } else if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.mimetype)) fail('FILE_TYPE');
    if (file.buffer.length > 15 * 1024 * 1024) fail('FILE_TOO_LARGE');
    const ext = file.mimetype === 'image/svg+xml' ? 'svg' : file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const priv = kind !== 'photo'; // выписку и документы видит только модератор
    const key = this.storage.put(file.buffer, ext, priv);
    const sort = (await this.db.one<{ m: number }>('SELECT coalesce(max(sort),0)+1 m FROM property_media WHERE property_id=$1', [lot.property_id])).m;
    const m = await this.db.one(`INSERT INTO property_media(property_id, kind, storage_key, is_private, sort, uploaded_at, room, doc_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [
      lot.property_id,
      kind,
      key,
      priv,
      sort,
      this.clock.now(),
      kind === 'photo' ? opts.room ?? 'other' : null,
      kind === 'document' ? opts.docType : null,
    ]);
    return { id: m.id };
  }

  /** v0.2: оценка объекта независимой организацией — название, сумма, дата и документ. */
  async addValuation(user: User, lotId: number, body: { org_name?: string; amount?: unknown; valued_at?: string; report_no?: string }, file?: { buffer: Buffer; mimetype: string }) {
    const lot = await this.ownDraft(user, lotId);
    const v = z
      .object({
        org_name: z.string().trim().min(2).max(200),
        amount: z.coerce.number().int().positive().max(1e13),
        valued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        report_no: z.string().trim().max(100).optional(),
      })
      .parse(body);
    if (new Date(v.valued_at).getTime() > this.clock.ms()) fail('VALUATION_DATE_INVALID');
    if (!file) fail('FILE_REQUIRED');
    if (!/^(application\/pdf|image\/(jpeg|png))$/.test(file!.mimetype)) fail('FILE_TYPE');
    // отчёт об оценке публичен на странице лота — продавец сам его прикладывает
    const key = this.storage.put(file!.buffer, file!.mimetype === 'application/pdf' ? 'pdf' : file!.mimetype.split('/')[1].replace('jpeg', 'jpg'), false);
    const r = await this.db.one(`INSERT INTO property_valuations(property_id, org_name, amount, valued_at, report_no, storage_key, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
      lot.property_id,
      v.org_name,
      v.amount,
      v.valued_at,
      v.report_no || null,
      key,
      this.clock.now(),
    ]);
    return { id: r.id };
  }
  async removeValuation(user: User, lotId: number, id: number) {
    const lot = await this.ownDraft(user, lotId);
    await this.db.q('DELETE FROM property_valuations WHERE id=$1 AND property_id=$2', [id, lot.property_id]);
    return { ok: true };
  }
  async valuations(propertyId: number) {
    const rows = await this.db.q(`SELECT id, org_name, amount, valued_at, report_no, storage_key FROM property_valuations WHERE property_id=$1 ORDER BY valued_at DESC, id DESC`, [propertyId]);
    return rows.map((v) => ({ id: v.id, orgName: v.org_name, amount: v.amount, valuedAt: v.valued_at, reportNo: v.report_no, documentUrl: this.storage.publicUrl(v.storage_key) }));
  }

  async removeMedia(user: User, lotId: number, mediaId: number) {
    const lot = await this.ownDraft(user, lotId);
    await this.db.q('DELETE FROM property_media WHERE id=$1 AND property_id=$2', [mediaId, lot.property_id]);
    return { ok: true };
  }

  async draft(user: User, lotId: number) {
    const lot = await this.db.maybe(`SELECT * FROM lots WHERE id=$1 AND seller_id=$2`, [lotId, user.id]);
    if (!lot) fail('LOT_NOT_FOUND', 404);
    const prop = await this.db.one('SELECT * FROM properties WHERE id=$1', [lot.property_id]);
    const media = await this.db.q('SELECT id, kind, storage_key, is_private, sort, room, doc_type FROM property_media WHERE property_id=$1 ORDER BY sort', [lot.property_id]);
    const mod = await this.db.q('SELECT decision, comment, created_at FROM moderation WHERE lot_id=$1 ORDER BY id DESC', [lotId]);
    const s = await this.settings.all();
    const cards = await this.db.one<{ c: number }>(`SELECT count(*)::int c FROM cards WHERE user_id=$1 AND status='active'`, [user.id]);
    return {
      lot: this.lotPublicFields(lot),
      property: prop,
      photos: media.filter((m) => m.kind === 'photo').map((m) => ({ id: m.id, url: this.storage.publicUrl(m.storage_key), room: m.room })),
      extracts: media.filter((m) => m.kind === 'extract').map((m) => ({ id: m.id })),
      documents: media.filter((m) => m.kind === 'document').map((m) => ({ id: m.id, docType: m.doc_type })),
      cadastre: lot.cadastre_check ?? null,
      insurance: lot.insurance ?? null,
      readiness: await this.readiness(lot, media),
      valuations: await this.valuations(lot.property_id),
      moderation: mod,
      preview: lot.start_price
        ? { deposit: guaranteeFor(lot.start_price, lot.guarantee_bp, s), sellerDeposit: s.seller_deposit_enabled ? this.seller.amountFor(lot, s) : 0, guaranteePercent: lot.guarantee_bp === null || lot.guarantee_bp === undefined ? null : lot.guarantee_bp / 100, commission: commissionFor(lot.start_price, s), suggestedPlan: (await this.plans.suggestFor(lot.start_price))?.code ?? null }
        : null,
      submitBlockers: [
        ...(user.kyc_status !== 'verified' ? ['KYC_REQUIRED'] : []),
        ...(cards.c === 0 ? ['CARD_REQUIRED'] : []),
        ...(user.seller_blocked ? ['SELLER_BLOCKED'] : []),
      ],
      limits: { photosMin: s.photos_min, photosMax: s.photos_max, minStartPrice: s.min_start_price, durationMinHours: s.duration_min_hours, durationMaxHours: s.duration_max_hours, startDelayHours: s.start_delay_hours },
    };
  }

  async myLots(userId: number) {
    return this.db.q(
      `SELECT l.id, l.status, l.start_price, l.opens_at, l.closes_at, l.draft_step, p.property_type, p.region, p.settlement, p.street, d.status AS deal_status
       FROM lots l JOIN properties p ON p.id=l.property_id LEFT JOIN deals d ON d.lot_id=l.id WHERE l.seller_id=$1 ORDER BY l.id DESC`,
      [userId],
    );
  }

  /** Шаг 5: отправка на модерацию. Кнопка неактивна без проверенной личности и привязанной карты. */
  async submit(user: User, lotId: number, acceptRules: boolean) {
    const lot = await this.ownDraft(user, lotId);
    if (user.kyc_status !== 'verified') fail('KYC_REQUIRED', 403);
    if (user.seller_blocked) fail('SELLER_BLOCKED', 403);
    const card = await this.db.maybe(`SELECT id FROM cards WHERE user_id=$1 AND status='active'`, [user.id]);
    if (!card) fail('CARD_REQUIRED', 403);
    if (!acceptRules) fail('CONSENT_REQUIRED', 403, { missing: ['seller_offer'] });
    const prop = await this.db.one('SELECT * FROM properties WHERE id=$1', [lot.property_id]);
    try {
      step1.parse(prop);
      (prop.property_type === 'house' ? step2House : step2Apt).parse(prop);
    } catch {
      fail('LOT_INCOMPLETE', 400, { step: 'property' });
    }
    const s = await this.settings.all();
    const photos = await this.db.one<{ c: number }>(`SELECT count(*)::int c FROM property_media WHERE property_id=$1 AND kind='photo'`, [lot.property_id]);
    if (photos.c < s.photos_min || photos.c > s.photos_max) fail('PHOTOS_COUNT', 400, { min: s.photos_min, max: s.photos_max });
    const ex = await this.db.maybe(`SELECT id FROM property_media WHERE property_id=$1 AND kind='extract'`, [lot.property_id]);
    if (!ex) fail('EXTRACT_REQUIRED');
    // PRD v2 (F9.4): кадастр, обязательные документы, фото по комнатам, страховка
    const media = await this.db.q('SELECT kind, room, doc_type FROM property_media WHERE property_id=$1', [lot.property_id]);
    const problems = await this.readiness(lot, media);
    if (problems.length) fail(problems[0].code, 400, { problems });
    if (!lot.start_price) fail('LOT_INCOMPLETE', 400, { step: 'terms' });
    await this.validateTerms(lot.start_price, new Date(lot.opens_at), new Date(lot.closes_at), null);
    await this.db.tx(async (t) => {
      await this.auth.accept(user.id, ['seller_offer'], t);
      await this.seller.reserve(user, lot, t); // PRD v2 решение 16: размещение по тарифу продавца
      await t.q(`UPDATE lots SET status='moderation' WHERE id=$1`, [lotId]);
      await this.audit.log(user.id, 'lot.submitted', 'lot', lotId, null, null, t);
    });
    return { ok: true, status: 'moderation' };
  }

  // ---------------- Модерация (SC-05) ----------------
  async moderate(staff: User, lotId: number, decision: 'approve' | 'return' | 'reject', comment: string, checklist: Partial<Record<VerificationKey, boolean>> = {}) {
    const lot = await this.db.maybe(`SELECT * FROM lots WHERE id=$1`, [lotId]);
    if (!lot) fail('LOT_NOT_FOUND', 404);
    if (lot.status !== 'moderation') fail('LOT_NOT_IN_MODERATION');
    if (decision !== 'approve' && !comment) fail('COMMENT_REQUIRED');
    // SC-05: без проверки выписки и совпадения собственника одобрить нельзя
    if (decision === 'approve' && !(checklist.extract && checklist.owner_match)) fail('CHECKLIST_REQUIRED', 400, { required: ['extract', 'owner_match'] });
    const now = this.clock.now();
    if (decision === 'approve') {
      try {
        await this.validateTerms(lot.start_price, new Date(lot.opens_at), new Date(lot.closes_at), now);
      } catch (e) {
        if (e instanceof AppError && e.code === 'START_TOO_SOON') {
          // Время начала раньше чем через 24 ч после одобрения → продавцу предлагается сдвинуть время
          decision = 'return';
          comment = `START_TOO_SOON: ${e.data.minOpensAt}` + (comment ? ` — ${comment}` : '');
        } else throw e;
      }
    }
    const result = await this.db.tx(async (t) => {
      await t.q('INSERT INTO moderation(lot_id, moderator_id, decision, comment, created_at) VALUES ($1,$2,$3,$4,$5)', [lotId, staff.id, decision, comment || null, now]);
      if (decision === 'approve') {
        const s = await this.settings.all(t);
        const keys = generateLotKeys(); // 7.4.1: пара ключей создаётся при одобрении
        const snapshot = { ...s, consent_versions: undefined, auction_type: 'type1', captured_at: now.toISOString() };
        await t.q(
          `UPDATE lots SET status='scheduled', approved_at=$2, public_key=$3, private_key_wrapped=$4, rules_snapshot=$5, deposit_amount=$6, verification=$7, version=version+1 WHERE id=$1`,
          [
            lotId,
            now,
            keys.publicKey,
            this.kms.wrap(lotId, keys.privateKey),
            JSON.stringify(snapshot),
            guaranteeFor(lot.start_price, lot.guarantee_bp, s),
            JSON.stringify({ ...Object.fromEntries(VERIFICATION_KEYS.map((k) => [k, !!checklist[k]])), checked_at: now.toISOString() }),
          ],
        );
      } else {
        await t.q(`UPDATE lots SET status=$2 WHERE id=$1`, [lotId, decision === 'return' ? 'needs_changes' : 'rejected']);
      }
      await this.seller.onModeration(lotId, decision, t);
      await this.audit.log(staff.id, 'lot.moderated', 'lot', lotId, { status: lot.status }, { decision, comment }, t);
      const tpl = decision === 'approve' ? 'lot_approved' : decision === 'return' ? 'lot_returned' : 'lot_rejected';
      await this.notify.queue(lot.seller_id, 'email', tpl, { lotId, comment, opensAt: fmtYerevan(lot.opens_at), closesAt: fmtYerevan(lot.closes_at) }, {}, t);
      return { status: decision === 'approve' ? 'scheduled' : decision === 'return' ? 'needs_changes' : 'rejected', comment };
    });
    return result;
  }

  // ---------------- Снятие лота (SC-06, R-15) ----------------
  async withdraw(actor: User, lotId: number, reason: string, asAdmin: boolean) {
    const res = await this.db.tx(async (t) => {
      const lot = await t.maybe(`SELECT * FROM lots WHERE id=$1 FOR UPDATE`, [lotId]);
      if (!lot) fail('LOT_NOT_FOUND', 404);
      if (!asAdmin && lot.seller_id !== actor.id) fail('LOT_NOT_FOUND', 404);
      if (!asAdmin && ['draft', 'moderation', 'needs_changes', 'rejected'].includes(lot.status)) {
        await t.q(`UPDATE lots SET status='withdrawn', ended_reason='seller_draft' WHERE id=$1`, [lotId]);
        return { lot, participants: [] as number[] };
      }
      if (!['scheduled', 'live'].includes(lot.status) || this.clock.ms() >= new Date(lot.closes_at).getTime()) fail('LOT_NOT_WITHDRAWABLE');
      const bids = await t.one<{ c: number }>('SELECT count(*)::int c FROM bids WHERE lot_id=$1', [lotId]);
      if (!asAdmin && bids.c > 0) fail('WITHDRAW_NEEDS_ADMIN', 403); // после первой ставки — только администратор
      if (asAdmin && !reason) fail('REASON_REQUIRED');
      const participants = (
        await t.q<{ user_id: number }>(`SELECT DISTINCT user_id FROM deposits WHERE lot_id=$1 AND status IN ('pending','held') UNION SELECT user_id FROM bids WHERE lot_id=$1`, [lotId])
      ).map((r) => r.user_id);
      // ставки не вскрываются и удаляются
      await t.q('DELETE FROM bid_versions WHERE bid_id IN (SELECT id FROM bids WHERE lot_id=$1)', [lotId]); // история версий удаляется вместе со ставками
      await t.q('DELETE FROM bids WHERE lot_id=$1', [lotId]);
      await t.q(`UPDATE deposits SET status='releasing', updated_at=$2 WHERE lot_id=$1 AND status IN ('pending','held')`, [lotId, this.clock.now()]);
      await t.q(`UPDATE lots SET status='withdrawn', ended_reason=$2, private_key_wrapped=NULL WHERE id=$1`, [lotId, asAdmin ? 'admin: ' + reason : 'seller']);
      await this.audit.log(actor.id, asAdmin ? 'lot.withdrawn_by_admin' : 'lot.withdrawn', 'lot', lotId, { status: lot.status }, { reason, bids: asAdmin ? undefined : 0 }, t);
      // PRD v2 решение 17: взнос продавца. Сам снял после открытия регистрации — 25 %, во время торгов — 100 %;
      // снял администратор (техническая причина, документы и т. п.) — взнос возвращается
      if (asAdmin) await this.seller.release(lotId, 'admin_withdraw', t);
      else {
        const s2 = await this.settings.all(t);
        const bp = this.clock.ms() >= new Date(lot.opens_at).getTime() ? 10_000 : Number(s2.seller_cancel_registration_bp ?? 0);
        await this.seller.forfeit(lotId, bp, 'seller_withdraw', null, t);
      }
      // PRD v2 решение 5: лот отменён — попытки тарифа возвращаются всем, кто нажал «Участвовать» (+ pop-up)
      const credited = await t.q<{ user_id: number }>(`SELECT DISTINCT user_id FROM participation_credits WHERE lot_id=$1`, [lotId]);
      for (const c of credited) await this.plans.refund(c.user_id, lotId, asAdmin ? 'lot_cancelled_admin' : 'lot_cancelled_seller', actor.id, t);
      for (const u of participants) await this.notify.queue(u, 'email', 'lot_withdrawn', { lotId, reason: reason || '—' }, { dedupeKey: `withdrawn:${lotId}:${u}` }, t);
      return { lot, participants };
    });
    return { ok: true, notified: res.participants.length };
  }

  /** SC-13: перезапуск — новый черновик с теми же данными и новой ценой (снова через модерацию). */
  async relaunch(user: User, lotId: number) {
    if (user.seller_blocked) fail('SELLER_BLOCKED', 403);
    const lot = await this.db.maybe(`SELECT * FROM lots WHERE id=$1 AND seller_id=$2`, [lotId, user.id]);
    if (!lot) fail('LOT_NOT_FOUND', 404);
    if (!['no_sale', 'withdrawn'].includes(lot.status)) fail('LOT_NOT_RELAUNCHABLE');
    return this.db.tx(async (t) => {
      const cols = PROPERTY_COLS.join(', ');
      const p = await t.one(`INSERT INTO properties(owner_id, ${cols}) SELECT owner_id, ${cols} FROM properties WHERE id=$1 RETURNING id`, [lot.property_id]);
      await t.q(
        `INSERT INTO property_media(property_id, kind, storage_key, is_private, sort, uploaded_at) SELECT $2, kind, storage_key, is_private, sort, uploaded_at FROM property_media WHERE property_id=$1 AND kind='photo'`,
        [lot.property_id, p.id],
      );
      await t.q(
        `INSERT INTO property_valuations(property_id, org_name, amount, valued_at, report_no, storage_key, created_at) SELECT $2, org_name, amount, valued_at, report_no, storage_key, created_at FROM property_valuations WHERE property_id=$1`,
        [lot.property_id, p.id],
      );
      const nl = await t.one(`INSERT INTO lots(property_id, seller_id, status, draft_step, relaunched_from, created_at) VALUES ($1,$2,'draft',3,$3,$4) RETURNING id`, [
        p.id,
        user.id,
        lotId,
        this.clock.now(),
      ]);
      await this.audit.log(user.id, 'lot.relaunched', 'lot', nl.id, null, { from: lotId }, t);
      return { id: nl.id };
    });
  }

  // ---------------- Каталог и карточка (3.2, 3.3) ----------------
  lotPublicFields(l: any) {
    return {
      id: l.id,
      status: this.displayStatus(l),
      raw_status: l.status,
      auction_type: l.auction_type,
      start_price: l.start_price,
      opens_at: l.opens_at,
      closes_at: l.closes_at,
      published_at: l.published_at ?? l.approved_at ?? null,
      registration_opens_at: l.registration_opens_at ?? l.published_at ?? l.approved_at ?? null,
      allow_late_registration: l.allow_late_registration ?? true,
      stage: this.stage(l),
      deposit_amount: l.deposit_amount,
      guarantee_percent: l.guarantee_bp === null || l.guarantee_bp === undefined ? null : l.guarantee_bp / 100,
      extended_at: l.extended_at,
      draft_step: l.draft_step,
      relaunched_from: l.relaunched_from,
    };
  }
  /** «Скоро / Идёт / Вскрытие / Завершён» по времени сервера, даже если фоновая задача ещё не отработала. */
  displayStatus(l: { status: string; opens_at: Date; closes_at: Date }) {
    const now = this.clock.ms();
    if (l.status === 'scheduled' && now >= new Date(l.opens_at).getTime()) return now >= new Date(l.closes_at).getTime() ? 'revealing' : 'live';
    if (l.status === 'live' && now >= new Date(l.closes_at).getTime()) return 'revealing';
    return l.status;
  }

  /** PRD v2 §2: скоро / регистрация / торги / ждёт договора / завершён / не состоялся / отменён. */
  stage(l: { status: string; opens_at: Date; closes_at: Date; registration_opens_at?: Date | null }): Stage | string {
    if (['withdrawn', 'invalidated'].includes(l.status)) return 'cancelled';
    if (l.status === 'sold') return 'finished';
    if (l.status === 'no_sale') return 'no_sale';
    if (l.status === 'finished') return 'awaiting_contract';
    const d = this.displayStatus(l);
    if (d === 'live' || d === 'revealing') return 'in_progress';
    if (d === 'scheduled') return !l.registration_opens_at || this.clock.ms() >= new Date(l.registration_opens_at).getTime() ? 'registration_open' : 'upcoming';
    return l.status; // черновики и модерация — для кабинета продавца
  }

  async catalog(q: Record<string, string>) {
    // PRD v2: отменённые после публикации тоже видны (внизу каталога)
    const where: string[] = [`(l.status = ANY($1) OR (l.status IN ('withdrawn','invalidated') AND l.approved_at IS NOT NULL AND coalesce(l.ended_reason,'') <> 'seller_draft'))`];
    const params: unknown[] = [PUBLIC_STATUSES];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', '$' + params.length));
    };
    const now = this.clock.now();
    if (q.type) add('p.property_type = ?', q.type);
    if (q.region) add('p.region = ?', q.region);
    if (q.priceMin) add('l.start_price >= ?', Number(q.priceMin));
    if (q.priceMax) add('l.start_price <= ?', Number(q.priceMax));
    if (q.areaMin) add('p.area_m2 >= ?', Number(q.areaMin));
    if (q.areaMax) add('p.area_m2 <= ?', Number(q.areaMax));
    if (q.rooms) add(Number(q.rooms) >= 5 ? 'p.rooms >= ?' : 'p.rooms = ?', Number(q.rooms));
    if (q.status === 'soon') add(`(l.status='scheduled' AND l.opens_at > ?)`, now);
    if (q.status === 'live') add(`(l.status IN ('scheduled','live') AND l.opens_at <= ?)`, now);
    if (q.status === 'live') add(`l.closes_at > ?`, now);
    if (q.status === 'ended') add(`(l.status IN ('revealing','finished','no_sale','sold') OR l.closes_at <= ?)`, now);
    if (q.status) where.push(`l.status NOT IN ('withdrawn','invalidated')`); // фильтры v1 — без отменённых
    add('(l.published_at IS NULL OR l.published_at <= ?)', now); // до даты показа лота в каталоге нет
    const isDefaultSort = !['new', 'price_asc', 'price_desc', 'ending'].includes(q.sort);
    if (isDefaultSort) params.push(now);
    const nowP = '$' + params.length + '::timestamptz';
    const order =
      q.sort === 'new'
        ? 'l.approved_at DESC NULLS LAST'
        : q.sort === 'price_asc'
          ? 'l.start_price ASC'
          : q.sort === 'price_desc'
            ? 'l.start_price DESC'
            : `CASE WHEN l.closes_at > ${nowP} AND l.status IN ('scheduled','live') THEN 0 ELSE 1 END, CASE WHEN l.closes_at > ${nowP} THEN l.closes_at END ASC, l.closes_at DESC`;
    const rows = await this.db.q(
      `SELECT l.*, p.property_type, p.region, p.settlement, p.street, p.area_m2, p.rooms, p.geo_lat, p.geo_lng,
        (SELECT storage_key FROM property_media m WHERE m.property_id=p.id AND m.kind='photo' ORDER BY sort LIMIT 1) AS cover
       FROM lots l JOIN properties p ON p.id=l.property_id WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`,
      params,
    );
    let items = rows.map((r) => ({
        ...this.lotPublicFields(r),
        property_type: r.property_type,
        region: r.region,
        geo: r.geo_lat && r.geo_lng ? { lat: Number(r.geo_lat), lng: Number(r.geo_lng) } : null, // для карты каталога
        settlement: r.settlement,
        street: r.street,
        area_m2: r.area_m2,
        rooms: r.rooms,
        cover: r.cover ? this.storage.publicUrl(r.cover) : null,
      }));
    if (q.stage) items = items.filter((i) => i.stage === q.stage);
    if (isDefaultSort) {
      // PRD v2: торги → регистрация → скоро → ждёт договора → завершён / не состоялся → отменён;
      // внутри активных — что раньше закончится (или начнётся), внутри завершённых — свежие сверху
      const rank = (st: string) => { const i = STAGE_ORDER.indexOf(st as Stage); return i < 0 ? 99 : i === 5 ? 4 : i; };
      const t = (x: any) => new Date(x.closes_at).getTime();
      items = [...items].sort((a, b) => rank(a.stage) - rank(b.stage) || (rank(a.stage) <= 2 ? t(a) - t(b) : t(b) - t(a)));
    }
    return { serverTime: now.toISOString(), items };
  }

  /** Карточка лота. До итога — никаких данных о ставках (R-06, R-07). */
  async card(lotId: number, viewer: User | null) {
    const l = await this.db.maybe(`SELECT * FROM lots WHERE id=$1`, [lotId]);
    const isOwner = viewer && l && l.seller_id === viewer.id;
    if (!l || (!PUBLIC_STATUSES.includes(l.status) && !isOwner && !['withdrawn', 'invalidated'].includes(l.status))) fail('LOT_NOT_FOUND', 404);
    if (!isOwner && l.published_at && this.clock.ms() < new Date(l.published_at).getTime()) fail('LOT_NOT_FOUND', 404); // PRD v2: до даты показа
    const p = await this.db.one('SELECT * FROM properties WHERE id=$1', [l.property_id]);
    const photos = await this.db.q(`SELECT storage_key FROM property_media WHERE property_id=$1 AND kind='photo' ORDER BY sort`, [l.property_id]);
    const plan = l.start_price ? await this.plans.suggestFor(l.start_price) : null;
    const status = this.displayStatus(l);
    const { cadastral_no, owner_id, ...property } = p;
    const out: any = {
      serverTime: this.clock.now().toISOString(),
      lot: this.lotPublicFields(l),
      property,
      photos: photos.map((m) => this.storage.publicUrl(m.storage_key)),
      requiredPlan: plan ? { code: plan.code, name_i18n: plan.name_i18n, price: plan.price } : null,
      rules: l.rules_snapshot
        ? { deal_confirm_hours: l.rules_snapshot.deal_confirm_hours, commission_bp: l.rules_snapshot.commission_bp, commission_min: l.rules_snapshot.commission_min }
        : null,
      isSeller: !!isOwner,
      isFavorite: viewer ? !!(await this.db.maybe('SELECT 1 FROM favorites WHERE user_id=$1 AND lot_id=$2', [viewer.id, lotId])) : false,
      valuations: await this.valuations(l.property_id),
      verification: await this.verificationOf(l),
      bidMaxChanges: Number((await this.settings.all()).bid_max_changes ?? 3), // PRD v2 решение 9
    };
    if (viewer && !isOwner && ['scheduled', 'live'].includes(status)) {
      out.steps = await this.elig.steps(viewer, l);
    } else if (!viewer && ['scheduled', 'live'].includes(status)) {
      out.steps = await this.elig.steps(null, l);
    }
    if (viewer) {
      const my = await this.db.maybe(`SELECT id, receipt_no, server_received_at, commitment FROM bids WHERE lot_id=$1 AND user_id=$2`, [lotId, viewer.id]);
      if (my) out.myBidRef = { id: my.id, receiptNo: my.receipt_no, serverReceivedAt: my.server_received_at, commitment: my.commitment };
      if (viewer.id !== l.seller_id && ['scheduled', 'live'].includes(status)) {
        try {
          await this.elig.checkLimits(viewer, l);
        } catch (e: any) {
          if (e instanceof AppError) out.limitBlock = { error: e.code, ...e.data };
        }
      }
    }
    if (['finished', 'no_sale', 'sold'].includes(l.status) || (l.status === 'invalidated' && (await this.db.maybe('SELECT 1 FROM lot_results WHERE lot_id=$1', [lotId])))) {
      out.result = await this.result(lotId, viewer);
    }
    return out;
  }

  /** Блок «Документы проверены»: что сверил модератор при одобрении и проверка личности продавца. */
  private async verificationOf(l: any) {
    if (!l.approved_at) return null;
    const seller = await this.db.one<{ kyc_status: string }>('SELECT kyc_status FROM users WHERE id=$1', [l.seller_id]);
    const v = l.verification || {};
    return {
      checkedAt: v.checked_at ?? l.approved_at,
      items: [{ key: 'seller_kyc', ok: seller.kyc_status === 'verified' }, ...VERIFICATION_KEYS.map((k) => ({ key: k, ok: !!v[k] }))],
      // PRD v2 (F5): проверка по кадастру и страховка — без самих документов
      cadastre: l.cadastre_check ? { checked: !!l.cadastre_check.found, encumbrance: l.cadastre_check.encumbrance, checkedAt: l.cadastre_check.checkedAt } : null,
      insurance: l.insurance ? { mode: l.insurance.mode, insurer: l.insurance.mode === 'have' ? l.insurance.insurer ?? null : null } : null,
    };
  }

  /**
   * R-09: после конца — все ставки открыты всем; «Это вы» — у самого участника.
   * v0.2: рядом со ставкой показывается публичный ID участника (настройка results_show_user_ids);
   * если победитель отказался — видно, что лот перешёл 2-му месту.
   */
  async result(lotId: number, viewer: User | null) {
    const r = await this.db.maybe<{ ranking: any[]; winner_user_id: number | null; revealed_at: Date }>('SELECT * FROM lot_results WHERE lot_id=$1', [lotId]);
    if (!r) return null;
    const s = await this.settings.all();
    const myBid = viewer ? await this.db.maybe<{ id: string }>('SELECT id FROM bids WHERE lot_id=$1 AND user_id=$2', [lotId, viewer.id]) : null;
    const deal = await this.db.maybe<{ winner_user_id: number; round: number; status: string; transferred_at: Date | null }>(
      'SELECT winner_user_id, round, status, transferred_at FROM deals WHERE lot_id=$1',
      [lotId],
    );
    const buyerBid = deal ? r.ranking.find((x: any) => x.userId === deal.winner_user_id)?.bidId : null;
    const showIds = !!s.results_show_user_ids;
    return {
      revealedAt: r.revealed_at,
      bids: r.ranking.map((x: any) => ({
        place: x.place,
        label: x.place,
        userId: showIds ? x.userId ?? null : null,
        amount: x.amount,
        at: x.at,
        isWinner: x.place === 1,
        isBuyer: !!buyerBid && x.bidId === buyerBid,
        isMe: !!myBid && myBid.id === x.bidId,
        commitment: x.commitment,
        salt: x.salt,
        bidId: x.bidId,
      })),
      hasWinner: r.winner_user_id !== null,
      youWon: !!viewer && !!deal && deal.winner_user_id === viewer.id && !['buyer_failed', 'seller_failed', 'invalidated'].includes(deal.status),
      secondChance: {
        days: s.second_chance_days,
        until: s.second_chance_days ? new Date(new Date(r.revealed_at).getTime() + s.second_chance_days * DAY) : null,
        transferred: (deal?.round ?? 1) > 1,
        transferredAt: deal?.transferred_at ?? null,
        place: deal?.round ?? 1, // PRD v2: с какого места сейчас покупатель
        chainPlaces: Number(s.chain_places ?? 1),
      },
    };
  }

}
