// Создаёт пользователя и базы auction / auction_test в локальном PostgreSQL (нужен доступ суперпользователя postgres).
//   npm run db:create        (или используйте docker compose up db)
import { execSync } from 'node:child_process';
const sql = [
  "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='auction') THEN CREATE ROLE auction LOGIN PASSWORD 'auction' SUPERUSER; END IF; END $$;",
  "SELECT 'CREATE DATABASE auction OWNER auction' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='auction')\\gexec",
  "SELECT 'CREATE DATABASE auction_test OWNER auction' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='auction_test')\\gexec",
].join('\n');
const user = process.env.PGUSER || 'postgres';
execSync(`psql -U ${user} -h ${process.env.PGHOST || 'localhost'} -d postgres -v ON_ERROR_STOP=1`, { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
console.log('OK: databases auction и auction_test готовы');
