import request from 'supertest';
import { H } from './helpers';
import { DAY, HOUR } from '../src/common/clock';
import { SchedulerService } from '../src/modules/scheduler/scheduler.service';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** Победа: лот с одной ставкой победителя и одной проигравшего, вскрыт. */
async function wonLot(o: { winnerCard?: string; sellerCard?: string; price?: number } = {}) {
  const seller = await h.user({ card: o.sellerCard ?? '4111111111119991' });
  const lot = await h.lot(seller.id, { price: o.price ?? 40_000_000, closesIn: HOUR });
  const win = await h.bidder(lot, o.winnerCard ? { card: o.winnerCard } : {});
  const lose = await h.bidder(lot);
  await h.bid(win.agent, lot, 45_000_000);
  await h.bid(lose.agent, lot, 41_000_000);
  h.advance(HOUR);
  await h.reveal().revealDue();
  await h.fresh(win.agent);
  await h.fresh(seller.agent);
  return { seller, lot, win, lose };
}

describe('SC-04 Мастер создания лота', () => {
  it('5 шагов с сохранением черновика; кнопка «Отправить» требует KYC и карту; проверки R-01, R-02', async () => {
    const s = await h.user({ kyc: false });
    const { body: d } = await s.agent.post('/api/lots').expect(201);
    const id = d.id;
    await s.agent.patch(`/api/lots/${id}`).send({ step: 1, data: { property_type: 'house', region: 'Kotayk', settlement: 'Abovyan', street: 'Main St', cadastral_no: '07-001-0001-0002' } }).expect(200);
    const step2 = { area_m2: 150, rooms: 4, bathrooms: 2, year_built: 2005, heating: 'gas', condition: 'good', description_i18n: { ru: 'Дом' }, land_area_m2: 500, floors: 2, wall_material: 'tuff', gas: true, water: true, sewage: true };
    await s.agent.patch(`/api/lots/${id}`).send({ step: 2, data: step2 }).expect(200);
    for (let i = 0; i < 10; i++) await s.agent.post(`/api/lots/${id}/media?kind=photo`).attach('file', png, { filename: `p${i}.png`, contentType: 'image/png' }).expect(201);
    await s.agent.post(`/api/lots/${id}/media?kind=extract`).attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'e.pdf', contentType: 'application/pdf' }).expect(201);
    const now = h.clock.ms();
    const low = await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: 999_999, opens_at: new Date(now + 2 * DAY).toISOString(), closes_at: new Date(now + 6 * DAY).toISOString() } });
    expect(low.body.error).toBe('START_PRICE_TOO_LOW');
    const short = await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: 50_000_000, opens_at: new Date(now + 2 * DAY).toISOString(), closes_at: new Date(now + 3 * DAY).toISOString() } });
    expect(short.body.error).toBe('DURATION_INVALID');
    const ok = await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: { start_price: 50_000_000, opens_at: new Date(now + 2 * DAY).toISOString(), closes_at: new Date(now + 6 * DAY).toISOString() } }).expect(200);
    expect(ok.body.preview).toMatchObject({ deposit: 500_000, commission: 250_000, suggestedPlan: 'full' });
    expect(ok.body.submitBlockers).toEqual(['KYC_REQUIRED', 'CARD_REQUIRED']);
    expect((await s.agent.post(`/api/lots/${id}/submit`).send({ acceptRules: true })).body.error).toBe('KYC_REQUIRED');
    // проверяем личность и карту
    await h.db.q(`UPDATE users SET kyc_status='verified', kyc_level=2, full_name='Seller' WHERE id=$1`, [s.id]);
    const b = h.gw.seedBinding('4111111111117771');
    await h.db.q(`INSERT INTO cards(user_id, mask, binding_id) VALUES ($1,$2,$3)`, [s.id, b.mask, b.bindingId]);
    expect((await s.agent.post(`/api/lots/${id}/submit`).send({})).body.error).toBe('CONSENT_REQUIRED');
    await s.agent.post(`/api/lots/${id}/submit`).send({ acceptRules: true }).expect(201);
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [id])).status).toBe('moderation');
    expect((await h.db.q(`SELECT 1 FROM consents WHERE user_id=$1 AND kind='seller_offer'`, [s.id])).length).toBe(1);
    // после отправки менять нельзя (R-15)
    expect((await s.agent.patch(`/api/lots/${id}`).send({ step: 4, data: {} })).body.error).toBe('LOT_NOT_EDITABLE');
    // выписку видит только модератор: публичной ссылки нет
    const pub = await request(h.http).get(`/api/lots/${id}`);
    expect(pub.status).toBe(404);
  });
});

