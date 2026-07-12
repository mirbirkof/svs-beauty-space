/* lib/booking-guard.js — защита от двойного бронирования (аудит 22.06).
 *
 * Проблема: ни один путь создания/переноса записи не проверял пересечение по
 * времени для мастера. Админ мог поставить две записи на одного мастера на один
 * слот; перенос записи мог наехать на чужую. DB-constraint добавляется отдельно
 * (миграция, backstop от гонки), но прикладная проверка нужна, чтобы:
 *   • ловить конфликт с УЖЕ существующими записями (в т.ч. историческими),
 *   • отдавать дружелюбный 409, а не сырую ошибку БД.
 *
 * findOverlap принимает pool ИЛИ client (для вызова внутри транзакции).
 */
const { getPool } = require('../db-pg');

// Возвращает первую пересекающуюся активную запись мастера или null.
// excludeId — id переносимой записи (чтобы не конфликтовала сама с собой).
async function findOverlap({ masterId, startsAt, endsAt, excludeId = null }, db) {
  if (!masterId || !startsAt || !endsAt) return null;
  const q = db || getPool();
  const r = await q.query(
    `SELECT id, starts_at, ends_at, status
       FROM appointments
      WHERE master_id = $1
        AND status NOT IN ('cancelled','noshow')
        AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::int IS NULL OR id <> $4)
      LIMIT 1`,
    [Number(masterId), new Date(startsAt).toISOString(), new Date(endsAt).toISOString(), excludeId]
  );
  return r.rows[0] || null;
}

// Вместимость мастера: сколько клиентов одновременно он ведёт (max_parallel, дефолт 1).
// Если колонки ещё нет (миграция 239 не накатилась) — возвращаем 1 = прежнее поведение.
async function masterMaxParallel(masterId, db) {
  if (!masterId) return 1;
  const q = db || getPool();
  try {
    const r = await q.query(`SELECT COALESCE(max_parallel, 1) AS mp FROM masters WHERE id = $1`, [Number(masterId)]);
    const mp = r.rows[0] ? Number(r.rows[0].mp) : 1;
    return Number.isFinite(mp) && mp >= 1 ? mp : 1;
  } catch (_) { return 1; }
}

// Сколько активных записей мастера пересекается с интервалом (без учитываемой excludeId).
async function countOverlap({ masterId, startsAt, endsAt, excludeId = null }, db) {
  if (!masterId || !startsAt || !endsAt) return 0;
  const q = db || getPool();
  const r = await q.query(
    `SELECT count(*)::int AS c
       FROM appointments
      WHERE master_id = $1
        AND status NOT IN ('cancelled','noshow')
        AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::int IS NULL OR id <> $4)`,
    [Number(masterId), new Date(startsAt).toISOString(), new Date(endsAt).toISOString(), excludeId]
  );
  return r.rows[0]?.c ?? 0;
}

// Превысит ли добавление ещё одной записи вместимость мастера.
// { exceeds, count, cap, conflict } — conflict для дружелюбного сообщения.
async function wouldExceedParallel(params, db) {
  const [count, cap] = await Promise.all([
    countOverlap(params, db),
    masterMaxParallel(params.masterId, db),
  ]);
  const conflict = count >= cap ? await findOverlap(params, db) : null;
  return { exceeds: count >= cap, count, cap, conflict };
}

module.exports = { findOverlap, countOverlap, masterMaxParallel, wouldExceedParallel };
