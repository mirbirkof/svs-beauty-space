// Аудит «чужих» послуг у майстрів, у яких звʼязки ВЖЕ є (нотатка «Второй взгляд» 13.10 12:52).
// Правило 828ce3df (autoLinkNew/suggestFor) покриває лише майстрів БЕЗ звʼязок; тут — решта.
// ТІЛЬКИ ЧИТАННЯ: транзакція READ ONLY + ROLLBACK, нічого не видаляє.
// «Чужа» = категорія послуги не входить у categoriesFor(спеціальність); «без факту» = майстер її жодного разу не робив
// (ні appointments.service_id, ні appointment_services). Кандидат на зняття = чужа І без факту — рішення за Власником.
// Запуск: node ops/audit-master-svc-mismatch.mjs [--json]
import { createRequire } from 'node:module';
const BK = '/home/client/workspace/svs-beauty-space/backend/';
const require = createRequire(BK);
require(BK + 'node_modules/dotenv').config({ path: BK + '.env' });
const { Client } = require(BK + 'node_modules/pg');
const { categoriesFor } = require(BK + 'lib/master-svc-suggest.js');

const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const res = [];
try {
  await c.query('BEGIN READ ONLY');
  const ms = (await c.query(`SELECT m.id, m.name, m.specialty, m.tenant_id FROM masters m
     WHERE m.merged_into IS NULL AND m.fire_date IS NULL AND m.active IS NOT FALSE AND COALESCE(m.provides_services,true)
     ORDER BY m.tenant_id, m.id`)).rows;
  for (const m of ms) {
    const cats = categoriesFor(m.specialty);
    const links = (await c.query(`SELECT s.id, s.name, s.category, ms.source,
        EXISTS(SELECT 1 FROM appointments a WHERE a.master_id=$1 AND a.service_id=s.id)
        OR EXISTS(SELECT 1 FROM appointment_services x JOIN appointments a ON a.id=x.appointment_id
                  WHERE COALESCE(x.master_id,a.master_id)=$1 AND x.service_id=s.id) AS did
       FROM master_services ms JOIN services s ON s.id=ms.service_id
      WHERE ms.master_id=$1 AND s.deleted_at IS NULL ORDER BY s.category, s.name`, [m.id])).rows;
    if (!links.length) continue;
    const foreign = cats.length ? links.filter(l => !cats.includes(l.category)) : [];
    res.push({ id: m.id, name: m.name, specialty: m.specialty, tenant: m.tenant_id, links: links.length,
      categories: cats, unknown_specialty: !cats.length,
      foreign_done: foreign.filter(l => l.did).map(l => ({ id: l.id, category: l.category, name: l.name })),
      foreign_never: foreign.filter(l => !l.did).map(l => ({ id: l.id, category: l.category, name: l.name, source: l.source })) });
  }
} finally { await c.query('ROLLBACK').catch(() => {}); await c.end(); }

if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 1)); process.exit(0); }
let total = 0;
for (const r of res) {
  const n = r.foreign_never.length; total += n;
  console.log(`#${r.id} ${r.name} — «${r.specialty || '—'}», звʼязок ${r.links}` +
    (r.unknown_specialty ? ' · спеціальність не розпізнана, не перевіряю' : ` · чужих без факту ${n}, чужих з фактом ${r.foreign_done.length}`));
  const byCat = {};
  for (const l of r.foreign_never) (byCat[l.category || '—'] ||= []).push(l.name);
  for (const [k, v] of Object.entries(byCat)) console.log(`   ${k} (${v.length}): ${v.join('; ')}`);
}
console.log(`РАЗОМ кандидатів на зняття (чужа категорія і жодного візиту): ${total}`);
