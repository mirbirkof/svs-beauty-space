require('dotenv/config');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const t = await c.query(`SELECT id,slug,name,status FROM tenants ORDER BY created_at LIMIT 40`);
  console.log('tenants total:', t.rowCount);
  t.rows.forEach(r => console.log(' ', r.slug, '|', r.status, '|', r.id));
  const d = await c.query(`SELECT tenant_id, count(*)::int n, SUM(amount) FILTER(WHERE type='in') rev
                           FROM cash_operations GROUP BY tenant_id ORDER BY n DESC LIMIT 12`);
  console.log('\ncash_ops by tenant:');
  d.rows.forEach(r => console.log(' ', r.tenant_id, 'ops:', r.n, 'rev:', r.rev));
  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
