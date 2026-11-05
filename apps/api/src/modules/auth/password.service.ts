import { Injectable } from '@nestjs/common';
import crypto from 'crypto';
import type { Response } from 'express';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Db } from '../../common/db';
import { Clock } from '../../common/clock';
import { fail } from '../../common/errors';
import { codeHash, randomDigits, randomToken, sha256 } from '../../common/hash';
import { SettingsService } from '../../common/settings';
import { Audit } from '../../common/audit';
import { rateLimit } from '../../common/ratelimit';
import { NotifyService } from '../notifications/notify.service';
import { AuthService, normalizePhone, User } from './auth.service';

type Login = { kind: 'email'; email: string } | { kind: 'phone'; phone: string };

/** «email или телефон» в одном поле: есть @ — email, иначе армянский номер. */
export function parseLogin(raw: string): Login {
  const v = String(raw || '').trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) fail('EMAIL_INVALID');
    return { kind: 'email', email };
  }
  return { kind: 'phone', phone: normalizePhone(v) };
}

/** PRD v2 решение 1: регистрация и вход по email или телефону + пароль, подтверждение кодом, «забыли пароль». */
@Injectable()
export class PasswordAuthService {
  constructor(
    private db: Db,
    private clock: Clock,
    private settings: SettingsService,
    private audit: Audit,
    private notify: NotifyService,
    private auth: AuthService,
  ) {}

  private async checkPassword(pw: unknown) {
    const s = await this.settings.all();
    const p = String(pw ?? '');
    if (p.length < Number(s.password_min_length ?? 8) || p.length > 200 || !/[A-Za-zЀ-ӿ԰-֏]/.test(p) || !/\d/.test(p)) {
      fail('PASSWORD_WEAK', 400, { minLength: Number(s.password_min_length ?? 8) });
    }
    return p;
  }

  private findUser(l: Login) {
    return l.kind === 'email'
      ? this.db.maybe<User & { password_hash: string | null; phone_verified_at: Date | null; login_failed: number; login_locked_until: Date | null }>(
          `SELECT * FROM users WHERE lower(email)=$1 AND role='user'`,
          [l.email],
        )
      : this.db.maybe<User & { password_hash: string | null; phone_verified_at: Date | null; login_failed: number; login_locked_until: Date | null }>(
          `SELECT * FROM users WHERE phone=$1 AND role='user'`,
          [l.phone],
        );
  }
  private confirmed(u: any, l: Login) {
    return l.kind === 'email' ? !!u.email_verified_at : !!u.phone_verified_at;
  }

  // ---------- Регистрация ----------
  async register(body: { login: string; password: string; lang?: string; acceptTerms?: boolean }, ip: string) {
    rateLimit('register-ip:' + ip, 10, 10 * 60_000);
    const l = parseLogin(body.login);
    const pw = await this.checkPassword(body.password);
    if (!body.acceptTerms) fail('CONSENT_REQUIRED', 400, { missing: ['terms', 'privacy'] });
    const lang = ['hy', 'ru', 'en'].includes(body.lang ?? '') ? body.lang : 'hy';
    const hash = await argonHash(pw);
    const existing = await this.findUser(l);
    let userId: number;
    if (existing) {
      // контакт уже подтверждён — это чужой (или свой) аккаунт: только вход или «забыли пароль»
      if (this.confirmed(existing, l)) fail('LOGIN_TAKEN', 409);
      // регистрация не завершена — можно повторить с новым паролем, код придёт снова
      await this.db.q('UPDATE users SET password_hash=$2, lang=$3 WHERE id=$1', [existing.id, hash, lang]);
      userId = existing.id;
    } else {
      const now = this.clock.now();
      const u =
        l.kind === 'email'
          ? await this.db.one<{ id: number }>(`INSERT INTO users(email, password_hash, lang, kyc_level, created_at) VALUES ($1,$2,$3,0,$4) RETURNING id`, [l.email, hash, lang, now])
          : await this.db.one<{ id: number }>(`INSERT INTO users(phone, password_hash, lang, kyc_level, created_at) VALUES ($1,$2,$3,0,$4) RETURNING id`, [l.phone, hash, lang, now]);
      userId = u.id;
      await this.audit.log(userId, 'user.register', 'user', userId, null, { via: l.kind });
    }
    await this.auth.accept(userId, ['terms', 'privacy']);
    return { channel: l.kind, ...(await this.sendConfirmCode(l, userId, ip)) };
  }