describe('SC-05 Модерация', () => {
  async function submitted() {
    const s = await h.user({ card: '4111111111117772' });
    const id = (await s.agent.post('/api/lots')).body.id;
    await h.db.q(`UPDATE lots SET status='moderation', start_price=30000000, opens_at=$2, closes_at=$3 WHERE id=$1`, [id, new Date(h.clock.ms() + 2 * DAY), new Date(h.clock.ms() + 7 * DAY)]);
    return { s, id };
  }
  it('одобрить → «Скоро», создаются ключи и снимок правил; вернуть/отклонить — с комментарием', async () => {
    const adm = await h.staff();
    const a = await submitted();
    // без отметок «выписка проверена» и «собственник совпадает» одобрить нельзя
    expect((await adm.post(`/api/admin/lots/${a.id}/moderate`).send({ decision: 'approve' })).body.error).toBe('CHECKLIST_REQUIRED');
    await adm.post(`/api/admin/lots/${a.id}/moderate`).send({ decision: 'approve', checklist: { extract: true, owner_match: true, no_encumbrance: true } }).expect(201);
    const l = await h.db.one(`SELECT status, public_key, private_key_wrapped, rules_snapshot, verification FROM lots WHERE id=$1`, [a.id]);
    expect(l.verification).toMatchObject({ extract: true, owner_match: true, no_encumbrance: true, photos_match: false });
    expect(l.status).toBe('scheduled');
    expect(l.public_key).toContain('PUBLIC KEY');
    expect(l.private_key_wrapped).not.toContain('PRIVATE KEY');
    expect(l.rules_snapshot.min_start_price).toBe(1_000_000);
    expect((await h.outbox(a.s.id, 'lot_approved')).length).toBe(1);
    const b = await submitted();
    expect((await adm.post(`/api/admin/lots/${b.id}/moderate`).send({ decision: 'reject' })).body.error).toBe('COMMENT_REQUIRED');
    await adm.post(`/api/admin/lots/${b.id}/moderate`).send({ decision: 'return', comment: 'Фото не соответствуют выписке' }).expect(201);
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [b.id])).status).toBe('needs_changes');
  });
  it('время начала раньше чем через 24 ч после одобрения → лот возвращается с предложением сдвинуть время', async () => {
    const adm = await h.staff();
    const a = await submitted();
    await h.db.q(`UPDATE lots SET opens_at=$2 WHERE id=$1`, [a.id, new Date(h.clock.ms() + 10 * HOUR)]);
    const r = await adm.post(`/api/admin/lots/${a.id}/moderate`).send({ decision: 'approve', checklist: { extract: true, owner_match: true } }).expect(201);
    expect(r.body.status).toBe('needs_changes');
    expect(r.body.comment).toMatch(/^START_TOO_SOON/);
  });
});

