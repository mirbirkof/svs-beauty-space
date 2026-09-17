// Сторож складу графіка (16.09, власник: «додав співробітника — він не зʼявився,
// і кнопки звільнити немає; виправ так, щоб проблема не повторювалась»).
//
// ЩО ЛОВИМО — три причини, через які людина мовчки випадає з «Персоналу графіка»:
//   1. колонка masters.in_schedule втратила DEFAULT true → нова картка = NULL = поза графіком;
//   2. співробітник із логіном лишився БЕЗ картки в masters (так було з «Дашею»-адміном) →
//      його немає ні в графіку, ні в команді, і нема кнопки «Звільнити»;
//   3. активна працююча картка з in_schedule IS NULL — «загублений» після якогось імпорту.
// Тест лише ЧИТАЄ базу, нічого не змінює.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

let db;
before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

test('склад графіка: нова картка співробітника потрапляє в графік автоматично (DEFAULT true)', async () => {
  const r = await db.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'masters' AND column_name = 'in_schedule'`);
  assert.strictEqual(r.rows.length, 1, 'колонка masters.in_schedule існує');
  assert.match(String(r.rows[0].column_default || ''), /true/i,
    'masters.in_schedule має DEFAULT true — інакше новий співробітник знову опиниться поза графіком');
});

test('склад графіка: у кожного працюючого логіна є картка співробітника', async () => {
  const r = await db.query(
    `SELECT u.id, u.display_name, r.code AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.master_id IS NULL
        AND COALESCE(u.is_active, true) = true
        -- лише робочі ролі салону: власник у зміну не виходить і картки може не мати,
        -- а 'readonly' — це доступ на перегляд, не співробітник
        AND r.code IN ('master','admin','manager','reception')
        -- лише наш салон: у QA-тенантах живуть тестові власники без карток, це нормально
        AND u.tenant_id = '00000000-0000-0000-0000-000000000001'`);
  const lost = r.rows.map(x => `${x.display_name} (${x.role})`);
  assert.strictEqual(r.rows.length, 0,
    `логіни без картки співробітника — їх не видно в графіку і нема кнопки «Звільнити»: ${lost.join(', ')}`);
});

test('склад графіка: немає «загублених» карток з невизначеним прапорцем', async () => {
  const r = await db.query(
    `SELECT id, name FROM masters
      WHERE in_schedule IS NULL
        AND COALESCE(active, true) = true
        AND COALESCE(status, 'active') <> 'fired'
        AND merged_into IS NULL`);
  assert.strictEqual(r.rows.length, 0,
    `картки без прапорця in_schedule (мовчки поза графіком): ${r.rows.map(x => x.name).join(', ')}`);
});
