import request from 'supertest';
import { H } from './helpers';
import { HOUR } from '../src/common/clock';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const reg = (agent: any, login: string, password = 'secret123', extra: any = {}) => agent.post('/api/auth/register').send({ login, password, acceptTerms: true, lang: 'ru', ...extra });

describe('PRD v2 решение 1: email или телефон + пароль', () => {
  it('регистрация по email: код на почту → подтверждение → вход сразу, статус «не проверен»', async () => {
    const a = request.agent(h.http);
    const r = await reg(a, 'New.User@Example.am').expect(201);
    expect(r.body).toMatchObject({ channel: 'email' });
    expect(r.body.devCode).toMatch(/^\d{6}$/);
    // до подтверждения войти нельзя
    expect((await a.post('/api/auth/login').send({ login: 'new.user@example.am', password: 'secret123' })).body.error).toBe('CONTACT_NOT_CONFIRMED');
    expect((await a.post('/api/auth/register/confirm').send({ login: 'new.user@example.am', code: '000000' })).body).toMatchObject({ error: 'OTP_INVALID', attemptsLeft: 4 });
    await a.post('/api/auth/register/confirm').send({ login: 'new.user@example.am', code: r.body.devCode }).expect(201);
    const me = (await a.get('/api/me').expect(200)).body;
    expect(me).toMatchObject({ email: 'new.user@example.am', emailVerified: true, kycStatus: 'none' });
    const u = await h.db.one(`SELECT password_hash, phone, email_verified_at FROM users WHERE lower(email)='new.user@example.am'`);
    expect(u.password_hash).not.toContain('secret123');
    expect(u.phone).toBeNull();
    expect(u.email_verified_at).not.toBeNull();
    // повторная регистрация того же email — отказ
    expect((await reg(request.agent(h.http), 'new.user@example.am')).body.error).toBe('LOGIN_TAKEN');
  });

  it('регистрация по телефону: код по SMS; пароль проверяется на сложность', async () => {
    const a = request.agent(h.http);
    expect((await reg(a, '+374 99 123 456', 'short')).body.error).toBe('PASSWORD_WEAK');
    expect((await reg(a, '+374 99 123 456', 'onlyletters')).body.error).toBe('PASSWORD_WEAK');
    expect((await reg(a, '+374 99 123 456', 'secret123', { acceptTerms: false })).body.error).toBe('CONSENT_REQUIRED');
    const r = await reg(a, '+374 99 123 456').expect(201);
    expect(r.body.channel).toBe('phone');
    await a.post('/api/auth/register/confirm').send({ login: '099123456', code: r.body.devCode }).expect(201);
    const b = request.agent(h.http);
    await b.post('/api/auth/login').send({ login: '+37499123456', password: 'secret123' }).expect(201);
    expect((await b.get('/api/me')).status).toBe(200);
  });

  it('вход: неверный пароль — «осталось N попыток», после 5 — вход закрыт на 15 минут; одинаковый ответ для несуществующего', async () => {
    const a = request.agent(h.http);
    const r = await reg(a, 'lock@example.am');
    await a.post('/api/auth/register/confirm').send({ login: 'lock@example.am', code: r.body.devCode }).expect(201);
    const bad = () => request(h.http).post('/api/auth/login').send({ login: 'lock@example.am', password: 'wrong1234' });
    expect((await bad()).body).toMatchObject({ error: 'INVALID_CREDENTIALS', attemptsLeft: 4 });
    for (let i = 0; i < 3; i++) await bad();
    expect((await bad()).body.error).toBe('LOGIN_LOCKED');
    // даже верный пароль не пускает, пока закрыто
    expect((await request(h.http).post('/api/auth/login').send({ login: 'lock@example.am', password: 'secret123' })).body.error).toBe('LOGIN_LOCKED');
    h.advance(16 * 60_000);
    await request(h.http).post('/api/auth/login').send({ login: 'lock@example.am', password: 'secret123' }).expect(201);
    const ghost = await request(h.http).post('/api/auth/login').send({ login: 'nobody@example.am', password: 'secret123' });
    expect(ghost.status).toBe(401);
    expect(ghost.body.error).toBe('INVALID_CREDENTIALS');
    expect(ghost.body.attemptsLeft).toBeUndefined();
  });

  it('«забыли пароль»: одинаковый ответ; ссылка одноразовая и на 30 минут; все сессии завершаются', async () => {
    const a = request.agent(h.http);
    const r = await reg(a, 'forgot@example.am');
    await a.post('/api/auth/register/confirm').send({ login: 'forgot@example.am', code: r.body.devCode }).expect(201);
    expect((await a.get('/api/me')).status).toBe(200);
    const unknown = await request(h.http).post('/api/auth/password/forgot').send({ login: 'ghost@example.am' }).expect(201);
    expect(unknown.body).toEqual({ ok: true, ttlMin: 30 });
    const f = await request(h.http).post('/api/auth/password/forgot').send({ login: 'forgot@example.am' }).expect(201);
    expect(f.body.devToken).toBeTruthy();
    const mail = await h.db.one(`SELECT to_addr, template, body FROM notifications WHERE template='password_reset' ORDER BY id DESC LIMIT 1`);
    expect(mail).toMatchObject({ to_addr: 'forgot@example.am' });
    expect(mail.body).toContain('/reset-password?token=');
    expect(JSON.stringify(await h.db.q(`SELECT * FROM password_resets`))).not.toContain(f.body.devToken); // в базе только хэш
    expect((await request(h.http).post('/api/auth/password/reset').send({ token: f.body.devToken, password: 'weak' })).body.error).toBe('PASSWORD_WEAK');
    await request(h.http).post('/api/auth/password/reset').send({ token: f.body.devToken, password: 'newsecret1' }).expect(201);
    expect((await request(h.http).post('/api/auth/password/reset').send({ token: f.body.devToken, password: 'newsecret2' })).body.error).toBe('RESET_LINK_INVALID');
    expect((await a.post('/api/auth/refresh')).status).toBe(401); // старая сессия завершена
    await request(h.http).post('/api/auth/login').send({ login: 'forgot@example.am', password: 'newsecret1' }).expect(201);
    // просроченная ссылка
    const f2 = await request(h.http).post('/api/auth/password/forgot').send({ login: 'forgot@example.am' });
    h.advance(HOUR);
    expect((await request(h.http).post('/api/auth/password/reset').send({ token: f2.body.devToken, password: 'newsecret3' })).body.error).toBe('RESET_LINK_INVALID');
  });

  it('вошёл по email без телефона: подтверждения по SMS просят добавить телефон, телефон добавляется одним кодом', async () => {
    const a = request.agent(h.http);
    const r = await reg(a, 'nophone@example.am');
    await a.post('/api/auth/register/confirm').send({ login: 'nophone@example.am', code: r.body.devCode }).expect(201);
    expect((await a.post('/api/auth/step-up').send({ action: 'bid' })).body.error).toBe('PHONE_REQUIRED');
    const st = await a.post('/api/me/phone/start').send({ phone: '+37477000111' });
    expect(st.status).toBe(201);
    await a.post('/api/me/phone/confirm').send({ phone: '+37477000111', codeNew: st.body.devCodeNew }).expect(201);
    expect((await a.post('/api/auth/step-up').send({ action: 'bid' })).status).toBe(201);
  });
});
