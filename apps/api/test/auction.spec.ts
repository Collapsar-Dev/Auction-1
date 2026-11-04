import request from 'supertest';
import { H } from './helpers';
import { DAY, HOUR } from '../src/common/clock';
import { depositFor, commissionFor, DEFAULT_SETTINGS } from '../src/common/settings';
import { FakeKms } from '../src/adapters/kms';
import { BidsService } from '../src/modules/bids/bids.service';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

describe('6.1 Размер депозита и R-17 комиссия', () => {
  it('примеры из PRD', () => {
    expect(depositFor(15_000_000, DEFAULT_SETTINGS)).toBe(200_000);
    expect(depositFor(40_000_000, DEFAULT_SETTINGS)).toBe(400_000);
    expect(depositFor(300_000_000, DEFAULT_SETTINGS)).toBe(2_000_000);
    expect(commissionFor(43_500_000, DEFAULT_SETTINGS)).toBe(217_500);
    expect(commissionFor(10_000_000, DEFAULT_SETTINGS)).toBe(100_000);
  });
});

describe('SC-03 Привязка карты', () => {
  it('через страницу банка; сервер сам проверяет статус; маска сохраняется', async () => {
    const u = await h.user({ name: 'Aram Petrosyan' });
    const tk = await h.stepUp(u.agent, 'card_bind');
    const start = await u.agent.post('/api/cards/bind').set('x-step-up', tk).expect(201);
    // подделанный возврат без оплаты не проходит
    const fake = await u.agent.post('/api/cards/bind/complete').send({ orderId: start.body.orderId });
    expect(fake.body.error).toBe('CARD_BIND_DECLINED');
    const tk2 = await h.stepUp(u.agent, 'card_bind');
    const s2 = await u.agent.post('/api/cards/bind').set('x-step-up', tk2);
    await request(h.http).post('/api/sandbox/bank/' + s2.body.orderId).send({ pan: '4111 1111 1111 4321', holderName: 'ARAM PETROSYAN' }).expect(201);
    const done = await u.agent.post('/api/cards/bind/complete').send({ orderId: s2.body.orderId }).expect(201);
    expect(done.body.mask).toBe('•••• 4321');
    expect(h.gw.orders.get(s2.body.orderId)!.status).toBe('reversed'); // проверочная сумма отменена
  });
  it('имя держателя не совпало с ФИО → карта не привязывается', async () => {
    const u = await h.user({ name: 'Lilit Sargsyan' });
    const tk = await h.stepUp(u.agent, 'card_bind');
    const s = await u.agent.post('/api/cards/bind').set('x-step-up', tk);
    await request(h.http).post('/api/sandbox/bank/' + s.body.orderId).send({ pan: '4111111111115555', holderName: 'JOHN DOE' });
    const r = await u.agent.post('/api/cards/bind/complete').send({ orderId: s.body.orderId });
    expect(r.body.error).toBe('CARD_HOLDER_MISMATCH');
  });
});

describe('SC-21 / 6.5 Годовой доступ', () => {
  it('покупка, продление после окончания текущего, повышение с доплатой разницы', async () => {
    const u = await h.user({ card: '4111111111110001' });
    const buy = async (plan: string) => u.agent.post('/api/subscriptions').set('x-step-up', await h.stepUp(u.agent, 'subscription')).send({ plan });
    const b1 = await buy('basic');
    expect(b1.status).toBe(201);
    const ends1 = new Date(b1.body.subscription.ends_at).getTime();
    expect(ends1 - h.clock.ms()).toBe(365 * DAY);
    const b2 = await buy('basic');
    expect(b2.body.renewal).toBe(true);
    expect(new Date(b2.body.subscription.starts_at).getTime()).toBe(ends1);
    const up = await u.agent.post('/api/subscriptions/upgrade').set('x-step-up', await h.stepUp(u.agent, 'subscription')).send({ plan: 'full' });
    expect(up.body.paid).toBe(7000);
    expect(new Date(up.body.subscription.ends_at).getTime()).toBe(ends1); // срок не меняется
    const pays = await h.db.q(`SELECT kind, amount, status FROM payments WHERE user_id=$1 ORDER BY id`, [u.id]);
    expect(pays.map((p) => [p.kind, p.amount, p.status])).toEqual([
      ['subscription', 5000, 'paid'],
      ['subscription', 5000, 'paid'],
      ['upgrade', 7000, 'paid'],
    ]);
  });
  it('оплата отклонена банком → доступ не активируется', async () => {
    const u = await h.user({ card: '4000000000000002' });
    const r = await u.agent.post('/api/subscriptions').set('x-step-up', await h.stepUp(u.agent, 'subscription')).send({ plan: 'full' });
    expect(r.body.error).toBe('PAYMENT_DECLINED');
    expect((await u.agent.get('/api/me/subscription')).body.active).toHaveLength(0);
  });
  it('R-18: Базовый не покрывает лот дороже 2 000 000 ֏ — сайт подсказывает Полный', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 5_000_000 });
    const u = await h.user({ plan: 'basic' });
    const r = await h.deposit(u.agent, lot);
    expect(r.body).toMatchObject({ error: 'SUBSCRIPTION_REQUIRED', suggestedPlan: 'full' });
    const cheap = await h.lot(seller.id, { price: 1_500_000 });
    expect((await h.deposit(u.agent, cheap)).status).toBe(201);
  });
});