  async resend(loginRaw: string, ip: string) {
    const l = parseLogin(loginRaw);
    const u = await this.findUser(l);
    if (!u || this.confirmed(u, l)) return { ok: true }; // не раскрываем, есть ли такой аккаунт
    return { ok: true, ...(await this.sendConfirmCode(l, u.id, ip)) };
  }

  private async sendConfirmCode(l: Login, userId: number, ip: string) {
    if (l.kind === 'phone') {
      const r = await this.auth.sendCode(l.phone, 'register', null, userId, ip);
      return { expiresInSec: r.expiresInSec, resendInSec: r.resendInSec, ...(r.devCode ? { devCode: r.devCode } : {}) };
    }
    rateLimit('email-code-ip:' + ip, 20, 10 * 60_000);
    const s = await this.settings.all();
    const now = this.clock.now();
    const last = await this.db.maybe<{ created_at: Date }>(`SELECT created_at FROM email_codes WHERE email=$1 AND purpose='register' ORDER BY id DESC LIMIT 1`, [l.email]);
    if (last && now.getTime() - new Date(last.created_at).getTime() < s.otp_resend_sec * 1000) fail('OTP_RESEND_TOO_SOON', 429);
    const code = randomDigits(6);
    const ttlMin = Number(s.email_code_ttl_min ?? 10);
    await this.db.q(`INSERT INTO email_codes(email, purpose, code_hash, expires_at, created_at) VALUES ($1,'register',$2,$3,$4)`, [
      l.email,
      codeHash(l.email + ':' + code),
      new Date(now.getTime() + ttlMin * 60_000),
      now,
    ]);
    await this.notify.queue(userId, 'email', 'register_code', { code, minutes: ttlMin }, { toAddr: l.email });
    return { expiresInSec: ttlMin * 60, resendInSec: s.otp_resend_sec, ...(this.auth.devCodes() ? { devCode: code } : {}) };
  }

  /** Код верный → контакт подтверждён, пользователь сразу вошёл (статус — «не проверен»). */
  async confirm(body: { login: string; code: string }, device: string, res: Response) {
    const l = parseLogin(body.login);
    const u = await this.findUser(l);
    if (!u) fail('OTP_NOT_FOUND');
    const now = this.clock.now();
    if (l.kind === 'phone') {
      await this.auth.checkCode(l.phone, 'register', body.code, null);
      await this.db.q('UPDATE users SET phone_verified_at=$2 WHERE id=$1', [u!.id, now]);
    } else {
      const s = await this.settings.all();
      const row = await this.db.maybe<{ id: number; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
        `SELECT * FROM email_codes WHERE email=$1 AND purpose='register' ORDER BY id DESC LIMIT 1`,
        [l.email],
      );
      if (!row || row.consumed_at) fail('OTP_NOT_FOUND');
      if (row!.attempts >= s.otp_attempts) fail('OTP_TOO_MANY_ATTEMPTS', 429);
      if (new Date(row!.expires_at).getTime() <= now.getTime()) fail('OTP_EXPIRED');
      const ok = crypto.timingSafeEqual(Buffer.from(row!.code_hash), Buffer.from(codeHash(l.email + ':' + String(body.code ?? '').trim())));
      if (!ok) {
        await this.db.q('UPDATE email_codes SET attempts=attempts+1 WHERE id=$1', [row!.id]);
        fail('OTP_INVALID', 400, { attemptsLeft: Math.max(0, s.otp_attempts - row!.attempts - 1) });
      }
      await this.db.q('UPDATE email_codes SET consumed_at=$2 WHERE id=$1', [row!.id, now]);
      await this.db.q('UPDATE users SET email_verified_at=$2, kyc_level=GREATEST(kyc_level,1) WHERE id=$1', [u!.id, now]);
    }
    await this.audit.log(u!.id, 'user.contact_confirmed', 'user', u!.id, null, { via: l.kind });
    await this.auth.createSession(u!.id, 'user', device, res);
    return { ok: true, needsConsents: await this.auth.missingConsents(u!.id) };
  }

