import request from 'supertest';
import { H } from './helpers';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const pdf = Buffer.from('%PDF-1.4');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

async function partner(kind = 'insurance', name = 'Страховая «Тест-Полис»') {
  const u = await h.user();
  await u.agent
    .post('/api/partner/apply')
    .field('kind', kind)
    .field('name', name)
    .field('city', 'Ереван')
    .field('description', 'Титул и имущество')
    .field('license_no', 'L-0001')
    .attach('license', pdf, { filename: 'lic.pdf', contentType: 'application/pdf' })
    .expect(201);
  const p = await h.db.one('SELECT id FROM partners WHERE user_id=$1', [u.id]);
  return { u, id: Number(p.id) };
}

describe('PRD v2 (F10, F11.4): партнёры, заявки, реклама', () => {
  it('в справочнике — только партнёры с проверенной лицензией; отказ — только с причиной', async () => {
    const p = await partner();
    const noKyc = await h.user({ kyc: false });
    expect((await noKyc.agent.post('/api/partner/apply').field('kind', 'notary')).body.error).toBe('KYC_REQUIRED');
    expect((await request(h.http).get('/api/partners')).body.find((x: any) => x.id === p.id)).toBeUndefined();
    const adm = await h.staff();
    const queue = (await adm.get('/api/admin/partners').expect(200)).body;
    expect(queue.find((x: any) => x.id === p.id)).toMatchObject({ status: 'pending', license_no: 'L-0001' });
    expect(queue[0].license_url).toBeTruthy();
    expect((await adm.post(`/api/admin/partners/${p.id}/decide`).send({ action: 'reject' })).body.error).toBe('REASON_REQUIRED');
    await adm.post(`/api/admin/partners/${p.id}/decide`).send({ action: 'approve' }).expect(201);
    const list = (await request(h.http).get('/api/partners?kind=insurance')).body;
    expect(list.find((x: any) => x.id === p.id)).toMatchObject({ name: 'Страховая «Тест-Полис»', licensed: true });
    expect(JSON.stringify(list)).not.toContain('L-0001'); // номер и файл лицензии — только модератору
    expect((await h.outbox(p.u.id, 'partner_decision')).length).toBe(1);
  });

  it('заявка на страховку: партнёр получает письмо, принимает или отказывает с причиной; клиент видит ответ', async () => {
    const p = await partner('insurance', 'Страховая Б');
    await (await h.staff()).post(`/api/admin/partners/${p.id}/decide`).send({ action: 'approve' }).expect(201);
    const client = await h.user();
    const r = await client.agent.post(`/api/partners/${p.id}/requests`).send({ service: 'insurance_title', comment: 'Нужен полис до договора' }).expect(201);
    expect((await h.outbox(p.u.id, 'partner_request_new')).length).toBe(1);
    const cab = (await p.u.agent.get('/api/partner').expect(200)).body;
    expect(cab.requests[0]).toMatchObject({ id: r.body.id, service: 'insurance_title', status: 'new' });
    expect((await p.u.agent.post(`/api/partner/requests/${r.body.id}`).send({ status: 'rejected' })).body.error).toBe('REASON_REQUIRED');
    await p.u.agent.post(`/api/partner/requests/${r.body.id}`).send({ status: 'accepted', reply: 'Пришлём полис завтра' }).expect(201);
    const mine = (await client.agent.get('/api/me/service-requests')).body;
    expect(mine[0]).toMatchObject({ status: 'accepted', reply: 'Пришлём полис завтра', partner_name: 'Страховая Б' });
    // чужую заявку партнёр не меняет
    const other = await partner('lawyer', 'Юрист В');
    await (await h.staff()).post(`/api/admin/partners/${other.id}/decide`).send({ action: 'approve' }).expect(201);
    expect((await other.u.agent.post(`/api/partner/requests/${r.body.id}`).send({ status: 'done' })).status).toBe(404);
  });

  it('реклама: цена по месту и сроку; показывается только после одобрения и в свои даты; показы и клики считаются', async () => {
    const p = await partner('lawyer', 'Юридическое бюро «Пример»');
    await (await h.staff()).post(`/api/admin/partners/${p.id}/decide`).send({ action: 'approve' }).expect(201);
    const today = h.clock.now().toISOString().slice(0, 10);
    const in29 = new Date(h.clock.ms() + 29 * 86400_000).toISOString().slice(0, 10);
    const a = await p.u.agent
      .post('/api/partner/ads')
      .field('slot', 'catalog')
      .field('title', 'Проверка сделки за 24 часа')
      .field('url', 'https://example.am/offer')
      .field('starts_on', today)
      .field('ends_on', in29)
      .attach('creative', png, { filename: 'ad.png', contentType: 'image/png' })
      .expect(201);
    expect(a.body).toMatchObject({ status: 'pending', price: 120000 });
    expect((await request(h.http).get('/api/ads?slot=catalog')).body).toEqual([]); // до одобрения не показывается
    const adm = await h.staff();
    expect((await adm.post(`/api/admin/ads/${a.body.id}/decide`).send({ action: 'reject' })).body.error).toBe('REASON_REQUIRED');
    await adm.post(`/api/admin/ads/${a.body.id}/decide`).send({ action: 'approve' }).expect(201);
    const shown = (await request(h.http).get('/api/ads?slot=catalog')).body;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ title: 'Проверка сделки за 24 часа', partner: 'Юридическое бюро «Пример»' });
    expect((await request(h.http).get('/api/ads?slot=lot')).body).toEqual([]);
    const c = await request(h.http).get(shown[0].href).redirects(0);
    expect(c.status).toBe(302);
    expect(c.headers.location).toBe('https://example.am/offer');
    const stat = (await p.u.agent.get('/api/partner')).body.ads[0];
    expect(stat).toMatchObject({ status: 'approved', impressions: 1, clicks: 1 });
    h.advance(31 * 86400_000);
    expect((await request(h.http).get('/api/ads?slot=catalog')).body).toEqual([]); // срок закончился
    // неактивный партнёр рекламу не подаёт
    const pending = await partner('notary', 'Нотариус Г');
    expect((await pending.u.agent.post('/api/partner/ads').field('slot', 'catalog')).body.error).toBe('PARTNER_NOT_ACTIVE');
  });
});