describe('SC-07 Депозит', () => {
  it('блокировка без списания; повторный депозит запрещён; отказ банка → понятная ошибка', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000, opensIn: DAY }); // можно заранее, пока «Скоро»
    const u = await h.user({ plan: 'full' });
    const r = await h.deposit(u.agent, lot);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'held', amount: 400_000 });
    const again = await h.deposit(u.agent, lot);
    expect(again.body.error).toBe('DEPOSIT_EXISTS');
    const poor = await h.user({ plan: 'full', card: '4000000000000002' });
    const d = await h.deposit(poor.agent, lot);
    expect(d.body).toMatchObject({ error: 'DEPOSIT_DECLINED', canChooseAnotherCard: true });
  });
  it('нельзя без email, проверки личности; продавец не участвует в своём лоте (R-14)', async () => {
    const seller = await h.user({ plan: 'full' });
    const lot = await h.lot(seller.id);
    expect((await h.deposit(seller.agent, lot)).body.error).toBe('OWN_LOT');
    const noKyc = await h.user({ kyc: false, plan: 'full' });
    expect((await h.deposit(noKyc.agent, lot)).body.error).toBe('KYC_REQUIRED');
  });
});

describe('SC-08 Ставка', () => {
  let lot: number;
  let seller: any;
  beforeAll(async () => {
    seller = await h.user();
    lot = await h.lot(seller.id, { price: 40_000_000 });
  });
  it('отказы: не больше начальной цены, не целое, нет депозита, нет доступа, свой лот', async () => {
    const u = await h.bidder(lot);
    expect((await h.bid(u.agent, lot, 40_000_000)).body).toMatchObject({ error: 'BID_TOO_LOW', min: 40_000_001 });
    expect((await h.bid(u.agent, lot, '40000000.5')).body.error).toBe('BID_NOT_INTEGER');
    expect((await h.bid(u.agent, lot, -5)).body.error).toBe('BID_NOT_INTEGER');
    const noDep = await h.user({ plan: 'full' });
    expect((await h.bid(noDep.agent, lot, 41_000_000)).body.error).toBe('DEPOSIT_REQUIRED');
    const noSub = await h.user({ card: '4111111111110002' });
    expect((await h.bid(noSub.agent, lot, 41_000_000)).body.error).toBe('SUBSCRIPTION_REQUIRED');
    expect((await h.bid(seller.agent, lot, 41_000_000)).body.error).toBe('OWN_LOT');
  });
  it('R-04: любая сумма > начальной с точностью до 1 ֏; квитанция с мс и контрольным кодом; без повторного SMS — отказ', async () => {
    const u = await h.bidder(lot);
    const noStep = await u.agent.post(`/api/lots/${lot}/bids`).set('idempotency-key', 'k-nostep-123').send({ amount: 40_000_001, acceptRules: true });
    expect(noStep.body.error).toBe('STEP_UP_REQUIRED');
    const r = await h.bid(u.agent, lot, '40 000 001');
    expect(r.status).toBe(201);
    expect(r.body.amount).toBe(40_000_001);
    expect(r.body.serverReceivedAt).toMatch(/\.\d{3}Z$/);
    expect(r.body.commitment).toMatch(/^[0-9a-f]{64}$/);
    const mine = await u.agent.get(`/api/lots/${lot}/my-bids`);
    expect(mine.body.bid.amount).toBe(40_000_001);
    // квитанция письмом, но тело в базе зашифровано (7.4.4)
    const mail = await h.outbox(u.id, 'bid_receipt');
    expect(mail).toHaveLength(1);
    expect(mail[0].sealed).toBe(true);
    expect(mail[0].body).not.toContain('40 000 001');
  });
  it('идемпотентность: повторное нажатие с тем же ключом возвращает ту же квитанцию', async () => {
    const u = await h.bidder(lot);
    const a = await h.bid(u.agent, lot, 45_000_000, 'same-key-0001');
    const b = await h.bid(u.agent, lot, 45_000_000, 'same-key-0001');
    expect(b.body.bidId).toBe(a.body.bidId);
    expect((await h.db.q(`SELECT 1 FROM bids WHERE user_id=$1`, [u.id])).length).toBe(1);
  });
});

