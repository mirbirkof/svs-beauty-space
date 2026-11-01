#!/usr/bin/env node
// Скриншот Фінцентра на ПК-ширині 1280 (директива: CRM завжди ПК 1280). ТІЛЬКИ перегляд.
// node -r dotenv/config ops/shot-fincenter-0111.mjs reports/accrual-0111 dotenv_config_path=backend/.env
import pkg from '/home/client/workspace/node_modules/playwright/index.js';
const { chromium } = pkg;
const BASE = process.env.BASE || 'http://127.0.0.1:3011';
const TOK = process.env.ADMIN_TOKEN; // вхід без запису в БД: токен + профіль з /api/users/me
const OUT = process.argv[2] || 'reports/accrual-0111';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const me = await (await fetch(BASE + '/api/users/me', { headers: { 'X-Admin-Token': TOK } })).json();
const user = me.user || me;
await p.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
await p.evaluate(({ t, u }) => { localStorage.setItem('svs_admin_token', t); localStorage.setItem('svs_user', JSON.stringify(u)); }, { t: TOK, u: user });
await p.goto(BASE + '/admin/', { waitUntil: 'networkidle' });
await p.evaluate(() => go('fincenter'));
await p.waitForTimeout(2500);
for (const [name, f, t] of [['fincenter-1280', '2026-11-01', '2026-11-01'], ['fincenter-1280-oct', '2026-10-01', '2026-10-31']]) {
  await p.evaluate(([f, t]) => { document.getElementById('fcFrom').value = f; document.getElementById('fcTo').value = t; fcRangeCustom(); }, [f, t]);
  await p.waitForTimeout(1000);
  await p.waitForFunction(() => !/Завантаження/.test(document.getElementById('fcKpis')?.innerText || 'Завантаження'), null, { timeout: 60000 });
  await p.waitForTimeout(4000);
  const info = await p.evaluate(() => ({
    w: document.documentElement.clientWidth,
    kpi: (document.getElementById('fcKpis')?.innerText || '').replace(/\s+/g, ' '),
    zones: (document.getElementById('fcZones')?.innerText || '').replace(/\s+/g, ' '),
  }));
  console.log(name, JSON.stringify(info));
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  const z = await p.$('#fcZones');
  if (z) { await z.scrollIntoViewIfNeeded(); await p.screenshot({ path: `${OUT}/${name}-zones.png` }); await p.evaluate(() => window.scrollTo(0, 0)); }
}
await b.close();
