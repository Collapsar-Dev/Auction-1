import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

/** Применяет SQL-миграции из apps/api/migrations по порядку (один раз каждую). */
export async function migrate(url = process.env.DATABASE_URL || 'postgresql://auction:auction@localhost:5432/auction') {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(74201)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = [path.resolve(__dirname, '../migrations'), path.resolve(__dirname, '../../migrations')].find((d) => fs.existsSync(d))!;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/CREATE TABLE schema_migrations[^;]+;/, '');
      await c.query('BEGIN');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await c.query('COMMIT');
      console.log('migrated', f);
    }
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.query('SELECT pg_advisory_unlock(74201)').catch(() => undefined);
    await c.end();
  }
}

if (require.main === module) {
  migrate().then(() => process.exit(0), (e) => (console.error(e), process.exit(1)));
}
