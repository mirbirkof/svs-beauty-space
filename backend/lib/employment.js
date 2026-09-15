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
   повертаються самі, якщо людину повернути до роботи.

   ─────────────────────────────────────────────────────────────────────────────
   Нотатка #159 (Власник): «Перевір, чи при звільненні закривається доступ до
   внутрішньої інформації салону у колишнього співробітника».

   Перевірено на живій базі — НЕ закривався. Звільнення жило в картці людини
   (masters), а вхід у CRM — в окремому обліковому записі (users + активні сесії).
   Ці дві половини не були звʼязані: setWorkingState() гасив лише картку майстра,
   а логін лишався робочим. Пропуск у салон відбирали РУКАМИ, окремою кнопкою на
   іншому екрані — і лише якщо про неї згадали.

   Що це означало на практиці (факт з бази на 15.09.2026): звільнена людина з
   роллю «адміністратор» мала 25 живих сесій, частина з них — БЕЗСТРОКОВІ
   (expires_at IS NULL, тобто «запамʼятати назавжди» = 10 років і без кінця),
   і останній вхід стався вже В ДЕНЬ звільнення. Обліковий запис вимкнули вручну
   лише через кілька годин. Все це вікно людина бачила касу, клієнтів і зарплати.

   Тепер звільнення = одна операція, що закриває і роботу, і доступ:
     • обліковий запис стає неактивним (is_active = false);
     • УСІ живі сесії гасяться одразу — і панельні (user_tokens), і мобільні
       та браузерні refresh-сесії (user_sessions).
   Сесії НЕ видаляємо (історія входів потрібна для аудиту) — їм проставляється
   момент закінчення/відкликання, а кожна перевірка доступу вже й так дивиться
   на цей термін. Тому доступ падає з наступного ж запиту.

   Звʼязок «людина ↔ логін» беремо ТІЛЬКИ по users.master_id. Звіряти по телефону
   НЕ можна: у базі номер власника збігається з карткою іншого майстра, і за
   телефоном звільнення вимкнуло б самого власника.

   Запобіжник: власника (роль owner) звільнення НЕ замикає — інакше салон можна
   випадково залишити без єдиного входу. Такий випадок повертається окремо
   (owner_skipped), щоб адміністратор бачив, що пропуск лишився живим. */

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

/* ── ДОСТУП ДО CRM ──────────────────────────────────────────────────────────
   Логіни цієї людини. Тільки по master_id — по телефону звіряти небезпечно
   (див. коментар угорі: номер власника збігається з карткою іншого майстра). */
async function linkedAccounts(pool, masterId) {
  const r = await pool.query(
    `SELECT u.id, u.display_name, u.is_active, COALESCE(r.code, '') AS role
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.master_id = $1`, [masterId]);
  return r.rows;
}

/* Гасить живі сесії облікового запису. НЕ видаляє рядки — історія входів потрібна
   для аудиту; проставляємо момент закінчення, а всі перевірки доступу вже дивляться
   саме на нього, тож токен перестає діяти з наступного запиту. */
async function killSessions(pool, userIds) {
  if (!userIds.length) return { panel: 0, refresh: 0 };
  const t = await pool.query(
    `UPDATE user_tokens SET expires_at = NOW()
      WHERE user_id = ANY($1::int[]) AND (expires_at IS NULL OR expires_at > NOW())`,
    [userIds]);
  let refresh = 0;
  try {
    const s = await pool.query(
      `UPDATE user_sessions SET revoked_at = NOW()
        WHERE user_id = ANY($1::int[]) AND revoked_at IS NULL`, [userIds]);
    refresh = s.rowCount || 0;
  } catch (_) { /* таблиці може не бути на старих інсталяціях — панельні сесії вже погашені */ }
  return { panel: t.rowCount || 0, refresh };
}

/* Звільнили → закрити вхід. Власника не чіпаємо (щоб не лишити салон без доступу). */
async function closeCrmAccess(pool, masterId) {
  const accounts = await linkedAccounts(pool, masterId);
  if (!accounts.length) return { accounts_closed: 0, sessions_killed: 0, owner_skipped: [], names: [] };

  const ownerSkipped = accounts.filter(a => a.role === 'owner');
  const toClose = accounts.filter(a => a.role !== 'owner');
  const ids = toClose.map(a => a.id);
  if (!ids.length) return { accounts_closed: 0, sessions_killed: 0, owner_skipped: ownerSkipped.map(a => a.display_name), names: [] };

  await pool.query(
    `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
  const killed = await killSessions(pool, ids);

  for (const a of toClose) {
    await pool.query(
      `INSERT INTO audit_log (user_label, action, entity, entity_id, meta)
       VALUES ($1, 'user.access_revoked', 'user', $2, $3)`,
      ['employment (fire)', a.id,
       JSON.stringify({ master_id: masterId, reason: 'employee-dismissed',
                        sessions_panel: killed.panel, sessions_refresh: killed.refresh })]
    ).catch(() => {});
  }
  return {
    accounts_closed: ids.length,
    sessions_killed: killed.panel + killed.refresh,
    owner_skipped: ownerSkipped.map(a => a.display_name),
    names: toClose.map(a => a.display_name),
  };
}

/* Повернули до роботи → повернути вхід. Сесії НЕ воскрешаємо: людина логіниться
   заново (старі токени лишаються погашеними — так безпечніше). */
async function reopenCrmAccess(pool, masterId) {
  const accounts = await linkedAccounts(pool, masterId);
  const ids = accounts.filter(a => a.role !== 'owner' && !a.is_active).map(a => a.id);
  if (!ids.length) return { accounts_opened: 0, names: [] };
  await pool.query(
    `UPDATE users SET is_active = true, updated_at = NOW() WHERE id = ANY($1::int[])`, [ids]);
  for (const id of ids) {
    await pool.query(
      `INSERT INTO audit_log (user_label, action, entity, entity_id, meta)
       VALUES ($1, 'user.access_restored', 'user', $2, $3)`,
      ['employment (rehire)', id, JSON.stringify({ master_id: masterId, reason: 'employee-returned' })]
    ).catch(() => {});
  }
  return { accounts_opened: ids.length, names: accounts.filter(a => ids.includes(a.id)).map(a => a.display_name) };
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
    const access = await reopenCrmAccess(pool, id);
    return { ...r.rows[0], shifts_cleared: 0, shifts_restored: restored, leftovers: null, access };
  }

  const r = await pool.query(
    `UPDATE masters
        SET active = false, in_schedule = false, updated_at = NOW()
            ${fired ? `, status = 'fired', fire_date = COALESCE(fire_date, CURRENT_DATE)` : ''}
      WHERE id = $1 RETURNING id, name, active, in_schedule`, [id]);
  if (!r.rowCount) return null;

  const cleared = await stashFutureShifts(pool, id);
  const appts = await futureAppointments(pool, id);
  // Нотатка #159: разом з роботою закривається і вхід у CRM.
  const access = await closeCrmAccess(pool, id);
  return { ...r.rows[0], shifts_cleared: cleared, shifts_restored: 0, access,
           leftovers: { shifts_cleared: cleared, appts,
                        accounts_closed: access.accounts_closed,
                        sessions_killed: access.sessions_killed,
                        owner_skipped: access.owner_skipped } };
}

module.exports = { setWorkingState, stashFutureShifts, restoreFutureShifts, futureAppointments,
                   closeCrmAccess, reopenCrmAccess, linkedAccounts };
