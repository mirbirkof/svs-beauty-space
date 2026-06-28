/* routes/recurring-expenses.js — Постійні (програмовані) витрати.
   Шаблони щомісячних витрат (оренда, фікс-ЗП, підписки). Авто-проводка в cash_operations
   раз на місяць (ідемпотентно через last_posted). Доступ як у фінансів. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'reports.read' : 'reports.finance';
  return requirePerm(perm)(req, res, next);
});

function monthStart() {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit' }).format(d) + '-01';
}
function kyivDay() {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', day: '2-digit' }).format(new Date()));
}

// Провести всі «дозрілі» постійні витрати за поточний місяць (ідемпотентно).
async function postDue(db = pool) {
  const ms = monthStart();
  const today = kyivDay();
  const due = await db.query(
    `SELECT * FROM recurring_expenses
      WHERE active=TRUE AND (last_posted IS NULL OR last_posted < $1::date) AND day_of_month <= $2`,
    [ms, today]);
  let posted = 0;
  for (const t of due.rows) {
    try {
      // Атомарний «claim»: ставимо last_posted ТІЛЬКИ якщо ще не проведено за цей місяць.
      // Якщо паралельний тік / ручний /run уже провів — rowCount=0, пропускаємо.
      // Це закриває гонку (подвійну проводку грошей) без окремої транзакції.
      const claim = await db.query(
        `UPDATE recurring_expenses SET last_posted=$1::date, updated_at=NOW()
          WHERE id=$2 AND (last_posted IS NULL OR last_posted < $1::date)`,
        [ms, t.id]);
      if (claim.rowCount === 0) continue;
      await db.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, description)
         VALUES (NULL,'out',$1,$2,$3,$4)`,
        [t.category, t.amount, t.method || 'cash', (t.description || 'Постійна витрата') + ' (авто)']);
      posted++;
    } catch (e) { console.error('[recurring-exp] post', t.id, e.message); }
  }
  return posted;
}

// GET / — список шаблонів
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM recurring_expenses ORDER BY active DESC, category`);
    res.json({ items: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — створити шаблон (+ одразу провести за поточний місяць, якщо день настав)
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.category || !(Number(b.amount) > 0)) return res.status(400).json({ error: 'category, amount обовʼязкові' });
    const dom = Math.min(Math.max(parseInt(b.day_of_month, 10) || 1, 1), 28);
    const r = await pool.query(
      `INSERT INTO recurring_expenses (category, amount, method, description, day_of_month)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.category, Number(b.amount), b.method || 'cash', b.description || null, dom]);
    // одразу провести за поточний місяць, якщо день уже настав і просять
    let postedNow = false;
    if (b.post_now !== false && dom <= kyivDay()) {
      const n = await postDue();
      postedNow = n > 0;
    }
    res.json({ ok: true, item: r.rows[0], posted_now: postedNow });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — змінити (сума, активність, день)
router.patch('/:id', async (req, res) => {
  try {
    const allow = ['category', 'amount', 'method', 'description', 'day_of_month', 'active'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE recurring_expenses SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — прибрати шаблон (вже проведені витрати в касі лишаються)
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM recurring_expenses WHERE id=$1 RETURNING id`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /run — вручну провести дозрілі (кнопка в UI / тік)
router.post('/run', async (req, res) => {
  try { const n = await postDue(); res.json({ ok: true, posted: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.postDue = postDue;
