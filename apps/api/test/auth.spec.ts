import request from 'supertest';
import { H, STAFF_SECRET } from './helpers';
import { SettingsService } from '../src/common/settings';
import { totp } from '../src/common/totp';
import { DAY } from '../src/common/clock';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

describe('SC-01 Вход по телефону', () => {
  it('новый пользователь: код → вход → нужны согласия → после согласия доступ открыт', async () => {
    const a = request.agent(h.http);
    const otp = await a.post('/api/auth/otp').send({ phone: '+374 77 123456' }).expect(201);
    expect(otp.body.devCode).toMatch(/^\d{6}$/);
    const v = await a.post('/api/auth/verify').send({ phone: '+37477123456', code: otp.body.devCode }).expect(201);
    expect(v.body.isNew).toBe(true);
    expect(v.body.needsConsents).toEqual(['terms', 'privacy']);
    await a.get('/api/me/bids').expect(403); // без согласия дальше нельзя
    await a.post('/api/me/consents').send({ kinds: ['terms', 'privacy'] }).expect(201);
    await a.get('/api/me/bids').expect(200);
  });

  it('номер должен быть армянским', async () => {
    const r = await request(h.http).post('/api/auth/otp').send({ phone: '+7 999 1234567' });
    expect(r.body.error).toBe('PHONE_INVALID');
  });

  it('AU-01: неверный код — 5 попыток, затем блок; в базе только хэш', async () => {
    const phone = '+37455000001';
    const otp = await request(h.http).post('/api/auth/otp').send({ phone });
    const row = await h.db.one(`SELECT code_hash FROM otp_codes WHERE phone=$1`, [phone]);
    expect(row.code_hash).not.toContain(otp.body.devCode);
    for (let i = 0; i < 5; i++) {
      const r = await request(h.http).post('/api/auth/verify').send({ phone, code: '000000' === otp.body.devCode ? '111111' : '000000' });
      expect(r.body.error).toBe('OTP_INVALID');
      expect(r.body.attemptsLeft).toBe(4 - i);
    }
    const r = await request(h.http).post('/api/auth/verify').send({ phone, code: otp.body.devCode });
    expect(r.body.error).toBe('OTP_TOO_MANY_ATTEMPTS');
  });

  it('AU-01: код живёт 5 минут', async () => {
    const phone = '+37455000002';
    const otp = await request(h.http).post('/api/auth/otp').send({ phone });
    h.advance(5 * 60_000 + 1);
    const r = await request(h.http).post('/api/auth/verify').send({ phone, code: otp.body.devCode });
    expect(r.body.error).toBe('OTP_EXPIRED');
  });

  it('AU-01: повторная отправка не чаще раза в 60 с и не больше 10 в сутки', async () => {
    const s = h.get(SettingsService);
    await s.set('otp_resend_sec', 60, null);
    await s.set('otp_daily_max', 10, null);
    try {
      const phone = '+37455000003';
      await request(h.http).post('/api/auth/otp').send({ phone }).expect(201);
      const again = await request(h.http).post('/api/auth/otp').send({ phone });
      expect(again.body.error).toBe('OTP_RESEND_TOO_SOON');
      for (let i = 0; i < 9; i++) {
        h.advance(61_000);
        await request(h.http).post('/api/auth/otp').send({ phone }).expect(201);
      }
      h.advance(61_000);
      const over = await request(h.http).post('/api/auth/otp').send({ phone });
      expect(over.body.error).toBe('OTP_DAILY_LIMIT');
    } finally {
      await s.set('otp_resend_sec', 0, null);
      await s.set('otp_daily_max', 10000, null);
    }
  });
});

describe('AU-02 Сессии', () => {
  it('refresh заменяет долгий токен; повторное использование старого → выход со всех устройств', async () => {
    const u = await h.user();
    const first = await u.agent.post('/api/auth/refresh').expect(201);
    const oldRt = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('rt='))!;
    await u.agent.post('/api/auth/refresh').expect(201); // ротация: oldRt больше не текущий
    const thief = request(h.http);
    const reuse = await thief.post('/api/auth/refresh').set('Cookie', oldRt.split(';')[0]);
    expect(reuse.body.error).toBe('SESSION_REUSE');
    const sessions = await h.db.q(`SELECT revoked_at FROM sessions WHERE user_id=$1`, [u.id]);
    expect(sessions.every((s) => s.revoked_at)).toBe(true);
    await u.agent.get('/api/me').expect(401);
  });

  it('короткий токен живёт 15 минут', async () => {
    const u = await h.user();
    await u.agent.get('/api/me').expect(200);
    h.advance(15 * 60_000 + 1);
    await u.agent.get('/api/me').expect(401);
  });
});

