/* routes/budgets.js — FIN-05 Бюджетування.
   Планування доходів/витрат по періодах, статті по категоріях × місяцях,
   сезонні коефіцієнти, план/факт із реальних даних каси, простий workflow.
   Прагматична версія для 1 салону (без мульти-філій/консолідації).
   Доступ: reports.finance (керівник). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
router.use(requirePerm('reports.finance'));

// Стандартний сезонний пресет для салону краси
const STANDARD_PRESET = { name: 'Салон краси стандарт', factors: { '01': 0.7, '02': 0.85, '03': 1.3, '04': 1.05, '05': 1.1, '06': 0.95, '07': 0.8, '08': 0.85, '09': 1.15, '10': 1.05, '11': 1.1, '12': 1.4 } };

function firstOfMonth(dateStr) { return dateStr.slice(0, 8) + '01'; }
// Перелік перших днів місяців у періоді [start, end]
function monthsBetween(start, end) {
  const out = [];
  let y = +start.slice(0, 4), m = +start.slice(5, 7);
  const ey = +end.slice(0, 4), em = +end.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
// Факт за місяць+категорію з каси (+ orders для товарів)
async function actualFor(cat, monthStart) {
  const next = (() => { let y = +monthStart.slice(0, 4), m = +monthStart.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}-01`; })();
  const from = `${monthStart} 00:00:00+03`, to = `${next} 00:00:00+03`;
  let sum = 0;
  const cbCats = Array.isArray(cat.cashbox_categories) ? cat.cashbox_categories : [];
  if (cbCats.length) {
    const dir = cat.type === 'revenue' ? 'in' : 'out';
    const r = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type=$1 AND category = ANY($2) AND created_at >= $3 AND created_at < $4`,
      [dir, cbCats, from, to]);
    sum += Number(r.rows[0].s || 0);
  }
  // товари: додати оплачені замовлення магазину
  if (cat.code === 'products') {
    const r = await pool.query(`SELECT COALESCE(SUM(total),0)::numeric s FROM orders WHERE status='paid' AND created_at >= $1 AND created_at < $2`, [from, to]);
    sum += Number(r.rows[0].s || 0);
  }
  // сертифікати: продані за місяць
  if (cat.code === 'certificates') {
    const r = await pool.query(`SELECT COALESCE(SUM(original_amount),0)::numeric s FROM gift_certificates WHERE created_at >= $1 AND created_at < $2`, [from, to]).catch(() => ({ rows: [{ s: 0 }] }));
    sum += Number(r.rows[0].s || 0);
  }
  // абонементи: продані за місяць
  if (cat.code === 'subscriptions') {
    const r = await pool.query(`SELECT COALESCE(SUM(p.price),0)::numeric s FROM subscriptions s JOIN subscription_plans p ON p.id=s.plan_id WHERE s.created_at >= $1 AND s.created_at < $2`, [from, to]).catch(() => ({ rows: [{ s: 0 }] }));
    sum += Number(r.rows[0].s || 0);
  }
  return sum;
}

// ════════ КАТЕГОРІЇ ════════
router.get('/categories', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.type) { params.push(req.query.type); cond.push(`type=$${params.length}`); }
    if (req.query.active !== undefined) { params.push(req.query.active === 'true'); cond.push(`is_active=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(`SELECT * FROM budget_categories ${where} ORDER BY type, sort_order, id`, params);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/categories', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.code || !['revenue', 'expense'].includes(b.type)) return res.status(400).json({ error: 'name, code, type(revenue|expense) required' });
    const r = await pool.query(
      `INSERT INTO budget_categories (name,type,code,cashbox_categories,sort_order,is_system) VALUES ($1,$2,$3,$4,$5,false) RETURNING *`,
      [b.name, b.type, b.code, Array.isArray(b.cashbox_categories) ? b.cashbox_categories : [], b.sort_order ?? 100]);
    res.json({ ok: true, category: r.rows[0] });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'code exists' : e.message }); }
});

router.patch('/categories/:id', async (req, res) => {
  try {
    const allow = ['name', 'cashbox_categories', 'sort_order', 'is_active'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE budget_categories SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, category: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ СЕЗОННІ ПРЕСЕТИ ════════
router.get('/seasonal-presets', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM budget_seasonal_presets ORDER BY is_system DESC, id').catch(() => ({ rows: [] }));
    const items = r.rows.length ? r.rows : [STANDARD_PRESET];
    res.json({ items });
  } catch (e) { res.json({ items: [STANDARD_PRESET] }); }
});

// POST /seasonal-presets — зберегти кастомний пресет
router.post('/seasonal-presets', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.factors || typeof b.factors !== 'object') return res.status(400).json({ error: 'name and factors required' });
    const r = await pool.query(
      'INSERT INTO budget_seasonal_presets (name, is_system, factors) VALUES ($1, false, $2) RETURNING *',
      [b.name, JSON.stringify(b.factors)]);
    res.json({ ok: true, preset: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /seasonal-presets/suggest — авто-пропозиція коефіцієнтів з даних каси
router.post('/seasonal-presets/suggest', async (req, res) => {
  try {
    const baseYear = Number(req.body && req.body.base_year) || (new Date().getFullYear() - 1);
    const r = await pool.query(
      `SELECT to_char(created_at,'MM') m, SUM(amount)::numeric s
       FROM cash_operations WHERE type='in'
         AND created_at >= $1 AND created_at < $2
       GROUP BY 1 ORDER BY 1`,
      [`${baseYear}-01-01`, `${baseYear + 1}-01-01`]);
    const sums = {};
    r.rows.forEach(function(row) { sums[row.m] = Number(row.s); });
    const total = Object.values(sums).reduce(function(a, v) { return a + v; }, 0) || 1;
    const avgMonth = total / 12;
    const factors = {};
    for (var m = 1; m <= 12; m++) {
      var key = String(m).padStart(2, '0');
      factors[key] = avgMonth > 0 ? Math.round((sums[key] || avgMonth) / avgMonth * 100) / 100 : 1.0;
    }
    res.json({ factors, base_year: baseYear, source_months: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /alerts — непрочитані алерти
router.get('/alerts', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.budget_id) { params.push(+req.query.budget_id); cond.push('a.budget_id=$' + params.length); }
    if (req.query.is_read !== undefined) { params.push(req.query.is_read === 'true'); cond.push('a.is_read=$' + params.length); }
    else { cond.push('NOT a.is_read'); }
    const where = 'WHERE ' + cond.join(' AND ');
    const r = await pool.query(
      'SELECT a.*, b.name budget_name, c.name category_name FROM budget_alerts a' +
      ' JOIN budgets b ON b.id=a.budget_id JOIN budget_categories c ON c.id=a.category_id' +
      ' ' + where + ' ORDER BY a.created_at DESC LIMIT 50', params);
    res.json({ data: r.rows, total: r.rowCount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// PUT /alerts/:id/read
router.put('/alerts/:id/read', async (req, res) => {
  try {
    const r = await pool.query('UPDATE budget_alerts SET is_read=true WHERE id=$1 RETURNING id', [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /consolidated — зведений план/факт по всіх активних бюджетах за місяць
router.get('/consolidated', async (req, res) => {
  try {
    const tz = 'Europe/Kiev';
    const month = req.query.period_start
      ? firstOfMonth(req.query.period_start)
      : firstOfMonth(new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()));
    const budgets = (await pool.query(
      `SELECT * FROM budgets WHERE status IN ('active','closed') AND period_start<=$1 AND period_end>=$1`, [month])).rows;
    const cats = (await pool.query('SELECT * FROM budget_categories WHERE is_active=true ORDER BY type, sort_order')).rows;
    let revPlan = 0, revAct = 0, expPlan = 0, expAct = 0;
    const catMap = {};
    for (var ci = 0; ci < cats.length; ci++) { catMap[cats[ci].id] = { category: cats[ci], plan: 0, actual: 0 }; }
    for (var bi = 0; bi < budgets.length; bi++) {
      const items = (await pool.query('SELECT * FROM budget_items WHERE budget_id=$1 AND month=$2', [budgets[bi].id, month])).rows;
      for (var ii = 0; ii < items.length; ii++) {
        const cm = catMap[items[ii].category_id]; if (!cm) continue;
        const plan = Number(items[ii].plan_amount);
        const actual = await actualFor(cm.category, month);
        cm.plan += plan; cm.actual += actual;
        if (cm.category.type === 'revenue') { revPlan += plan; revAct += actual; }
        else { expPlan += plan; expAct += actual; }
      }
    }
    const rows = Object.values(catMap).filter(function(r) { return r.plan > 0 || r.actual > 0; }).map(function(r) {
      return { category: { id: r.category.id, name: r.category.name, type: r.category.type, code: r.category.code },
        plan: r.plan, actual: r.actual,
        deviation_percent: r.plan > 0 ? Math.round((r.actual - r.plan) / r.plan * 1000) / 10 : 0 };
    });
    res.json({
      month, budgets_count: budgets.length,
      categories: rows,
      totals: {
        revenue: { plan: revPlan, actual: revAct, percent: revPlan > 0 ? Math.round(revAct / revPlan * 1000) / 10 : 0 },
        expense: { plan: expPlan, actual: expAct, percent: expPlan > 0 ? Math.round(expAct / expPlan * 1000) / 10 : 0 },
        profit_plan: revPlan - expPlan, profit_actual: revAct - expAct
      }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ════════ БЮДЖЕТИ ════════
router.get('/', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`status=$${params.length}`); }
    if (req.query.period_type) { params.push(req.query.period_type); cond.push(`period_type=$${params.length}`); }
    if (req.query.year) { params.push(req.query.year); cond.push(`to_char(period_start,'YYYY')=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(`SELECT * FROM budgets ${where} ORDER BY period_start DESC, id DESC`, params);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST / — створити бюджет (+ авто-розбивка по місяцях, опц. копія з джерела)
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !b.period_start || !b.period_end) return res.status(400).json({ error: 'name, period_start, period_end required' });
    const period_type = ['month', 'quarter', 'year'].includes(b.period_type) ? b.period_type : 'month';
    const ins = await pool.query(
      `INSERT INTO budgets (name,period_type,period_start,period_end,status,source_budget_id,created_by) VALUES ($1,$2,$3,$4,'draft',$5,$6) RETURNING *`,
      [b.name, period_type, b.period_start, b.period_end, b.source_budget_id || null, req.user?.display_name || null]);
    const budget = ins.rows[0];
    const months = monthsBetween(firstOfMonth(b.period_start), firstOfMonth(b.period_end));
    const cats = (await pool.query(`SELECT id FROM budget_categories WHERE is_active=true`)).rows;
    // джерело для копіювання планів (за відповідний місяць-зсув)
    let srcItems = [];
    if (b.source_budget_id) {
      srcItems = (await pool.query(`SELECT category_id, plan_amount, seasonal_factor FROM budget_items WHERE budget_id=$1 ORDER BY month`, [+b.source_budget_id])).rows;
    }
    for (const m of months) {
      for (const c of cats) {
        const src = srcItems.find(s => s.category_id === c.id);
        await pool.query(
          `INSERT INTO budget_items (budget_id,category_id,month,plan_amount,seasonal_factor) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [budget.id, c.id, m, src ? src.plan_amount : 0, src ? src.seasonal_factor : 1.0]);
      }
    }
    await recomputeTotals(budget.id);
    logAction({ user: req.user, action: 'budget.create', entity: 'budget', entity_id: budget.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, budget: (await pool.query(`SELECT * FROM budgets WHERE id=$1`, [budget.id])).rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

async function recomputeTotals(budgetId) {
  await pool.query(`
    UPDATE budgets b SET
      total_revenue_plan = COALESCE((SELECT SUM(bi.plan_amount) FROM budget_items bi JOIN budget_categories c ON c.id=bi.category_id WHERE bi.budget_id=b.id AND c.type='revenue'),0),
      total_expense_plan = COALESCE((SELECT SUM(bi.plan_amount) FROM budget_items bi JOIN budget_categories c ON c.id=bi.category_id WHERE bi.budget_id=b.id AND c.type='expense'),0),
      updated_at=NOW()
    WHERE b.id=$1`, [budgetId]);
}

// GET /:id — деталі з розбивкою план/факт
router.get('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const budget = (await pool.query(`SELECT * FROM budgets WHERE id=$1`, [id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    const cats = (await pool.query(`SELECT * FROM budget_categories ORDER BY type, sort_order, id`)).rows;
    const items = (await pool.query(`SELECT * FROM budget_items WHERE budget_id=$1 ORDER BY month`, [id])).rows;
    const months = [...new Set(items.map(i => String(i.month).slice(0, 10)))].sort();
    // факт по кожній категорії×місяць
    const out = [];
    let revPlan = 0, revAct = 0, expPlan = 0, expAct = 0;
    for (const c of cats) {
      const catItems = items.filter(i => i.category_id === c.id);
      if (!catItems.length) continue;
      const monthsArr = [];
      for (const it of catItems) {
        const ms = String(it.month).slice(0, 10);
        const plan = Number(it.plan_amount);
        const actual = await actualFor(c, ms);
        monthsArr.push({ month: ms, plan, actual, seasonal_factor: Number(it.seasonal_factor), deviation_percent: plan > 0 ? Math.round((actual - plan) / plan * 1000) / 10 : (actual > 0 ? 100 : 0) });
        if (c.type === 'revenue') { revPlan += plan; revAct += actual; } else { expPlan += plan; expAct += actual; }
      }
      out.push({ category: { id: c.id, name: c.name, type: c.type, code: c.code }, months: monthsArr });
    }
    res.json({
      budget, months,
      items: out,
      totals: {
        revenue: { plan: revPlan, actual: revAct, percent: revPlan > 0 ? Math.round(revAct / revPlan * 1000) / 10 : 0 },
        expense: { plan: expPlan, actual: expAct, percent: expPlan > 0 ? Math.round(expAct / expPlan * 1000) / 10 : 0 },
        profit_plan: revPlan - expPlan, profit_actual: revAct - expAct
      }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PUT /:id — оновити (тільки draft)
router.put('/:id', async (req, res) => {
  try {
    const id = +req.params.id;
    const budget = (await pool.query(`SELECT * FROM budgets WHERE id=$1`, [id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    if (budget.status !== 'draft') return res.status(409).json({ error: 'not-draft' });
    const allow = ['name', 'period_type'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(id);
    const r = await pool.query(`UPDATE budgets SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    res.json({ ok: true, budget: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PUT /:id/items — масове оновлення планів (тільки draft)
router.put('/:id/items', async (req, res) => {
  try {
    const id = +req.params.id;
    const budget = (await pool.query(`SELECT status FROM budgets WHERE id=$1`, [id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    if (budget.status === 'closed' || budget.status === 'archived') return res.status(409).json({ error: 'budget-closed' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    for (const it of items) {
      if (!it.category_id || !it.month) continue;
      const m = String(it.month).slice(0, 10);
      const factor = it.seasonal_factor != null ? Number(it.seasonal_factor) : 1.0;
      const plan = Number(it.plan_amount) || 0;
      await pool.query(
        `INSERT INTO budget_items (budget_id,category_id,month,plan_amount,seasonal_factor,base_amount,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (budget_id,category_id,month)
         DO UPDATE SET plan_amount=$4, seasonal_factor=$5, base_amount=$6, notes=$7, updated_at=NOW()`,
        [id, +it.category_id, m, plan, factor, it.base_amount ?? null, it.notes ?? null]);
    }
    await recomputeTotals(id);
    res.json({ ok: true, updated: items.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /:id/apply-seasonal — застосувати сезонний пресет до річної бази
router.post('/:id/apply-seasonal', async (req, res) => {
  try {
    const id = +req.params.id;
    const budget = (await pool.query(`SELECT status FROM budgets WHERE id=$1`, [id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    if (budget.status !== 'draft') return res.status(409).json({ error: 'not-draft' });
    const factors = (req.body?.factors && typeof req.body.factors === 'object') ? req.body.factors : STANDARD_PRESET.factors;
    // base_amounts: [{category_id, annual_amount}] → розкидати по місяцях за коефіцієнтами
    const bases = Array.isArray(req.body?.base_amounts) ? req.body.base_amounts : [];
    for (const ba of bases) {
      const cid = +ba.category_id;
      const annual = Number(ba.annual_amount) || 0;
      const itemMonths = (await pool.query(`SELECT month FROM budget_items WHERE budget_id=$1 AND category_id=$2`, [id, cid])).rows.map(r => String(r.month).slice(0, 10));
      const factorSum = itemMonths.reduce((a, m) => a + (factors[m.slice(5, 7)] || 1), 0) || 1;
      for (const m of itemMonths) {
        const f = factors[m.slice(5, 7)] || 1;
        const plan = Math.round(annual * f / factorSum * 100) / 100;
        await pool.query(`UPDATE budget_items SET plan_amount=$1, seasonal_factor=$2, base_amount=$3, updated_at=NOW() WHERE budget_id=$4 AND category_id=$5 AND month=$6`,
          [plan, f, annual / itemMonths.length, id, cid, m]);
      }
    }
    await recomputeTotals(id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Workflow: activate / close / delete
router.post('/:id/activate', async (req, res) => {
  try {
    const r = await pool.query(`UPDATE budgets SET status='active', updated_at=NOW() WHERE id=$1 AND status IN ('draft') RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(409).json({ error: 'not-draft-or-missing' });
    logAction({ user: req.user, action: 'budget.activate', entity: 'budget', entity_id: +req.params.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true, budget: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.post('/:id/close', async (req, res) => {
  try {
    const r = await pool.query(`UPDATE budgets SET status='closed', updated_at=NOW() WHERE id=$1 AND status='active' RETURNING *`, [+req.params.id]);
    if (!r.rows[0]) return res.status(409).json({ error: 'not-active-or-missing' });
    res.json({ ok: true, budget: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.delete('/:id', async (req, res) => {
  try {
    const budget = (await pool.query(`SELECT status FROM budgets WHERE id=$1`, [+req.params.id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    if (budget.status !== 'draft') return res.status(409).json({ error: 'not-draft' });
    await pool.query(`DELETE FROM budgets WHERE id=$1`, [+req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /:id/plan-fact — звіт план/факт за місяць (з прогнозом на кінець місяця і статусом)
router.get('/:id/plan-fact', async (req, res) => {
  try {
    const id = +req.params.id;
    const budget = (await pool.query(`SELECT * FROM budgets WHERE id=$1`, [id])).rows[0];
    if (!budget) return res.status(404).json({ error: 'not found' });
    const month = req.query.month ? firstOfMonth(req.query.month) : firstOfMonth(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev' }).format(new Date()));
    const cats = (await pool.query(`SELECT * FROM budget_categories ORDER BY type, sort_order`)).rows;
    const items = (await pool.query(`SELECT * FROM budget_items WHERE budget_id=$1 AND month=$2`, [id, month])).rows;
    // прогноз: лінійна екстраполяція за поточний день місяця
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev' }).format(new Date());
    const isCurMonth = today.slice(0, 7) === month.slice(0, 7);
    const dayOfMonth = +today.slice(8, 10);
    const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
    const out = [];
    for (const c of cats) {
      const it = items.find(i => i.category_id === c.id); if (!it) continue;
      const plan = Number(it.plan_amount);
      const actual = await actualFor(c, month);
      const pctv = plan > 0 ? actual / plan * 100 : 0;
      const status = pctv < 80 ? 'green' : (pctv < 100 ? 'yellow' : 'red');
      const forecast = isCurMonth && dayOfMonth > 0 ? Math.round(actual / dayOfMonth * daysInMonth) : actual;
      out.push({ category: { id: c.id, name: c.name, code: c.code, type: c.type }, plan, actual,
        deviation_abs: Math.round((actual - plan) * 100) / 100, deviation_percent: Math.round((pctv - 100) * 10) / 10,
        percent: Math.round(pctv * 10) / 10, status, forecast_eom: forecast });
    }
    res.json({ budget_id: id, month, categories: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ WORKFLOW: submit / approve / reject ════════
async function logTransition(budgetId, fromStatus, toStatus, user, comment) {
  await pool.query(
    'INSERT INTO budget_approval_log (budget_id, from_status, to_status, user_id, comment) VALUES ($1,$2,$3,$4,$5)',
    [budgetId, fromStatus, toStatus, user || null, comment || null]).catch(function() {});
}

// POST /:id/submit — draft → pending_approval
router.post('/:id/submit', async (req, res) => {
  try {
    const id = +req.params.id;
    const bg = (await pool.query('SELECT * FROM budgets WHERE id=$1', [id])).rows[0];
    if (!bg) return res.status(404).json({ error: 'not found' });
    if (bg.status !== 'draft') return res.status(409).json({ error: 'budget must be in draft to submit' });
    await pool.query("UPDATE budgets SET status='pending_approval', updated_at=NOW() WHERE id=$1", [id]);
    await logTransition(id, 'draft', 'pending_approval', req.user && req.user.display_name, req.body && req.body.comment);
    logAction({ user: req.user, action: 'budget.submit', entity: 'budget', entity_id: id, ip: req.ip }).catch(function() {});
    res.json({ ok: true, status: 'pending_approval' });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /:id/approve — pending_approval → active
router.post('/:id/approve', async (req, res) => {
  try {
    const id = +req.params.id;
    const bg = (await pool.query('SELECT * FROM budgets WHERE id=$1', [id])).rows[0];
    if (!bg) return res.status(404).json({ error: 'not found' });
    if (bg.status !== 'pending_approval') return res.status(409).json({ error: 'budget must be pending_approval' });
    const approver = req.user && req.user.display_name;
    await pool.query(
      "UPDATE budgets SET status='active', approved_by=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2",
      [approver, id]);
    await logTransition(id, 'pending_approval', 'active', approver, req.body && req.body.comment);
    logAction({ user: req.user, action: 'budget.approve', entity: 'budget', entity_id: id, ip: req.ip }).catch(function() {});
    res.json({ ok: true, status: 'active' });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /:id/reject — pending_approval → draft
router.post('/:id/reject', async (req, res) => {
  try {
    const id = +req.params.id;
    const bg = (await pool.query('SELECT * FROM budgets WHERE id=$1', [id])).rows[0];
    if (!bg) return res.status(404).json({ error: 'not found' });
    if (bg.status !== 'pending_approval') return res.status(409).json({ error: 'budget must be pending_approval' });
    await pool.query("UPDATE budgets SET status='draft', updated_at=NOW() WHERE id=$1", [id]);
    await logTransition(id, 'pending_approval', 'draft', req.user && req.user.display_name, req.body && req.body.comment);
    logAction({ user: req.user, action: 'budget.reject', entity: 'budget', entity_id: id, ip: req.ip }).catch(function() {});
    res.json({ ok: true, status: 'draft' });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /:id/approval-log — історія переходів
router.get('/:id/approval-log', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT * FROM budget_approval_log WHERE budget_id=$1 ORDER BY created_at DESC', [+req.params.id]);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
