const { Client } = require('pg');
require('dotenv').config({ path: '/home/client/workspace/svs-beauty-space/backend/.env' });
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Нормализуем все телефоны юзеров — убираем '+', пробелы и т.д.
  const r = await c.query(`UPDATE users SET phone = REGEXP_REPLACE(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]' RETURNING id, phone`);
  console.log('Normalized:', r.rows);
  // То же для clients
  await c.query(`UPDATE clients SET phone = REGEXP_REPLACE(phone, '[^0-9]', '', 'g') WHERE phone ~ '[^0-9]'`);
  await c.end();
})().catch(e => { console.error(e); process.exit(1); });