describe('SC-09 Вторая ставка', () => {
  it('отказ «Ставка уже сделана»; при двух одновременных запросах в базе одна ставка', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const u = await h.bidder(lot);
    await h.bid(u.agent, lot, 41_000_000).then((r) => expect(r.status).toBe(201));
    expect((await h.bid(u.agent, lot, 50_000_000)).body.error).toBe('BID_EXISTS');
    const v = await h.bidder(lot);
    const [t1, t2] = [await h.stepUp(v.agent, 'bid'), await h.stepUp(v.agent, 'bid')];
    const res = await Promise.all([
      v.agent.post(`/api/lots/${lot}/bids`).set('x-step-up', t1).set('idempotency-key', 'race-aaaa-1').send({ amount: 42_000_000, acceptRules: true }),
      v.agent.post(`/api/lots/${lot}/bids`).set('x-step-up', t2).set('idempotency-key', 'race-bbbb-2').send({ amount: 43_000_000, acceptRules: true }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await h.db.q(`SELECT 1 FROM bids WHERE lot_id=$1 AND user_id=$2`, [lot, v.id])).length).toBe(1);
  });
});

describe('SC-10 / R-03 / R-08 Ставка после конца', () => {
  it('запрос ровно в момент конца — «Аукцион завершён», ставка не сохраняется', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { closesIn: 10 * 60_000 });
    const u = await h.bidder(lot);
    const tk = await h.stepUp(u.agent, 'bid');
    h.advance(10 * 60_000);
    const r = await u.agent.post(`/api/lots/${lot}/bids`).set('x-step-up', tk).set('idempotency-key', 'late-key-001').send({ amount: 50_000_000, acceptRules: true });
    expect(r.body.error).toBe('AUCTION_ENDED');
    expect((await h.db.q(`SELECT 1 FROM bids WHERE lot_id=$1`, [lot])).length).toBe(0);
    const l = await h.db.one(`SELECT closes_at FROM lots WHERE id=$1`, [lot]);
    expect(new Date(l.closes_at).getTime()).toBe(h.clock.ms()); // конец не продлевается
  });
});

describe('R-06 / 7.4 Тайна ставок до конца', () => {
  it('ни карточка, ни каталог, ни админка, ни база не раскрывают ставки', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const u = await h.bidder(lot);
    await h.bid(u.agent, lot, 47_777_777);
    const guest = await request(h.http).get(`/api/lots/${lot}`);
    const asSeller = await seller.agent.get(`/api/lots/${lot}`);
    const admin = await h.staff();
    const adm = await admin.get(`/api/admin/lots/${lot}`);
    const cat = await request(h.http).get('/api/lots');
    for (const body of [guest.body, asSeller.body, adm.body, cat.body]) {
      const s = JSON.stringify(body);
      expect(s).not.toContain('47777777');
      expect(s).not.toMatch(/"(bids|bidCount|participants)"/);
    }
    expect(guest.body.result).toBeUndefined();
    const raw = await h.db.one(`SELECT * FROM bids WHERE lot_id=$1`, [lot]);
    expect(raw.amount).toBeNull();
    expect(JSON.stringify(raw)).not.toContain('47777777');
    const audit = await h.db.q(`SELECT after FROM audit_log WHERE entity='bid'`);
    expect(JSON.stringify(audit)).not.toContain('47777777');
    // закрытый ключ не разворачивается до конца
    const l = await h.db.one(`SELECT private_key_wrapped, closes_at FROM lots WHERE id=$1`, [lot]);
    expect(() => h.get(FakeKms).unwrap(lot, l.private_key_wrapped, new Date(l.closes_at), h.clock.now())).toThrow();
  });
});

