/* employment.js — ЄДИНЕ джерело правди «людина працює / не працює».

   Нотатка #154 (Власник): «Уволеный сотрудник остается в графике и отображается».

   Корінь був не в самій сітці, а в тому, що звільнення робилося ТРЬОМА різними
   маршрутами, і кожен робив своє:
     • PATCH /api/schedule/masters/:id — саме ця кнопка «Звільнити» в картці людини —
       ставив ЛИШЕ active=false. Людина лишалась у складі графіка (in_schedule=true),
       а її МАЙБУТНІ зміни далі висіли в master_schedule_days;
     • DELETE /api/employees/:id      — status='fired' + in_schedule=false, зміни лишались;
     • DELETE /api/admin/masters/:id  — active=false + in_schedule=false, зміни лишались.
   Тому звільнений «лишався в графіку»: склад графіка його не відпускав, а онлайн-запис,
   «хто на зміні» й план дня читають master_schedule_days НАПРЯМУ — і далі віддавали
   його години. Досить було одного розходження прапорців, щоб він знову зʼявився на екрані.

   Тепер усі маршрути звільнення викликають setWorkingState() — одна операція, один результат.
   НІЧОГО НЕ ВИДАЛЯЄМО: минулі зміни, візити, зарплата й історія лишаються недоторканими,
   а зняті МАЙБУТНІ години не зникають — лягають поруч (stash_*, міграція 299) і
   повертаються самі, якщо людину повернути до роботи. */

const { kyivToday } = require('./schedule-month');

/* Знімає МАЙБУТНІ зміни (від сьогодні за Києвом), зберігаючи години в stash_*.
   Минуле — факт, за ним рахується ЗП: не чіпаємо. День не видаляється, а стає
   рядком-вихідним (start_time NULL) — рівно так графік позначає вихідний. */
async function stashFutureShifts(pool, masterId) {
  const r = await pool.query(
    `UPDATE master_schedule_days
        SET stash_start_time = start_time, stash_end_time = end_time,
            start_time = NULL, end_time = NULL, source = 'manual', synced_at = NOW()
      WHERE master_id = $1 AND work_date >= $2::date AND start_time IS NOT NULL`,
    [masterId, kyivToday()]);
  return r.rowCount || 0;
}

/* Повертає зняті майбутні зміни тими самими годинами. */
async function restoreFutureShifts(pool, masterId) {
  const r = await pool.query(
    `UPDATE master_schedule_days
        SET start_time = stash_start_time, end_time = stash_end_time,
            stash_start_time = NULL, stash_end_time = NULL, synced_at = NOW()
      WHERE master_id = $1 AND work_date >= $2::date
        AND start_time IS NULL AND stash_start_time IS NOT NULL`,
    [masterId, kyivToday()]);
  return r.rowCount || 0;
}

/* Майбутні записи клієнтів — зобовʼязання салону, їх НЕ чіпаємо. Повертаємо кількість,
   щоб адміністратор перевів людей на іншого майстра, а не дізнався постфактум із журналу. */
async function futureAppointments(pool, masterId) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM appointments
      WHERE master_id = $1 AND starts_at >= CURRENT_DATE
        AND COALESCE(status,'') NOT IN ('cancelled','noshow')`, [masterId]);
  return r.rows[0].cnt;
}

/* working=false — звільнити/деактивувати: прибрати з команди, зі складу графіка,
                   зняти майбутні зміни (щоб онлайн-запис не віддавала його години).
   working=true  — повернути до роботи: знову активний, знову у складі графіка,
                   зняті зміни повертаються самі.
   fired=true    — саме звільнення (status='fired' + дата), а не тимчасова деактивація. */
async function setWorkingState(pool, masterId, working, opts = {}) {
  const id = Number(masterId);
  if (!Number.isFinite(id)) return null;
  const fired = opts.fired === true;

  if (working) {
    const r = await pool.query(
      `UPDATE masters
          SET active = true, in_schedule = true,
              status = 'active', fire_date = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING id, name, active, in_schedule`, [id]);
    if (!r.rowCount) return null;
    const restored = await restoreFutureShifts(pool, id);
    return { ...r.rows[0], shifts_cleared: 0, shifts_restored: restored, leftovers: null };
  }

  const r = await pool.query(
    `UPDATE masters
        SET active = false, in_schedule = false, updated_at = NOW()
            ${fired ? `, status = 'fired', fire_date = COALESCE(fire_date, CURRENT_DATE)` : ''}
      WHERE id = $1 RETURNING id, name, active, in_schedule`, [id]);
  if (!r.rowCount) return null;

  const cleared = await stashFutureShifts(pool, id);
  const appts = await futureAppointments(pool, id);
  return { ...r.rows[0], shifts_cleared: cleared, shifts_restored: 0,
           leftovers: { shifts_cleared: cleared, appts } };
}

module.exports = { setWorkingState, stashFutureShifts, restoreFutureShifts, futureAppointments };
