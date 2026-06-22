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

module.exports = { findOverlap };
