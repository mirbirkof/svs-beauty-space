/* lib/automations.js — минимальный набор бизнес-автоматизаций → задача администратору.
   1) Неявка (appointment.noshow) — сразу по событию.
   2) Отток: клиент не был 60 дней — суточный cron.
   3) День рождения клиента — суточный cron.
   Все создают задачу в tasks. Идемпотентность: не плодим дубли (проверка EXISTS по tag+client+дате). */
const { getPool } = require('../db-pg');

// Создать задачу администратору, если такой ещё нет (идемпотентно по tag+client за сегодня).
async function createAdminTask({ tenant_id, title, description, priority = 'normal', client_id = null, appointment_id = null, tag }) {
  const pool = getPool();
  try {
    // дубль: открытая задача с тем же тегом и клиентом за сегодня — пропускаем
    const dup = await pool.query(
      `SELECT 1 FROM tasks
        WHERE tags @> ARRAY[$1]::text[] AND COALESCE(client_id,0)=COALESCE($2,0)
          AND status NOT IN ('done','cancelled')
          AND created_at::date = (NOW() AT TIME ZONE 'Europe/Kiev')::date LIMIT 1`,
      [tag, client_id]
    ).catch(() => ({ rowCount: 0 }));
    if (dup.rowCount) return null;
    const r = await pool.query(
      `INSERT INTO tasks (tenant_id, title, description, priority, status, client_id, appointment_id, tags, creator_name, due_date)
       VALUES ($1,$2,$3,$4,'open',$5,$6,ARRAY['auto',$7]::text[],'Автоматизація', (NOW() AT TIME ZONE 'Europe/Kiev')::date)
       RETURNING id`,
      [tenant_id || null, title, description || null, priority, client_id, appointment_id, tag]
    );
    return r.rows[0] ? r.rows[0].id : null;
  } catch (e) { console.error('[automations] createAdminTask:', e.message); return null; }
}

// 1) Неявка → задача
async function onNoShow(evt) {
  const pool = getPool();
  const apptId = evt && (evt.entity_id || (evt.payload && evt.payload.appointment_id));
  if (!apptId) return;
  try {
    const a = (await pool.query(
      `SELECT a.id, a.client_id, a.tenant_id, c.name AS client_name, a.starts_at
         FROM appointments a LEFT JOIN clients c ON c.id=a.client_id WHERE a.id=$1`, [apptId])).rows[0];
    if (!a) return;
    await createAdminTask({
      tenant_id: a.tenant_id, client_id: a.client_id, appointment_id: a.id, priority: 'high', tag: 'noshow',
      title: `Неявка: ${a.client_name || 'клієнт'} — перезаписати`,
      description: `Клієнт не прийшов на візит. Зв'язатися і запропонувати новий час.`,
    });
  } catch (e) { console.error('[automations] onNoShow:', e.message); }
}

// 2) Отток 60 дней + 3) День рождения — суточный прогон
async function runDailyAutomations() {
  const pool = getPool();
  // отток: последний визит 60-89 дней назад (узкое окно — чтобы задача создавалась один раз)
  try {
    const churn = (await pool.query(
      `SELECT c.id, c.tenant_id, c.name, MAX(a.starts_at) last_visit
         FROM clients c JOIN appointments a ON a.client_id=c.id
        WHERE a.status IN ('done','completed') AND c.deleted_at IS NULL
        GROUP BY c.id, c.tenant_id, c.name
       HAVING MAX(a.starts_at) BETWEEN NOW() - INTERVAL '63 days' AND NOW() - INTERVAL '60 days'`)).rows;
    for (const c of churn) {
      await createAdminTask({
        tenant_id: c.tenant_id, client_id: c.id, priority: 'normal', tag: 'winback',
        title: `Повернути клієнта: ${c.name || 'клієнт'} (60 днів без візиту)`,
        description: `Клієнт не був 60 днів. Зателефонувати, запропонувати акцію/запис.`,
      });
    }
    if (churn.length) console.log(`[automations] отток 60д: создано задач ${churn.length}`);
  } catch (e) { console.error('[automations] churn:', e.message); }
  // день рождения сегодня
  try {
    const bdays = (await pool.query(
      `SELECT id, tenant_id, name FROM clients
        WHERE deleted_at IS NULL AND birthday IS NOT NULL
          AND to_char(birthday,'MM-DD') = to_char((NOW() AT TIME ZONE 'Europe/Kiev'),'MM-DD')`)).rows;
    for (const c of bdays) {
      await createAdminTask({
        tenant_id: c.tenant_id, client_id: c.id, priority: 'normal', tag: 'birthday',
        title: `День народження: ${c.name || 'клієнт'} — привітати`,
        description: `Сьогодні день народження клієнта. Привітати, можна запропонувати подарунок/знижку.`,
      });
    }
    if (bdays.length) console.log(`[automations] ДР сегодня: создано задач ${bdays.length}`);
  } catch (e) { console.error('[automations] birthday:', e.message); }
}

let _timer = null;
function startAutomations() {
  // подписка на неявку
  try { require('./event-bus').on('appointment.noshow', onNoShow); } catch (e) { console.error('[automations] subscribe:', e.message); }
  // суточный прогон отток+ДР: первый через 6 мин, далее раз в 24ч
  if (!_timer) {
    setTimeout(() => runDailyAutomations().catch(() => {}), 6 * 60 * 1000);
    _timer = setInterval(() => runDailyAutomations().catch(() => {}), 24 * 3600 * 1000);
  }
  console.log('[automations] активны: noshow→задача, отток60→задача, ДР→задача');
}

module.exports = { startAutomations, runDailyAutomations, onNoShow, createAdminTask };
