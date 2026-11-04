import crypto from 'crypto';
import request from 'supertest';
import { H } from './helpers';
import { DAY, HOUR } from '../src/common/clock';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

async function change(agent: any, lotId: number, amount: unknown, key: string = crypto.randomUUID()) {
  const tk = await h.stepUp(agent, 'bid');
  return agent.put(`/api/lots/${lotId}/bids`).set('x-step-up', tk).set('idempotency-key', key).send({ amount });
}

describe('PRD v2 решение 9: изменение ставки до 3 раз', () => {
  it('3 изменения разрешены, 4-е — отказ; участник видит «осталось N» и все свои версии', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000 });
    const u = await h.bidder(lot);
    const first = await h.bid(u.agent, lot, 41_000_000);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ version: 1, changesLeft: 3 });

    const amounts = [45_000_000, 42_000_000, 43_333_333];
    for (let i = 0; i < 3; i++) {
      const r = await change(u.agent, lot, amounts[i]);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ version: i + 2, changesLeft: 2 - i, amount: amounts[i] });
    }
    const fourth = await change(u.agent, lot, 50_000_000);
    expect(fourth.status).toBe(409);
    expect(fourth.body).toMatchObject({ error: 'BID_CHANGES_EXHAUSTED', max: 3 });

    const mine = await u.agent.get(`/api/lots/${lot}/my-bids`).expect(200);
    expect(mine.body.bid).toMatchObject({ amount: 43_333_333, version: 4, changesLeft: 0 });
    expect(mine.body.bid.versions.map((v: any) => v.amount)).toEqual([43_333_333, 42_000_000, 45_000_000, 41_000_000]);
    expect(mine.body.bid.versions.filter((v: any) => v.current).length).toBe(1);
    // строка ставки одна — одна ставка на участника
    expect((await h.db.q(`SELECT 1 FROM bids WHERE lot_id=$1 AND user_id=$2`, [lot, u.id])).length).toBe(1);
  });

  it('ниже начальной цены, без ставки, после конца — отказ; повтор с тем же ключом не тратит изменение', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000, closesIn: 2 * DAY });
    const u = await h.bidder(lot);
    expect((await change(u.agent, lot, 41_000_000)).body.error).toBe('BID_NOT_FOUND');
    await h.bid(u.agent, lot, 41_000_000);
    expect((await change(u.agent, lot, 40_000_000)).body).toMatchObject({ error: 'BID_TOO_LOW', min: 40_000_001 });
    const a = await change(u.agent, lot, 44_000_000, 'change-key-0001');
    const b = await change(u.agent, lot, 44_000_000, 'change-key-0001');
    expect(b.body.receiptNo).toBe(a.body.receiptNo);
    expect(b.body.changesLeft).toBe(2);
    h.set(new Date((await h.db.one(`SELECT closes_at FROM lots WHERE id=$1`, [lot])).closes_at));
    expect((await change(u.agent, lot, 46_000_000)).body.error).toBe('AUCTION_ENDED');
  });

  it('суммы версий нигде не видны до итога: ни в базе, ни в журнале, ни в карточке лота', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000 });
    const u = await h.bidder(lot);
    await h.bid(u.agent, lot, 41_111_111);
    await change(u.agent, lot, 47_654_321);
    const raw = await h.db.q(`SELECT v.* FROM bid_versions v JOIN bids b ON b.id=v.bid_id WHERE b.lot_id=$1`, [lot]);
    expect(raw.length).toBe(2);
    const audit = await h.db.q(`SELECT after FROM audit_log WHERE entity='bid'`);
    const card = await request(h.http).get(`/api/lots/${lot}`);
    for (const x of [raw, audit, card.body, await h.db.q(`SELECT * FROM bids WHERE lot_id=$1`, [lot])]) {
      const s = JSON.stringify(x);
      expect(s).not.toContain('41111111');
      expect(s).not.toContain('47654321');
    }
  });

  it('вскрытие учитывает только последнюю версию; при равных суммах раньше — тот, чья последняя версия пришла раньше', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { price: 40_000_000, closesIn: 7 * DAY });
    const A = await h.bidder(lot);
    const B = await h.bidder(lot);
    await h.bid(A.agent, lot, 50_000_000); // A был выше, но потом понизил
    h.advance(HOUR);
    await h.bid(B.agent, lot, 43_000_000);
    h.advance(HOUR);
    await change(B.agent, lot, 44_000_000);
    h.advance(HOUR);
    await change(A.agent, lot, 44_000_000); // та же сумма, но последняя версия A — позже
    h.set(new Date((await h.db.one(`SELECT closes_at FROM lots WHERE id=$1`, [lot])).closes_at));
    await h.scheduler().tick();
    const res = await request(h.http).get(`/api/lots/${lot}/result`).expect(200);
    expect(res.body.bids.map((b: any) => b.amount)).toEqual([44_000_000, 44_000_000]);
    expect(res.body.bids.map((b: any) => b.userId)).toEqual([B.id, A.id]);
    expect(JSON.stringify(res.body)).not.toContain('50000000');
  });
});
