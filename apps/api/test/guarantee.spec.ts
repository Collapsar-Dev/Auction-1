import { H } from './helpers';
import { DAY } from '../src/common/clock';
import { DEFAULT_SETTINGS, guaranteeFor } from '../src/common/settings';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

describe('PRD v2 решение 6: взнос 0–10 % задаёт продавец; «Счёт участника»', () => {
  it('расчёт: ровно процент продавца без мин/макс; без процента — правило v1', () => {
    expect(guaranteeFor(45_000_000, 100, DEFAULT_SETTINGS)).toBe(450_000);
    expect(guaranteeFor(45_000_000, 1000, DEFAULT_SETTINGS)).toBe(4_500_000); // больше старого максимума 2 000 000
    expect(guaranteeFor(15_000_000, 50, DEFAULT_SETTINGS)).toBe(75_000); // меньше старого минимума 200 000
    expect(guaranteeFor(45_000_000, 0, DEFAULT_SETTINGS)).toBe(0);
    expect(guaranteeFor(15_000_000, null, DEFAULT_SETTINGS)).toBe(200_000);
  });

  it('мастер: процент сохраняется, по умолчанию 1 %, больше 10 % — отказ', async () => {
    const s = await h.user({ card: '4111111111111111' });
    const id = (await s.agent.post('/api/lots').expect(201)).body.id;
    const opens = new Date(h.clock.ms() + 2 * DAY).toISOString();
    const closes = new Date(h.clock.ms() + 6 * DAY).toISOString();
    const save = (extra: any) => s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: 40_000_000, opens_at: opens, closes_at: closes, ...extra } });
    const def = await save({});
    expect(def.status).toBe(200);
    expect(def.body.lot).toMatchObject({ guarantee_percent: 1, deposit_amount: 400_000 });
    expect((await save({ guarantee_percent: 2.5 })).body.lot).toMatchObject({ guarantee_percent: 2.5, deposit_amount: 1_000_000 });
    expect((await save({ guarantee_percent: 0 })).body.lot).toMatchObject({ guarantee_percent: 0, deposit_amount: 0 });
    expect((await save({ guarantee_percent: 11 })).status).toBe(400);
  });

  it('взнос 0 %: участие без блокировки на карте, попытка списывается, ставка принимается', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    await h.db.q(`UPDATE lots SET guarantee_bp=0, deposit_amount=0 WHERE id=$1`, [lot]);
    const u = await h.user({ plan: 'standard' });
    const before = Object.keys((h.gw as any).orders ?? {}).length;
    const d = await h.deposit(u.agent, lot);
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ status: 'held', amount: 0 });
    expect(Object.keys((h.gw as any).orders ?? {}).length).toBe(before); // в банк не ходили
    expect((await h.bid(u.agent, lot, 41_000_000)).status).toBe(201);
    const p = (await u.agent.get('/api/subscriptions/participations')).body.subscriptions[0];
    expect(p.used).toBe(1);
  });

  it('не хватает средств: ответ с суммой и картой для окна «Пополнить?»; «Счёт» показывает блокировки', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const poor = await h.user({ plan: 'full', card: '4000000000000002' });
    const r = await h.deposit(poor.agent, lot);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: 'DEPOSIT_DECLINED', reason: 'INSUFFICIENT_FUNDS', amount: 400_000 });
    expect(r.body.mask).toMatch(/0002$/);
    expect((await poor.agent.get('/api/me/account')).body.items.length).toBe(0); // неудачные не показываются

    const u = await h.user({ plan: 'full' });
    await h.deposit(u.agent, lot);
    const lot2 = await h.lot(seller.id, { price: 50_000_000 });
    await h.db.q(`UPDATE lots SET guarantee_bp=200, deposit_amount=1000000 WHERE id=$1`, [lot2]);
    await h.deposit(u.agent, lot2);
    const acc = (await u.agent.get('/api/me/account').expect(200)).body;
    expect(acc.model).toBe('card_hold');
    expect(acc.totals).toMatchObject({ blocked: 1_400_000, released: 0, charged: 0 });
    expect(acc.items.map((i: any) => [i.lot_id, i.amount, i.guarantee_percent])).toEqual([
      [lot2, 1_000_000, 2],
      [lot, 400_000, null],
    ]);
  });
});
