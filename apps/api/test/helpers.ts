import 'reflect-metadata';
import crypto from 'crypto';
import request from 'supertest';
import { Client } from 'pg';
import { hash as argonHash } from '@node-rs/argon2';
import { INestApplication } from '@nestjs/common';
import { createApp } from '../src/bootstrap';
import { migrate } from '../src/migrate';
import { Db } from '../src/common/db';
import { Clock, DAY, HOUR } from '../src/common/clock';
import { SettingsService, depositFor } from '../src/common/settings';
import { FakeGateway } from '../src/adapters/gateway';
import { FakeKms, generateLotKeys } from '../src/adapters/kms';
import { KycService } from '../src/modules/kyc/kyc.service';
import { RevealService } from '../src/modules/reveal/reveal.service';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';
import { DealsService } from '../src/modules/deals/deals.service';
import { NotifyService } from '../src/modules/notifications/notify.service';
import { totp } from '../src/common/totp';

export const T0 = new Date('2026-12-01T08:00:00.000Z');
export const STAFF_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export class H {
  app!: INestApplication;
  db!: Db;
  clock!: Clock;
  gw!: FakeGateway;
  phoneSeq = 100;

  async start() {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await c.end();
    await migrate(process.env.DATABASE_URL);
    this.app = await createApp();
    await this.app.listen(0); // постоянный порт: supertest не закрывает сервер между параллельными запросами
    this.db = this.app.get(Db);
    this.clock = this.app.get(Clock);
    this.gw = this.app.get(FakeGateway);
    this.clock.set(T0);
    await this.db.q(`INSERT INTO plans(code, name_i18n, price, duration_days, max_start_price) VALUES
      ('basic', '{"ru":"Базовый","en":"Basic","hy":"Հիմնական"}', 5000, 365, 2000000),
      ('full', '{"ru":"Полный","en":"Full","hy":"Լրիվ"}', 12000, 365, NULL)`);
    await this.db.q(
      `INSERT INTO users(username, role, password_hash, totp_secret, full_name, email, email_verified_at, lang) VALUES ('admin','admin',$1,$2,'Admin','admin@x.am',now(),'ru')`,
      [await argonHash('Admin123!'), STAFF_SECRET],
    );
    // в тестах коды можно запрашивать подряд; правила AU-01 проверяются отдельно
    await this.get(SettingsService).set('otp_resend_sec', 0, null);
    await this.get(SettingsService).set('otp_daily_max', 10000, null);
    return this;
  }
  async stop() {
    this.clock.reset();
    await this.app.close();
  }
  get http() {
    return this.app.getHttpServer();
  }
  get<T>(cls: new (...a: any[]) => T): T {
    return this.app.get(cls as any);
  }
  reveal = () => this.get(RevealService);
  scheduler = () => this.get(SchedulerService);
  deals = () => this.get(DealsService);
  notify = () => this.get(NotifyService);
  set = (d: Date) => this.clock.set(d);
  advance = (ms: number) => this.clock.advance(ms);

  /** Пользователь с нужным уровнем подготовки. Возвращает агент supertest с cookie сессии. */
  async user(o: { kyc?: boolean; email?: boolean; card?: string; plan?: 'basic' | 'full' | null; name?: string; lang?: string; birth?: string } = {}) {
    const phone = '+3749' + String(1000000 + this.phoneSeq++).slice(-7);
    const name = o.name ?? 'Test User ' + this.phoneSeq;
    const kyc = o.kyc ?? true;
    const email = o.email ?? true;
    const u = await this.db.one(
      `INSERT INTO users(phone, email, email_verified_at, lang, kyc_level, kyc_status, full_name, birth_date, doc_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [phone, email ? `u${this.phoneSeq}@test.am` : null, email ? this.clock.now() : null, o.lang ?? 'ru', kyc ? 2 : 1, kyc ? 'verified' : 'none', kyc ? name : null, kyc ? o.birth ?? '1990-01-01' : null, kyc ? KycService.docHash('D' + phone) : null],
    );
    for (const k of ['terms', 'privacy']) await this.db.q(`INSERT INTO consents(user_id, kind, version, accepted_at) VALUES ($1,$2,'1.0',now())`, [u.id, k]);
    let cardId: number | undefined;
    if (o.card !== undefined || o.plan) {
      const b = this.gw.seedBinding(o.card || '4111111111111111');
      cardId = (await this.db.one(`INSERT INTO cards(user_id, mask, binding_id) VALUES ($1,$2,$3) RETURNING id`, [u.id, b.mask, b.bindingId])).id;
    }
    if (o.plan) {
      const p = await this.db.one(`SELECT * FROM plans WHERE code=$1`, [o.plan]);
      await this.db.q(`INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,'paid',$5)`, [
        u.id,
        p.id,
        p.price,
        p.max_start_price,
        new Date(this.clock.ms() - DAY),
        new Date(this.clock.ms() + 300 * DAY),
      ]);
    }
    const agent = request.agent(this.http);
    const otp = await agent.post('/api/auth/otp').send({ phone });
    // в тестах каждый пользователь входит ровно один раз — кулдаун не мешает
    await agent.post('/api/auth/verify').send({ phone, code: otp.body.devCode }).expect(201);
    return { id: u.id as number, phone, agent, cardId };
  }

  /** Обновить короткий токен после «прыжка» времени. */
  async fresh<A extends { post: any }>(agent: A) {
    await agent.post('/api/auth/refresh');
    return agent;
  }

  async stepUp(agent: any, action: string) {
    // время в тестах «прыгает» — обновляем короткий токен (AU-02), как это делает сайт
    await agent.post('/api/auth/refresh');
    const r = await agent.post('/api/auth/step-up').send({ action });
    const v = await agent.post('/api/auth/step-up').send({ action, code: r.body.devCode });
    if (!v.body.stepUpToken) throw new Error('step-up failed: ' + JSON.stringify([r.body, v.body]));
    return v.body.stepUpToken as string;
  }

  /** Опубликованный лот (как после одобрения модератором). */
  async lot(sellerId: number, o: { price?: number; opensIn?: number; closesIn?: number; status?: string } = {}) {
    const s = await this.get(SettingsService).all();
    const price = o.price ?? 40_000_000;
    const p = await this.db.one(
      `INSERT INTO properties(owner_id, property_type, cadastral_no, region, settlement, street, area_m2, rooms, bathrooms, year_built, heating, condition, floor, building_floors, building_type, has_elevator, has_balcony, parking)
       VALUES ($1,'apartment','01-001-0001-0001','Yerevan','Yerevan','Abovyan St',80,3,1,2000,'central','good',3,9,'monolith',true,true,false) RETURNING id`,
      [sellerId],
    );
    const opens = new Date(this.clock.ms() + (o.opensIn ?? -HOUR));
    const closes = new Date(this.clock.ms() + (o.closesIn ?? 3 * DAY));
    const status = o.status ?? (opens.getTime() <= this.clock.ms() ? 'live' : 'scheduled');
    const lot = await this.db.one(
      `INSERT INTO lots(property_id, seller_id, status, start_price, opens_at, closes_at, deposit_amount, approved_at, rules_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}') RETURNING id`,
      [p.id, sellerId, status, price, opens, closes, depositFor(price, s), new Date(this.clock.ms() - 2 * DAY)],
    );
    const keys = generateLotKeys();
    await this.db.q(`UPDATE lots SET public_key=$2, private_key_wrapped=$3 WHERE id=$1`, [lot.id, keys.publicKey, this.get(FakeKms).wrap(lot.id, keys.privateKey)]);
    return lot.id as number;
  }

  async deposit(agent: any, lotId: number, cardId?: number) {
    const tk = await this.stepUp(agent, 'deposit');
    return agent.post(`/api/lots/${lotId}/deposit`).set('x-step-up', tk).send({ cardId });
  }

  async bid(agent: any, lotId: number, amount: unknown, key: string = crypto.randomUUID()) {
    const tk = await this.stepUp(agent, 'bid');
    return agent.post(`/api/lots/${lotId}/bids`).set('x-step-up', tk).set('idempotency-key', key).send({ amount, acceptRules: true });
  }

  /** Готовый участник: личность, доступ, карта и депозит по лоту. */
  async bidder(lotId: number, o: Parameters<H['user']>[0] = {}) {
    const u = await this.user({ plan: 'full', ...o });
    const d = await this.deposit(u.agent, lotId);
    if (d.status !== 201) throw new Error('deposit failed ' + JSON.stringify(d.body));
    return u;
  }

  async staff() {
    const agent = request.agent(this.http);
    await agent.post('/api/auth/staff/login').send({ username: 'admin', password: 'Admin123!', code: totp(STAFF_SECRET, this.clock.ms()) }).expect(201);
    return agent;
  }

  outbox(userId: number, template?: string) {
    return this.db.q(`SELECT * FROM notifications WHERE user_id=$1 ${template ? 'AND template=$2' : ''} ORDER BY id`, template ? [userId, template] : [userId]);
  }
}
