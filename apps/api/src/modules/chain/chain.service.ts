import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../../common/db';
import { Clock } from '../../common/clock';
import { sha256 } from '../../common/hash';

export const GENESIS = '0'.repeat(64);

/**
 * Канонические строки. Тот же формат повторяет браузер (кнопка «Проверить хэши»), поэтому он простой и
 * описан в docs/ADR-001.md: поля через «|», время — ISO UTC, JSON — как его отдаёт PostgreSQL (jsonb).
 */
export const ledgerLine = (prev: string, e: { id: number | string; user_id: number | string; kind: string; amount: number | string; ref: string; created_at: Date | string }) =>
  [prev, e.id, e.user_id, e.kind, e.amount, e.ref, new Date(e.created_at).toISOString()].join('|');
export const auditLine = (prev: string, a: { id: number | string; actor_id: any; action: string; entity: string; entity_id: any; before: any; after: any; at: Date | string }) =>
  [prev, a.id, a.actor_id ?? '', a.action, a.entity, a.entity_id ?? '', JSON.stringify(a.before ?? null), JSON.stringify(a.after ?? null), new Date(a.at).toISOString()].join('|');

export interface ChainCheck {
  chain: string;
  rows: number;
  ok: boolean;
  brokenAt?: { seq: number; refId: number; reason: 'hash_mismatch' | 'prev_mismatch' | 'source_missing' };
  unsealed: number;
}

/** PRD v2 (F8, F11.3): хэш-цепочки журнала аудита и движений по счёту участника. */
@Injectable()
export class ChainService {
  constructor(private db: Db, private clock: Clock) {}

  /** Запечатать новые записи. Одна задача за раз (advisory lock), порядок — по id источника. */
  async seal(limit = 2000) {
    return this.db.tx(async (t) => {
      await t.q('SELECT pg_advisory_xact_lock(424242)');
      const now = this.clock.now();
      let n = 0;
      // журнал аудита — одна общая цепочка
      const audit = await t.q(`SELECT a.* FROM audit_log a WHERE NOT EXISTS (SELECT 1 FROM hash_chain c WHERE c.chain='audit' AND c.ref_id=a.id) ORDER BY a.id LIMIT $1`, [limit]);
      if (audit.length) {
        let prev = (await this.last('audit', t)) ?? GENESIS;
        for (const a of audit) {
          const hash = sha256(auditLine(prev, a));
          await t.q(`INSERT INTO hash_chain(chain, ref_id, prev_hash, hash, sealed_at) VALUES ('audit',$1,$2,$3,$4)`, [a.id, prev, hash, now]);
          prev = hash;
          n++;
        }
      }
      // движения по счёту — цепочка у каждого пользователя своя
      const led = await t.q(`SELECT l.* FROM ledger l WHERE NOT EXISTS (SELECT 1 FROM hash_chain c WHERE c.chain='ledger:' || l.user_id AND c.ref_id=l.id) ORDER BY l.id LIMIT $1`, [limit]);
      const prevOf = new Map<string, string>();
      for (const e of led) {
        const chain = 'ledger:' + e.user_id;
        const prev = prevOf.get(chain) ?? (await this.last(chain, t)) ?? GENESIS;
        const hash = sha256(ledgerLine(prev, e));
        await t.q(`INSERT INTO hash_chain(chain, ref_id, prev_hash, hash, sealed_at) VALUES ($1,$2,$3,$4,$5)`, [chain, e.id, prev, hash, now]);
        prevOf.set(chain, hash);
        n++;
      }
      return n;
    });
  }

  private async last(chain: string, t: Queryable) {
    return (await t.maybe<{ hash: string }>('SELECT hash FROM hash_chain WHERE chain=$1 ORDER BY seq DESC LIMIT 1', [chain]))?.hash ?? null;
  }

  /** Пересчитать цепочку и найти первое расхождение. */
  async verify(chain: string): Promise<ChainCheck> {
    const isAudit = chain === 'audit';
    const links = await this.db.q<{ seq: number; ref_id: number; prev_hash: string; hash: string }>('SELECT seq, ref_id, prev_hash, hash FROM hash_chain WHERE chain=$1 ORDER BY seq', [chain]);
    const src = isAudit
      ? await this.db.q('SELECT * FROM audit_log WHERE id = ANY($1)', [links.map((l) => l.ref_id)])
      : await this.db.q('SELECT * FROM ledger WHERE id = ANY($1)', [links.map((l) => l.ref_id)]);
    const byId = new Map(src.map((r: any) => [Number(r.id), r]));
    let prev = GENESIS;
    for (const l of links) {
      const r = byId.get(Number(l.ref_id));
      const at = { seq: Number(l.seq), refId: Number(l.ref_id) };
      if (!r) return { chain, rows: links.length, ok: false, brokenAt: { ...at, reason: 'source_missing' }, unsealed: 0 };
      if (l.prev_hash !== prev) return { chain, rows: links.length, ok: false, brokenAt: { ...at, reason: 'prev_mismatch' }, unsealed: 0 };
      const h = sha256(isAudit ? auditLine(prev, r) : ledgerLine(prev, r));
      if (h !== l.hash) return { chain, rows: links.length, ok: false, brokenAt: { ...at, reason: 'hash_mismatch' }, unsealed: 0 };
      prev = l.hash;
    }
    const unsealed = isAudit
      ? (await this.db.one<{ c: number }>(`SELECT count(*)::int c FROM audit_log a WHERE NOT EXISTS (SELECT 1 FROM hash_chain c WHERE c.chain='audit' AND c.ref_id=a.id)`)).c
      : (await this.db.one<{ c: number }>(`SELECT count(*)::int c FROM ledger l WHERE 'ledger:' || l.user_id = $1 AND NOT EXISTS (SELECT 1 FROM hash_chain c WHERE c.chain=$1 AND c.ref_id=l.id)`, [chain])).c;
    return { chain, rows: links.length, ok: true, unsealed };
  }

  /** «Мои транзакции» с хэшами — всё, что нужно браузеру, чтобы пересчитать цепочку самому. */
  async myLedger(userId: number) {
    await this.seal();
    const rows = await this.db.q(
      `SELECT l.id, l.user_id, l.kind, l.amount, l.ref, l.lot_id, l.created_at, c.seq, c.prev_hash, c.hash
       FROM ledger l JOIN hash_chain c ON c.chain=$2 AND c.ref_id=l.id WHERE l.user_id=$1 ORDER BY c.seq`,
      [userId, 'ledger:' + userId],
    );
    return {
      format: 'sha256(prev_hash|id|user_id|kind|amount|ref|created_at ISO)',
      genesis: GENESIS,
      entries: rows.map((r: any) => ({ ...r, id: Number(r.id), user_id: Number(r.user_id), amount: Number(r.amount), seq: Number(r.seq), created_at: new Date(r.created_at).toISOString() })),
    };
  }

  /** Для администратора: журнал аудита и все цепочки счетов. */
  async verifyAll() {
    await this.seal();
    const audit = await this.verify('audit');
    const chains = (await this.db.q<{ chain: string }>(`SELECT DISTINCT chain FROM hash_chain WHERE chain LIKE 'ledger:%'`)).map((r) => r.chain);
    const ledgers: ChainCheck[] = [];
    for (const c of chains) ledgers.push(await this.verify(c));
    const bad = ledgers.filter((l) => !l.ok);
    return {
      audit,
      ledger: { chains: ledgers.length, rows: ledgers.reduce((a, l) => a + l.rows, 0), ok: bad.length === 0, broken: bad },
      checkedAt: this.clock.now().toISOString(),
    };
  }
}
