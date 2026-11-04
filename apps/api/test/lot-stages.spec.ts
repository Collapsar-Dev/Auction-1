import request from 'supertest';
import { H } from './helpers';
import { DAY, HOUR } from '../src/common/clock';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const setDates = (lot: number, d: { published?: Date | null; registration?: Date | null; late?: boolean }) =>
  h.db.q(`UPDATE lots SET published_at=$2, registration_opens_at=$3, allow_late_registration=$4 WHERE id=$1`, [lot, d.published ?? null, d.registration ?? null, d.late ?? true]);

describe('PRD v2 §2 и решение 11: статусы лота, даты, сортировка каталога', () => {
  it('статус меняется по датам: скоро → регистрация → торги → ждёт договора; до даты показа лота нет', async () => {
    const seller = await h.user();
    const now = h.clock.ms();
    const lot = await h.lot(seller.id, { opensIn: 3 * DAY, closesIn: 7 * DAY });
    await setDates(lot, { published: new Date(now + HOUR), registration: new Date(now + DAY) });
    const stage = async () => (await request(h.http).get(`/api/lots/${lot}`)).body.lot?.stage;
    expect((await request(h.http).get(`/api/lots/${lot}`)).status).toBe(404); // ещё не показан
    expect((await request(h.http).get('/api/lots')).body.items.find((i: any) => i.id === lot)).toBeUndefined();
    h.advance(2 * HOUR);
    expect(await stage()).toBe('upcoming');
    h.advance(DAY);
    expect(await stage()).toBe('registration_open');
    h.advance(2 * DAY);
    expect(await stage()).toBe('in_progress');
    await h.db.q(`UPDATE lots SET status='finished' WHERE id=$1`, [lot]);
    expect(await stage()).toBe('awaiting_contract');
  });

  it('«Участвовать» до открытия регистрации — отказ; во время торгов — только если продавец разрешил', async () => {
    const seller = await h.user();
    const now = h.clock.ms();
    const soon = await h.lot(seller.id, { opensIn: 2 * DAY, closesIn: 5 * DAY });
    await setDates(soon, { registration: new Date(now + DAY) });
    const u = await h.user({ plan: 'full' });
    const r = await h.deposit(u.agent, soon);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('REGISTRATION_NOT_OPEN');
    const live = await h.lot(seller.id); // торги уже идут
    await setDates(live, { late: false });
    expect((await h.deposit(u.agent, live)).body.error).toBe('REGISTRATION_CLOSED');
    const liveOk = await h.lot(seller.id);
    expect((await h.deposit(u.agent, liveOk)).status).toBe(201);
  });

  it('каталог по умолчанию: торги → регистрация → скоро → ждёт договора → завершён → отменён', async () => {
    await h.db.q(`UPDATE lots SET status='invalidated', ended_reason='test-cleanup' WHERE status IN ('scheduled','live','finished','sold','no_sale','revealing')`);
    const seller = await h.user();
    const now = h.clock.ms();
    const live = await h.lot(seller.id);
    const reg = await h.lot(seller.id, { opensIn: DAY, closesIn: 4 * DAY });
    const up = await h.lot(seller.id, { opensIn: 3 * DAY, closesIn: 6 * DAY });
    await setDates(up, { registration: new Date(now + 2 * DAY) });
    const awaiting = await h.lot(seller.id, { opensIn: -5 * DAY, closesIn: -DAY, status: 'finished' });
    const sold = await h.lot(seller.id, { opensIn: -9 * DAY, closesIn: -5 * DAY, status: 'sold' });
    const cancelled = await h.lot(seller.id, { status: 'withdrawn' });
    await h.db.q(`UPDATE lots SET ended_reason='seller' WHERE id=$1`, [cancelled]);
    const items = (await request(h.http).get('/api/lots').expect(200)).body.items.filter((i: any) => [live, reg, up, awaiting, sold, cancelled].includes(i.id));
    expect(items.map((i: any) => i.stage)).toEqual(['in_progress', 'registration_open', 'upcoming', 'awaiting_contract', 'finished', 'cancelled']);
    const onlyUp = (await request(h.http).get('/api/lots?stage=upcoming')).body.items.map((i: any) => i.id);
    expect(onlyUp).toEqual([up]);
  });

  it('продавец: регистрация не раньше показа и не позже начала торгов', async () => {
    const { LotsService } = await import('../src/modules/lots/lots.service');
    expect(() => LotsService.validateDates('2026-11-10T10:00:00Z', '2026-11-09T10:00:00Z', '2026-11-12T10:00:00Z')).toThrow();
    expect(() => LotsService.validateDates('2026-11-08T10:00:00Z', '2026-11-13T10:00:00Z', '2026-11-12T10:00:00Z')).toThrow();
    expect(() => LotsService.validateDates('2026-11-08T10:00:00Z', '2026-11-10T10:00:00Z', '2026-11-12T10:00:00Z')).not.toThrow();
  });
});
