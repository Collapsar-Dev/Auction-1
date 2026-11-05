import request from 'supertest';
import { H } from './helpers';
import { DAY } from '../src/common/clock';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const pdf = Buffer.from('%PDF-1.4');

async function prepared(cadastral: string, o: { rooms?: string[]; docs?: string[]; insurance?: any } = {}) {
  const s = await h.user({ card: '4111111111110303', name: 'Seller Wizard' });
  const id = (await s.agent.post('/api/lots').expect(201)).body.id;
  const st1 = await s.agent.patch(`/api/lots/${id}`).send({ step: 1, data: { property_type: 'apartment', region: 'Yerevan', settlement: 'Yerevan', street: 'Abovyan St', cadastral_no: cadastral } }).expect(200);
  await s.agent.patch(`/api/lots/${id}`).send({ step: 2, data: { area_m2: 80, rooms: 3, bathrooms: 1, year_built: 2000, heating: 'central', condition: 'good', description_i18n: { ru: 'Квартира' }, floor: 3, building_floors: 9, building_type: 'monolith', has_elevator: true, has_balcony: true, parking: false } }).expect(200);
  const rooms = o.rooms ?? ['living', 'kitchen', 'bathroom', 'bedroom', 'facade'];
  for (let i = 0; i < 10; i++) await s.agent.post(`/api/lots/${id}/media?kind=photo&room=${rooms[i % rooms.length]}`).attach('file', png, { filename: `p${i}.png`, contentType: 'image/png' }).expect(201);
  await s.agent.post(`/api/lots/${id}/media?kind=extract`).attach('file', pdf, { filename: 'e.pdf', contentType: 'application/pdf' }).expect(201);
  for (const d of o.docs ?? ['encumbrance']) await s.agent.post(`/api/lots/${id}/media?kind=document&docType=${d}`).attach('file', pdf, { filename: d + '.pdf', contentType: 'application/pdf' }).expect(201);
  const now = h.clock.ms();
  await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: 40_000_000, opens_at: new Date(now + 2 * DAY).toISOString(), closes_at: new Date(now + 6 * DAY).toISOString(), ...(o.insurance ? { insurance: o.insurance } : {}) } }).expect(200);
  return { s, id, step1: st1.body };
}
const submit = (p: any) => p.s.agent.post(`/api/lots/${p.id}/submit`).send({ acceptRules: true });

describe('PRD v2 (F9): создание лота — кадастр, документы, фото по комнатам, страховка, переписка', () => {
  it('шаг «Объект»: проверка по кадастру видна сразу; «не найден» и «арест» не дают отправить', async () => {
    const ok = await prepared('01-002-0045-0041');
    expect(ok.step1.cadastre).toMatchObject({ found: true, ownerMatches: true, encumbrance: 'none' });
    expect(ok.step1.readiness.map((r: any) => r.code)).toContain('DOCUMENT_REQUIRED'); // справку ещё не загрузили на шаге 1
    await submit(ok).expect(201);

    const nf = await prepared('01-002-0045-9999');
    expect((await submit(nf)).body.error).toBe('CADASTRE_NOT_FOUND');
    const ar = await prepared('01-002-0045-0013');
    expect((await submit(ar)).body.error).toBe('CADASTRE_ARREST');
  });

  it('собственник другой — нужна доверенность; нет справки об аресте/ипотеке — нельзя; фото без нужных комнат — нельзя', async () => {
    const other = await prepared('01-002-0045-0007');
    expect((await submit(other)).body).toMatchObject({ error: 'OWNER_MISMATCH' });
    await other.s.agent.post(`/api/lots/${other.id}/media?kind=document&docType=power_of_attorney`).attach('file', pdf, { filename: 'poa.pdf', contentType: 'application/pdf' }).expect(201);
    await submit(other).expect(201);

    const noDoc = await prepared('01-002-0045-0042', { docs: [] });
    expect((await submit(noDoc)).body).toMatchObject({ error: 'DOCUMENT_REQUIRED', problems: [{ code: 'DOCUMENT_REQUIRED', data: { doc: 'encumbrance' } }] });

    const rooms = await prepared('01-002-0045-0043', { rooms: ['facade', 'living'] });
    expect((await submit(rooms)).body).toMatchObject({ error: 'PHOTOS_ROOMS_MISSING', problems: [{ data: { missing: ['kitchen', 'bathroom'] } }] });
    expect((await rooms.s.agent.post(`/api/lots/${rooms.id}/media?kind=photo&room=garage`).attach('file', png, { filename: 'g.png', contentType: 'image/png' })).body.error).toBe('ROOM_INVALID');
  });

  it('страховка: «есть полис» требует загрузить полис; документы видит только модератор; покупатель видит отметки', async () => {
    const p = await prepared('01-002-0045-0044', { insurance: { mode: 'have', insurer: 'Тест-Полис', policy_no: 'P-1' } });
    expect((await submit(p)).body.problems).toEqual([{ code: 'DOCUMENT_REQUIRED', data: { doc: 'insurance_policy' } }]);
    await p.s.agent.post(`/api/lots/${p.id}/media?kind=document&docType=insurance_policy`).attach('file', pdf, { filename: 'pol.pdf', contentType: 'application/pdf' }).expect(201);
    await submit(p).expect(201);
    const adm = await h.staff();
    const al = (await adm.get(`/api/admin/lots/${p.id}`).expect(200)).body;
    expect(al.documents.map((d: any) => d.docType).sort()).toEqual(['encumbrance', 'insurance_policy']);
    expect(al.documents[0].url).toBeTruthy();
    expect(al.photoRooms).toContain('kitchen');
    await adm.post(`/api/admin/lots/${p.id}/moderate`).send({ decision: 'approve', checklist: { extract: true, owner_match: true } }).expect(201);
    const card = (await request(h.http).get(`/api/lots/${p.id}`)).body;
    expect(card.verification).toMatchObject({ cadastre: { checked: true, encumbrance: 'none' }, insurance: { mode: 'have', insurer: 'Тест-Полис' } });
    expect(JSON.stringify(card)).not.toMatch(/P-1|pol\.pdf|enc\.pdf|docType/); // ни номера полиса, ни файлов
  });

  it('переписка: модератор пишет — продавцу письмо; продавец отвечает; чужой не видит', async () => {
    const p = await prepared('01-002-0045-0045');
    await submit(p).expect(201);
    const adm = await h.staff();
    await adm.post(`/api/admin/lots/${p.id}/messages`).send({ text: 'Замените фото кухни — это другая квартира' }).expect(201);
    expect((await h.outbox(p.s.id, 'lot_message')).length).toBe(1);
    await p.s.agent.post(`/api/lots/${p.id}/messages`).send({ text: 'Заменил' }).expect(201);
    const thread = (await p.s.agent.get(`/api/lots/${p.id}/messages`).expect(200)).body;
    expect(thread.map((m: any) => [m.author_role, m.text])).toEqual([
      ['staff', 'Замените фото кухни — это другая квартира'],
      ['seller', 'Заменил'],
    ]);
    const stranger = await h.user();
    expect((await stranger.agent.get(`/api/lots/${p.id}/messages`)).status).toBe(404);
    expect((await p.s.agent.post(`/api/lots/${p.id}/messages`).send({ text: '' })).body.error).toBe('MESSAGE_INVALID');
  });
});
