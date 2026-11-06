// Запуск: npm run seed && npm run dev, затем: node scripts/responsive-audit.js [all|guest,bidder,...] [hy|ru|en]
// Нужен Playwright с Chromium. Отчёт и снимки (390 px) — в папке audit_<язык>/ рядом с местом запуска.
// Аудит адаптивности: все страницы × 5 экранов. Ищет горизонтальную прокрутку, элементы за краем экрана,
// ошибки JS и консоли. Снимки — в audit/<роль>/<страница>@<ширина>.png
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const VPS = [
  [360, 740],
  [390, 844],
  [768, 1024],
  [1024, 768],
  [1440, 900],
];
const ONLY = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const LANG = process.argv[3] || 'hy';
const OUTDIR = 'audit_' + LANG;

function totp(secret, ms = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(ms / 30000)));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

const ROLES = {
  guest: { pages: ['/', '/lots/1', '/lots/5', '/lots/6', '/lots/7', '/login', '/rules', '/partners', '/reset-password?token=x'] },
  bidder: {
    phone: '+37491000003',
    pages: ['/', '/lots/1', '/lots/6', ...['profile', 'access', 'cards', 'bids', 'lots', 'seller', 'deals', 'deposits', 'payments', 'favorites', 'notifications', 'investor'].map((t) => '/account?tab=' + t), '/partners'],
  },
  seller: { phone: '+37491000001', pages: ['/sell', '/sell/10', '/account?tab=lots', '/account?tab=seller', '/lots/1'] },
  winner: { phone: '+37491000006', pages: ['/deals/6', '/account?tab=deals'] },
  partner: { phone: '+37491000013', pages: ['/partner'] },
  staff: {
    staff: true,
    pages: [
      ...['moderation', 'lots', 'users', 'kyc', 'deposits', 'deals', 'risk', 'funds', 'sanctions', 'disputes', 'outages', 'notifications', 'settings', 'plans', 'audit', 'chain', 'partners', 'ads'].map((t) => '/admin?tab=' + t),
      '/admin/lots/1',
      '/admin/lots/9',
      '/admin/users/3',
    ],
  },
};

(async () => {
  const b = await chromium.launch();
  const report = [];
  for (const [role, cfg] of Object.entries(ROLES)) {
    if (ONLY && !ONLY.includes(role)) continue;
    const ctx = await b.newContext();
    await ctx.addInitScript((l) => { try { localStorage.setItem('lang', l); } catch {} }, LANG);
    if (cfg.phone) {
      const o = await (await ctx.request.post(BASE + '/api/auth/otp', { data: { phone: cfg.phone } })).json();
      const v = await ctx.request.post(BASE + '/api/auth/verify', { data: { phone: cfg.phone, code: o.devCode } });
      if (v.status() !== 201) report.push({ role, page: 'LOGIN', problem: 'login failed ' + JSON.stringify(o) });
    }
    if (cfg.staff) {
      const v = await ctx.request.post(BASE + '/api/auth/staff/login', { data: { username: 'admin', password: 'Admin123!', code: totp('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP') } });
      if (v.status() !== 201) report.push({ role, page: 'LOGIN', problem: 'staff login failed ' + v.status() });
    }
    fs.mkdirSync(`${OUTDIR}/${role}`, { recursive: true });
    const p = await ctx.newPage();
    let cur = '';
    p.on('pageerror', (e) => report.push({ role, page: cur, problem: 'JS error: ' + e.message }));
    p.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|favicon|fonts\.g/.test(m.text())) report.push({ role, page: cur, problem: 'console: ' + m.text().slice(0, 200) });
    });
    for (const path of cfg.pages) {
      for (const [w, h] of VPS) {
        cur = `${path} @${w}`;
        await p.setViewportSize({ width: w, height: h });
        try {
          await p.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (e) {
          report.push({ role, page: cur, problem: 'goto: ' + e.message.split('\n')[0] });
          continue;
        }
        await p.waitForTimeout(700);
        const r = await p.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const docW = document.documentElement.scrollWidth;
          const out = [];
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
            const rc = el.getBoundingClientRect();
            if (rc.width === 0 || rc.height === 0) continue;
            // элемент внутри прокручиваемого контейнера — не проблема
            let sc = el.parentElement, inScroll = false;
            while (sc && sc !== document.body) {
              const s = getComputedStyle(sc);
              if (/(auto|scroll)/.test(s.overflowX) || s.overflowX === 'hidden') { inScroll = true; break; }
              sc = sc.parentElement;
            }
            if (inScroll) continue;
            if (rc.right > vw + 1 || rc.left < -1) {
              const id = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' «' + (el.textContent || '').trim().slice(0, 30) + '»';
              out.push(`${id} [${Math.round(rc.left)}..${Math.round(rc.right)}]`);
            }
          }
          // самые «внешние» нарушители: убрать потомков уже найденных
          return { vw, docW, offenders: out.slice(0, 6) };
        });
        if (r.docW > r.vw + 1) report.push({ role, page: cur, problem: `горизонтальная прокрутка: ${r.docW} > ${r.vw}`, offenders: r.offenders });
        else if (r.offenders.length) report.push({ role, page: cur, problem: 'элемент за краем', offenders: r.offenders });
        if (w === 390) await p.screenshot({ path: `${OUTDIR}/${role}/${path.replace(/[\/?=&]/g, '_') || 'home'}@${w}.png`, fullPage: true }).catch(() => {});
      }
    }
    await ctx.close();
  }
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(OUTDIR + '/report.json', JSON.stringify(report, null, 1));
  const by = {};
  for (const x of report) (by[x.problem.split(':')[0]] ??= []).push(`${x.role} ${x.page}${x.offenders ? ' → ' + x.offenders[0] : ''}`);
  for (const [k, v] of Object.entries(by)) console.log(`\n## ${k} (${v.length})\n` + v.slice(0, 40).join('\n'));
  console.log('\nTOTAL', report.length);
  await b.close();
})();
