/* Миграция: схлопывание дублей парикмахерских услуг + чистка ЗП-мусора + единая категория «Волосся».
   Безопасно: транзакция, soft-delete, записи переназначаются (не стираются), цена/мастер в записях не трогаются.
   ЗП считается по master_id + зафиксированной price в appointment_services → не затрагивается. */
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const log = [];
  try {
    await c.query('BEGIN');

    // ── 1. Чистка ЗП-мусора (не влияет на расчёт, убираем хлам) ──
    const zpJunk = await c.query(
      `DELETE FROM payroll_schemes WHERE master_name ILIKE '%test%' RETURNING id,master_name`);
    // выключенный дубль Інни (оставляем активную)
    const innaDup = await c.query(
      `DELETE FROM payroll_schemes ps USING (
         SELECT master_id, MIN(id) keep FROM payroll_schemes GROUP BY master_id HAVING count(*)>1
       ) d
       WHERE ps.master_id=d.master_id AND ps.id<>d.keep AND ps.is_active=false
       RETURNING ps.id, ps.master_name`);
    log.push('ЗП-мусор удалён: ' + ([...zpJunk.rows, ...innaDup.rows].map(r => r.master_name).join(', ') || 'нет'));

    // ── 2. Группы дублей парикмахерских по нормализованному имени ──
    const svc = await c.query(
      `SELECT id, name, price FROM services
        WHERE category LIKE 'Перукарські послуги%' AND deleted_at IS NULL`);
    const groups = {};
    svc.rows.forEach(s => { const k = s.name.trim().toLowerCase(); (groups[k] = groups[k] || []).push(s); });

    let merged = 0, reassigned = 0, skipped = [];
    for (const [key, rows] of Object.entries(groups)) {
      if (rows.length < 2) continue;
      const prices = new Set(rows.map(r => String(r.price)));
      if (prices.size > 1) { skipped.push(rows[0].name); continue; } // разные цены → ручное решение

      // каноническая = с макс. числом привязок к записям, при равенстве min id
      const counts = await c.query(
        `SELECT service_id, count(*)::int n FROM appointment_services
          WHERE service_id = ANY($1) GROUP BY service_id`, [rows.map(r => r.id)]);
      const cmap = {}; counts.rows.forEach(x => cmap[x.service_id] = x.n);
      const canonical = rows.slice().sort((a, b) => (cmap[b.id] || 0) - (cmap[a.id] || 0) || a.id - b.id)[0];
      const dupIds = rows.filter(r => r.id !== canonical.id).map(r => r.id);

      // переназначаем записи на каноническую (НЕ трогаем master_id/price/starts_at)
      const ra = await c.query(
        `UPDATE appointment_services SET service_id=$1 WHERE service_id = ANY($2)`,
        [canonical.id, dupIds]);
      reassigned += ra.rowCount;
      // soft-delete дублей
      await c.query(
        `UPDATE services SET deleted_at=NOW(), status='inactive', updated_at=NOW() WHERE id = ANY($1)`, [dupIds]);
      merged += dupIds.length;
    }
    log.push(`Схлопнуто дублей: ${merged} (переназначено записей: ${reassigned})`);
    log.push(`Пропущено (разные цены, ручное решение): ${skipped.join(', ') || 'нет'}`);

    // ── 3. Единая категория «Волосся» для всех оставшихся парикмахерских ──
    const cat = await c.query(
      `UPDATE services SET category='Волосся', updated_at=NOW()
        WHERE category LIKE 'Перукарські послуги%' AND deleted_at IS NULL`);
    log.push(`Категория → «Волосся»: ${cat.rowCount} услуг`);

    // ── 4. Проверки целостности ──
    const orphan = await c.query(
      `SELECT count(*)::int n FROM appointment_services aps
        LEFT JOIN services s ON s.id=aps.service_id
       WHERE s.id IS NULL AND aps.service_id IS NOT NULL`);
    if (orphan.rows[0].n > 0) throw new Error('БИТЫЕ привязки записей: ' + orphan.rows[0].n + ' — откат');

    await c.query('COMMIT');
    log.push('OK — транзакция зафиксирована, битых привязок нет');
  } catch (e) {
    await c.query('ROLLBACK');
    log.push('ROLLBACK: ' + e.message);
  } finally {
    await c.end();
  }
  console.log(log.join('\n'));
})();
