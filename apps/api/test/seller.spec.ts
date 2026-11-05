import { H } from './helpers';
import { DAY, HOUR } from '../src/common/clock';
import { SettingsService } from '../src/common/settings';
import { SellerService } from '../src/modules/seller/seller.service';

const h = new H();
beforeAll(async () => {
  await h.start();
  await h.get(SettingsService).set('seller_plans_enabled', true, null);
  await h.get(SettingsService).set('seller_deposit_enabled', true, null);
});
afterAll(() => h.stop());

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** Черновик, готовый к отправке на модерацию. */
async function draft(s: any, price = 40_000_000) {
  const id = (await s.agent.post('/api/lots').expect(201)).body.id;
  await s.agent.patch(`/api/lots/${id}`).send({ step: 1, data: { property_type: 'apartment', region: 'Yerevan', settlement: 'Yerevan', street: 'Abovyan St', cadastral_no: '01-001-0001-0099' } }).expect(200);
  const step2 = { area_m2: 80, rooms: 3, bathrooms: 1, year_built: 2000, heating: 'central', condition: 'good', description_i18n: { ru: 'Квартира' }, floor: 3, building_floors: 9, building_type: 'monolith', has_elevator: true, has_balcony: true, parking: false };
  await s.agent.patch(`/api/lots/${id}`).send({ step: 2, data: step2 }).expect(200);
  for (let i = 0; i < 10; i++) await s.agent.post(`/api/lots/${id}/media?kind=photo`).attach('file', png, { filename: `p${i}.png`, contentType: 'image/png' }).expect(201);
  await s.agent.post(`/api/lots/${id}/media?kind=extract`).attach('file', Buffer.from('%PDF-1.4'), { filename: 'e.pdf', contentType: 'application/pdf' }).expect(201);
  const now = h.clock.ms();
  await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: price, opens_at: new Date(now + 2 * DAY).toISOString(), closes_at: new Date(now + 6 * DAY).toISOString(), guarantee_percent: 1 } }).expect(200);
  return id as number;
}
const buy = async (s: any, plan: string) => s.agent.post('/api/seller/subscriptions').set('x-step-up', await h.stepUp(s.agent, 'subscription')).send({ plan });
const submit = (s: any, id: number) => s.agent.post(`/api/lots/${id}/submit`).send({ acceptRules: true });
const approve = async (id: number) => (await h.staff()).post(`/api/admin/lots/${id}/moderate`).send({ decision: 'approve', checklist: { extract: true, owner_match: true } }).expect(201);

describe('PRD v2 решение 16: тарифы продавца', () => {
  it('без тарифа на модерацию не отправить; разовое — 1 лот; отклонён — размещение вернулось; одобрен — потрачено', async () => {
    const s = await h.user({ card: '4111111111110101' });
    const a = await draft(s);
    expect((await submit(s, a)).body.error).toBe('SELLER_PLAN_REQUIRED');
    expect((await buy(s, 'single')).status).toBe(201);
    await submit(s, a).expect(201);
    const b = await draft(s);
    expect((await submit(s, b)).body.error).toBe('SELLER_PLAN_REQUIRED'); // разовое уже занято лотом A
    await (await h.staff()).post(`/api/admin/lots/${a}/moderate`).send({ decision: 'reject', comment: 'Документы не те' }).expect(201);
    await submit(s, b).expect(201); // размещение вернулось после отказа
    await approve(b);
    const mine = (await s.agent.get('/api/me/seller')).body;
    expect(mine.subscriptions[0]).toMatchObject({ plan: 'single', limit: 1, used: 1, left: 0 });
    expect(mine.history.map((x: any) => [x.lot_id, x.type])).toEqual([
      [b, 'spent'],
      [b, 'reserved'],
      [a, 'released'],
      [a, 'reserved'],
    ]);
    const pay = await h.db.one(`SELECT kind, amount, status FROM payments WHERE user_id=$1`, [s.id]);
    expect(pay).toMatchObject({ kind: 'seller_plan', amount: 10000, status: 'paid' });
  });

  it('безлимит: не больше 20 активных одновременно; повторная отправка после «вернуть на доработку» не тратит размещение', async () => {
    const s = await h.user({ card: '4111111111110101' });
    await buy(s, 'unlimited');
    await h.db.q(`UPDATE seller_subscriptions SET max_active=1 WHERE user_id=$1`, [s.id]); // для теста — лимит 1
    const a = await draft(s);
    await submit(s, a).expect(201);
    await (await h.staff()).post(`/api/admin/lots/${a}/moderate`).send({ decision: 'return', comment: 'Добавьте фото кухни' }).expect(201);
    await s.agent.patch(`/api/lots/${a}`).send({ step: 3, data: {} });
    await submit(s, a).expect(201);
    expect((await h.db.q(`SELECT 1 FROM listing_credits WHERE lot_id=$1 AND type='reserved'`, [a])).length).toBe(1);
    const b = await draft(s);
    expect((await submit(s, b)).body).toMatchObject({ error: 'SELLER_ACTIVE_LIMIT', max: 1 });
  });
});

