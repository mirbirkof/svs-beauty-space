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

// Дефолтний шаблон пунктів — з посадової інструкції адміністратора.
// solo=true (одиночка) прибирає командні пункти. Пункт може мати days:[0..6] (0=нд..6=сб) —
// тоді показується ЛИШЕ в ці дні тижня (адаптація під день).
const TEAM_ONLY = new Set(['masters_ready', 'plan_sent']);
const DEFAULT_TEMPLATE = [
  { key: 'zones_clean',    phase: 'open',  label: 'Робочі зони чисті: пил, підлога, дзеркала, стільці' },
  { key: 'toilet_clean',   phase: 'open',  label: 'Туалетна кімната чиста' },
  { key: 'masters_ready',  phase: 'open',  label: 'Майстри на місцях о 7:55, готові до клієнтів' },
  { key: 'supplies_ok',    phase: 'open',  label: 'Чай/кава/цукор/вода/мило/рушники в наявності' },
  { key: 'plan_sent',      phase: 'open',  label: 'План на день надіслано керуючій (до 9:00)' },
  { key: 'call_tomorrow',  phase: 'day',   label: 'Обдзвон клієнтів на завтра (до 12:00)' },
  { key: 'call_2days',     phase: 'day',   label: 'Обдзвон клієнтів що були 2 дні тому (після 12:00)' },
  { key: 'instagram',      phase: 'day',   label: 'Instagram stories — мінімум 8 за день' },
  { key: 'cash_reconciled',phase: 'close', label: 'Каса зведена: програма + журнал = факт' },
  { key: 'trash_out',      phase: 'close', label: 'Сміття винесено, нові пакети в відрах' },
  { key: 'cleaning_ok',    phase: 'close', label: 'Прибирання прийнято (поверхні без пилу)' },
  { key: 'water_off',      phase: 'close', label: 'Воду перекрито' },
  { key: 'power_off',      phase: 'close', label: 'Електроприлади вимкнено' },
  { key: 'alarm_on',       phase: 'close', label: 'Сигналізацію поставлено' },
  { key: 'keys_safe',      phase: 'close', label: 'Ключі від каси не залишені в замку' },
];

// Кастомний шаблон салону (owner редагує) з settings; інакше дефолт.
async function loadTemplate() {
  try {
    const { getSetting } = require('../lib/settings');
    const custom = await getSetting('shift_checklist_template');
    if (Array.isArray(custom) && custom.length) {
      return custom.filter(x => x && x.key && x.label).map(x => ({
        key: String(x.key), phase: ['open', 'day', 'close'].includes(x.phase) ? x.phase : 'day',
        label: String(x.label), days: Array.isArray(x.days) ? x.days.map(Number) : null,
      }));
    }
  } catch (_) {}
  return DEFAULT_TEMPLATE;
}
function dowOf(dateStr) { try { return new Date(String(dateStr) + 'T12:00:00').getDay(); } catch (_) { return null; } }

// Чек-лист під конкретний день: solo прибирає командні, dow фільтрує по дню тижня.
async function template(solo = false, dow = null) {
  const tpl = await loadTemplate();
  return tpl
    .filter((x) => !(solo && TEAM_ONLY.has(x.key)))
    .filter((x) => dow == null || !Array.isArray(x.days) || x.days.length === 0 || x.days.includes(Number(dow)))
    .map((x) => ({ key: x.key, phase: x.phase, label: x.label, done: false, done_at: null }));
}
async function isSolo() {
  try { const { getSetting } = require('../lib/settings'); return !!(await getSetting('solo_master_mode')); }
  catch (_) { return false; }
}

