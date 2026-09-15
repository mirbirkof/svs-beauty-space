/* schedule-undo.js — точки відкату графіка роботи (нотатка #156).

   ПРИЧИНА ІСНУВАННЯ: масові операції над графіком (генерація на місяці вперед,
   схема 2/2 на місяць, копіювання тижня) перезаписують клітинки БЕЗ СЛІДУ.
   15.09.2026 власник натиснув «Генерувати на місяці» — і рукописний графік салону
   зник; повернути змогли лише з нічного дампа руками розробника.
   Тепер кожна масова операція спершу знімає «як було» по зачеплених клітинках,
   і власник відкочує одним кліком у розділі «Графік роботи».

   Принцип: зберігаємо не всю таблицю, а рівно ті (master_id, work_date), які
   операція збирається переписати + їх попередній стан. Відкат = видалити ці
   клітинки і повернути збережені рядки. Ідемпотентно, нічого зайвого не чіпає. */

const MAX_CELLS = 60000; // 16 людей × 6 міс ≈ 3 тис.; запас великий, але не безмежний

/* Знімок «як було» ПЕРЕД масовим записом.
   keys — масив [master_id, 'YYYY-MM-DD'] тих клітинок, які операція перепише.
   Повертає id точки відкату або null (якщо нема чого зберігати / операція завелика). */
async function snapshot(pool, { kind, label, author, keys }) {
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_CELLS) return null;
  const mids = keys.map((k) => Number(k[0]));
  const dates = keys.map((k) => String(k[1]).slice(0, 10));
  const prev = await pool.query(
    `SELECT d.master_id,
            to_char(d.work_date,'YYYY-MM-DD') AS work_date,
            to_char(d.start_time,'HH24:MI')   AS start_time,
            to_char(d.end_time,'HH24:MI')     AS end_time,
            d.source
       FROM master_schedule_days d
       JOIN unnest($1::int[], $2::date[]) AS u(mid, wd)
         ON d.master_id = u.mid AND d.work_date = u.wd`,
    [mids, dates],
  );
  const r = await pool.query(
    `INSERT INTO schedule_undo_points (kind, label, author, cells, payload)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [kind, label || null, author || null, keys.length,
      JSON.stringify({ keys: keys.map((k) => [Number(k[0]), String(k[1]).slice(0, 10)]), rows: prev.rows })],
  );
  // тримаємо останні 10 точок на салон — решта не потрібна і лише роздуває базу
  await pool.query(
    `DELETE FROM schedule_undo_points
      WHERE id IN (SELECT id FROM schedule_undo_points ORDER BY created_at DESC OFFSET 10)`,
  );
  return r.rows[0].id;
}

/* Останні точки відкату (для кнопки в адмінці). */
async function list(pool, limit = 5) {
  const r = await pool.query(
    `SELECT id, kind, label, author, cells, created_at, undone_at
       FROM schedule_undo_points
      ORDER BY created_at DESC
      LIMIT $1`, [limit]);
  return r.rows;
}

/* Відкат: повертає графік у стан ДО операції.
   id не вказано → остання ще не відкочена точка.
   Повертає { ok, restored, cleared, label } або { ok:false, error }. */
async function undo(pool, id) {
  const pick = await pool.query(
    id ? `SELECT * FROM schedule_undo_points WHERE id=$1`
       : `SELECT * FROM schedule_undo_points WHERE undone_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    id ? [id] : []);
  const p = pick.rows[0];
  if (!p) return { ok: false, error: 'no-undo-point' };
  const payload = typeof p.payload === 'string' ? JSON.parse(p.payload) : p.payload;
  const keys = payload.keys || [];
  const rows = payload.rows || [];
  if (!keys.length) return { ok: false, error: 'empty-undo-point' };

  const client = await pool.connect();
  let cleared = 0;
  try {
    await require('../db-pg').applyTenant(client);
    await client.query('BEGIN');
    const del = await client.query(
      `DELETE FROM master_schedule_days d
        USING unnest($1::int[], $2::date[]) AS u(mid, wd)
        WHERE d.master_id = u.mid AND d.work_date = u.wd`,
      [keys.map((k) => k[0]), keys.map((k) => k[1])]);
    cleared = del.rowCount;
    if (rows.length) {
      await client.query(
        `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source, synced_at)
         SELECT u.mid, u.wd, u.st::time, u.et::time, u.src, NOW()
           FROM unnest($1::int[], $2::date[], $3::text[], $4::text[], $5::text[]) AS u(mid, wd, st, et, src)`,
        [rows.map((r) => r.master_id), rows.map((r) => r.work_date),
          rows.map((r) => r.start_time), rows.map((r) => r.end_time),
          rows.map((r) => r.source || 'manual')]);
    }
    await client.query(`UPDATE schedule_undo_points SET undone_at=NOW() WHERE id=$1`, [p.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();
  return { ok: true, id: p.id, label: p.label, restored: rows.length, cleared };
}

module.exports = { snapshot, list, undo, MAX_CELLS };