describe('SC-06 Снятие лота', () => {
  it('до первой ставки — сам продавец; после — только администратор, ставки удаляются, депозиты освобождаются', async () => {
    const seller = await h.user();
    const lot1 = await h.lot(seller.id);
    await seller.agent.post(`/api/lots/${lot1}/withdraw`).send({}).expect(201);
    const lot2 = await h.lot(seller.id);
    const b = await h.bidder(lot2);
    await h.bid(b.agent, lot2, 41_000_000);
    expect((await (await h.fresh(seller.agent)).post(`/api/lots/${lot2}/withdraw`).send({})).body.error).toBe('WITHDRAW_NEEDS_ADMIN');
    const adm = await h.staff();
    await adm.post(`/api/admin/lots/${lot2}/withdraw`).send({ reason: 'Документы оказались поддельными' }).expect(201);
    expect((await h.db.q(`SELECT 1 FROM bids WHERE lot_id=$1`, [lot2])).length).toBe(0);
    expect((await h.db.q(`SELECT 1 FROM bid_versions v WHERE NOT EXISTS (SELECT 1 FROM bids b WHERE b.id=v.bid_id)`)).length).toBe(0);
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1`, [lot2])).status).toBe('releasing');
    await h.get(SchedulerService).tick();
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1`, [lot2])).status).toBe('released');
    expect((await h.outbox(b.id, 'lot_withdrawn')).length).toBe(1);
    const log = await h.db.one(`SELECT after FROM audit_log WHERE action='lot.withdrawn_by_admin' AND entity_id=$1`, [String(lot2)]);
    expect(log.after.reason).toContain('поддельными');
  });
});

describe('SC-14 / SC-15 Сделка и комиссия', () => {
  it('оба подтверждают → видят контакты; выписка → «Продано» → депозит освобождён, комиссия списана', async () => {
    const { seller, lot, win } = await wonLot();
    const before = await win.agent.get(`/api/deals/${lot}`);
    expect(before.body.counterparty).toBeUndefined();
    const conf = async (a: any) => a.post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(a, 'deal_confirm'));
    expect((await conf(win.agent)).body.status).toBe('awaiting_confirm');
    expect((await conf(seller.agent)).body.status).toBe('confirmed');
    const v = await win.agent.get(`/api/deals/${lot}`);
    expect(v.body.counterparty.phone).toBe(seller.phone);
    expect(v.body.notaryDocuments.length).toBeGreaterThan(0);
    await seller.agent.post(`/api/deals/${lot}/extract`).attach('file', Buffer.from('%PDF new owner'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(201);
    const adm = await h.staff();
    await adm.post(`/api/admin/deals/${lot}/sold`).expect(201);
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('sold');
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, win.id])).status).toBe('released');
    const pay = await h.db.one(`SELECT * FROM payments WHERE lot_id=$1 AND kind='commission'`, [lot]);
    expect(pay).toMatchObject({ status: 'paid', amount: 225_000, user_id: seller.id });
  });

  it('SC-14: напоминания через 24 ч и за 2 ч до срока', async () => {
    const { seller, lot, win } = await wonLot();
    h.advance(24 * HOUR + 1000);
    await h.deals().tick();
    expect((await h.outbox(win.id, 'deal_reminder')).length).toBe(1);
    h.advance(22 * HOUR);
    await h.deals().tick();
    expect((await h.outbox(seller.id, 'deal_reminder')).length).toBe(2);
    void lot;
  });

  it('6.4: комиссия не прошла → 3 повтора за 3 дня, потом блокировка новых лотов и ссылка на оплату', async () => {
    const { seller, lot, win } = await wonLot({ sellerCard: '4000000000000069' });
    const conf = async (a: any) => a.post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(a, 'deal_confirm'));
    await conf(win.agent);
    await conf(seller.agent);
    await seller.agent.post(`/api/deals/${lot}/extract`).attach('file', Buffer.from('%PDF'), { filename: 'x.pdf', contentType: 'application/pdf' });
    await (await h.staff()).post(`/api/admin/deals/${lot}/sold`).expect(201);
    for (let d = 0; d < 3; d++) {
      h.advance(DAY + 1000);
      await h.deals().processCommissions();
    }
    const pay = await h.db.one(`SELECT * FROM payments WHERE lot_id=$1 AND kind='commission'`, [lot]);
    expect(pay.status).toBe('failed');
    expect((await h.db.one(`SELECT seller_blocked, seller_block_reason FROM users WHERE id=$1`, [seller.id])).seller_block_reason).toBe('COMMISSION_UNPAID');
    expect((await h.outbox(seller.id, 'commission_failed')).length).toBe(1);
  });
});

