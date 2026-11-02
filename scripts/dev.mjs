// Запускает API (NestJS, :4000) и сайт (Next.js, :3000) одной командой.
//   npm run dev          — режим разработки (сайт с горячей перезагрузкой)
//   npm run start        — собранная версия (после npm run build)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

const prod = process.argv.includes('--prod');
// .env из корня (если есть)
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
process.env.DEV_TOOLS ??= 'true';
process.env.DEV_SHOW_CODES ??= process.env.DEV_TOOLS;

if (!prod) execSync('npm run build -w @auction/api', { stdio: 'inherit' });
const procs = [
  spawn('node', ['--enable-source-maps', 'dist/src/main.js'], { cwd: 'apps/api', stdio: 'inherit', env: process.env }),
  spawn('npx', ['next', prod ? 'start' : 'dev', '-p', '3000'], { cwd: 'apps/web', stdio: 'inherit', env: process.env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => code && code !== 0 && (console.error('process exited', code), stop())));
console.log('\n  Сайт:  http://localhost:3000\n  API:   http://localhost:4000/api\n  Dev:   http://localhost:3000/dev\n');
