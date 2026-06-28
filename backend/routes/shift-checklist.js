/* routes/shift-checklist.js — Чек-лист зміни адміністратора.
   Оживлює посадову інструкцію: відкриття зміни, протягом дня, закриття + звірка каси.
   Один запис на робочий день. Зміна не закривається доки каса не зведена.
   Доступ: GET = schedule.read, мутації = schedule.write (як зміни/табель). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'schedule.read' : 'schedule.write';
  return requirePerm(perm)(req, res, next);
});

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Шаблон пунктів — прямо з посадової інструкції адміністратора.
function template() {
  return [
    // Відкриття зміни (7:45–9:00)
    { key: 'zones_clean',    phase: 'open',  label: 'Робочі зони чисті: пил, підлога, дзеркала, стільці' },
    { key: 'toilet_clean',   phase: 'open',  label: 'Туалетна кімната чиста' },
    { key: 'masters_ready',  phase: 'open',  label: 'Майстри на місцях о 7:55, готові до клієнтів' },
    { key: 'supplies_ok',    phase: 'open',  label: 'Чай/кава/цукор/вода/мило/рушники в наявності' },
    { key: 'plan_sent',      phase: 'open',  label: 'План на день надіслано керуючій (до 9:00)' },
    // Протягом дня
    { key: 'call_tomorrow',  phase: 'day',   label: 'Обдзвон клієнтів на завтра (до 12:00)' },
    { key: 'call_2days',     phase: 'day',   label: 'Обдзвон клієнтів що були 2 дні тому (після 12:00)' },
    { key: 'instagram',      phase: 'day',   label: 'Instagram stories — мінімум 8 за день' },
    // Закриття зміни
    { key: 'cash_reconciled',phase: 'close', label: 'Каса зведена: програма + журнал = факт' },
    { key: 'trash_out',      phase: 'close', label: 'Сміття винесено, нові пакети в відрах' },
    { key: 'cleaning_ok',    phase: 'close', label: 'Прибирання прийнято (поверхні без пилу)' },
    { key: 'water_off',      phase: 'close', label: 'Воду перекрито' },
    { key: 'power_off',      phase: 'close', label: 'Електроприлади вимкнено' },
    { key: 'alarm_on',       phase: 'close', label: 'Сигналізацію поставлено' },
    { key: 'keys_safe',      phase: 'close', label: 'Ключі від каси не залишені в замку' },
  ].map((x) => ({ ...x, done: false, done_at: null }));
}

// Зливає збережені відмітки на свіжий шаблон (щоб нові пункти зʼявлялись у старих днів).
function mergeItems(saved) {
  const tpl = template();
  const byKey = {};
  (Array.isArray(saved) ? saved : []).forEach((s) => { if (s && s.key) byKey[s.key] = s; });
  return tpl.map((t) => byKey[t.key]
    ? { ...t, done: !!byKey[t.key].done, done_at: byKey[t.key].done_at || null }
    : t);
}

// ── GET /api/shift-checklist?date=YYYY-MM-DD — чек-лист дня (сидиться шаблоном) ──
router.get('/', async (req, res) => {
  try {
    const date = req.query.date || kyivToday();
    const r = await pool.query('SELECT * FROM shift_checklists WHERE work_date=$1', [date]);
    if (!r.rows[0]) {
      return res.json({ work_date: date, admin_name: null, items: template(),
        cash_program: null, cash_journal: null, cash_fact: null, cash_diff: null,
        note: null, closed_at: null, saved: false });
    }
    const row = r.rows[0];
    row.items = mergeItems(row.items);
    row.saved = true;
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/shift-checklist/history?limit= — останні дні ──
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 14, 90);
    const r = await pool.query(
      `SELECT work_date, admin_name, closed_at, cash_diff,
              (SELECT COUNT(*) FROM jsonb_array_elements(items) e WHERE (e->>'done')='true') AS done_cnt,
              jsonb_array_length(items) AS total_cnt
         FROM shift_checklists ORDER BY work_date DESC LIMIT $1`, [limit]);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/shift-checklist — зберегти/оновити чек-лист дня (upsert) ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const date = b.work_date || kyivToday();
    const items = mergeItems(b.items); // нормалізуємо на шаблон
    // проставляємо done_at для свіжо відмічених
    const nowIso = new Date().toISOString();
    items.forEach((it) => { if (it.done && !it.done_at) it.done_at = nowIso; if (!it.done) it.done_at = null; });
    const prog = b.cash_program != null && b.cash_program !== '' ? Number(b.cash_program) : null;
    const jour = b.cash_journal != null && b.cash_journal !== '' ? Number(b.cash_journal) : null;
    const fact = b.cash_fact != null && b.cash_fact !== '' ? Number(b.cash_fact) : null;
    const diff = (fact != null && prog != null) ? +(fact - prog).toFixed(2) : null;
    const admin = (b.admin_name || (req.staff && req.staff.name) || null);
    const r = await pool.query(
      `INSERT INTO shift_checklists (work_date, admin_name, items, cash_program, cash_journal, cash_fact, cash_diff, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (work_date) DO UPDATE SET
         admin_name=COALESCE(EXCLUDED.admin_name, shift_checklists.admin_name),
         items=EXCLUDED.items, cash_program=EXCLUDED.cash_program, cash_journal=EXCLUDED.cash_journal,
         cash_fact=EXCLUDED.cash_fact, cash_diff=EXCLUDED.cash_diff, note=EXCLUDED.note, updated_at=NOW()
       RETURNING *`,
      [date, admin, JSON.stringify(items), prog, jour, fact, diff, b.note || null]);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/shift-checklist/close — закрити зміну (тільки якщо каса зведена) ──
router.post('/close', async (req, res) => {
  try {
    const date = (req.body && req.body.work_date) || kyivToday();
    const r = await pool.query('SELECT * FROM shift_checklists WHERE work_date=$1', [date]);
    if (!r.rows[0]) return res.status(400).json({ error: 'Спочатку збережіть чек-лист дня' });
    const row = r.rows[0];
    // Інструкція: зміна НЕ закривається доки не зведена каса (факт введено й розбіжність відома)
    if (row.cash_fact == null || row.cash_program == null) {
      return res.status(400).json({ error: 'Не можна закрити зміну: спочатку зведіть касу (введіть суму за програмою і реальну готівку)' });
    }
    const closer = (req.body && req.body.closed_by) || (req.staff && req.staff.name) || row.admin_name || null;
    const u = await pool.query(
      'UPDATE shift_checklists SET closed_at=NOW(), closed_by=$2, updated_at=NOW() WHERE work_date=$1 RETURNING *',
      [date, closer]);
    res.json({ ok: true, ...u.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