describe('AU-03 Повторный SMS-код', () => {
  it('действует 5 минут и только на одно действие, один раз', async () => {
    const u = await h.user({ plan: 'full' });
    const tk = await h.stepUp(u.agent, 'card_bind');
    // не подходит для другого действия
    const wrong = await u.agent.post('/api/subscriptions').set('x-step-up', tk).send({ plan: 'basic' });
    expect(wrong.body.error).toBe('STEP_UP_REQUIRED');
    await u.agent.post('/api/cards/bind').set('x-step-up', tk).expect(201);
    const twice = await u.agent.post('/api/cards/bind').set('x-step-up', tk);
    expect(twice.body.error).toBe('STEP_UP_REQUIRED');
    const tk2 = await h.stepUp(u.agent, 'card_bind');
    h.advance(5 * 60_000 + 1);
    const late = await u.agent.post('/api/cards/bind').set('x-step-up', tk2);
    expect(late.body.error).toBe('STEP_UP_REQUIRED');
  });
});

describe('AU-04 Смена телефона', () => {
  it('нужны коды со старого и нового номера; 7 дней нельзя привязать карту', async () => {
    const u = await h.user();
    const start = await u.agent.post('/api/me/phone/start').send({ phone: '+37499888777' }).expect(201);
    await u.agent.post('/api/me/phone/confirm').send({ phone: '+37499888777', codeOld: '000000', codeNew: start.body.devCodeNew }).expect(400);
    await u.agent.post('/api/me/phone/start').send({ phone: '+37499888777' });
    const codes = await h.db.q(`SELECT 1 FROM otp_codes WHERE phone='+37499888777'`);
    expect(codes.length).toBeGreaterThan(0);
    const s2 = await u.agent.post('/api/me/phone/start').send({ phone: '+37499888777' });
    await u.agent.post('/api/me/phone/confirm').send({ phone: '+37499888777', codeOld: s2.body.devCodeOld, codeNew: s2.body.devCodeNew }).expect(201);
    const tk = await h.stepUp(u.agent, 'card_bind');
    const r = await u.agent.post('/api/cards/bind').set('x-step-up', tk);
    expect(r.body.error).toBe('PHONE_RECENTLY_CHANGED');
    h.advance(7 * DAY + 1000);
    const tk2 = await h.stepUp(u.agent, 'card_bind');
    await u.agent.post('/api/cards/bind').set('x-step-up', tk2).expect(201);
  });
});

describe('AU-05 Вход сотрудников', () => {
  it('пароль + TOTP; без кода — отказ; пользовательская сессия не открывает админку', async () => {
    const bad = await request(h.http).post('/api/auth/staff/login').send({ username: 'admin', password: 'Admin123!', code: '000000' });
    expect(bad.body.error).toBe('STAFF_LOGIN_FAILED');
    const staff = await h.staff();
    await staff.get('/api/admin/overview').expect(200);
    const u = await h.user();
    await u.agent.get('/api/admin/overview').expect(403);
    const log = await h.db.q(`SELECT action FROM audit_log WHERE action LIKE 'staff.%'`);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['staff.login', 'staff.login_failed']));
    expect(totp(STAFF_SECRET, 0)).toMatch(/^\d{6}$/);
  });
});

describe('SC-02 Проверка личности', () => {
  async function startKyc(agent: any) {
    const s = await agent.post('/api/kyc/session').send({ acceptBiometrics: true }).expect(201);
    return s.body.sessionId as string;
  }
  it('одобрение → L2; биометрия — отдельное согласие', async () => {
    const u = await h.user({ kyc: false });
    const noConsent = await u.agent.post('/api/kyc/session').send({});
    expect(noConsent.body.error).toBe('CONSENT_REQUIRED');
    const sid = await startKyc(u.agent);
    await request(h.http).post('/api/sandbox/kyc/complete').send({ sessionId: sid, decision: 'approved', fullName: 'Aram Test', birthDate: '1990-05-05', docNumber: 'AN1234567' }).expect(201);
    const me = await u.agent.get('/api/me');
    expect(me.body.kycStatus).toBe('verified');
    expect(me.body.level).toBe(2);
    const row = await h.db.one(`SELECT doc_hash FROM users WHERE id=$1`, [u.id]);
    expect(row.doc_hash).not.toContain('1234567'); // AU-07: только хэш
  });
  it('младше 18 — отказ; один документ — один аккаунт', async () => {
    const kid = await h.user({ kyc: false });
    const sid = await startKyc(kid.agent);
    const r = await request(h.http).post('/api/sandbox/kyc/complete').send({ sessionId: sid, decision: 'approved', fullName: 'Kid', birthDate: '2010-01-01', docNumber: 'AN7654321' });
    expect(r.body).toEqual({ status: 'rejected', reason: 'UNDER_18' });
    const twin = await h.user({ kyc: false });
    const sid2 = await startKyc(twin.agent);
    const r2 = await request(h.http).post('/api/sandbox/kyc/complete').send({ sessionId: sid2, decision: 'approved', fullName: 'Twin', birthDate: '1990-01-01', docNumber: 'AN 1234567' });
    expect(r2.body.reason).toBe('DOC_ALREADY_USED');
  });
});
