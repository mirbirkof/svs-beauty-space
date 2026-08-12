'use strict';
/**
 * Автопилот кассовых смен + контроль «его ли смена».
 *
 * ЗАЧЕМ (факт 11.08.2026): кассовая смена #191 висела открытой с 02.07 — открывают и
 * закрывают руками, значит не делают вовсе. Ответственный не записывался (opened_by NULL),
 * поэтому по кассе нельзя было сказать, кто в ней работал.
 *
 * Логика привязана к РЕАЛЬНОМУ графику master_schedule_days (staff_shifts пустая, не в ходу).
 *
 * Правила:
 *   • открываем смену, когда по графику началась чья-то рабочая смена и открытой нет;
 *   • стартовый остаток берём из последней закрытой (фактический пересчёт), а не с нуля;
 *   • закрываем, когда рабочее окно всех сотрудников закончилось + буфер;
 *   • при авто-закрытии фактический остаток = расчётный, разница 0, в примечании — пометка,
 *     что закрыл автопилот и требуется подтверждение живым пересчётом;
 *   • ответственный = аккаунт, который реально работал в CRM в эту смену (по журналу),
 *     иначе — мастер из графика.
 */
const { getPool } = require('../db-pg');

const CLOSE_BUFFER_MIN = 30;   // сколько ждём после конца графика перед закрытием
const OPEN_LEAD_MIN    = 15;   // за сколько минут до начала смены можно открывать

function q(sql, params) { return getPool().query(sql, params); }

/** Рабочее окно дня по графику: самый ранний старт и самый поздний конец. */
async function todayWindow(branchId = null) {
  const r = await q(
    `SELECT MIN(msd.work_date + msd.start_time) AS starts_at,
            MAX(msd.work_date + msd.end_time)   AS ends_at,
            COUNT(*)                            AS masters_count
       FROM master_schedule_days msd
      WHERE msd.work_date = CURRENT_DATE
        AND msd.start_time IS NOT NULL AND msd.end_time IS NOT NULL`);
  const row = r.rows[0] || {};
  if (!row.starts_at) return null;
  return {
    starts_at: new Date(row.starts_at),
    ends_at: new Date(row.ends_at),
    masters_count: Number(row.masters_count || 0),
  };
}

/** Кто ПО ГРАФИКУ должен быть на смене прямо сейчас. */
async function onShiftNow() {
  const r = await q(
    `SELECT m.id AS master_id, m.name, u.id AS user_id, u.display_name,
            msd.start_time, msd.end_time
       FROM master_schedule_days msd
       JOIN masters m ON m.id = msd.master_id
       LEFT JOIN users u ON u.master_id = m.id AND u.is_active
      WHERE msd.work_date = CURRENT_DATE
        AND msd.start_time IS NOT NULL AND msd.end_time IS NOT NULL
        AND LOCALTIME BETWEEN msd.start_time AND msd.end_time
      ORDER BY msd.start_time`);
  return r.rows;
}

/** Открытая кассовая смена (одна на филиал). */
async function openShift(branchId = null) {
  const r = await q(
    `SELECT * FROM cash_shifts
      WHERE status = 'open' AND ($1::int IS NULL OR branch_id IS NOT DISTINCT FROM $1)
      ORDER BY opened_at DESC LIMIT 1`, [branchId]);
  return r.rows[0] || null;
}

/** Расчётный остаток: старт + приход − расход. */
async function expectedCash(shiftId, openingCash) {
  // только наличные: карта/перевод в остаток кассы не попадают
  const r = await q(
    `SELECT COALESCE(SUM(CASE WHEN type='in'  THEN amount END),0) AS cash_in,
            COALESCE(SUM(CASE WHEN type='out' THEN amount END),0) AS cash_out
       FROM cash_operations WHERE shift_id = $1 AND method = 'cash'`, [shiftId]);
  const t = r.rows[0] || { cash_in: 0, cash_out: 0 };
  return Number(openingCash || 0) + Number(t.cash_in) - Number(t.cash_out);
}

/** Кто фактически работал в CRM в эту смену (по журналу входов). */
async function actualWorker(workDate = null) {
  const r = await q(
    `SELECT user_id, master_id, display_name
       FROM shift_login_audit
      WHERE work_date = COALESCE($1::date, CURRENT_DATE)
      ORDER BY seen_count DESC, last_seen_at DESC LIMIT 1`, [workDate]);
  return r.rows[0] || null;
}

/**
 * Один такт автопилота. Возвращает что сделал — для лога и отчёта Боссу.
 */
