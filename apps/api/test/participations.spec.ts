import { H } from './helpers';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const left = async (agent: any) => (await agent.get('/api/subscriptions/participations').expect(200)).body;

describe('PRD v2 решения 4–5: тариф по числу участий', () => {
  it('«Участвовать» списывает 1 попытку, повторно за тот же лот — нет; когда кончились — понятная ошибка', async () => {
    const seller = await h.user();
    const [l1, l2, l3] = [await h.lot(seller.id), await h.lot(seller.id), await h.lot(seller.id)];
    const u = await h.user({ plan: 'standard' }); // лимит 2
    expect((await left(u.agent)).subscriptions[0]).toMatchObject({ limit: 2, used: 0, left: 2 });
    expect((await h.deposit(u.agent, l1)).status).toBe(201);
    expect((await h.deposit(u.agent, l2)).status).toBe(201);
    const p = await left(u.agent);
    expect(p.subscriptions[0]).toMatchObject({ used: 2, left: 0 });
    expect(p.history.map((x: any) => [x.lot_id, x.type])).toEqual([
      [l2, 'spent'],
      [l1, 'spent'],
    ]);
    const third = await h.deposit(u.agent, l3);
    expect(third.status).toBe(403);
    expect(third.body.error).toBe('PARTICIPATIONS_EXHAUSTED');
    // по лоту, где уже участвует, ставка принимается, хотя попыток 0
    expect((await h.bid(u.agent, l1, 41_000_000)).status).toBe(201);
  });

  it('банк отказал в блокировке взноса — попытка не сгорает', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const u = await h.user({ plan: 'standard', card: '4000000000000002' });
    expect((await h.deposit(u.agent, lot)).body.error).toBe('DEPOSIT_DECLINED');
    expect((await left(u.agent)).subscriptions[0]).toMatchObject({ used: 0, left: 2 });
  });

  it('лот отменён — попытки возвращаются всем участникам и показывается pop-up', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const a = await h.user({ plan: 'standard' });
    const b = await h.user({ plan: 'standard' });
    await h.deposit(a.agent, lot);
    await h.deposit(b.agent, lot);
    await h.bid(a.agent, lot, 42_000_000);
    const adm = await h.staff();
    await adm.post(`/api/admin/lots/${lot}/withdraw`).send({ reason: 'Технический сбой' }).expect(201);
    for (const u of [a, b]) {
      const agent = await h.fresh(u.agent);
      expect((await left(agent)).subscriptions[0]).toMatchObject({ used: 0, left: 2 });
      const pops = (await agent.get('/api/me/popups').expect(200)).body;
      expect(pops.length).toBe(1);
      expect(pops[0]).toMatchObject({ template: 'participation_refunded' });
      expect(pops[0].payload).toMatchObject({ lotId: lot, left: 2 });
      await agent.post(`/api/me/popups/${pops[0].id}/read`).expect(201);
      expect((await agent.get('/api/me/popups')).body.length).toBe(0);
    }
  });

  it('модератор возвращает попытку за лот или начисляет новую — только с причиной, с записью в журнал', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const u = await h.user({ plan: 'standard' });
    await h.deposit(u.agent, lot);
    const adm = await h.staff();
    expect((await adm.post(`/api/admin/users/${u.id}/participations`).send({})).status).toBe(400);
    await adm.post(`/api/admin/users/${u.id}/participations`).send({ reason: 'Техсбой при оплате взноса', lotId: lot }).expect(201);
    expect((await left(u.agent)).subscriptions[0]).toMatchObject({ used: 0, left: 2 });
    await adm.post(`/api/admin/users/${u.id}/participations`).send({ reason: 'Компенсация за жалобу' }).expect(201);
    expect((await left(u.agent)).subscriptions[0]).toMatchObject({ left: 3 });
    const audit = await h.db.q(`SELECT action FROM audit_log WHERE action LIKE 'participation.%' AND after->>'userId' = $1`, [String(u.id)]);
    expect(audit.map((r: any) => r.action).sort()).toEqual(['participation.granted', 'participation.refunded']);
    expect((await u.agent.get('/api/me/popups')).body.map((p: any) => p.template)).toEqual(['participation_refunded', 'participation_granted']);
  });

  it('тариф без лимита (v1 «Полный») — попытки не кончаются', async () => {
    const seller = await h.user();
    const u = await h.user({ plan: 'full' });
    for (let i = 0; i < 3; i++) expect((await h.deposit(u.agent, await h.lot(seller.id))).status).toBe(201);
    expect((await left(u.agent)).subscriptions[0]).toMatchObject({ limit: null, left: null, used: 3 });
  });
});
