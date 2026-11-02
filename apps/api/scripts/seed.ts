/**
 * Демо-данные для ручного тестирования. ВНИМАНИЕ: полностью очищает базу и папку storage.
 *   npm run seed            (остановите API перед запуском)
 */
import 'reflect-metadata';
process.env.SCHEDULER = 'off';
process.env.DEV_TOOLS = process.env.DEV_TOOLS || 'true';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Client } from 'pg';
import { NestFactory } from '@nestjs/core';
import { hash as argonHash } from '@node-rs/argon2';
import { AppModule } from '../src/app.module';
import { migrate } from '../src/migrate';
import { Db } from '../src/common/db';
import { Clock, DAY, HOUR } from '../src/common/clock';
import { SettingsService, depositFor } from '../src/common/settings';
import { FakeGateway } from '../src/adapters/gateway';
import { FakeKms, commitmentOf, generateLotKeys, sealBid } from '../src/adapters/kms';
import { Storage } from '../src/adapters/storage';
import { sealText } from '../src/common/seal';
import { KycService } from '../src/modules/kyc/kyc.service';
import { RevealService } from '../src/modules/reveal/reveal.service';
import { NotifyService } from '../src/modules/notifications/notify.service';
import { demoPdf, demoPhoto } from './demo-images';
import { DESC, VALUATIONS } from './demo-descriptions';

export const ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export const MODER_TOTP_SECRET = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';

