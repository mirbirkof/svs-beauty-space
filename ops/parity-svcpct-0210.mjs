#!/usr/bin/env node
// Паритет ЗП до/після «окремий % майстра за послугу» (02.10). ТІЛЬКИ GET-запити.
//  snap  <file>            — зняти відповіді BASE (дефолт прод :3011) у файл
//  diff  <fileA> <fileB>   — порівняти два знімки
//  pair  <file>            — одночасно BASE_OLD і BASE_NEW, зберегти обидва + diff
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOK = process.env.ADMIN_TOKEN || (readFileSync(join(__dirname, '..', 'backend', '.env'), 'utf8').match(/^ADMIN_TOKEN=(.*)$/m) || [])[1];
const MONTHS = (process.env.MONTHS || '2026-07,2026-08,2026-09,2026-10').split(',');
const last = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
function urls() {
  const u = [];
  for (const m of MONTHS) {
    const f = m + '-01', t = last(m);
    u.push(`/api/payouts/sheet?period=${m}`);
    u.push(`/api/expense-confirm/pending?from=${f}&to=${t}`);
    u.push(`/api/zones?from=${f}&to=${t}`);
    u.push(`/api/financial/detail?from=${f}&to=${t}`);
    u.push(`/api/reports/masters?from=${f}&to=${t}&fresh=1`);
  }
  u.push('/api/reports/overview?fresh=1');
  u.push('/api/financial/dashboard');
  return u;
}
async function get(base, path) {
  const r = await fetch(base + path, { headers: { 'X-Admin-Token': TOK } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt.slice(0, 300); }
  return { status: r.status, body };
}
const IGN = /^(generated_at|generatedAt|elapsed_ms|took_ms|cached|cache|cached_at|server_time|now|ts|computed_at|asOf|as_of)$/;
function diff(a, b, p = '$', out = []) {
  if (out.length > 200) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) { out.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`); return out; }
  if (a && typeof a === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) { if (IGN.test(k)) continue; diff(a[k], b[k], Array.isArray(a) ? `${p}[${k}]` : `${p}.${k}`, out); }
    return out;
  }
  if (a !== b) out.push(`${p}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  return out;
}
function cmp(A, B) {
  let bad = 0;
  for (const k of Object.keys(A)) {
    if (!B[k]) { console.log('НЕТ в B:', k); bad++; continue; }
    const d = diff(A[k], B[k]);
    if (d.length) { bad++; console.log(`✗ ${k}\n   ` + d.slice(0, 12).join('\n   ')); }
    else console.log(`✓ ${k} (${A[k].status})`);
  }
  console.log(bad ? `ИТОГ: расхождений в ${bad} из ${Object.keys(A).length}` : `ИТОГ: 0 расхождений в ${Object.keys(A).length} ответах`);
  return bad;
}
const [mode, f1, f2] = process.argv.slice(2);
if (mode === 'snap') {
  const base = process.env.BASE || 'http://127.0.0.1:3011', res = {};
  for (const u of urls()) res[u] = await get(base, u);
  writeFileSync(f1, JSON.stringify(res));
  console.log('snap', base, Object.keys(res).length, 'ответов; статусы:', [...new Set(Object.values(res).map(r => r.status))].join(','));
} else if (mode === 'diff') {
  process.exit(cmp(JSON.parse(readFileSync(f1, 'utf8')), JSON.parse(readFileSync(f2, 'utf8'))) ? 1 : 0);
} else if (mode === 'pair') {
  const A = {}, B = {};
  for (const u of urls()) { const [x, y] = await Promise.all([get(process.env.BASE_OLD, u), get(process.env.BASE_NEW, u)]); A[u] = x; B[u] = y; }
  writeFileSync(f1, JSON.stringify({ old: A, new: B }));
  process.exit(cmp(A, B) ? 1 : 0);
} else { console.log('usage: snap <f> | diff <a> <b> | pair <f>'); process.exit(2); }
