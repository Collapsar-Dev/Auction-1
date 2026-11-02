import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, types } from 'pg';

// bigint (int8) и numeric → number. Суммы в драмах намного меньше 2^53.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

export interface Queryable {
  q<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T>;
  maybe<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
}

class Conn implements Queryable {
  constructor(private c: Pool | PoolClient) {}
  async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.c.query(sql, params as any[]);
    return r.rows as T[];
  }
  async one<T = any>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.q<T>(sql, params);
    if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
    return rows[0];
  }
  async maybe<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.q<T>(sql, params);
    return rows[0] ?? null;
  }
}

@Injectable()
export class Db extends Conn implements OnModuleDestroy {
  readonly pool: Pool;
  constructor() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://auction:auction@localhost:5432/auction', max: 20 });
    super(pool);
    this.pool = pool;
  }
  /** Транзакция. Все записи внутри — атомарно. */
  async tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await fn(new Conn(client));
      await client.query('COMMIT');
      return res;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async onModuleDestroy() {
    await this.pool.end().catch(() => undefined);
  }
}
