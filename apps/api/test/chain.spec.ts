import crypto from 'crypto';
import { H } from './helpers';
import { HOUR } from '../src/common/clock';
import { ChainService } from '../src/modules/chain/chain.service';

const h = new H();
beforeAll(() => h.start());
afterAll(() => h.stop());

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('PRD v2 (F8, F11.3): хэш-цепочки счёта и журнала', () => {
  it('движения по счёту попадают в цепочку автоматически; участник может пересчитать её сам', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id, { closesIn: HOUR });
    const u = await h.user({ plan: 'standard' });
    const other = await h.bidder(lot);
    await h.deposit(u.agent, lot);
    await h.bid(u.agent, lot, 41_000_000);
    await h.bid(other.agent, lot, 45_000_000);
    h.advance(HOUR);
    await h.reveal().revealDue();
    await h.get(ChainService).seal();
    const led = (await (await h.fresh(u.agent)).get('/api/me/ledger').expect(200)).body;
    expect(led.entries.map((e: any) => e.kind)).toEqual(['try_spent', 'guarantee_held']); // попытка списывается при регистрации, блок подтверждает банк
    // пересчёт «как в браузере»: только по тому, что пришло в ответе
    let prev = led.genesis;
    for (const e of led.entries) {
      expect(e.prev_hash).toBe(prev);
      expect(sha([prev, e.id, e.user_id, e.kind, e.amount, e.ref, e.created_at].join('|'))).toBe(e.hash);
      prev = e.hash;
    }
    // чужих записей нет
    expect(led.entries.every((e: any) => e.user_id === u.id)).toBe(true);
  });

  it('подделка записи в журнале или на счёте обнаруживается; таблицы — только на добавление', async () => {
    const seller = await h.user();
    const lot = await h.lot(seller.id);
    const u = await h.bidder(lot);
    const adm = await h.staff();
    const ok = (await adm.get('/api/admin/chain/verify').expect(200)).body;
    expect(ok.audit).toMatchObject({ ok: true, unsealed: 0 });
    expect(ok.audit.rows).toBeGreaterThan(0);
    expect(ok.ledger.ok).toBe(true);

    await expect(h.db.q(`UPDATE ledger SET amount=1 WHERE user_id=$1`, [u.id])).rejects.toThrow(/append-only/);
    await expect(h.db.q(`DELETE FROM hash_chain`)).rejects.toThrow(/append-only/);

    // злоумышленник с доступом к базе обходит защиту и меняет сумму
    const row = await h.db.one(`SELECT id FROM ledger WHERE user_id=$1 ORDER BY id LIMIT 1`, [u.id]);
    await h.db.q('ALTER TABLE ledger DISABLE TRIGGER ledger_append_only');
    await h.db.q('UPDATE ledger SET amount=amount+1 WHERE id=$1', [row.id]);
    await h.db.q('ALTER TABLE ledger ENABLE TRIGGER ledger_append_only');
    const a = await h.db.one(`SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 2`);
    await h.db.q('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await h.db.q(`UPDATE audit_log SET action='tampered' WHERE id=$1`, [a.id]);
    await h.db.q('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');

    const bad = (await adm.get('/api/admin/chain/verify')).body;
    expect(bad.audit).toMatchObject({ ok: false, brokenAt: { refId: Number(a.id), reason: 'hash_mismatch' } });
    expect(bad.ledger.ok).toBe(false);
    expect(bad.ledger.broken[0]).toMatchObject({ chain: 'ledger:' + u.id, brokenAt: { refId: Number(row.id), reason: 'hash_mismatch' } });
  });
});