  // ---------- Вход по паролю ----------
  async login(body: { login: string; password: string }, device: string, ip: string, res: Response) {
    rateLimit('login-ip:' + ip, 30, 10 * 60_000);
    const l = parseLogin(body.login);
    const s = await this.settings.all();
    const u = await this.findUser(l);
    const now = this.clock.now();
    if (u?.login_locked_until && new Date(u.login_locked_until).getTime() > now.getTime()) {
      fail('LOGIN_LOCKED', 429, { until: u.login_locked_until });
    }
    const ok = u?.password_hash ? await argonVerify(u.password_hash, String(body.password ?? '')).catch(() => false) : false;
    if (!ok) {
      const max = Number(s.login_max_attempts ?? 5);
      if (u) {
        const failed = u.login_failed + 1;
        const lock = failed >= max ? new Date(now.getTime() + Number(s.login_lock_min ?? 15) * 60_000) : null;
        await this.db.q('UPDATE users SET login_failed=$2, login_locked_until=$3 WHERE id=$1', [u.id, lock ? 0 : failed, lock]);
        if (lock) {
          await this.audit.log(u.id, 'user.login_locked', 'user', u.id);
          fail('LOGIN_LOCKED', 429, { until: lock });
        }
        fail('INVALID_CREDENTIALS', 401, { attemptsLeft: max - failed });
      }
      fail('INVALID_CREDENTIALS', 401); // нет такого аккаунта — тот же ответ
    }
    if (!this.confirmed(u, l)) fail('CONTACT_NOT_CONFIRMED', 403, { channel: l.kind });
    if (u!.status === 'blocked') fail('USER_BLOCKED', 403);
    await this.db.q('UPDATE users SET login_failed=0, login_locked_until=NULL WHERE id=$1', [u!.id]);
    await this.auth.createSession(u!.id, 'user', device, res);
    return { ok: true, needsConsents: await this.auth.missingConsents(u!.id) };
  }

  // ---------- «Забыли пароль» ----------
  /** Ответ всегда одинаковый — по нему нельзя понять, зарегистрирован ли адрес. */
  async forgot(loginRaw: string, ip: string) {
    rateLimit('forgot-ip:' + ip, 10, 10 * 60_000);
    const l = parseLogin(loginRaw);
    const u = await this.findUser(l);
    const s = await this.settings.all();
    const ttl = Number(s.reset_ttl_min ?? 30);
    let devToken: string | undefined;
    if (u && this.confirmed(u, l)) {
      rateLimit('forgot-user:' + u.id, 3, 10 * 60_000);
      const token = randomToken(32);
      const now = this.clock.now();
      await this.db.q(`INSERT INTO password_resets(user_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4)`, [u.id, sha256(token), new Date(now.getTime() + ttl * 60_000), now]);
      const link = `${process.env.WEB_URL || 'http://localhost:3000'}/reset-password?token=${token}`;
      await this.notify.queue(u.id, l.kind === 'email' ? 'email' : 'sms', 'password_reset', { link, minutes: ttl }, { toAddr: l.kind === 'email' ? l.email : l.phone });
      await this.audit.log(u.id, 'user.password_reset_requested', 'user', u.id, null, { via: l.kind });
      if (this.auth.devCodes()) devToken = token;
    }
    return { ok: true, ttlMin: ttl, ...(devToken ? { devToken } : {}) };
  }

  /** Новый пароль по ссылке: ссылка одноразовая, все сессии пользователя завершаются. */
  async reset(body: { token: string; password: string }) {
    const pw = await this.checkPassword(body.password);
    const now = this.clock.now();
    const r = await this.db.maybe<{ id: number; user_id: number; expires_at: Date; used_at: Date | null }>('SELECT * FROM password_resets WHERE token_hash=$1', [sha256(String(body.token ?? ''))]);
    if (!r || r.used_at || new Date(r.expires_at).getTime() <= now.getTime()) fail('RESET_LINK_INVALID', 400);
    const hash = await argonHash(pw);
    await this.db.tx(async (t) => {
      await t.q('UPDATE password_resets SET used_at=$2 WHERE id=$1', [r!.id, now]);
      await t.q('UPDATE users SET password_hash=$2, login_failed=0, login_locked_until=NULL WHERE id=$1', [r!.user_id, hash]);
      await t.q('UPDATE sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL', [r!.user_id, now]);
      await this.audit.log(r!.user_id, 'user.password_reset', 'user', r!.user_id, null, null, t);
    });
    return { ok: true };
  }
}