describe('SC-16 / 6A.3 Победитель отказался или молчит 48 ч', () => {
  it('PRD v2: отказ победителя → лот переходит 2-му месту по его ставке', async () => {
    const { seller, lot, win, lose } = await wonLot();
    await win.agent.post(`/api/deals/${lot}/decline`).send({ reason: 'передумал' }).expect(201);
    const d = await h.db.one(`SELECT * FROM deals WHERE lot_id=$1`, [lot]);
    expect(d).toMatchObject({ winner_user_id: lose.id, amount: 41_000_000, round: 2, prev_winner_user_id: win.id, status: 'awaiting_confirm' });
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('finished');
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, win.id])).status).toBe('disputed');
    expect((await h.outbox(lose.id, 'lot_offered_second')).length).toBe(2); // email + SMS
    expect((await h.outbox(seller.id, 'lot_passed_second_seller')).length).toBe(1);
    // новый покупатель видит «Вы выиграли» и подтверждает
    const res = await (await h.fresh(lose.agent)).get(`/api/lots/${lot}/result`);
    expect(res.body).toMatchObject({ youWon: true, secondChance: { transferred: true, place: 2, chainPlaces: 3 } });
    expect(res.body.bids.find((b: any) => b.isBuyer).userId).toBe(lose.id);
    await lose.agent.post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(lose.agent, 'deal_confirm')).expect(201);
    // если и 2-е место отказывается, а 3-го нет — лот «не состоялся»
    await lose.agent.post(`/api/deals/${lot}/decline`).send({ reason: 'нет денег' }).expect(201);
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('no_sale');
  });

  it('PRD v2: окна в 5 дней нет — взнос 2-го места держится до договора; режим v0.2 включается настройкой', async () => {
    const { seller, lot, win, lose } = await wonLot();
    await win.agent.post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(win.agent, 'deal_confirm'));
    await seller.agent.post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(seller.agent, 'deal_confirm'));
    h.advance(5 * DAY + 1000);
    await h.deals().tick();
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, lose.id])).status).toBe('held');
    await (await h.fresh(win.agent)).post(`/api/deals/${lot}/decline`).send({ reason: 'поздно' }).expect(201);
    expect((await h.db.one(`SELECT winner_user_id, round FROM deals WHERE lot_id=$1`, [lot]))).toMatchObject({ winner_user_id: lose.id, round: 2 });

    // режим v0.2: second_chance_days = 5 → после 5 дней взнос 2-го места освобождается и лот не передаётся
    const { SettingsService } = await import('../src/common/settings');
    await h.get(SettingsService).set('second_chance_days', 5, null);
    try {
      const x = await wonLot();
      await x.win.agent.post(`/api/deals/${x.lot}/confirm`).set('x-step-up', await h.stepUp(x.win.agent, 'deal_confirm'));
      await x.seller.agent.post(`/api/deals/${x.lot}/confirm`).set('x-step-up', await h.stepUp(x.seller.agent, 'deal_confirm'));
      h.advance(5 * DAY + 1000);
      await h.deals().tick();
      expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [x.lot, x.lose.id])).status).toBe('released');
      await (await h.fresh(x.win.agent)).post(`/api/deals/${x.lot}/decline`).send({ reason: 'поздно' }).expect(201);
      expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [x.lot])).status).toBe('no_sale');
    } finally {
      await h.get(SettingsService).set('second_chance_days', 0, null);
    }
  });

  it('PRD v2: цепочка 1 → 2 → 3, у каждого 48 ч; удержанный взнос — 80 % продавцу, 20 % платформе', async () => {
    const seller = await h.user({ card: '4111111111119994' });
    const lot = await h.lot(seller.id, { price: 40_000_000, closesIn: HOUR });
    const p1 = await h.bidder(lot);
    const p2 = await h.bidder(lot);
    const p3 = await h.bidder(lot);
    const p4 = await h.bidder(lot);
    await h.bid(p1.agent, lot, 46_000_000);
    await h.bid(p2.agent, lot, 45_000_000);
    await h.bid(p3.agent, lot, 44_000_000);
    await h.bid(p4.agent, lot, 43_000_000);
    h.advance(HOUR);
    await h.reveal().revealDue();
    const st = async (u: any) => (await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, u.id])).status;
    expect([await st(p1), await st(p2), await st(p3)]).toEqual(['held', 'held', 'held']);
    expect(['releasing', 'released']).toContain(await st(p4)); // 4-е место — вне цепочки
    // место 1 молчит 48 ч → место 2; место 2 отказывается → место 3
    h.advance(48 * HOUR + 1000);
    await h.deals().tick();
    expect(await h.db.one(`SELECT winner_user_id, round, amount FROM deals WHERE lot_id=$1`, [lot])).toMatchObject({ winner_user_id: p2.id, round: 2, amount: 45_000_000 });
    await (await h.fresh(p2.agent)).post(`/api/deals/${lot}/decline`).send({ reason: 'нет денег' }).expect(201);
    expect(await h.db.one(`SELECT winner_user_id, round, amount FROM deals WHERE lot_id=$1`, [lot])).toMatchObject({ winner_user_id: p3.id, round: 3, amount: 44_000_000 });
    expect((await h.outbox(p3.id, 'lot_offered_second'))[0].body).toContain('3-м месте');
    expect([await st(p1), await st(p2), await st(p3)]).toEqual(['disputed', 'disputed', 'held']);
    // место 3 подписывает → сделка; админ удерживает взнос места 1 → 80 / 20
    const conf = async (a: any) => (await h.fresh(a)).post(`/api/deals/${lot}/confirm`).set('x-step-up', await h.stepUp(a, 'deal_confirm')).expect(201);
    await conf(p3.agent);
    await conf(seller.agent);
    const dep1 = await h.db.one(`SELECT id, amount FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, p1.id]);
    await (await h.staff()).post(`/api/admin/deposits/${dep1.id}/decide`).send({ action: 'charge', reason: 'Отказ по оферте' }).expect(201);
    const pay = await h.db.q(`SELECT recipient, user_id, amount FROM payouts WHERE deposit_id=$1 ORDER BY recipient`, [dep1.id]);
    expect(pay).toEqual([
      { recipient: 'platform', user_id: null, amount: Math.floor(Number(dep1.amount) * 0.2) },
      { recipient: 'seller', user_id: seller.id, amount: Number(dep1.amount) - Math.floor(Number(dep1.amount) * 0.2) },
    ]);
    expect((await h.outbox(seller.id, 'forfeit_payout')).length).toBe(1);
  });

  it('молчание 48 ч без 2-го места: лот «не состоялся», депозит спорный, лестница мер 30 → 180 дней → бессрочно', async () => {
    const seller = await h.user({ card: '4111111111119993' });
    const lot = await h.lot(seller.id, { closesIn: HOUR });
    const win = await h.bidder(lot);
    await h.bid(win.agent, lot, 45_000_000);
    h.advance(HOUR);
    await h.reveal().revealDue();
    h.advance(48 * HOUR + 1000);
    await h.deals().tick();
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('no_sale');
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, win.id])).status).toBe('disputed');
    const s1 = await h.db.one(`SELECT * FROM sanctions WHERE user_id=$1`, [win.id]);
    expect(s1.strike_no).toBe(1);
    expect(new Date(s1.ends_at).getTime() - new Date(s1.starts_at).getTime()).toBe(30 * DAY);
    const seller2 = await h.user();
    const lot2 = await h.lot(seller2.id);
    await h.fresh(win.agent);
    expect((await h.deposit(win.agent, lot2)).body.error).toBe('BIDDING_BLOCKED');
    const dep = await h.db.one(`SELECT id FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, win.id]);
    const adm = await h.staff();
    await adm.post(`/api/admin/deposits/${dep.id}/decide`).send({ action: 'release', reason: 'Юрист: удержание не разрешено' }).expect(201);
    expect((await h.db.one(`SELECT status FROM deposits WHERE id=$1`, [dep.id])).status).toBe('released');
    const { RiskService } = await import('../src/modules/risk/risk.service');
    const r2 = await h.db.tx((t) => h.get(RiskService).strike(win.id, lot, 'second', t));
    expect(r2).toMatchObject({ strike: 2, kind: 'bid_block' });
    const r3 = await h.db.tx((t) => h.get(RiskService).strike(win.id, lot, 'third', t));
    expect(r3).toMatchObject({ strike: 3, kind: 'permanent', ends: null });
  });
});

