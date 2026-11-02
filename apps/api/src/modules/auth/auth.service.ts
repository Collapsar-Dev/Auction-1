import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { verify as argonVerify } from '@node-rs/argon2';
import { Db, Queryable } from '../../common/db';
import { Clock, DAY } from '../../common/clock';
import { AppError, fail } from '../../common/errors';
import { codeHash, hmac, randomDigits, randomToken, secret, sha256 } from '../../common/hash';
import { SettingsService } from '../../common/settings';
import { NotifyService } from '../notifications/notify.service';
import { Audit } from '../../common/audit';
import { verifyTotp } from '../../common/totp';
import { rateLimit } from '../../common/ratelimit';

export interface User {
  id: number;
  phone: string | null;
  email: string | null;
  email_verified_at: Date | null;
  lang: 'hy' | 'ru' | 'en';
  kyc_level: number;
  kyc_status: string;
  kyc_reject_reason: string | null;
  full_name: string | null;
  birth_date: string | null;
  doc_hash: string | null;
  status: string;
  role: 'user' | 'moderator' | 'admin';
  username: string | null;
  seller_blocked: boolean;
  seller_block_reason: string | null;
  phone_changed_at: Date | null;
  created_at: Date;
  session_id?: string;
  session_kind?: 'user' | 'staff';
}

export const STEP_UP_ACTIONS = ['bid', 'deposit', 'card_bind', 'card_delete', 'deal_confirm', 'phone_change', 'subscription'] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];
export const REQUIRED_LOGIN_CONSENTS = ['terms', 'privacy'] as const;

const ACCESS_TTL_MS = 15 * 60_000; // AU-02
const REFRESH_TTL_MS = 30 * DAY;
const STAFF_TTL_MS = 8 * 3600_000; // AU-05

export const normalizePhone = (p: string) => {
  const d = (p || '').replace(/[^\d+]/g, '');
  const digits = d.replace(/\D/g, '');
  let local = digits;
  if (digits.startsWith('374')) local = digits.slice(3);
  else if (digits.startsWith('0')) local = digits.slice(1);
  if (!/^\d{8}$/.test(local)) fail('PHONE_INVALID');
  return '+374' + local;
};

@Injectable()
export class AuthService {
  constructor(private db: Db, private clock: Clock, private settings: SettingsService, private notify: NotifyService, private audit: Audit) {}

  devCodes() {
    return process.env.DEV_SHOW_CODES === 'true' || process.env.NODE_ENV === 'test';
  }

  // ---------- SMS-коды (AU-01) ----------
  async sendCode(phoneRaw: string, purpose: 'login' | 'step_up' | 'phone_old' | 'phone_new', action: string | null, userId: number | null, ip = '') {
    const phone = normalizePhone(phoneRaw);
    rateLimit('otp-ip:' + ip, 20, 10 * 60_000);
    const s = await this.settings.all();
    const now = this.clock.now();
    const last = await this.db.maybe<{ created_at: Date }>(`SELECT created_at FROM otp_codes WHERE phone=$1 AND purpose=$2 ORDER BY created_at DESC, id DESC LIMIT 1`, [phone, purpose]);
    if (last && now.getTime() - new Date(last.created_at).getTime() < s.otp_resend_sec * 1000) {
      fail('OTP_RESEND_TOO_SOON', 429, { retryAfterSec: Math.ceil((s.otp_resend_sec * 1000 - (now.getTime() - new Date(last.created_at).getTime())) / 1000) });
    }
    const daily = await this.db.one<{ c: number }>(`SELECT count(*)::int AS c FROM otp_codes WHERE phone=$1 AND created_at > $2`, [phone, new Date(now.getTime() - DAY)]);
    if (daily.c >= s.otp_daily_max) fail('OTP_DAILY_LIMIT', 429);
    const code = randomDigits(6);
    await this.db.q(`INSERT INTO otp_codes(phone, purpose, action, code_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      phone,
      purpose,
      action,
      codeHash(phone + ':' + code),
      new Date(now.getTime() + s.otp_ttl_sec * 1000),
      now,
    ]);
    const tpl = purpose === 'login' ? 'otp_login' : purpose === 'step_up' ? 'otp_step_up' : 'phone_change_code';
    const known = userId ?? (await this.db.maybe<{ id: number }>('SELECT id FROM users WHERE phone=$1', [phone]))?.id ?? null;
    await this.notify.queue(known, 'sms', tpl, { code, action }, { toAddr: phone });
    return { phone, expiresInSec: s.otp_ttl_sec, resendInSec: s.otp_resend_sec, ...(this.devCodes() ? { devCode: code } : {}) };
  }

  async checkCode(phoneRaw: string, purpose: string, code: string, action: string | null) {
    const phone = normalizePhone(phoneRaw);
    const s = await this.settings.all();
    const row = await this.db.maybe<{ id: number; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null; action: string | null }>(
      `SELECT id, code_hash, attempts, expires_at, consumed_at, action FROM otp_codes WHERE phone=$1 AND purpose=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [phone, purpose],
    );
    if (!row || row.consumed_at) fail('OTP_NOT_FOUND');
    if (action !== null && row!.action !== action) fail('OTP_NOT_FOUND');
    if (row!.attempts >= s.otp_attempts) fail('OTP_TOO_MANY_ATTEMPTS', 429);
    if (new Date(row!.expires_at).getTime() <= this.clock.ms()) fail('OTP_EXPIRED');
    const ok = crypto.timingSafeEqual(Buffer.from(row!.code_hash), Buffer.from(codeHash(phone + ':' + String(code).trim())));
    if (!ok) {
      await this.db.q('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1', [row!.id]);
      fail('OTP_INVALID', 400, { attemptsLeft: Math.max(0, s.otp_attempts - row!.attempts - 1) });
    }
    await this.db.q('UPDATE otp_codes SET consumed_at=$2 WHERE id=$1', [row!.id, this.clock.now()]);
    return phone;
  }

