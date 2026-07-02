#!/usr/bin/env node
/**
 * Заметка #100 — Бэкфилл services.category_id по текстовому services.category.
 *
 * Связывает ТОЛЬКО по точному совпадению имени:
 *   services.category = service_categories.name  (приоритет)
 *   services.category = service_categories.name_ua (вторым проходом)
 * Обновляет ТОЛЬКО строки, где category_id IS NULL. Заполненные не трогает.
 * Услуги без совпадения остаются с category_id IS NULL (не трогаем).
 *
 * Usage: DATABASE_URL=postgresql://... node scripts/backfill-service-category-id.js
 */
const { Client } = require('pg');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL env.');
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const before = await client.query(
      `SELECT COUNT(*)::int AS c FROM services WHERE deleted_at IS NULL AND category_id IS NULL`);
    console.log('До бэкфилла: services без category_id =', before.rows[0].c);

    // Проход 1: точное совпадение с service_categories.name
    const byName = await client.query(`
      UPDATE services s
         SET category_id = sc.id
        FROM service_categories sc
       WHERE s.category_id IS NULL
         AND s.deleted_at IS NULL
         AND sc.deleted_at IS NULL
         AND s.category = sc.name
    `);
    console.log('Связано по name:', byName.rowCount);

    // Проход 2: точное совпадение с service_categories.name_ua (только оставшиеся)
    const byNameUa = await client.query(`
      UPDATE services s
         SET category_id = sc.id
        FROM service_categories sc
       WHERE s.category_id IS NULL
         AND s.deleted_at IS NULL
         AND sc.deleted_at IS NULL
         AND sc.name_ua IS NOT NULL
         AND s.category = sc.name_ua
    `);
    console.log('Связано по name_ua:', byNameUa.rowCount);

    const after = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE category_id IS NOT NULL)::int AS linked,
        COUNT(*) FILTER (WHERE category_id IS NULL)::int AS unlinked,
        COUNT(*) FILTER (WHERE category_id IS NULL AND category IS NOT NULL)::int AS unlinked_with_text
      FROM services WHERE deleted_at IS NULL`);
    const a = after.rows[0];
    console.log('Итог: с category_id =', a.linked,
      '| без category_id =', a.unlinked,
      '| из них с текстовой категорией без совпадения =', a.unlinked_with_text);

    if (a.unlinked_with_text > 0) {
      const rest = await client.query(`
        SELECT category, COUNT(*)::int AS c FROM services
         WHERE deleted_at IS NULL AND category_id IS NULL AND category IS NOT NULL
         GROUP BY category ORDER BY c DESC`);
      console.log('Несвязанные текстовые категории:');
      for (const r of rest.rows) console.log('  -', r.category, '×', r.c);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