describe('v0.2 Оценка и проверенные документы на странице лота', () => {
  it('продавец прикладывает оценку (организация, сумма, дата, документ); на карточке — оценка и что проверил модератор', async () => {
    const s = await h.user({ card: '4111111111117773' });
    const id = (await s.agent.post('/api/lots')).body.id;
    const bad = await s.agent.post(`/api/lots/${id}/valuations`).field('org_name', 'ArmEval LLC').field('amount', '52000000').field('valued_at', '2026-11-10');
    expect(bad.body.error).toBe('FILE_REQUIRED');
    await s.agent
      .post(`/api/lots/${id}/valuations`)
      .field('org_name', 'ArmEval LLC')
      .field('amount', '52000000')
      .field('valued_at', '2026-11-10')
      .field('report_no', 'R-77')
      .attach('file', Buffer.from('%PDF report'), { filename: 'r.pdf', contentType: 'application/pdf' })
      .expect(201);
    await h.db.q(`UPDATE lots SET status='moderation', start_price=45000000, opens_at=$2, closes_at=$3 WHERE id=$1`, [id, new Date(h.clock.ms() + 2 * DAY), new Date(h.clock.ms() + 7 * DAY)]);
    await (await h.staff()).post(`/api/admin/lots/${id}/moderate`).send({ decision: 'approve', checklist: { extract: true, owner_match: true, no_encumbrance: true, photos_match: true, valuation: true } }).expect(201);
    const card = await request(h.http).get(`/api/lots/${id}`).expect(200);
    expect(card.body.valuations).toEqual([expect.objectContaining({ orgName: 'ArmEval LLC', amount: 52_000_000, reportNo: 'R-77' })]);
    expect(card.body.verification.items.every((i: any) => i.ok)).toBe(true);
    const doc = await request(h.http).get(card.body.valuations[0].documentUrl).expect(200);
    expect(doc.headers['content-type']).toContain('pdf');
  });
});