describe('SC-11 / SC-12 / R-09 / R-10 Вскрытие и итог', () => {
  it('пример из PRD: равные суммы — побеждает пришедшая раньше; всё открыто всем; письма всем', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000, closesIn: 7 * DAY });
    const A = await h.bidder(lot);
    const B = await h.bidder(lot);
    const C = await h.bidder(lot);
    const watcher = await h.bidder(lot); // внёс депозит, но не поставил
    await h.bid(A.agent, lot, 43_500_000);
    h.advance(HOUR);
    await h.bid(B.agent, lot, 42_815_000);
    h.advance(HOUR);
    await h.bid(C.agent, lot, 43_500_000);
    h.set(new Date((await h.db.one(`SELECT closes_at FROM lots WHERE id=$1`, [lot])).closes_at));
    const card = await request(h.http).get(`/api/lots/${lot}`);
    expect(card.body.lot.status).toBe('revealing');
    await h.scheduler().tick();
    const res = await request(h.http).get(`/api/lots/${lot}/result`).expect(200);
    expect(res.body.bids.map((b: any) => b.amount)).toEqual([43_500_000, 43_500_000, 42_815_000]);
    expect(res.body.bids[0].isWinner).toBe(true);
    const asA = await (await h.fresh(A.agent)).get(`/api/lots/${lot}/result`);
    expect(asA.body.youWon).toBe(true);
    expect(asA.body.bids.find((b: any) => b.isMe).place).toBe(1);
    const asC = await (await h.fresh(C.agent)).get(`/api/lots/${lot}/result`);
    expect(asC.body.bids.find((b: any) => b.isMe).place).toBe(2);
    // имён и телефонов в итоге нет, но есть публичный ID участника (v0.2)
    expect(JSON.stringify(res.body)).not.toMatch(/Test User|\+374/);
    expect(res.body.bids.map((b: any) => b.userId)).toEqual([A.id, C.id, B.id]);
    expect((await h.outbox(B.id, 'results'))[0].body).toContain('ID ' + A.id);
    const deal = await h.db.one(`SELECT * FROM deals WHERE lot_id=$1`, [lot]);
    expect(deal).toMatchObject({ winner_user_id: A.id, amount: 43_500_000, status: 'awaiting_confirm' });
    // депозиты проигравших и не ставившего освобождены, у победителя — держится
    const deps = await h.db.q(`SELECT user_id, status FROM deposits WHERE lot_id=$1`, [lot]);
    const st = Object.fromEntries(deps.map((d) => [d.user_id, d.status]));
    expect(st[A.id]).toBe('held');
    // PRD v2 решение 8: взнос держат места 1–3 (A, C, B) — сделка может перейти к ним; не ставившему — освобождён
    expect([st[B.id], st[C.id], st[watcher.id]]).toEqual(['held', 'held', 'released']);
    expect((await h.outbox(C.id, 'results'))[0].body).toContain('2-м месте');
    expect((await h.outbox(B.id, 'results'))[0].body).toContain('3-м месте');
    // письма: каждому участнику и продавцу + SMS-дубль
    for (const u of [A, B, C, seller]) {
      expect((await h.outbox(u.id, 'results')).length).toBe(1);
      expect((await h.outbox(u.id, 'results_sms')).length).toBe(1);
    }
    expect((await h.outbox(A.id, 'results'))[0].body).toContain('/deals/');
    expect((await h.outbox(B.id, 'results'))[0].body).toContain('остаётся заблокированным'); // PRD v2: 3-е место тоже ждёт
    // контрольные коды проверяемы любым
    const crypto = await import('crypto');
    for (const b of res.body.bids) expect(crypto.createHash('sha256').update(`${b.amount}${b.salt}${b.bidId}`).digest('hex')).toBe(b.commitment);
    // повтор вскрытия не меняет результат
    const again = await h.reveal().reveal(lot);
    expect(again).toEqual({ skipped: true });
  });

  it('SC-12: письмо не доставлено → повторы до 24 ч, затем failed (виден в админке)', async () => {
    await h.db.q(`UPDATE users SET email='bad+fail@test.am' WHERE id=(SELECT max(id) FROM users WHERE role='user')`);
    const uid = (await h.db.one(`SELECT max(id) id FROM users WHERE role='user'`)).id;
    await h.notify().queue(uid, 'email', 'results_no_bids', { lotId: 1 });
    await h.notify().deliver();
    let n = (await h.outbox(uid, 'results_no_bids'))[0];
    expect(n.status).toBe('queued');
    expect(n.attempts).toBe(1);
    h.advance(25 * HOUR);
    await h.notify().deliver();
    n = (await h.outbox(uid, 'results_no_bids'))[0];
    expect(n.status).toBe('failed');
  });
});

describe('SC-13 / R-12 Ставок нет', () => {
  it('лот «не состоялся», депозиты освобождены, продавец перезапускает лот одной кнопкой', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { closesIn: HOUR });
    const w = await h.bidder(lot);
    h.advance(HOUR);
    await h.scheduler().tick();
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('no_sale');
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, w.id])).status).toBe('released');
    const r = await (await h.fresh(seller.agent)).post(`/api/lots/${lot}/relaunch`).expect(201);
    const nl = await h.db.one(`SELECT status, relaunched_from FROM lots WHERE id=$1`, [r.body.id]);
    expect(nl).toEqual({ status: 'draft', relaunched_from: lot });
  });
});

describe('BidsService.parseAmount', () => {
  it('принимает целые с пробелами, отвергает дробные и мусор', () => {
    expect(BidsService.parseAmount('1 000 001')).toBe(1_000_001);
    expect(() => BidsService.parseAmount('1e7')).toThrow();
    expect(() => BidsService.parseAmount(1.5)).toThrow();
  });
});
