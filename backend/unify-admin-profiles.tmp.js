const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, statement_timeout: 20000 });
  await c.connect();
  // тенант салона Босса
  const t = await c.query(`SELECT id FROM tenants WHERE slug='svs-beauty-space' OR is_internal=true LIMIT 1`);
  const tid = t.rows[0].id;
  // активные админы/менеджеры БЕЗ master_id в этом тенанте (не owner — у него отдельно)
  const us = await c.query(`
    SELECT u.id, u.display_name, u.phone, r.code AS role
      FROM users u JOIN roles r ON r.id=u.role_id
     WHERE u.tenant_id=$1 AND u.is_active=true AND u.master_id IS NULL
       AND r.code IN ('admin','manager','reception')`, [tid]);
  console.log('кандидатов без карточки:', us.rows.length);
  for (const u of us.rows) {
    // создаём master-запись (админ, услуги НЕ предоставляет → в журнал не попадёт)
    const m = await c.query(`
      INSERT INTO masters (tenant_id, name, provides_services, staff_role, active, phone, created_at, updated_at)
      VALUES ($1,$2,false,'admin',true,$3,NOW(),NOW()) RETURNING id`,
      [tid, u.display_name || ('Співробітник #' + u.id), u.phone || null]);
    await c.query(`UPDATE users SET master_id=$1, updated_at=NOW() WHERE id=$2`, [m.rows[0].id, u.id]);
    console.log(`  ${u.display_name} (${u.role}) → master_id=${m.rows[0].id}`);
  }
  await c.end();
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