describe('PRD v2 решение 17: взнос продавца', () => {
  async function liveLot(price = 40_000_000) {
    const seller = await h.user({ card: '4111111111110202' });
    const lot = await h.lot(seller.id, { price, opensIn: DAY, closesIn: 3 * DAY });
    await h.db.q(`UPDATE lots SET guarantee_bp=100 WHERE id=$1`, [lot]); // продавец выбрал 1 %
    return { seller, lot };
  }

  it('регистрация участников открывается только после блокировки взноса продавца (1 %, не меньше 100 000)', async () => {
    const { lot } = await liveLot(5_000_000);
    const u = await h.user({ plan: 'full' });
    expect((await h.deposit(u.agent, lot)).status).toBe(201); // взнос продавца заблокировался при первой регистрации
    const sd = await h.db.one(`SELECT amount, status FROM seller_deposits WHERE lot_id=$1`, [lot]);
    expect(sd).toMatchObject({ amount: 100000, status: 'held' }); // 1 % = 50 000 → минимум 100 000
    // у продавца не прошла блокировка → регистрация закрыта
    const poor = await h.user({ card: '4000000000000002' });
    const lot2 = await h.lot(poor.id);
    const r = await h.deposit(u.agent, lot2);
    expect(r.body).toMatchObject({ error: 'REGISTRATION_NOT_OPEN', reason: 'SELLER_GUARANTEE' });
    expect((await h.outbox(poor.id, 'seller_deposit_failed')).length).toBe(1);
  });

  it('снял лот после открытия регистрации — удержано 25 %: 80 % участникам поровну, 20 % платформе', async () => {
    const { seller, lot } = await liveLot();
    const a = await h.bidder(lot);
    const b = await h.bidder(lot);
    await seller.agent.post(`/api/lots/${lot}/withdraw`).send({}).expect(201);
    const sd = await h.db.one(`SELECT amount, charged_amount, status FROM seller_deposits WHERE lot_id=$1`, [lot]);
    expect(sd).toMatchObject({ amount: 400000, charged_amount: 100000, status: 'charged' });
    const p = await h.db.q(`SELECT recipient, user_id, amount FROM payouts WHERE seller_lot_id=$1 ORDER BY recipient, user_id`, [lot]);
    expect(p).toEqual([
      { recipient: 'buyer', user_id: Math.min(a.id, b.id), amount: 40000 },
      { recipient: 'buyer', user_id: Math.max(a.id, b.id), amount: 40000 },
      { recipient: 'platform', user_id: null, amount: 20000 },
    ]);
    expect((await h.outbox(a.id, 'seller_forfeit_compensation')).length).toBe(1);
    const led = await h.db.q(`SELECT kind, amount FROM ledger WHERE user_id=$1 AND kind LIKE 'seller_%' ORDER BY id`, [seller.id]);
    expect(led).toEqual([
      { kind: 'seller_guarantee_held', amount: 400000 },
      { kind: 'seller_guarantee_charged', amount: 100000 },
    ]);
  });

  it('продавец сорвал сделку — 100 %, 80 % победителю; продано — взнос возвращается; админ снял — возвращается', async () => {
    const { seller, lot } = await liveLot();
    const win = await h.bidder(lot);
    h.advance(DAY);
    await h.bid(win.agent, lot, 45_000_000);
    h.advance(2 * DAY);
    await h.reveal().revealDue();
    await (await h.fresh(win.agent)).post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(win.agent, 'deal_confirm')).expect(201);
    await (await h.fresh(seller.agent)).post(`/api/deals/${lot}/decline`).send({ reason: 'передумал' }).expect(201);
    expect(await h.db.one(`SELECT charged_amount, status FROM seller_deposits WHERE lot_id=$1`, [lot])).toMatchObject({ charged_amount: 400000, status: 'charged' });
    expect(await h.db.one(`SELECT user_id, amount FROM payouts WHERE seller_lot_id=$1 AND recipient='buyer'`, [lot])).toMatchObject({ user_id: win.id, amount: 320000 });

    const x = await liveLot();
    await h.bidder(x.lot);
    await h.db.q(`UPDATE lots SET status='sold' WHERE id=$1`, [x.lot]);
    await h.get(SellerService).tick();
    expect((await h.db.one(`SELECT status FROM seller_deposits WHERE lot_id=$1`, [x.lot])).status).toBe('released');

    const y = await liveLot();
    await h.bidder(y.lot);
    await (await h.staff()).post(`/api/admin/lots/${y.lot}/withdraw`).send({ reason: 'Технический сбой' }).expect(201);
    expect((await h.db.one(`SELECT status FROM seller_deposits WHERE lot_id=$1`, [y.lot])).status).toBe('released');
    h.advance(HOUR);
  });
});
