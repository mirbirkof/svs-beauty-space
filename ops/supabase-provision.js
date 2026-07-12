#!/usr/bin/env node
/* Провижининг схемы CRM в Supabase через Management API (без пароля БД).
   Токен: SUPERBASEACESSTOKEN (sbp_...). Прогоняет migrations/*.sql по порядку,
   трекает в _migrations, benign-ошибки («уже существует», устаревший индекс) — skip.
   Запуск: node ops/supabase-provision.js */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REF = process.env.SUPABASE_PROJECT_REF || 'mbbahbprldketnlostvo';
const HOME = process.env.HOME;
// токен из окружения или own-engine/.env
let TOK = process.env.SUPERBASEACESSTOKEN;
if (!TOK) { try { TOK = (fs.readFileSync(path.join(HOME, 'workspace/own-engine/.env'), 'utf8').match(/^SUPERBASEACESSTOKEN=(.*)$/m) || [])[1]; } catch (_) {} }
const MIG = path.join(__dirname, '../backend/migrations');
const BENIGN = /already exists|does not exist|duplicate key|multiple primary keys|could not create unique index|relation .* already|is not unique|already a member|cannot drop|is of type/i;

function q(sql) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query: sql });
    const r = https.request({
      method: 'POST', hostname: 'api.supabase.com', path: `/v1/projects/${REF}/database/query`,
      headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (rp) => { let d = ''; rp.on('data', c => d += c); rp.on('end', () => res({ code: rp.statusCode, body: d })); });
    r.on('error', rej); r.setTimeout(60000, () => r.destroy(new Error('timeout'))); r.write(body); r.end();
  });
}
const esc = (s) => s.replace(/'/g, "''");

(async () => {
  if (!TOK) { console.log('NO_TOKEN'); process.exit(2); }
  await q(`CREATE TABLE IF NOT EXISTS _migrations(name text primary key, applied_at timestamptz default now())`);
  const applied = new Set();
  try { const r = await q(`SELECT name FROM _migrations`); (JSON.parse(r.body) || []).forEach(x => applied.add(x.name)); } catch (_) {}

  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  const todo = files.filter(f => !applied.has(f));
  console.log(`всего ${files.length}, применено ${applied.size}, к накату ${todo.length}`);
  let ok = 0, skip = 0, stop = null;
  for (const f of todo) {
    const sql = fs.readFileSync(path.join(MIG, f), 'utf8');
    const r = await q(sql);
    if (r.code < 300) {
      await q(`INSERT INTO _migrations(name) VALUES('${esc(f)}') ON CONFLICT DO NOTHING`);
      ok++; if (ok % 20 === 0) console.log(`  …${ok} применено (${f})`);
    } else if (BENIGN.test(r.body)) {
      await q(`INSERT INTO _migrations(name) VALUES('${esc(f)}') ON CONFLICT DO NOTHING`);
      skip++;
    } else { stop = { f, err: r.body.slice(0, 200) }; break; }
  }
  if (stop) console.log(`STOP на ${stop.f}: ${stop.err}`);
  // финальная сверка + гранты app_tenant (миграция 233 уже в наборе, но подстрахуем)
  await q(`GRANT USAGE ON SCHEMA public TO app_tenant`).catch(() => {});
  await q(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO app_tenant`).catch(() => {});
  await q(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_tenant`).catch(() => {});
  const cnt = await q(`SELECT count(*) n FROM information_schema.tables WHERE table_schema='public'`);
  const mig = await q(`SELECT count(*) n, max(name) mx FROM _migrations`);
  console.log(`ИТОГО применено:${ok} пропущено:${skip}${stop ? ' ОСТАНОВ' : ' ДО КОНЦА'}`);
  try { console.log(`таблиц в Supabase: ${JSON.parse(cnt.body)[0].n} | миграций: ${JSON.parse(mig.body)[0].n} (посл. ${JSON.parse(mig.body)[0].mx})`); } catch (_) {}
  process.exit(stop ? 1 : 0);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
