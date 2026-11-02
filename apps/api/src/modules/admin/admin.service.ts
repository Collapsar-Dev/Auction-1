import { Injectable } from '@nestjs/common';
import { Db } from '../../common/db';
import { Clock, HOUR } from '../../common/clock';
import { fail } from '../../common/errors';
import { DEFAULT_SETTINGS, SettingKey, SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { Storage } from '../../adapters/storage';
import { User } from '../auth/auth.service';
import { NotifyService } from '../notifications/notify.service';
import { DepositsService } from '../deposits/deposits.service';
import { KycService } from '../kyc/kyc.service';
import { commitmentOf } from '../../adapters/kms';
import { fmtYerevan } from '../../common/format';

@Injectable()
export class AdminService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private storage: Storage,
    private notify: NotifyService,
    private deposits: DepositsService,
    private kyc: KycService,
  ) {}

  async overview() {
    const one = async (sql: string) => (await this.db.one<{ c: number }>(sql)).c;
    return {
      moderation: await one(`SELECT count(*)::int c FROM lots WHERE status='moderation'`),
      live: await one(`SELECT count(*)::int c FROM lots WHERE status IN ('scheduled','live')`),
      kycManual: await one(`SELECT count(*)::int c FROM users WHERE kyc_status='manual'`),
      riskOpen: await one(`SELECT count(*)::int c FROM risk_flags WHERE status='open'`),
      fundsPending: await one(`SELECT count(*)::int c FROM funds_proofs WHERE status='pending'`),
      disputedDeposits: await one(`SELECT count(*)::int c FROM deposits WHERE status='disputed'`),
      dealsOpen: await one(`SELECT count(*)::int c FROM deals WHERE status IN ('awaiting_confirm','confirmed','extract_uploaded')`),
      disputesOpen: await one(`SELECT count(*)::int c FROM disputes WHERE status='open'`),
      outages: await one(`SELECT count(*)::int c FROM outages WHERE status='detected'`),
      emailFailed: await one(`SELECT count(*)::int c FROM notifications WHERE status='failed' AND channel='email'`),
    };
  }

  lots(status?: string) {
    // До итога сотрудники не видят ничего о ставках (R-06) — в списке нет ни сумм, ни числа ставок
    return this.db.q(
      `SELECT l.id, l.status, l.start_price, l.opens_at, l.closes_at, l.seller_id, u.full_name AS seller_name, p.property_type, p.region, p.settlement, p.street, p.cadastral_no
       FROM lots l JOIN properties p ON p.id=l.property_id JOIN users u ON u.id=l.seller_id ${status ? 'WHERE l.status=$1' : ''} ORDER BY l.id DESC LIMIT 300`,
      status ? [status] : [],
    );
  }

  async lot(id: number) {
    const l = await this.db.maybe(
      `SELECT l.id, l.status, l.start_price, l.opens_at, l.closes_at, l.deposit_amount, l.approved_at, l.ended_reason, l.extended_at, l.rules_snapshot, l.seller_id, l.relaunched_from FROM lots l WHERE id=$1`,
      [id],
    );
    if (!l) fail('LOT_NOT_FOUND', 404);
    const p = await this.db.one(`SELECT * FROM properties WHERE id=(SELECT property_id FROM lots WHERE id=$1)`, [id]);
    const media = await this.db.q('SELECT id, kind, storage_key, uploaded_at FROM property_media WHERE property_id=$1 ORDER BY sort', [p.id]);
    const seller = await this.db.one('SELECT id, full_name, phone, email, kyc_status, seller_blocked FROM users WHERE id=$1', [l.seller_id]);
    const mod = await this.db.q('SELECT m.*, u.username FROM moderation m LEFT JOIN users u ON u.id=m.moderator_id WHERE lot_id=$1 ORDER BY m.id DESC', [id]);
    const deal = await this.db.maybe('SELECT * FROM deals WHERE lot_id=$1', [id]);
    const result = await this.db.maybe('SELECT * FROM lot_results WHERE lot_id=$1', [id]);
    const now = this.clock.now();
    return {
      lot: l,
      property: p,
      seller,
      photos: media.filter((m) => m.kind === 'photo').map((m) => this.storage.publicUrl(m.storage_key)),
      extracts: media.filter((m) => m.kind === 'extract').map((m) => ({ id: m.id, uploadedAt: m.uploaded_at, url: this.storage.signedUrl(m.storage_key, now) })),
      moderation: mod,
      deal: deal ? { ...deal, new_extract_url: deal.new_extract_key ? this.storage.signedUrl(deal.new_extract_key, now) : null } : null,
      result,
    };
  }

  async users(q?: string) {
    return this.db.q(
      `SELECT id, phone, email, full_name, role, status, kyc_status, seller_blocked, created_at FROM users
       WHERE ($1::text IS NULL OR phone ILIKE $1 OR email ILIKE $1 OR full_name ILIKE $1 OR username ILIKE $1) ORDER BY id LIMIT 300`,
      [q ? `%${q}%` : null],
    );
  }

  async user(id: number) {
    const u = await this.db.maybe(
      `SELECT id, phone, email, email_verified_at, lang, kyc_status, kyc_reject_reason, kyc_pending, full_name, birth_date, status, role, seller_blocked, seller_block_reason, phone_changed_at, created_at FROM users WHERE id=$1`,
      [id],
    );
    if (!u) fail('NOT_FOUND', 404);
    const [subs, deps, sanctions, flags, limits, wins, cards, proofs] = await Promise.all([
      this.db.q(`SELECT s.*, p.code FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE user_id=$1 ORDER BY s.id DESC`, [id]),
      this.db.q(`SELECT * FROM deposits WHERE user_id=$1 ORDER BY id DESC`, [id]),
      this.db.q(`SELECT * FROM sanctions WHERE user_id=$1 ORDER BY id DESC`, [id]),
      this.db.q(`SELECT * FROM risk_flags WHERE user_id=$1 ORDER BY id DESC`, [id]),
      this.db.maybe(`SELECT * FROM buyer_limits WHERE user_id=$1`, [id]),
      this.db.q(`SELECT d.lot_id, d.amount, d.status FROM deals d WHERE d.winner_user_id=$1 ORDER BY d.lot_id DESC`, [id]),
      this.db.q(`SELECT id, mask, status FROM cards WHERE user_id=$1`, [id]),
      this.db.q(`SELECT id, status, created_at FROM funds_proofs WHERE user_id=$1 ORDER BY id DESC`, [id]),
    ]);
    return { user: u, subscriptions: subs, deposits: deps, sanctions, riskFlags: flags, limits, wins, cards, fundsProofs: proofs };
  }

  async setUserStatus(admin: User, id: number, status: 'active' | 'blocked', reason: string) {
    if (!reason) fail('REASON_REQUIRED');
    const before = await this.db.one('SELECT status FROM users WHERE id=$1', [id]);
    await this.db.q('UPDATE users SET status=$2 WHERE id=$1', [id, status]);
    if (status === 'blocked') await this.db.q('UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [id, this.clock.now()]);
    await this.audit.log(admin.id, 'user.' + status, 'user', id, before, { status, reason });
    return { ok: true };
  }

  async sellerUnblock(admin: User, id: number, reason: string) {
    if (!reason) fail('REASON_REQUIRED');
    await this.db.q('UPDATE users SET seller_blocked=false, seller_block_reason=NULL WHERE id=$1', [id]);
    await this.audit.log(admin.id, 'seller.unblocked', 'user', id, null, { reason });
    return { ok: true };
  }

  async kycManual(staff: User, id: number, body: { approve: boolean; fullName?: string; birthDate?: string; docNumber?: string; reason?: string }) {
    const u = await this.db.maybe('SELECT * FROM users WHERE id=$1', [id]);
    if (!u) fail('NOT_FOUND', 404);
    if (!body.approve) return this.kyc.reject(u, body.reason || 'MANUAL_REJECT');
    const pending = u.kyc_pending || {};
    const docHash = body.docNumber ? KycService.docHash(body.docNumber) : pending.docHash;
    if (!docHash) fail('DOC_REQUIRED');
    return this.kyc.approve(u, body.fullName || pending.fullName, body.birthDate || pending.birthDate, docHash, staff.id);
  }

  deposits_() {
    return this.db.q(
      `SELECT d.*, u.full_name, u.phone, c.mask FROM deposits d JOIN users u ON u.id=d.user_id LEFT JOIN cards c ON c.id=d.card_id ORDER BY (d.status='disputed') DESC, d.id DESC LIMIT 300`,
    );
  }

  deals() {
    return this.db.q(
      `SELECT d.*, b.full_name AS buyer_name, s.full_name AS seller_name FROM deals d JOIN users b ON b.id=d.winner_user_id JOIN users s ON s.id=d.seller_id ORDER BY d.lot_id DESC`,
    );
  }

  async settingsAll() {
    return { values: await this.settings.all(), defaults: DEFAULT_SETTINGS };
  }
  async settingsSet(admin: User, key: string, value: unknown) {
    if (!(key in DEFAULT_SETTINGS)) fail('SETTING_UNKNOWN');
    const def = (DEFAULT_SETTINGS as any)[key];
    if (typeof def === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('SETTING_INVALID');
    const before = await this.settings.get(key as SettingKey);
    await this.settings.set(key as SettingKey, value, admin.id);
    await this.audit.log(admin.id, 'settings.changed', 'setting', key, { value: before }, { value });
    return { ok: true };
  }

  plans() {
    return this.db.q('SELECT * FROM plans ORDER BY price');
  }
  async planUpdate(admin: User, id: number, body: { price?: number; max_start_price?: number | null; is_active?: boolean }) {
    const before = await this.db.maybe('SELECT * FROM plans WHERE id=$1', [id]);
    if (!before) fail('NOT_FOUND', 404);
    // уже купленные доступы сохраняют свои условия (копия в subscriptions)
    const after = await this.db.one(
      `UPDATE plans SET price=coalesce($2,price), max_start_price=CASE WHEN $3::boolean THEN $4 ELSE max_start_price END, is_active=coalesce($5,is_active) WHERE id=$1 RETURNING *`,
      [id, body.price ?? null, 'max_start_price' in body, body.max_start_price ?? null, body.is_active ?? null],
    );
    await this.audit.log(admin.id, 'plan.updated', 'plan', id, before, after);
    return after;
  }

  audit_(limit = 300) {
    return this.db.q('SELECT a.*, u.username, u.full_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT $1', [limit]);
  }

  notifications() {
    // тела запечатанных писем (квитанции со ставкой) не показываются
    return this.db.q(
      `SELECT id, user_id, channel, to_addr, template, status, attempts, last_error, sent_at, created_at, CASE WHEN sealed THEN '[sealed]' ELSE subject END AS subject FROM notifications ORDER BY id DESC LIMIT 300`,
    );
  }

  risk() {
    return this.db.q(
      `SELECT f.*, u.full_name, u.phone,
        (SELECT count(*)::int FROM deals d WHERE d.winner_user_id=f.user_id) AS wins,
        (SELECT count(*)::int FROM sanctions s WHERE s.user_id=f.user_id AND s.strike_no IS NOT NULL AND s.voided_at IS NULL) AS refusals
       FROM risk_flags f JOIN users u ON u.id=f.user_id ORDER BY (f.status='open') DESC, f.id DESC LIMIT 300`,
    );
  }

  async fundsProofs() {
    const rows = await this.db.q(`SELECT f.*, u.full_name, u.phone FROM funds_proofs f JOIN users u ON u.id=f.user_id ORDER BY (f.status='pending') DESC, f.id DESC`);
    const now = this.clock.now();
    return rows.map((r) => ({ ...r, url: r.storage_key !== 'deleted' ? this.storage.signedUrl(r.storage_key, now) : null, storage_key: undefined }));
  }

  sanctions() {
    return this.db.q(`SELECT s.*, u.full_name FROM sanctions s JOIN users u ON u.id=s.user_id ORDER BY s.id DESC LIMIT 300`);
  }

  // ----- SC-19 Споры -----
  disputes() {
    return this.db.q(`SELECT d.*, u.full_name, u.phone FROM disputes d JOIN users u ON u.id=d.user_id ORDER BY (d.status='open') DESC, d.id DESC`);
  }
  /** Сверка квитанции участника с журналом ставок: контрольный код должен совпасть. */
  async verifyDispute(id: number) {
    const d = await this.db.maybe('SELECT * FROM disputes WHERE id=$1', [id]);
    if (!d) fail('NOT_FOUND', 404);
    const bid = await this.db.maybe('SELECT id, amount, salt, commitment, receipt_no, server_received_at FROM bids WHERE lot_id=$1 AND user_id=$2', [d.lot_id, d.user_id]);
    const logged = bid ? await this.db.maybe(`SELECT after FROM audit_log WHERE action='bid.placed' AND entity_id=$1`, [bid.id]) : null;
    const recomputed = bid && bid.amount !== null ? commitmentOf(bid.amount, bid.salt, bid.id) : null;
    return {
      dispute: d,
      bid: bid ? { receiptNo: bid.receipt_no, serverReceivedAt: bid.server_received_at, amount: bid.amount, commitment: bid.commitment } : null,
      checks: {
        receiptCommitmentMatchesDb: !!bid && (d.commitment || '').trim() === bid.commitment,
        dbMatchesAuditLog: !!bid && logged?.after?.commitment === bid.commitment,
        commitmentRecomputes: !!recomputed && recomputed === bid?.commitment,
      },
    };
  }
  async replyDispute(staff: User, id: number, reply: string) {
    if (!reply) fail('COMMENT_REQUIRED');
    const d = await this.db.maybe('SELECT * FROM disputes WHERE id=$1', [id]);
    if (!d) fail('NOT_FOUND', 404);
    await this.db.q(`UPDATE disputes SET status='answered', admin_reply=$2, answered_at=$3 WHERE id=$1`, [id, reply, this.clock.now()]);
    await this.audit.log(staff.id, 'dispute.answered', 'dispute', id, null, { reply });
    await this.notify.queue(d.user_id, 'email', 'dispute_answered', { lotId: d.lot_id, reply });
    return { ok: true };
  }

  // ----- SC-18 Сбои -----
  outages() {
    return this.db.q('SELECT * FROM outages ORDER BY id DESC');
  }
  async applyOutage(admin: User, id: number, apply: boolean) {
    const o = await this.db.maybe('SELECT * FROM outages WHERE id=$1', [id]);
    if (!o || o.status !== 'detected') fail('NOT_FOUND', 404);
    const s = await this.settings.all();
    await this.db.tx(async (t) => {
      if (apply) {
        for (const lotId of o.lot_ids as number[]) {
          const l = await t.one(`UPDATE lots SET closes_at=closes_at + ($2 || ' hours')::interval, extended_at=$3 WHERE id=$1 RETURNING closes_at`, [lotId, String(s.outage_extend_hours), this.clock.now()]);
          const users = await t.q<{ user_id: number }>(`SELECT user_id FROM deposits WHERE lot_id=$1 AND status IN ('pending','held') UNION SELECT user_id FROM bids WHERE lot_id=$1 UNION SELECT seller_id FROM lots WHERE id=$1`, [lotId]);
          for (const u of users) await this.notify.queue(u.user_id, 'sms', 'lot_extended', { lotId, closesAt: fmtYerevan(l.closes_at) }, { dedupeKey: `extended:${id}:${lotId}:${u.user_id}` }, t);
        }
      }
      await t.q(`UPDATE outages SET status=$2, decided_by=$3 WHERE id=$1`, [id, apply ? 'applied' : 'dismissed', admin.id]);
      await this.audit.log(admin.id, apply ? 'outage.applied' : 'outage.dismissed', 'outage', id, null, { lots: o.lot_ids, hours: s.outage_extend_hours }, t);
    });
    return { ok: true };
  }

  /** 6A.2: доказанный подставной участник продавца — лот недействителен. */
  async invalidateLot(admin: User, lotId: number, reason: string) {
    if (!reason) fail('REASON_REQUIRED');
    await this.db.tx(async (t) => {
      const l = await t.maybe('SELECT * FROM lots WHERE id=$1 FOR UPDATE', [lotId]);
      if (!l || !['finished', 'no_sale'].includes(l.status)) fail('LOT_NOT_INVALIDATABLE');
      const deal = await t.maybe('SELECT * FROM deals WHERE lot_id=$1', [lotId]);
      if (!deal) fail('DEAL_NOT_FOUND');
      await t.q(`UPDATE lots SET status='invalidated', ended_reason=$2 WHERE id=$1`, [lotId, 'invalidated: ' + reason]);
      await t.q(`UPDATE deals SET status='invalidated', closed_at=$2, fail_reason=$3 WHERE lot_id=$1`, [lotId, this.clock.now(), reason]);
      await this.deposits.markReleasing(`lot_id=$1 AND user_id<>$2 AND status IN ('held','pending')`, [lotId, deal.winner_user_id], t);
      await t.q(`UPDATE deposits SET status='disputed', updated_at=$3 WHERE lot_id=$1 AND user_id=$2 AND status='held'`, [lotId, deal.winner_user_id, this.clock.now()]);
      await t.q(`UPDATE users SET status='blocked', seller_blocked=true, seller_block_reason='INVALIDATED_LOT' WHERE id = ANY($1)`, [[l.seller_id, deal.winner_user_id]]);
      const users = await t.q<{ user_id: number }>(`SELECT DISTINCT user_id FROM bids WHERE lot_id=$1`, [lotId]);
      for (const u of users) await this.notify.queue(u.user_id, 'email', 'lot_invalidated', { lotId, reason }, { dedupeKey: `invalid:${lotId}:${u.user_id}` }, t);
      await this.audit.log(admin.id, 'lot.invalidated', 'lot', lotId, { status: l.status }, { reason }, t);
    });
    await this.deposits.processReleases();
    return { ok: true };
  }

  async createOutage(admin: User, startedAt: string, endedAt: string, recorder: (s: Date, e: Date, a: number) => Promise<any>) {
    const s = new Date(startedAt);
    const e = new Date(endedAt);
    if (!(e.getTime() > s.getTime())) fail('VALIDATION');
    const min = await this.settings.get('outage_threshold_min');
    if (e.getTime() - s.getTime() < min * 60_000) fail('OUTAGE_TOO_SHORT', 400, { minMinutes: min });
    void HOUR;
    return recorder(s, e, admin.id);
  }
}