describe('SC-17 Продавец отказался', () => {
  it('депозит победителя освобождается сразу, продавец блокируется на создание лотов', async () => {
    const { seller, lot, win } = await wonLot();
    await seller.agent.post(`/api/deals/${lot}/decline`).send({ reason: 'передумал' }).expect(201);
    expect((await h.db.one(`SELECT status FROM deposits WHERE lot_id=$1 AND user_id=$2`, [lot, win.id])).status).toBe('released');
    expect((await seller.agent.post('/api/lots')).body.error).toBe('SELLER_BLOCKED');
  });
});

describe('SC-18 Сбой в последний час', () => {
  it('простой > 5 мин → вскрытие ждёт решения; администратор сдвигает конец на 24 ч, участники получают SMS', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { closesIn: 30 * 60_000 });
    const b = await h.bidder(lot);
    const sch = h.get(SchedulerService);
    await sch.tick(); // пульс
    h.advance(40 * 60_000); // сервер «лежал» 40 минут, конец лота пришёлся на простой
    const o = await sch.detectOutage();
    expect(o.lot_ids).toContain(lot);
    await sch.tick();
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('live'); // не вскрыт
    const adm = await h.staff();
    await adm.post(`/api/admin/outages/${o.id}/decide`).send({ apply: true }).expect(201);
    const l = await h.db.one(`SELECT closes_at, extended_at FROM lots WHERE id=$1`, [lot]);
    expect(new Date(l.closes_at).getTime() - h.clock.ms()).toBe(24 * HOUR - 10 * 60_000);
    expect((await h.outbox(b.id, 'lot_extended')).length).toBe(1);
  });
});