async function tick() {
  const out = { opened: null, closed: null, note: null };
  const win = await todayWindow();
  const cur = await openShift();
  const now = new Date();

  // ── ЗАКРЫТИЕ ──────────────────────────────────────────────────────────
  if (cur) {
    const openedDay = new Date(cur.opened_at).toISOString().slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const workEnded = win && now.getTime() > win.ends_at.getTime() + CLOSE_BUFFER_MIN * 60000;
    const staleFromPastDay = openedDay < today;   // смена «залипла» с прошлых суток
    if (workEnded || staleFromPastDay) {
      const expected = await expectedCash(cur.id, cur.opening_cash);
      const worker = await actualWorker(openedDay);
      const reason = staleFromPastDay
        ? `автозакрытие: смена оставалась открытой с ${openedDay}`
        : 'автозакрытие: рабочий день по графику завершён';
      await q(
        `UPDATE cash_shifts
            SET status='closed', closed_at=NOW(), auto_closed=TRUE,
                expected_cash=$2, closing_cash=$2, difference=0,
                closed_by_user_id=$3,
                notes = COALESCE(notes || E'\n', '') || $4
          WHERE id=$1`,
        [cur.id, expected, worker ? worker.user_id : null,
         `${reason}. Фактический пересчёт наличных не подтверждён человеком.`]);
      out.closed = { id: cur.id, expected, reason };
    }
  }

  // ── ОТКРЫТИЕ ──────────────────────────────────────────────────────────
  const still = await openShift();
  if (!still && win) {
    const canOpen = now.getTime() >= win.starts_at.getTime() - OPEN_LEAD_MIN * 60000
                 && now.getTime() <= win.ends_at.getTime();
    if (canOpen) {
      const prev = await q(
        `SELECT closing_cash FROM cash_shifts
          WHERE status IN ('closed','reconciled') ORDER BY closed_at DESC NULLS LAST LIMIT 1`);
      const opening = Number(prev.rows[0]?.closing_cash || 0);
      const shiftMasters = await onShiftNow();
      const worker = await actualWorker();
      const r = await q(
        `INSERT INTO cash_shifts
           (branch_id, opened_by, opened_by_user_id, opening_cash, status,
            auto_opened, planned_start, planned_end, notes)
         VALUES (NULL,$1,$2,$3,'open',TRUE,$4,$5,$6) RETURNING *`,
        [shiftMasters[0]?.master_id || null,
         worker?.user_id || shiftMasters[0]?.user_id || null,
         opening, win.starts_at, win.ends_at,
         `автооткрытие по графику (${shiftMasters.length} чел. на смене)`]);
      out.opened = { id: r.rows[0].id, opening };
    }
  }
  if (!out.opened && !out.closed) out.note = win ? 'без изменений' : 'сегодня нет графика';
  return out;
}

/**
 * Его ли смена? Вердикт по аккаунту:
 *   owner       — владелец, ограничений нет
 *   own_shift   — сотрудник работает в своё время по графику
 *   off_shift   — сотрудник есть в графике на сегодня, но сейчас НЕ его время
 *   no_schedule — аккаунта нет в графике на сегодня (работает не в свою смену)
 */
async function verdictFor(user) {
  if (!user || !user.userId) return null;
  const r = await q(
    `SELECT u.master_id, u.display_name, u.role_id, r.code AS role_code, r.level AS role_level
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1`, [user.userId]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.role_code === 'owner' || Number(row.role_level) >= 100) {
    return { verdict: 'owner', master_id: row.master_id, display_name: row.display_name, role_id: row.role_id };
  }
  if (!row.master_id) {
    return { verdict: 'no_schedule', master_id: null, display_name: row.display_name, role_id: row.role_id };
  }
  const s = await q(
    `SELECT start_time, end_time,
            (LOCALTIME BETWEEN start_time AND end_time) AS now_inside
       FROM master_schedule_days
      WHERE work_date = CURRENT_DATE AND master_id = $1
        AND start_time IS NOT NULL AND end_time IS NOT NULL`, [row.master_id]);
  let verdict = 'no_schedule';
  if (s.rows.length) verdict = s.rows.some(x => x.now_inside) ? 'own_shift' : 'off_shift';
  return { verdict, master_id: row.master_id, display_name: row.display_name, role_id: row.role_id };
}

/** Записать факт работы аккаунта (одна строка на аккаунт+вердикт в сутки). */
async function audit(user, v, ip) {
  const cur = await openShift();
  const r = await q(
    `INSERT INTO shift_login_audit (user_id, master_id, display_name, role_id, verdict, shift_id, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (work_date, user_id, verdict) DO UPDATE
       SET last_seen_at = NOW(), seen_count = shift_login_audit.seen_count + 1
     RETURNING *`,
    [user.userId, v.master_id, v.display_name, v.role_id, v.verdict, cur ? cur.id : null, ip || null]);
  return r.rows[0];
}

module.exports = { tick, verdictFor, audit, onShiftNow, openShift, todayWindow, expectedCash };
