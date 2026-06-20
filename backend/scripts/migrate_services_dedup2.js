/* Добивка дедупликации: грейд-ногти переименовать, остальные дубли схлопнуть по числу записей. */
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const log = [];
  try {
    await c.query('BEGIN');

    // ── 1. Грейд-ногти: переименовать с суффиксом (оставляем как разные услуги) ──
    const grade = [
      { spec: 88, top: 89 },   // манікюр жіночий
      { spec: 119, top: 120 }, // нарощування нігтів 5-6
      { spec: 133, top: 134 }, // педикюр чоловічий
    ];
    let renamed = 0;
    for (const g of grade) {
      const a = await c.query(`UPDATE services SET name = name || ' (спеціаліст)', updated_at=NOW()
                                WHERE id=$1 AND deleted_at IS NULL AND name NOT LIKE '%(спеціаліст)%' RETURNING id`, [g.spec]);
      const b = await c.query(`UPDATE services SET name = name || ' (топ-майстер)', updated_at=NOW()
                                WHERE id=$1 AND deleted_at IS NULL AND name NOT LIKE '%(топ-майстер)%' RETURNING id`, [g.top]);
      renamed += a.rowCount + b.rowCount;
    }
    log.push(`Грейд-ногти переименованы: ${renamed} строк (спеціаліст/топ-майстер)`);

    // ── 2. Остальные дубли по имени: схлопнуть в каноническую (макс. записей) ──
    const dupNames = await c.query(
      `SELECT lower(trim(name)) k FROM services WHERE deleted_at IS NULL
        GROUP BY lower(trim(name)) HAVING count(*)>1`);
    let merged = 0, reassigned = 0;
    for (const { k } of dupNames.rows) {
      const rows = (await c.query(
        `SELECT id FROM services WHERE lower(trim(name))=$1 AND deleted_at IS NULL`, [k])).rows;
      if (rows.length < 2) continue;
      const counts = await c.query(
        `SELECT service_id, count(*)::int n FROM appointment_services WHERE service_id=ANY($1) GROUP BY service_id`,
        [rows.map(r => r.id)]);
      const cmap = {}; counts.rows.forEach(x => cmap[x.service_id] = x.n);
      const canon = rows.slice().sort((a, b) => (cmap[b.id] || 0) - (cmap[a.id] || 0) || a.id - b.id)[0];
      const dups = rows.filter(r => r.id !== canon.id).map(r => r.id);
      const ra = await c.query(`UPDATE appointment_services SET service_id=$1 WHERE service_id=ANY($2)`, [canon.id, dups]);
      reassigned += ra.rowCount;
      await c.query(`UPDATE services SET deleted_at=NOW(), status='inactive', updated_at=NOW() WHERE id=ANY($1)`, [dups]);
      merged += dups.length;
    }
    log.push(`Остальные дубли схлопнуты: ${merged} (переназначено записей: ${reassigned})`);

    // ── 3. Проверка целостности ──
    const orph = await c.query(
      `SELECT count(*)::int n FROM appointment_services aps LEFT JOIN services s ON s.id=aps.service_id
        WHERE s.id IS NULL AND aps.service_id IS NOT NULL`);
    if (orph.rows[0].n > 0) throw new Error('битые привязки: ' + orph.rows[0].n);

    await c.query('COMMIT');
    log.push('OK — зафиксировано, битых привязок нет');
  } catch (e) {
    await c.query('ROLLBACK');
    log.push('ROLLBACK: ' + e.message);
  } finally { await c.end(); }
  console.log(log.join('\n'));
})();