// Зливає збережені відмітки на свіжий шаблон (щоб нові пункти зʼявлялись у старих днів).
async function mergeItems(saved, solo = false, dow = null) {
  const tpl = await template(solo, dow);
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
    const solo = await isSolo();
    const r = await pool.query('SELECT * FROM shift_checklists WHERE work_date=$1', [date]);
    if (!r.rows[0]) {
      return res.json({ work_date: date, admin_name: null, items: await template(solo, dowOf(date)),
        cash_program: null, cash_journal: null, cash_fact: null,
        cash_fact_cash: null, cash_fact_cashless: null, cash_diff: null,
        note: null, closed_at: null, saved: false });
    }
    const row = r.rows[0];
    row.items = await mergeItems(row.items, solo, dowOf(date));
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
    const items = await mergeItems(b.items, await isSolo(), dowOf(date)); // нормалізуємо на шаблон дня
    // проставляємо done_at для свіжо відмічених
    const nowIso = new Date().toISOString();
    items.forEach((it) => { if (it.done && !it.done_at) it.done_at = nowIso; if (!it.done) it.done_at = null; });
    const num = (v) => (v != null && v !== '' ? Number(v) : null);
    const prog = num(b.cash_program);
    const jour = num(b.cash_journal);
    const factCash = num(b.cash_fact_cash);
    const factCashless = num(b.cash_fact_cashless);
    // факт = готівка + безготівка; якщо жодного поля не задано — падаємо на старий cash_fact
    const fact = (factCash != null || factCashless != null)
      ? +(((factCash || 0) + (factCashless || 0)).toFixed(2))
      : num(b.cash_fact);
    const diff = (fact != null && prog != null) ? +(fact - prog).toFixed(2) : null;
    const admin = (b.admin_name || (req.staff && req.staff.name) || null);
    const r = await pool.query(
      `INSERT INTO shift_checklists (work_date, admin_name, items, cash_program, cash_journal, cash_fact, cash_fact_cash, cash_fact_cashless, cash_diff, note, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
       ON CONFLICT (tenant_id, work_date) DO UPDATE SET
         admin_name=COALESCE(EXCLUDED.admin_name, shift_checklists.admin_name),
         items=EXCLUDED.items, cash_program=EXCLUDED.cash_program, cash_journal=EXCLUDED.cash_journal,
         cash_fact=EXCLUDED.cash_fact, cash_fact_cash=EXCLUDED.cash_fact_cash, cash_fact_cashless=EXCLUDED.cash_fact_cashless,
         cash_diff=EXCLUDED.cash_diff, note=EXCLUDED.note, updated_at=NOW()
       RETURNING *`,
      [date, admin, JSON.stringify(items), prog, jour, fact, factCash, factCashless, diff, b.note || null]);
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

// ── GET /api/shift-checklist/template — поточний шаблон салону (для редактора) ──
// Повертає масив пунктів {key,phase,label,days:[0..6]|null}. days=null → щодня.
router.get('/template', async (req, res) => {
  try {
    let items;
    try {
      const { getSetting } = require('../lib/settings');
      const custom = await getSetting('shift_checklist_template');
      items = (Array.isArray(custom) && custom.length) ? custom : null;
    } catch (_) { items = null; }
    res.json({ items: items || DEFAULT_TEMPLATE.map(x => ({ ...x, days: null })), is_default: !items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/shift-checklist/template — зберегти кастомний шаблон (owner) ──
// body.items = [{key,phase,label,days}]. Порожній масив/скидання → повернути дефолт.
router.put('/template', requirePerm('settings.write'), async (req, res) => {
  try {
    const { setSetting } = require('../lib/settings');
    const raw = (req.body && req.body.items);
    if (!Array.isArray(raw) || raw.length === 0) {
      await setSetting('shift_checklist_template', null);
      return res.json({ ok: true, reset: true, items: DEFAULT_TEMPLATE.map(x => ({ ...x, days: null })) });
    }
    const seen = new Set();
    const clean = raw.filter(x => x && x.key && x.label).map((x, i) => {
      let key = String(x.key).trim() || `item_${i}`;
      while (seen.has(key)) key += '_' + i; // унікальність ключів (по них зберігаються відмітки)
      seen.add(key);
      return {
        key,
        phase: ['open', 'day', 'close'].includes(x.phase) ? x.phase : 'day',
        label: String(x.label).trim().slice(0, 200),
        days: Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter(d => d >= 0 && d <= 6))] : null,
      };
    });
    if (!clean.length) return res.status(400).json({ error: 'Порожній список пунктів' });
    await setSetting('shift_checklist_template', clean);
    res.json({ ok: true, items: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
