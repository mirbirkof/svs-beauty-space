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
  // Processing time (Phase B wellness): існуючі записи «ширші» на буфери своєї послуги.
  // buffer=0 (всі салонні послуги, факт по БД) → умова тотожна старій.
  const r = await q.query(
    `SELECT a.id, a.starts_at, a.ends_at, a.status
       FROM appointments a LEFT JOIN services s ON s.id = a.service_id
      WHERE a.master_id = $1
        AND a.status NOT IN ('cancelled','noshow')
        AND tstzrange(a.starts_at - (COALESCE(s.buffer_before,0)||' minutes')::interval,
                      a.ends_at   + (COALESCE(s.buffer_after,0)||' minutes')::interval)
            && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::int IS NULL OR a.id <> $4)
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
       FROM appointments a LEFT JOIN services s ON s.id = a.service_id
      WHERE a.master_id = $1
        AND a.status NOT IN ('cancelled','noshow')
        AND tstzrange(a.starts_at - (COALESCE(s.buffer_before,0)||' minutes')::interval,
                      a.ends_at   + (COALESCE(s.buffer_after,0)||' minutes')::interval)
            && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::int IS NULL OR a.id <> $4)`,
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

/* ── Комнаты как ресурс расписания (Phase B wellness, 18.07.2026) ──
 * Велнес: услуга занимает комнату/кабинет — двойное бронирование дорогого ресурса
 * (couples-suite, сауна) = боль №1 сегмента. Проверка активируется ТОЛЬКО когда
 * запись несёт room_id — салонные записи без комнаты не задеты. */

// Занята ли комната в интервале: активные записи с этим room_id (учитывая rooms.capacity)
// + сервисные блоки room_blocks (ремонт/санобработка). null = свободна, иначе {reason,...}.
async function roomBusy({ roomId, startsAt, endsAt, excludeId = null, needCapacity = 1 }, db) {
  if (!roomId || !startsAt || !endsAt) return null;
  const q = db || getPool();
  const s = new Date(startsAt).toISOString(), e = new Date(endsAt).toISOString();
  const cap = await q.query(`SELECT COALESCE(capacity,1) AS c FROM rooms WHERE id=$1 AND COALESCE(active,true)`, [Number(roomId)]);
  if (!cap.rows.length) return { reason: 'room-not-found' };
  const roomCap = Math.max(1, Number(cap.rows[0].c) || 1);
  const occ = await q.query(
    `SELECT count(*)::int AS c FROM appointments
      WHERE room_id = $1 AND status NOT IN ('cancelled','noshow')
        AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)
        AND ($4::int IS NULL OR id <> $4)`, [Number(roomId), s, e, excludeId]);
  const used = occ.rows[0]?.c ?? 0;
  if (used + Number(needCapacity || 1) > roomCap) return { reason: 'room-busy', used, capacity: roomCap };
  try {
    const blk = await q.query(
      `SELECT 1 FROM room_blocks WHERE room_id=$1
        AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz) LIMIT 1`,
      [Number(roomId), s, e]);
    if (blk.rows.length) return { reason: 'room-blocked' };
  } catch (_) { /* таблицы может не быть (мигр. 152 не накатилась) — не блокируем */ }
  return null;
}

// Подбор свободной комнаты под интервал (preferred первой, потом по sort_order).
// needCapacity=2 для couples. Возвращает id или null.
async function findFreeRoom({ startsAt, endsAt, preferredRoomId = null, needCapacity = 1, excludeId = null }, db) {
  const q = db || getPool();
  const rooms = await q.query(
    `SELECT id FROM rooms WHERE COALESCE(active,true) AND COALESCE(capacity,1) >= $1
      ORDER BY CASE WHEN id = $2::int THEN 0 ELSE 1 END, COALESCE(sort_order, 999), id`,
    [Math.max(1, Number(needCapacity) || 1), preferredRoomId]);
  for (const r of rooms.rows) {
    const busy = await roomBusy({ roomId: r.id, startsAt, endsAt, excludeId, needCapacity }, db);
    if (!busy) return r.id;
  }
  return null;
}

// Требование услуги к комнате (service_room_requirements). null = комната не нужна.
async function serviceRoomRequirement(serviceId, db) {
  if (!serviceId) return null;
  const q = db || getPool();
  try {
    const r = await q.query(
      `SELECT requires_room, preferred_room_id FROM service_room_requirements WHERE service_id=$1`,
      [Number(serviceId)]);
    if (r.rows.length && r.rows[0].requires_room) return r.rows[0];
  } catch (_) { /* мигр. 277 не накатилась — как раньше */ }
  return null;
}

module.exports = { findOverlap, countOverlap, masterMaxParallel, wouldExceedParallel,
  roomBusy, findFreeRoom, serviceRoomRequirement };