describe('SC-19 Спор об итоге', () => {
  it('участник пишет в течение 48 ч; администратор сверяет контрольный код с журналом', async () => {
    const { lot, lose } = await wonLot();
    const my = await (await h.fresh(lose.agent)).get(`/api/lots/${lot}/my-bids`);
    const d = await lose.agent.post(`/api/lots/${lot}/disputes`).send({ message: 'Проверьте мою ставку', commitment: my.body.bid.commitment }).expect(201);
    const adm = await h.staff();
    const v = await adm.get(`/api/admin/disputes/${d.body.id}/verify`).expect(200);
    expect(v.body.checks).toEqual({ receiptCommitmentMatchesDb: true, dbMatchesAuditLog: true, commitmentRecomputes: true });
    await adm.post(`/api/admin/disputes/${d.body.id}/reply`).send({ reply: 'Код совпадает' }).expect(201);
    h.advance(49 * HOUR);
    const late = await (await h.fresh(lose.agent)).post(`/api/lots/${lot}/disputes`).send({ message: 'ещё раз' });
    expect(late.body.error).toBe('DISPUTE_WINDOW_CLOSED');
  });
});

describe('SC-20 Уведомления', () => {
  it('напоминание за 24 ч — тем, кто внёс депозит и ещё не поставил; без данных о чужих ставках', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { closesIn: 23 * HOUR });
    const waiting = await h.bidder(lot);
    const done = await h.bidder(lot);
    await h.bid(done.agent, lot, 48_000_000);
    await h.get(SchedulerService).endingReminders();
    const n = await h.outbox(waiting.id, 'ending_soon');
    expect(n).toHaveLength(1);
    expect(n[0].body).not.toMatch(/48 000 000|ставк[аи] \d/);
    expect(await h.outbox(done.id, 'ending_soon')).toHaveLength(0);
    await h.get(SchedulerService).endingReminders();
    expect(await h.outbox(waiting.id, 'ending_soon')).toHaveLength(1); // без дублей
  });
});

describe('SC-22 Лимит достигнут (R-19, R-20)', () => {
  it('третья ставка у обычного участника — отказ со списком лотов; депозит не блокируется', async () => {
    const seller = await h.user();
    const [l1, l2, l3] = [await h.lot(seller.id), await h.lot(seller.id), await h.lot(seller.id)];
    const u = await h.user({ plan: 'full' });
    for (const l of [l1, l2]) {
      await h.deposit(u.agent, l);
      await h.bid(u.agent, l, 41_000_000);
    }
    const d = await h.deposit(u.agent, l3);
    expect(d.body).toMatchObject({ error: 'LIMIT_ACTIVE_BIDS', limit: 2 });
    expect(d.body.lots.sort()).toEqual([l1, l2].sort());
    expect((await h.db.q(`SELECT 1 FROM deposits WHERE lot_id=$1 AND user_id=$2`, [l3, u.id])).length).toBe(0);
    const card = await u.agent.get(`/api/lots/${l3}`);
    expect(card.body.limitBlock.error).toBe('LIMIT_ACTIVE_BIDS');
  });
  it('R-19: открытая сделка блокирует новые ставки обычного участника', async () => {
    const { win } = await wonLot();
    const s = await h.user();
    const l = await h.lot(s.id);
    expect((await h.deposit(win.agent, l)).body.error).toBe('LIMIT_OPEN_DEALS');
  });
});

