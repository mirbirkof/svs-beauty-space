#!/usr/bin/env node
// Постійні витрати по нарахуванню (01.11). ТІЛЬКИ GET. node ops/accrual-recurring-0111.mjs <out.json>
// Знімає Фінцентр / деталі / зали / P&L за 01.11–01.11 і жовтень, друкує ключові цифри.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOK = process.env.ADMIN_TOKEN || (readFileSync(join(__dirname, '..', 'backend', '.env'), 'utf8').match(/^ADMIN_TOKEN=(.*)$/m) || [])[1];
const BASE = process.env.BASE || 'http://127.0.0.1:3011';
const P = [['nov01', '2026-11-01', '2026-11-01'], ['oct', '2026-10-01', '2026-10-31']];
const get = async (u) => { const r = await fetch(BASE + u, { headers: { 'X-Admin-Token': TOK } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const out = {};
for (const [k, f, t] of P) {
  const fc = await get(`/api/financial/dashboard?period=custom&date_from=${f}&date_to=${t}&compare=0`);
  const det = await get(`/api/financial/detail?from=${f}&to=${t}`);
  const z = await get(`/api/zones?from=${f}&to=${t}`);
  const pnl = await get(`/api/reports/pnl?from=${f}&to=${t}`);
  out[k] = { fc: fc.body, det: det.body, zones: z.body, pnl: pnl.body, st: [fc.status, det.status, z.status, pnl.status] };
  const b = fc.body || {}, zb = z.body || {};
  const zs = (zb.zones || []).concat(zb.shop ? [zb.shop] : []);
  const sum = (key) => zs.reduce((a, x) => a + (Number(x[key]) || 0), 0);
  console.log(`== ${k} ${f}..${t} статуси ${out[k].st.join(',')}`);
  console.log(`  Фінцентр: виручка ${b.revenue?.total} витрати ${b.expenses?.total} прибуток ${b.profit?.net} маржа ${b.profit?.margin_pct}`);
  console.log(`  статті: ${(b.expenses?.by_category || []).map(x => x.label + ' ' + x.sum).join(' | ')}`);
  console.log(`  деталі: витрати ${det.body?.expenses?.total} прибуток ${det.body?.profit?.total} маржа ${det.body?.profit?.margin_pct}`);
  console.log(`  зали: shared_total ${zb.shared_total}; totals ${JSON.stringify(zb.totals)}`);
  console.log(`  Σзалів(+магазин): дохід ${Math.round(sum('revenue'))} витрати ${Math.round(sum('expense'))} прибуток ${Math.round(sum('profit'))}`);
  console.log(`  маржі залів: ${(zb.zones || []).map(x => x.name + ' ' + x.margin_pct).join(' | ')}`);
  console.log(`  P&L(reports): ${JSON.stringify(pnl.body?.summary || pnl.body?.totals || Object.keys(pnl.body || {}))}`.slice(0, 400));
}
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