  // ---------- Вход (SC-01) ----------
  async verifyLogin(phoneRaw: string, code: string, device: string, res: Response, lang?: string) {
    const phone = await this.checkCode(phoneRaw, 'login', code, null);
    let user = await this.db.maybe<User>('SELECT * FROM users WHERE phone=$1', [phone]);
    const isNew = !user;
    if (!user) {
      user = await this.db.one<User>(`INSERT INTO users(phone, lang, kyc_level, created_at) VALUES ($1,$2,0,$3) RETURNING *`, [phone, ['hy', 'ru', 'en'].includes(lang ?? '') ? lang : 'hy', this.clock.now()]);
      await this.audit.log(user.id, 'user.register', 'user', user.id);
    }
    if (user.status === 'blocked') fail('USER_BLOCKED', 403);
    await this.createSession(user.id, 'user', device, res);
    return { isNew, needsConsents: await this.missingConsents(user.id) };
  }

  sign(payload: object) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + hmac(secret(), body);
  }
  unsign<T>(token: string): T | null {
    const [body, sig] = (token || '').split('.');
    if (!body || !sig) return null;
    const good = hmac(secret(), body);
    if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString());
    } catch {
      return null;
    }
  }

  private cookieOpts(maxAge: number, path = '/') {
    return { httpOnly: true, sameSite: 'lax' as const, secure: process.env.COOKIE_SECURE === 'true', maxAge, path };
  }

  async createSession(userId: number, kind: 'user' | 'staff', device: string, res: Response) {
    const sid = crypto.randomUUID();
    const now = this.clock.ms();
    const ttl = kind === 'staff' ? STAFF_TTL_MS : REFRESH_TTL_MS;
    let refresh: string | null = null;
    if (kind === 'user') refresh = sid + '.' + randomToken();
    await this.db.q(`INSERT INTO sessions(id, user_id, kind, refresh_hash, device, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      sid,
      userId,
      kind,
      refresh ? sha256(refresh) : null,
      device.slice(0, 200),
      new Date(now + ttl),
      new Date(now),
    ]);
    const accessTtl = kind === 'staff' ? STAFF_TTL_MS : ACCESS_TTL_MS;
    res.cookie('at', this.sign({ sid, uid: userId, kind, exp: now + accessTtl }), this.cookieOpts(accessTtl));
    if (refresh) res.cookie('rt', refresh, this.cookieOpts(REFRESH_TTL_MS, '/api/auth'));
    return sid;
  }

  /** AU-02: каждый refresh заменяет долгий токен; повторное использование старого → выход со всех устройств. */
  async refresh(req: Request, res: Response) {
    const rt: string = req.cookies?.rt;
    if (!rt) fail('UNAUTHORIZED', 401);
    const sid = rt.split('.')[0];
    const s = await this.db.maybe<{ id: string; user_id: number; refresh_hash: string; expires_at: Date; revoked_at: Date | null }>('SELECT * FROM sessions WHERE id=$1', [sid]);
    if (!s || s.revoked_at || new Date(s.expires_at).getTime() < this.clock.ms()) fail('UNAUTHORIZED', 401);
    const h = sha256(rt);
    if (h !== s!.refresh_hash) {
      const reused = await this.db.maybe('SELECT 1 FROM refresh_history WHERE token_hash=$1', [h]);
      if (reused) {
        await this.db.q('UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [s!.user_id, this.clock.now()]);
        await this.audit.log(s!.user_id, 'session.reuse_detected', 'session', sid);
        res.clearCookie('at', { path: '/' });
        res.clearCookie('rt', { path: '/api/auth' });
        fail('SESSION_REUSE', 401);
      }
      fail('UNAUTHORIZED', 401);
    }
    const next = sid + '.' + randomToken();
    await this.db.tx(async (t) => {
      await t.q('INSERT INTO refresh_history(token_hash, session_id, used_at) VALUES ($1,$2,$3)', [h, sid, this.clock.now()]);
      await t.q('UPDATE sessions SET refresh_hash=$2 WHERE id=$1', [sid, sha256(next)]);
    });
    const now = this.clock.ms();
    res.cookie('at', this.sign({ sid, uid: s!.user_id, kind: 'user', exp: now + ACCESS_TTL_MS }), this.cookieOpts(ACCESS_TTL_MS));
    res.cookie('rt', next, this.cookieOpts(REFRESH_TTL_MS, '/api/auth'));
    return { ok: true };
  }

  async logout(req: Request, res: Response) {
    const u = await this.optionalUser(req);
    if (u?.session_id) await this.db.q('UPDATE sessions SET revoked_at=$2 WHERE id=$1', [u.session_id, this.clock.now()]);
    res.clearCookie('at', { path: '/' });
    res.clearCookie('rt', { path: '/api/auth' });
    return { ok: true };
  }

  async optionalUser(req: Request): Promise<User | null> {
    const raw = req.cookies?.at || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '');
    if (!raw) return null;
    const p = this.unsign<{ sid: string; uid: number; kind: 'user' | 'staff'; exp: number }>(raw);
    if (!p || p.exp < this.clock.ms()) return null;
    const row = await this.db.maybe<User & { revoked_at: Date | null; expires_at: Date }>(
      `SELECT u.*, s.revoked_at, s.expires_at, s.id AS session_id, s.kind AS session_kind FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1`,
      [p.sid],
    );
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < this.clock.ms()) return null;
    return row;
  }

  /** Вошедший пользователь. По умолчанию требует обязательные согласия (SC-01, AU-08). */
  async user(req: Request, opts: { allowNoConsent?: boolean } = {}): Promise<User> {
    const u = await this.optionalUser(req);
    if (!u) throw new AppError('UNAUTHORIZED', 401);
    if (u.status === 'blocked') throw new AppError('USER_BLOCKED', 403);
    if (!opts.allowNoConsent && u.session_kind === 'user') {
      const missing = await this.missingConsents(u.id);
      if (missing.length) throw new AppError('CONSENT_REQUIRED', 403, { missing });
    }
    return u;
  }

  async staff(req: Request, role: 'moderator' | 'admin' = 'moderator'): Promise<User> {
    const u = await this.user(req, { allowNoConsent: true });
    if (u.session_kind !== 'staff') fail('STAFF_ONLY', 403);
    if (role === 'admin' && u.role !== 'admin') fail('ADMIN_ONLY', 403);
    if (role === 'moderator' && !['moderator', 'admin'].includes(u.role)) fail('STAFF_ONLY', 403);
    return u;
  }

  // ---------- Согласия (AU-08) ----------
  async missingConsents(userId: number, kinds: readonly string[] = REQUIRED_LOGIN_CONSENTS) {
    const versions = await this.settings.get('consent_versions');
    const rows = await this.db.q<{ kind: string; version: string }>('SELECT kind, version FROM consents WHERE user_id=$1', [userId]);
    return kinds.filter((k) => !rows.some((r) => r.kind === k && r.version === (versions as any)[k]));
  }
  async accept(userId: number, kinds: string[], t: Queryable = this.db) {
    const versions: any = await this.settings.get('consent_versions', t);
    for (const k of kinds) {
      if (!versions[k]) fail('CONSENT_UNKNOWN');
      await t.q('INSERT INTO consents(user_id, kind, version, accepted_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, k, versions[k], this.clock.now()]);
    }
  }

  // ---------- Повторный SMS-код (AU-03) ----------
  async stepUpRequest(user: User, action: StepUpAction, ip: string) {
    if (!STEP_UP_ACTIONS.includes(action)) fail('STEP_UP_ACTION_UNKNOWN');
    rateLimit('stepup:' + user.id, 10, 10 * 60_000);
    return this.sendCode(user.phone!, 'step_up', action, user.id, ip);
  }
  async stepUpVerify(user: User, action: StepUpAction, code: string) {
    await this.checkCode(user.phone!, 'step_up', code, action);
    const token = randomToken();
    const ttl = await this.settings.get('stepup_ttl_sec');
    await this.db.q('INSERT INTO step_up_tokens(token_hash, user_id, action, expires_at) VALUES ($1,$2,$3,$4)', [sha256(token), user.id, action, new Date(this.clock.ms() + ttl * 1000)]);
    return { stepUpToken: token, expiresInSec: ttl };
  }
  /** Подтверждение действует 5 мин и только на одно это действие. Вызывать внутри транзакции действия. */
  async consumeStepUp(user: User, action: StepUpAction, token: string | undefined, t: Queryable) {
    if (!token) fail('STEP_UP_REQUIRED', 403, { action });
    const r = await t.maybe<{ token_hash: string }>(
      `UPDATE step_up_tokens SET used_at=$4 WHERE token_hash=$1 AND user_id=$2 AND action=$3 AND used_at IS NULL AND expires_at > $4 RETURNING token_hash`,
      [sha256(token!), user.id, action, this.clock.now()],
    );
    if (!r) fail('STEP_UP_REQUIRED', 403, { action });
  }

  // ---------- Сотрудники (AU-05) ----------
  async staffLogin(username: string, password: string, code: string, device: string, ip: string, res: Response) {
    rateLimit('staff-ip:' + ip, 10, 10 * 60_000);
    const u = await this.db.maybe<User & { password_hash: string; totp_secret: string }>(`SELECT * FROM users WHERE username=$1 AND role IN ('moderator','admin')`, [username]);
    const okPass = u?.password_hash ? await argonVerify(u.password_hash, password).catch(() => false) : false;
    if (!u || !okPass || !u.totp_secret || !verifyTotp(u.totp_secret, String(code), this.clock.ms())) {
      await this.audit.log(u?.id ?? null, 'staff.login_failed', 'user', u?.id ?? null, null, { username });
      fail('STAFF_LOGIN_FAILED', 401);
    }
    if (u!.status === 'blocked') fail('USER_BLOCKED', 403);
    await this.createSession(u!.id, 'staff', device, res);
    await this.audit.log(u!.id, 'staff.login', 'user', u!.id);
    return { ok: true, role: u!.role };
  }

  // ---------- Смена телефона (AU-04) ----------
  async phoneChangeStart(user: User, newPhoneRaw: string, ip: string) {
    const newPhone = normalizePhone(newPhoneRaw);
    if (await this.db.maybe('SELECT 1 FROM users WHERE phone=$1', [newPhone])) fail('PHONE_TAKEN');
    const a = await this.sendCode(user.phone!, 'phone_old', newPhone, user.id, ip);
    const b = await this.sendCode(newPhone, 'phone_new', newPhone, user.id, ip);
    return { ...(a.devCode ? { devCodeOld: a.devCode, devCodeNew: b.devCode } : {}) };
  }
  async phoneChangeConfirm(user: User, newPhoneRaw: string, codeOld: string, codeNew: string) {
    const newPhone = normalizePhone(newPhoneRaw);
    await this.checkCode(user.phone!, 'phone_old', codeOld, newPhone);
    await this.checkCode(newPhone, 'phone_new', codeNew, newPhone);
    await this.db.q('UPDATE users SET phone=$2, phone_changed_at=$3 WHERE id=$1', [user.id, newPhone, this.clock.now()]);
    await this.audit.log(user.id, 'user.phone_changed', 'user', user.id, { phone: user.phone }, { phone: newPhone });
    return { ok: true };
  }
}