describe('SC-23 Подтверждение средств → статус «Инвестор» (R-21, R-22)', () => {
  it('модератор ставит лимит; сумма начальных цен лотов со ставками ≤ лимита', async () => {
    const u = await h.user({ plan: 'full' });
    await u.agent.post('/api/me/funds-proof').attach('file', Buffer.from('%PDF bank letter'), { filename: 'b.pdf', contentType: 'application/pdf' }).expect(201);
    const adm = await h.staff();
    const proofs = await adm.get('/api/admin/funds-proofs');
    const p = proofs.body.find((x: any) => x.user_id === u.id);
    expect(p.url).toContain('sig=');
    await adm.post(`/api/admin/funds-proofs/${p.id}/decide`).send({ approve: true, buyingPower: 100_000_000, comment: 'ok' }).expect(201);
    const me = await u.agent.get('/api/me');
    expect(me.body.limits).toMatchObject({ tier: 'investor', maxActiveBids: 5, maxOpenDeals: 3, buyingPower: 100_000_000 });
    const s = await h.user();
    const lots = [await h.lot(s.id, { price: 40_000_000 }), await h.lot(s.id, { price: 40_000_000 }), await h.lot(s.id, { price: 40_000_000 })];
    await h.deposit(u.agent, lots[0]);
    await h.bid(u.agent, lots[0], 40_000_001);
    await h.deposit(u.agent, lots[1]);
    await h.bid(u.agent, lots[1], 40_000_001);
    expect((await h.deposit(u.agent, lots[2])).body.error).toBe('LIMIT_BUYING_POWER'); // 120 млн > 100 млн
  });
});

describe('SC-24 / 6A.2 Сигналы после итога', () => {
  it('S-2: победная ставка выше второй больше чем на 30% → карточка в очереди; модератор решает с комментарием', async () => {
    const seller = await h.user({ card: '4111111111119992' });
    const lot = await h.lot(seller.id, { closesIn: HOUR });
    const a = await h.bidder(lot);
    const b = await h.bidder(lot);
    await h.bid(a.agent, lot, 90_000_000);
    await h.bid(b.agent, lot, 41_000_000);
    h.advance(HOUR);
    await h.reveal().revealDue();
    const flags = await h.db.q(`SELECT * FROM risk_flags WHERE lot_id=$1`, [lot]);
    expect(flags.map((f) => f.signal)).toContain('S-2');
    const adm = await h.staff();
    const f = flags.find((x) => x.signal === 'S-2');
    expect((await adm.post(`/api/admin/risk/${f.id}/action`).send({ action: 'request_funds', comment: '' })).status).toBe(400);
    await adm.post(`/api/admin/risk/${f.id}/action`).send({ action: 'request_funds', comment: 'Покажите средства' }).expect(201);
    const s2 = await h.user();
    const l2 = await h.lot(s2.id);
    await h.fresh(a.agent);
    // у победителя открытая сделка, но запрос документов проверяется первым
    expect((await h.deposit(a.agent, l2)).body.error).toBe('FUNDS_PROOF_REQUESTED');
    // итог лота не меняется
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('finished');
  });
});

describe('Dev: сдвиг времени лота', () => {
  it('конец через N секунд → фоновая задача вскрывает лот', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const b = await h.bidder(lot);
    await h.bid(b.agent, lot, 41_000_000);
    await request(h.http).post(`/api/dev/lots/${lot}/times`).send({ closesInSec: 5 }).expect(201);
    h.advance(5000);
    await h.get(SchedulerService).tick();
    expect((await h.db.one(`SELECT status FROM lots WHERE id=$1`, [lot])).status).toBe('finished');
  });
});