async function resetDb(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

async function main() {
  const url = process.env.DATABASE_URL || 'postgresql://auction:auction@localhost:5432/auction';
  const storageDir = process.env.STORAGE_DIR || path.resolve(process.cwd(), 'storage');
  console.log('Resetting database and storage…');
  await resetDb(url);
  fs.rmSync(storageDir, { recursive: true, force: true });
  await migrate(url);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const db = app.get(Db);
  const clock = app.get(Clock);
  const settings = app.get(SettingsService);
  const gw = app.get(FakeGateway);
  const kms = app.get(FakeKms);
  const storage = app.get(Storage);
  const reveal = app.get(RevealService);
  const notify = app.get(NotifyService);
  gw.reset();
  const s = await settings.all();
  const now = clock.ms();
  const at = (ms: number) => new Date(now + ms);

  // ---------- тарифы ----------
  await db.q(`INSERT INTO plans(code, name_i18n, price, duration_days, max_start_price) VALUES
    ('basic', '{"hy":"Հիմնական","ru":"Базовый","en":"Basic"}', 5000, 365, 2000000),
    ('full',  '{"hy":"Լրիվ","ru":"Полный","en":"Full"}', 12000, 365, NULL)`);
  const plans = await db.q<{ id: number; code: string; max_start_price: number | null; price: number }>('SELECT * FROM plans');
  const plan = (c: string) => plans.find((p) => p.code === c)!;

  // ---------- сотрудники (AU-05) ----------
  await db.q(
    `INSERT INTO users(username, role, password_hash, totp_secret, full_name, email, email_verified_at, lang, created_at) VALUES
     ('admin','admin',$1,$2,'Администратор (автор)','admin@auction.local',$5,'ru',$5),
     ('moderator','moderator',$3,$4,'Модератор','moderator@auction.local',$5,'ru',$5)`,
    [await argonHash('Admin123!'), ADMIN_TOTP_SECRET, await argonHash('Moder123!'), MODER_TOTP_SECRET, at(-30 * DAY)],
  );

  // ---------- пользователи ----------
  type U = { key: string; phone: string; name: string; email?: string; kyc?: boolean; card?: string; plan?: string; lang?: string; birth?: string };
  const people: U[] = [
    { key: 'anna', phone: '+37491000001', name: 'Anna Hakobyan', email: 'anna@example.am', kyc: true, card: '4111111111111111', lang: 'ru' },
    { key: 'aram', phone: '+37491000002', name: 'Aram Petrosyan', email: 'aram@example.am', kyc: true, card: '4111111111112222', plan: 'full', lang: 'hy' },
    { key: 'lilit', phone: '+37491000003', name: 'Lilit Sargsyan', email: 'lilit@example.am', kyc: true, card: '4111111111113333', plan: 'full', lang: 'ru' },
    { key: 'davit', phone: '+37491000004', name: 'Davit Grigoryan', email: 'davit@example.am', kyc: true, card: '4111111111114444', lang: 'en' },
    { key: 'narek', phone: '+37491000005', name: '', lang: 'ru' },
    { key: 'gor', phone: '+37491000006', name: 'Gor Vardanyan', email: 'gor@example.am', kyc: true, card: '4111111111116666', plan: 'full', lang: 'ru' },
    { key: 'karen', phone: '+37491000007', name: 'Karen Mkrtchyan', email: 'karen@example.am', kyc: true, card: '4111111111117777', plan: 'full', lang: 'ru' },
    { key: 'mane', phone: '+37491000008', name: 'Mane Avetisyan', email: 'mane@example.am', kyc: true, card: '4000000000000002', plan: 'full', lang: 'ru' },
    { key: 'sona', phone: '+37491000009', name: 'Sona Harutyunyan', email: 'sona@example.am', kyc: true, card: '4111111111119999', plan: 'basic', lang: 'ru' },
    { key: 'tigran', phone: '+37491000010', name: 'Tigran Ghazaryan', email: 'tigran@example.am', kyc: true, card: '4111111111110010', plan: 'full', lang: 'ru' },
    { key: 'ani', phone: '+37491000011', name: 'Ani Simonyan', email: 'ani+fail@example.am', kyc: true, card: '4111111111110011', plan: 'full', lang: 'ru' },
  ];
  const U: Record<string, { id: number; cardId?: number; bindingId?: string; subId?: number }> = {};
  const versions: any = s.consent_versions;
  for (const p of people) {
    const u = await db.one(
      `INSERT INTO users(phone, email, email_verified_at, lang, kyc_level, kyc_status, full_name, birth_date, doc_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        p.phone,
        p.email ?? null,
        p.email ? at(-20 * DAY) : null,
        p.lang ?? 'hy',
        p.kyc ? 2 : p.email ? 1 : 0,
        p.kyc ? 'verified' : 'none',
        p.name || null,
        p.kyc ? p.birth ?? '1988-04-12' : null,
        p.kyc ? KycService.docHash('AM' + p.phone.slice(-7)) : null,
        at(-25 * DAY),
      ],
    );
    U[p.key] = { id: u.id };
    if (p.key !== 'narek') {
      for (const k of ['terms', 'privacy', ...(p.kyc ? ['biometrics', 'auction_rules'] : [])])
        await db.q('INSERT INTO consents(user_id, kind, version, accepted_at) VALUES ($1,$2,$3,$4)', [u.id, k, versions[k], at(-25 * DAY)]);
    }
    if (p.card) {
      const b = gw.seedBinding(p.card, p.name);
      const c = await db.one(`INSERT INTO cards(user_id, mask, binding_id, holder_name, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [u.id, b.mask, b.bindingId, p.name.toUpperCase(), at(-20 * DAY)]);
      U[p.key].cardId = c.id;
      U[p.key].bindingId = b.bindingId;
    }
    if (p.plan) {
      const pl = plan(p.plan);
      const pay = await db.one(`INSERT INTO payments(kind, user_id, amount, status, receipt_no, created_at) VALUES ('subscription',$1,$2,'paid',$3,$4) RETURNING id`, [
        u.id,
        pl.price,
        'R-SEED' + u.id,
        at(-15 * DAY),
      ]);
      const sub = await db.one(
        `INSERT INTO subscriptions(user_id, plan_id, price_paid, max_start_price, starts_at, ends_at, payment_id, source, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$5) RETURNING id`,
        [u.id, pl.id, pl.price, pl.max_start_price, at(-15 * DAY), at(350 * DAY), pay.id],
      );
      U[p.key].subId = sub.id;
    }
  }
  // Gor — статус «Инвестор» (R-21)
  await db.q(`INSERT INTO buyer_limits(user_id, tier, max_active_bids, max_open_deals, buying_power, valid_until, set_by, reason) VALUES ($1,'investor',5,3,600000000,$2,1,'seed: bank letter')`, [
    U.gor.id,
    at(80 * DAY),
  ]);
  // Tigran — блокировка ставок после отказа (6A.3)
  await db.q(`INSERT INTO sanctions(user_id, kind, starts_at, ends_at, reason, strike_no, created_at) VALUES ($1,'bid_block',$2,$3,'seed: winner refused',1,$2)`, [U.tigran.id, at(-5 * DAY), at(25 * DAY)]);

  // ---------- лоты ----------
  type LotSpec = {
    key: string;
    seller: string;
    type: 'house' | 'apartment';
    region: string;
    settlement: string;
    street: string;
    price: number;
    opens: number;
    closes: number;
    status: string;
    area: number;
    rooms: number;
    extra?: Record<string, unknown>;
    desc: { hy: string; ru: string; en: string };
    lat: number;
    lng: number;
  };
  const apt = (floor: number, of: number) => ({ floor, building_floors: of, building_type: 'monolith', has_elevator: of > 5, has_balcony: true, parking: floor % 2 === 0 });
  const house = (land: number, floors: number) => ({ land_area_m2: land, floors, wall_material: 'tuff', gas: true, water: true, sewage: floors > 1 });
  const lots: LotSpec[] = [
    {
      key: 'live_soon_end', seller: 'anna', type: 'apartment', region: 'Yerevan', settlement: 'Yerevan, Kentron', street: 'Tumanyan St', price: 45_000_000,
      opens: -3 * DAY, closes: 15 * 60_000, status: 'live', area: 92, rooms: 3, extra: apt(5, 12), lat: 40.1855, lng: 44.5152,
      desc: { hy: 'Լուսավոր 3 սենյականոց բնակարան կենտրոնում, կապիտալ վերանորոգում։', ru: 'Светлая трёхкомнатная квартира в центре, капитальный ремонт, вид на Оперу.', en: 'Bright 3-room flat in the centre, fully renovated, Opera view.' },
    },
    {
      key: 'live_house', seller: 'karen', type: 'house', region: 'Kotayk', settlement: 'Tsaghkadzor', street: 'Orbeli St', price: 85_000_000,
      opens: -1 * DAY, closes: 3 * DAY, status: 'live', area: 240, rooms: 6, extra: house(800, 2), lat: 40.5329, lng: 44.7203,
      desc: { hy: 'Երկհարկանի տուն լեռներում, բուխարի, այգի։', ru: 'Двухэтажный дом в горах: камин, сад, вид на канатную дорогу.', en: 'Two-storey mountain house with fireplace and garden.' },
    },
    {
      key: 'live_gyumri', seller: 'anna', type: 'apartment', region: 'Shirak', settlement: 'Gyumri', street: 'Rustaveli St', price: 18_000_000,
      opens: -2 * HOUR, closes: 5 * DAY, status: 'live', area: 74, rooms: 2, extra: apt(2, 5), lat: 40.7894, lng: 43.8475,
      desc: { hy: '2 սենյականոց բնակարան պատմական կենտրոնում։', ru: 'Двухкомнатная квартира в историческом центре Гюмри.', en: '2-room apartment in historic Gyumri.' },
    },
    {
      key: 'live_cheap', seller: 'karen', type: 'apartment', region: 'Lori', settlement: 'Vanadzor', street: 'Tigran Mets Ave', price: 1_800_000,
      opens: -6 * HOUR, closes: 4 * DAY, status: 'live', area: 38, rooms: 1, extra: apt(4, 9), lat: 40.8128, lng: 44.4883,
      desc: { hy: 'Փոքր բնակարան ուսանողների համար։', ru: 'Небольшая однокомнатная квартира — подходит тарифу «Базовый».', en: 'Small studio — fits the Basic plan.' },
    },
    {
      key: 'soon_house', seller: 'anna', type: 'house', region: 'Tavush', settlement: 'Dilijan', street: 'Sharambeyan St', price: 120_000_000,
      opens: 1 * DAY, closes: 8 * DAY, status: 'scheduled', area: 310, rooms: 7, extra: house(1500, 3), lat: 40.7406, lng: 44.8636,
      desc: { hy: 'Տուն անտառի մոտ, 3 հարկ։', ru: 'Дом у леса в Дилижане, три этажа, баня.', en: 'Three-storey house near the forest in Dilijan.' },
    },
    {
      key: 'finished_deal', seller: 'anna', type: 'apartment', region: 'Yerevan', settlement: 'Yerevan, Arabkir', street: 'Komitas Ave', price: 40_000_000,
      opens: -8 * DAY, closes: -2 * HOUR, status: 'live', area: 88, rooms: 3, extra: apt(7, 14), lat: 40.2068, lng: 44.5052,
      desc: { hy: 'Բնակարան Արաբկիրում։', ru: 'Квартира в Арабкире (пример из PRD: равные ставки, побеждает ранняя).', en: 'Arabkir flat (PRD example: equal bids, earlier wins).' },
    },
    {
      key: 'finished_nobids', seller: 'karen', type: 'house', region: 'Ararat', settlement: 'Artashat', street: 'Shahumyan St', price: 60_000_000,
      opens: -10 * DAY, closes: -1 * DAY, status: 'live', area: 180, rooms: 5, extra: house(600, 1), lat: 39.9539, lng: 44.5506,
      desc: { hy: 'Տուն Արտաշատում։', ru: 'Дом в Арташате — аукцион завершился без ставок.', en: 'House in Artashat — ended with no bids.' },
    },
    {
      key: 'finished_confirmed', seller: 'karen', type: 'apartment', region: 'Yerevan', settlement: 'Yerevan, Davtashen', street: 'Davtashen 3rd district', price: 32_000_000,
      opens: -12 * DAY, closes: -3 * DAY, status: 'live', area: 70, rooms: 2, extra: apt(3, 9), lat: 40.2276, lng: 44.4925,
      desc: { hy: 'Բնակարան Դավթաշենում։', ru: 'Квартира в Давташене — сделка подтверждена обеими сторонами.', en: 'Davtashen flat — deal confirmed by both.' },
    },
    {
      key: 'moderation', seller: 'karen', type: 'house', region: 'Aragatsotn', settlement: 'Ashtarak', street: 'Grigor Lusavorich St', price: 55_000_000,
      opens: 3 * DAY, closes: 10 * DAY, status: 'moderation', area: 200, rooms: 5, extra: house(900, 2), lat: 40.2994, lng: 44.3624,
      desc: { hy: 'Տուն Աշտարակում։', ru: 'Дом в Аштараке — ждёт проверки модератором.', en: 'House in Ashtarak — awaiting moderation.' },
    },
  ];

  for (const l of lots) if (DESC[l.key]) l.desc = DESC[l.key];
  const L: Record<string, number> = {};
  let seed = 0;
  for (const spec of lots) {
    seed++;
    const prop = await db.one(
      `INSERT INTO properties(owner_id, property_type, cadastral_no, region, settlement, street, geo_lat, geo_lng, area_m2, rooms, bathrooms, year_built, heating, condition, description_i18n,
        land_area_m2, floors, wall_material, gas, water, sewage, floor, building_floors, building_type, has_elevator, has_balcony, parking)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id`,
      [
        U[spec.seller].id, spec.type, `01-0${seed}-0${100 + seed}-000${seed}`, spec.region, spec.settlement, spec.street, spec.lat, spec.lng, spec.area, spec.rooms,
        spec.rooms > 3 ? 2 : 1, 1995 + seed * 2, spec.type === 'house' ? 'gas' : 'central', seed % 2 ? 'renovated' : 'good', JSON.stringify(spec.desc),
        spec.extra?.land_area_m2 ?? null, spec.extra?.floors ?? null, spec.extra?.wall_material ?? null, spec.extra?.gas ?? null, spec.extra?.water ?? null, spec.extra?.sewage ?? null,
        spec.extra?.floor ?? null, spec.extra?.building_floors ?? null, spec.extra?.building_type ?? null, spec.extra?.has_elevator ?? null, spec.extra?.has_balcony ?? null, spec.extra?.parking ?? null,
      ],
    );
    for (let i = 0; i < 10; i++) {
      const key = storage.putNamed(`public/seed/lot${seed}-${i + 1}.svg`, demoPhoto(spec.type, seed, i, spec.settlement));
      await db.q(`INSERT INTO property_media(property_id, kind, storage_key, is_private, sort) VALUES ($1,'photo',$2,false,$3)`, [prop.id, key, i + 1]);
    }
    const owner = people.find((p) => p.key === spec.seller)!.name;
    const ex = storage.putNamed(
      `private/seed/extract-${seed}.pdf`,
      demoPdf(['Cadastre extract (DEMO)', `Object: ${spec.settlement}, ${spec.street}`, `Cadastral no: 01-0${seed}-0${100 + seed}-000${seed}`, `Owner: ${owner}`, 'Encumbrances: none', 'Mortgage: none']),
    );
    for (const [i, v] of (VALUATIONS[spec.key] ?? []).entries()) {
      const key = storage.putNamed(
        `public/seed/valuation-${seed}-${i}.pdf`,
        demoPdf([`Valuation report ${v.reportNo} (DEMO)`, v.org, `Object: ${spec.settlement}, ${spec.street}`, `Area: ${spec.area} m2`, `Market value: ${v.amount.toLocaleString('en-US')} AMD`]),
      );
      await db.q(`INSERT INTO property_valuations(property_id, org_name, amount, valued_at, report_no, storage_key) VALUES ($1,$2,$3,$4,$5,$6)`, [
        prop.id,
        v.org,
        v.amount,
        at(-v.daysAgo * DAY).toISOString().slice(0, 10),
        v.reportNo,
        key,
      ]);
    }
    await db.q(`INSERT INTO property_media(property_id, kind, storage_key, is_private, sort) VALUES ($1,'extract',$2,true,100)`, [prop.id, ex]);
    const lot = await db.one(
      `INSERT INTO lots(property_id, seller_id, status, draft_step, start_price, opens_at, closes_at, deposit_amount, created_at) VALUES ($1,$2,$3,5,$4,$5,$6,$7,$8) RETURNING id`,
      [prop.id, U[spec.seller].id, spec.status, spec.price, at(spec.opens), at(spec.closes), depositFor(spec.price, s), at(spec.opens - 3 * DAY)],
    );
    L[spec.key] = lot.id;
    if (spec.status !== 'moderation') {
      const keys = generateLotKeys();
      await db.q(`UPDATE lots SET public_key=$2, private_key_wrapped=$3, rules_snapshot=$4, approved_at=$5, verification=$6 WHERE id=$1`, [
        lot.id,
        keys.publicKey,
        kms.wrap(lot.id, keys.privateKey),
        JSON.stringify({ ...s, consent_versions: undefined, auction_type: 'type1' }),
        at(spec.opens - 2 * DAY),
        JSON.stringify({ extract: true, owner_match: true, no_encumbrance: true, photos_match: true, valuation: !!VALUATIONS[spec.key], checked_at: at(spec.opens - 2 * DAY).toISOString() }),
      ]);
      await db.q(`INSERT INTO moderation(lot_id, moderator_id, decision, comment, created_at) VALUES ($1,2,'approve','seed',$2)`, [lot.id, at(spec.opens - 2 * DAY)]);
    }
  }

  // черновик Анны (мастер, шаг 2)
  {
    const prop = await db.one(`INSERT INTO properties(owner_id, property_type, cadastral_no, region, settlement, street) VALUES ($1,'apartment','01-099-0099-0001','Yerevan','Yerevan, Ajapnyak','Halabyan St') RETURNING id`, [U.anna.id]);
    L.draft = (await db.one(`INSERT INTO lots(property_id, seller_id, status, draft_step, created_at) VALUES ($1,$2,'draft',2,$3) RETURNING id`, [prop.id, U.anna.id, at(-HOUR)])).id;
  }

  // ---------- депозиты и ставки ----------
  async function deposit(user: string, lotKey: string) {
    const lot = await db.one('SELECT id, deposit_amount FROM lots WHERE id=$1', [L[lotKey]]);
    const d = await db.one(`INSERT INTO deposits(lot_id, user_id, card_id, amount, status, created_at, updated_at) VALUES ($1,$2,$3,$4,'pending',$5,$5) RETURNING id`, [
      lot.id,
      U[user].id,
      U[user].cardId,
      lot.deposit_amount,
      at(-3 * DAY),
    ]);
    const o = await gw.holdByBinding(U[user].bindingId!, lot.deposit_amount, 'deposit:' + d.id, s.hold_days, new Date(now - 3 * DAY));
    await db.q(`UPDATE deposits SET status='held', gateway_order_id=$2, hold_expires_at=$3 WHERE id=$1`, [d.id, o.orderId, o.holdExpiresAt]);
  }
  async function bid(user: string, lotKey: string, amount: number, agoMs: number) {
    const lot = await db.one('SELECT id, public_key FROM lots WHERE id=$1', [L[lotKey]]);
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const receivedAt = at(-agoMs);
    const receiptNo = `${lot.id}-${receivedAt.getTime().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const commitment = commitmentOf(amount, salt, id);
    await db.q(
      `INSERT INTO bids(id, lot_id, user_id, subscription_id, ciphertext, commitment, idempotency_key, receipt_no, server_received_at, owner_ciphertext) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, lot.id, U[user].id, U[user].subId, sealBid(lot.public_key, { amount, salt }), commitment, 'seed-' + id, receiptNo, receivedAt, sealText(JSON.stringify({ amount }), 'bid:' + id)],
    );
    await db.q(`INSERT INTO audit_log(actor_id, action, entity, entity_id, after, at) VALUES ($1,'bid.placed','bid',$2,$3,$4)`, [U[user].id, id, JSON.stringify({ lotId: lot.id, receiptNo, commitment }), receivedAt]);
  }

  // Идёт, заканчивается через 15 минут: Арам и Гор поставили, у Лилит депозит есть — может поставить сама
  await deposit('aram', 'live_soon_end');
  await deposit('gor', 'live_soon_end');
  await deposit('lilit', 'live_soon_end');
  await deposit('ani', 'live_soon_end');
  await bid('aram', 'live_soon_end', 47_500_000, 2 * DAY);
  await bid('gor', 'live_soon_end', 46_250_000, DAY);
  await bid('ani', 'live_soon_end', 45_000_001, 3 * HOUR);
  // Дом в Цахкадзоре: ставка Арама (теперь у него 2 активные ставки → лимит R-20)
  await deposit('aram', 'live_house');
  await bid('aram', 'live_house', 88_000_000, 5 * HOUR);
  // Гюмри: депозит у Лилит и Мане нет (у Мане карта с отказом банка)
  await deposit('lilit', 'live_gyumri');

  // Завершённые: ставки сделаны в прошлом, вскрытие — настоящей задачей
  await deposit('aram', 'finished_deal');
  await deposit('gor', 'finished_deal');
  await deposit('lilit', 'finished_deal');
  // Пример из PRD: А = 43 500 000, Б = 42 815 000, В = 43 500 000 (позже А) → побеждает А (здесь — Гор)
  await bid('gor', 'finished_deal', 43_500_000, 6 * DAY);
  await bid('lilit', 'finished_deal', 42_815_000, 5 * DAY);
  await bid('aram', 'finished_deal', 43_500_000, 4 * DAY);

  await deposit('gor', 'finished_confirmed');
  await deposit('lilit', 'finished_confirmed');
  await bid('gor', 'finished_confirmed', 34_100_000, 7 * DAY);
  await bid('lilit', 'finished_confirmed', 33_000_000, 6 * DAY);

  // вскрытие завершённых лотов (finished_deal закончился 2 ч назад, остальные раньше)
  for (const k of ['finished_nobids', 'finished_confirmed', 'finished_deal']) await reveal.reveal(L[k]);
  // сделка по Давташену: обе стороны подтвердили
  await db.q(`UPDATE deals SET seller_confirmed_at=$2, buyer_confirmed_at=$2, status='confirmed' WHERE lot_id=$1`, [L.finished_confirmed, at(-2 * DAY)]);
  // по Арабкиру продавец уже подтвердил, ждём победителя (Гор)
  await db.q(`UPDATE deals SET seller_confirmed_at=$2 WHERE lot_id=$1`, [L.finished_deal, at(-HOUR)]);
  await app.get(DepositsServiceRef()).processReleases();

  // избранное
  await db.q('INSERT INTO favorites(user_id, lot_id) VALUES ($1,$2),($1,$3),($4,$5)', [U.lilit.id, L.live_soon_end, L.soon_house, U.davit.id, L.live_house]);
  // старые уведомления можно сразу «отправить», чтобы outbox не пустовал
  await notify.deliver(1000);
  await db.q(`INSERT INTO heartbeats(id, at) VALUES (1,$1)`, [clock.now()]);

  await app.close();

  console.log('\n✔ Демо-данные загружены. Лоты:', L);
  console.log(`
Вход пользователей: телефон → SMS-код (код показывается на экране в dev-режиме и в /dev).
  +374 91 000001  Анна    — продавец (лоты, черновик), без годового доступа
  +374 91 000002  Арам    — Полный доступ, 2 активные ставки (лимит R-20 достигнут)
  +374 91 000003  Лилит   — Полный доступ, депозиты внесены, ставок на «Кентрон» и «Гюмри» нет — можно ставить
  +374 91 000004  Давит   — личность проверена, карта есть, доступа нет (проверить покупку тарифа)
  +374 91 000005  Нарек   — новый: нет email, нет проверки личности, нет согласий
  +374 91 000006  Гор     — «Инвестор», выиграл Арабкир (ждёт его подтверждения) и Давташен (сделка подтверждена)
  +374 91 000007  Карен   — второй продавец (лот на модерации, лот без ставок → перезапуск)
  +374 91 000008  Мане    — карта 4000…0002: банк отклоняет депозит
  +374 91 000009  Сона    — тариф «Базовый» (лоты до 2 000 000 ֏), можно повысить до «Полного»
  +374 91 000010  Тигран  — блокировка ставок 30 дней (лестница мер)
  +374 91 000011  Ани     — email с «+fail»: письма не доставляются, видны повторы в админке
Сотрудники (/staff/login): admin / Admin123!   moderator / Moder123!   + код TOTP (смотрите /dev или добавьте секрет в Google Authenticator)
  TOTP admin:     ${ADMIN_TOTP_SECRET}
  TOTP moderator: ${MODER_TOTP_SECRET}
`);
}

// ленивый импорт, чтобы избежать циклов при загрузке скрипта
function DepositsServiceRef() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/modules/deposits/deposits.service').DepositsService;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
