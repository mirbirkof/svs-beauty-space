/* routes/cash-flow.js — FIN-06 Рух грошових коштів.
   Рахунки/каси з балансами, перекази, календар платежів,
   прогноз балансу 30/60/90 днів, звіт ДДС.
   Прагматично для 1 салону: реєстр потоків = cash_operations (не дублюємо).
   Доступ: reports.finance. */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
router.use(requirePerm('reports.finance'));

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(dateStr, n) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
}

// ════════ РЕЄСТР ПОТОКІВ (з каси) ════════
router.get('/', async (req, res) => {
  try {
    const from = (req.query.from || addDays(kyivToday(), -30)) + ' 00:00:00+03';
    const to = (req.query.to || kyivToday()) + ' 23:59:59+03';
    const cond = ['created_at BETWEEN $1 AND $2'], params = [from, to];
    if (req.query.type === 'inflow') cond.push(`type='in'`);
    else if (req.query.type === 'outflow') cond.push(`type='out'`);
    if (req.query.category) { params.push(req.query.category); cond.push(`category=$${params.length}`); }
    const lim = Math.min(+req.query.limit || 100, 500);
    const off = +req.query.offset || 0;
    const r = await pool.query(
      `SELECT id, type, category, amount, description, created_at FROM cash_operations
       WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`, params);
    const tot = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type='in'),0)::numeric inflow,
              COALESCE(SUM(amount) FILTER (WHERE type='out'),0)::numeric outflow
       FROM cash_operations WHERE ${cond.join(' AND ')}`, params);
    const inflow = Number(tot.rows[0].inflow), outflow = Number(tot.rows[0].outflow);
    res.json({ items: r.rows.map(x => ({ ...x, type: x.type === 'in' ? 'inflow' : 'outflow', amount: Number(x.amount) })), totals: { inflow, outflow, net: inflow - outflow } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ РАХУНКИ ════════
router.get('/accounts', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM bank_accounts ORDER BY sort_order, id`);
    const total = r.rows.filter(a => a.active).reduce((s, a) => s + Number(a.current_balance), 0);
    res.json({ items: r.rows, total_balance: total });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.post('/accounts', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const r = await pool.query(
      `INSERT INTO bank_accounts (name,type,bank_name,account_number,current_balance,min_balance_alert,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, ['cash', 'bank', 'card_terminal', 'online'].includes(b.type) ? b.type : 'cash',
       b.bank_name || null, b.account_number || null, Number(b.current_balance) || 0, b.min_balance_alert != null ? Number(b.min_balance_alert) : null, b.sort_order ?? 0]);
    res.json({ ok: true, account: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.patch('/accounts/:id', async (req, res) => {
  try {
    const allow = ['name', 'type', 'bank_name', 'account_number', 'current_balance', 'min_balance_alert', 'active', 'sort_order'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE bank_accounts SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, account: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ ПЕРЕКАЗИ ════════
router.post('/transfers', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const amt = Number(b.amount);
    if (!b.from_account_id || !b.to_account_id || !amt || amt <= 0) return res.status(400).json({ error: 'from_account_id, to_account_id, amount required' });
    if (+b.from_account_id === +b.to_account_id) return res.status(400).json({ error: 'same account' });
    await client.query('BEGIN');
    await applyTenant(client); // изоляция тенанта в ручной транзакции
    const from = (await client.query(`SELECT * FROM bank_accounts WHERE id=$1 FOR UPDATE`, [+b.from_account_id])).rows[0];
    const toAcc = (await client.query(`SELECT * FROM bank_accounts WHERE id=$1 FOR UPDATE`, [+b.to_account_id])).rows[0];
    if (!from || !toAcc) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'account not found' }); }
    if (Number(from.current_balance) < amt) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'insufficient-balance', balance: Number(from.current_balance) }); }
    await client.query(`UPDATE bank_accounts SET current_balance=current_balance-$1, updated_at=NOW() WHERE id=$2`, [amt, from.id]);
    await client.query(`UPDATE bank_accounts SET current_balance=current_balance+$1, updated_at=NOW() WHERE id=$2`, [amt, toAcc.id]);
    const t = (await client.query(`INSERT INTO account_transfers (from_account_id,to_account_id,amount,description,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [from.id, toAcc.id, amt, b.description || null, req.user?.display_name || null])).rows[0];
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'cashflow.transfer', entity: 'account_transfer', entity_id: t.id, ip: req.ip, meta: { amt } }).catch(() => {});
    res.json({ ok: true, transfer: t });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  finally { client.release(); }
});

// ════════ КАЛЕНДАР ПЛАТЕЖІВ ════════
router.get('/calendar', async (req, res) => {
  try {
    // ліниве протермінування
    await pool.query(`UPDATE payment_calendar SET status='overdue', updated_at=NOW() WHERE status='planned' AND due_date < $1`, [kyivToday()]);
    const cond = [], params = [];
    if (req.query.from) { params.push(req.query.from); cond.push(`due_date >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to); cond.push(`due_date <= $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); cond.push(`status=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(`SELECT * FROM payment_calendar ${where} ORDER BY due_date`, params);
    const due = r.rows.filter(p => ['planned', 'overdue'].includes(p.status)).reduce((s, p) => s + (p.type === 'outflow' ? Number(p.amount) : 0), 0);
    res.json({ payments: r.rows, total_due: due });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.post('/calendar', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.amount || !b.due_date) return res.status(400).json({ error: 'amount, due_date required' });
    const r = await pool.query(
      `INSERT INTO payment_calendar (account_id,type,category,amount,counterparty_name,description,due_date,recurring,recurrence_rule,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.account_id || null, b.type === 'inflow' ? 'inflow' : 'outflow', b.category || 'other', Number(b.amount),
       b.counterparty_name || null, b.description || null, b.due_date, !!b.recurring, b.recurrence_rule || null, req.user?.display_name || null]);
    res.json({ ok: true, payment: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.patch('/calendar/:id', async (req, res) => {
  try {
    const allow = ['account_id', 'type', 'category', 'amount', 'counterparty_name', 'description', 'due_date', 'recurring', 'recurrence_rule', 'status'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body || {})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(`UPDATE payment_calendar SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, payment: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.post('/calendar/:id/mark-paid', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenant(client); // изоляция тенанта в ручной транзакции
    const p = (await client.query(`SELECT * FROM payment_calendar WHERE id=$1 FOR UPDATE`, [+req.params.id])).rows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (p.status === 'paid') { await client.query('ROLLBACK'); return res.json({ ok: true, payment: p }); }
    await client.query(`UPDATE payment_calendar SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1`, [p.id]);
    // оновити баланс рахунку (якщо вказаний)
    if (p.account_id) {
      const delta = p.type === 'outflow' ? -Number(p.amount) : Number(p.amount);
      await client.query(`UPDATE bank_accounts SET current_balance=current_balance+$1, updated_at=NOW() WHERE id=$2`, [delta, p.account_id]);
    }
    // регулярний — створити наступний
    if (p.recurring && p.recurrence_rule && p.recurrence_rule.interval === 'monthly') {
      const nd = (() => { const d = new Date(String(p.due_date).slice(0, 10) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
      await client.query(
        `INSERT INTO payment_calendar (account_id,type,category,amount,counterparty_name,description,due_date,recurring,recurrence_rule,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9)`,
        [p.account_id, p.type, p.category, p.amount, p.counterparty_name, p.description, nd, p.recurrence_rule, p.created_by]);
    }
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'cashflow.mark_paid', entity: 'payment_calendar', entity_id: p.id, ip: req.ip, meta: { amount: p.amount, type: p.type, account_id: p.account_id } }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  finally { client.release(); }
});
router.delete('/calendar/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM payment_calendar WHERE id=$1 RETURNING amount, type`, [+req.params.id]);
    logAction({ user: req.user, action: 'cashflow.calendar_delete', entity: 'payment_calendar', entity_id: +req.params.id, ip: req.ip, meta: r.rows[0] || {} }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ ПРОГНОЗ ════════
router.get('/forecast', async (req, res) => {
  try {
    const days = Math.min(Math.max(+req.query.days || 90, 7), 365);
    const scenario = ['optimistic', 'realistic', 'pessimistic'].includes(req.query.scenario) ? req.query.scenario : 'realistic';
    const factor = scenario === 'optimistic' ? 1.15 : (scenario === 'pessimistic' ? 0.8 : 1.0);
    // стартовий баланс = сума активних рахунків
    const acc = await pool.query(`SELECT COALESCE(SUM(current_balance),0)::numeric s, COALESCE(MIN(min_balance_alert),0)::numeric m FROM bank_accounts WHERE active=true`);
    let balance = Number(acc.rows[0].s);
    const threshold = Number(acc.rows[0].m) || 0;
    // середній денний дохід за останні 90 днів (cash in)
    const inAvg = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations WHERE type='in' AND created_at >= NOW() - INTERVAL '90 days'`);
    const dailyInflow = Number(inAvg.rows[0].s) / 90 * factor;
    // планові платежі за період
    const today = kyivToday();
    const horizon = addDays(today, days);
    const pays = (await pool.query(
      `SELECT due_date, type, amount FROM payment_calendar WHERE status IN ('planned','overdue') AND due_date <= $1`, [horizon])).rows;
    const payByDate = {};
    for (const p of pays) {
      const d = String(p.due_date).slice(0, 10);
      payByDate[d] = (payByDate[d] || 0) + (p.type === 'outflow' ? -Number(p.amount) : Number(p.amount));
    }
    const series = []; let gapDate = null, gapAmount = null;
    for (let i = 1; i <= days; i++) {
      const d = addDays(today, i);
      const plannedDelta = payByDate[d] || 0;
      balance += dailyInflow + plannedDelta;
      if (gapDate === null && balance < threshold) { gapDate = d; gapAmount = Math.round(balance); }
      if (i % 1 === 0 && (i <= 30 || i % 5 === 0)) series.push({ date: d, balance: Math.round(balance), expected_inflow: Math.round(dailyInflow), planned: Math.round(plannedDelta) });
    }
    res.json({ scenario, days, start_balance: Math.round(Number(acc.rows[0].s)), threshold, daily_inflow: Math.round(dailyInflow), forecast: series, gap_date: gapDate, gap_amount: gapAmount });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ ЗВІТ ДДС ════════
router.get('/report', async (req, res) => {
  try {
    const from = (req.query.from || addDays(kyivToday(), -180)) + ' 00:00:00+03';
    const to = (req.query.to || kyivToday()) + ' 23:59:59+03';
    const r = await pool.query(`
      SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM') period,
             type, category, COALESCE(SUM(amount),0)::numeric s
      FROM cash_operations WHERE created_at BETWEEN $1 AND $2
      GROUP BY period, type, category ORDER BY period`, [from, to]);
    const map = {};
    for (const row of r.rows) {
      map[row.period] = map[row.period] || { period: row.period, inflow: 0, outflow: 0, by_category: {} };
      const amt = Number(row.s);
      if (row.type === 'in') map[row.period].inflow += amt; else map[row.period].outflow += amt;
      map[row.period].by_category[(row.type === 'in' ? 'in:' : 'out:') + row.category] = amt;
    }
    const periods = Object.values(map).map(p => ({ ...p, net: p.inflow - p.outflow }));
    res.json({ periods });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ РУЧНІ ЗАПИСИ (cash_flow_entries) ════════
const VALID_CATEGORIES = ['services','products','salary','purchasing','rent','taxes','marketing','utilities','other'];
const VALID_TYPES = ['inflow','outflow'];

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.amount || !b.entry_date) return res.status(400).json({ error: 'amount, entry_date required' });
    if (!VALID_TYPES.includes(b.type)) return res.status(400).json({ error: 'type must be inflow|outflow' });
    const r = await pool.query(
      `INSERT INTO cash_flow_entries
         (account_id,type,category,subcategory,amount,currency,description,counterparty_name,counterparty_type,entry_date,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [b.account_id||null, b.type,
       VALID_CATEGORIES.includes(b.category)?b.category:'other', b.subcategory||null,
       Number(b.amount), b.currency||'UAH', b.description||null,
       b.counterparty_name||null, b.counterparty_type||null,
       b.entry_date, req.user?.display_name||null]);
    // оновити баланс рахунку якщо вказаний
    if (b.account_id) {
      const delta = b.type === 'inflow' ? Number(b.amount) : -Number(b.amount);
      await pool.query(`UPDATE bank_accounts SET current_balance=current_balance+$1, updated_at=NOW() WHERE id=$2`, [delta, b.account_id]);
    }
    logAction({ user: req.user, action: 'cashflow.entry_create', entity: 'cash_flow_entries', entity_id: r.rows[0].id, ip: req.ip, meta: { type: b.type, amount: b.amount } }).catch(()=>{});
    res.json({ ok: true, entry: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const allow = ['account_id','type','category','subcategory','amount','currency','description','counterparty_name','counterparty_type','entry_date','reconciled','bank_statement_ref'];
    const sets = [], params = [];
    for (const k of allow) if (k in (req.body||{})) { params.push(req.body[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'no fields' });
    params.push(+req.params.id);
    const r = await pool.query(
      `UPDATE cash_flow_entries SET ${sets.join(', ')}, updated_at=NOW()
       WHERE id=$${params.length} AND source_type='manual' RETURNING *`, params);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found or auto-entry' });
    res.json({ ok: true, entry: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM cash_flow_entries WHERE id=$1 AND source_type='manual' RETURNING id, type, amount, account_id`, [+req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found or auto-entry' });
    const e = r.rows[0];
    // відкат балансу
    if (e.account_id) {
      const delta = e.type === 'inflow' ? -Number(e.amount) : Number(e.amount);
      await pool.query(`UPDATE bank_accounts SET current_balance=current_balance+$1, updated_at=NOW() WHERE id=$2`, [delta, e.account_id]);
    }
    logAction({ user: req.user, action: 'cashflow.entry_delete', entity: 'cash_flow_entries', entity_id: +req.params.id, ip: req.ip, meta: {} }).catch(()=>{});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /entries — лише ручні записи (окремо від cashbox)
router.get('/entries', async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.from) { params.push(req.query.from); cond.push(`entry_date>=$${params.length}`); }
    if (req.query.to)   { params.push(req.query.to);   cond.push(`entry_date<=$${params.length}`); }
    if (req.query.type) { params.push(req.query.type); cond.push(`type=$${params.length}`); }
    if (req.query.category) { params.push(req.query.category); cond.push(`category=$${params.length}`); }
    if (req.query.reconciled !== undefined) { params.push(req.query.reconciled === 'true'); cond.push(`reconciled=$${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const lim = Math.min(+req.query.limit||100, 500);
    const off = +req.query.offset||0;
    const r = await pool.query(
      `SELECT e.*, a.name account_name FROM cash_flow_entries e
       LEFT JOIN bank_accounts a ON a.id=e.account_id
       ${where} ORDER BY entry_date DESC, id DESC LIMIT ${lim} OFFSET ${off}`, params);
    const tot = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='inflow'),0)::numeric inflow,
              COALESCE(SUM(amount) FILTER(WHERE type='outflow'),0)::numeric outflow
       FROM cash_flow_entries ${where}`, params);
    const { inflow, outflow } = tot.rows[0];
    res.json({ items: r.rows.map(x=>({...x,amount:Number(x.amount)})), totals:{ inflow: Number(inflow), outflow: Number(outflow), net: Number(inflow)-Number(outflow) } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ ЗВІРКА З БАНКОМ ════════
router.post('/reconcile', async (req, res) => {
  try {
    const b = req.body || {};
    // [ { entry_id, bank_ref } ]  — для записів у cash_flow_entries
    // або [ { cashbox_id, bank_ref } ] — для cash_operations
    if (!Array.isArray(b.entries) || !b.entries.length) return res.status(400).json({ error: 'entries array required' });
    let matched = 0;
    for (const item of b.entries) {
      if (item.entry_id) {
        const r = await pool.query(
          `UPDATE cash_flow_entries SET reconciled=true, bank_statement_ref=$1, updated_at=NOW()
           WHERE id=$2 RETURNING id`, [item.bank_ref||null, +item.entry_id]);
        if (r.rows[0]) matched++;
      }
    }
    // зберегти лог імпорту якщо вказано account_id
    let importRec = null;
    if (b.account_id) {
      const { rows } = await pool.query(
        `INSERT INTO bank_statement_imports (account_id, row_count, matched, unmatched, imported_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [b.account_id, b.entries.length, matched, b.entries.length - matched, req.user?.display_name||null]);
      importRec = rows[0];
    }
    logAction({ user: req.user, action: 'cashflow.reconcile', entity: 'bank_statement_imports', entity_id: importRec?.id||null, ip: req.ip, meta: { matched } }).catch(()=>{});
    res.json({ ok: true, matched, unmatched: b.entries.length - matched, import: importRec });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /reconcile/status — статистика звірки по рахунку
router.get('/reconcile/status', async (req, res) => {
  try {
    const acc = req.query.account_id ? [+req.query.account_id] : [];
    const where = acc.length ? 'WHERE account_id=$1' : '';
    const r = await pool.query(
      `SELECT COUNT(*) FILTER(WHERE reconciled=true)::int reconciled,
              COUNT(*) FILTER(WHERE reconciled=false)::int unreconciled,
              COUNT(*)::int total
       FROM cash_flow_entries ${where}`, acc);
    const imports = await pool.query(
      `SELECT * FROM bank_statement_imports ${where} ORDER BY created_at DESC LIMIT 10`, acc);
    res.json({ stats: r.rows[0], recent_imports: imports.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ════════ ДАШБОРД (підсумок для UI) ════════
router.get('/dashboard', async (req, res) => {
  try {
    const today = kyivToday();
    const monthStart = today.slice(0,8) + '01';
    // баланси рахунків
    const accounts = await pool.query(`SELECT id,name,type,current_balance,min_balance_alert,currency,active FROM bank_accounts ORDER BY sort_order,id`);
    const totalBalance = accounts.rows.filter(a=>a.active).reduce((s,a)=>s+Number(a.current_balance),0);
    // потоки за сьогодні з каси
    const todayFlows = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='in'),0)::numeric t_in,
              COALESCE(SUM(amount) FILTER(WHERE type='out'),0)::numeric t_out
       FROM cash_operations WHERE created_at::date=$1`, [today]);
    // потоки за місяць
    const monthFlows = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='in'),0)::numeric m_in,
              COALESCE(SUM(amount) FILTER(WHERE type='out'),0)::numeric m_out
       FROM cash_operations WHERE created_at::date>=$1`, [monthStart]);
    // найближчі платежі (7 днів)
    await pool.query(`UPDATE payment_calendar SET status='overdue', updated_at=NOW() WHERE status='planned' AND due_date<$1`, [today]);
    const upcoming = await pool.query(
      `SELECT * FROM payment_calendar WHERE status IN ('planned','overdue') AND due_date<=$1 ORDER BY due_date LIMIT 10`,
      [addDays(today,7)]);
    // рахунки нижче порогу
    const alerts = accounts.rows.filter(a=>a.active && a.min_balance_alert!==null && Number(a.current_balance)<Number(a.min_balance_alert));
    res.json({
      total_balance: Math.round(totalBalance),
      accounts: accounts.rows.map(a=>({...a,current_balance:Number(a.current_balance),min_balance_alert:a.min_balance_alert!=null?Number(a.min_balance_alert):null})),
      today: { inflow: Number(todayFlows.rows[0].t_in), outflow: Number(todayFlows.rows[0].t_out), net: Number(todayFlows.rows[0].t_in)-Number(todayFlows.rows[0].t_out) },
      month: { inflow: Number(monthFlows.rows[0].m_in), outflow: Number(monthFlows.rows[0].m_out), net: Number(monthFlows.rows[0].m_in)-Number(monthFlows.rows[0].m_out) },
      upcoming_payments: upcoming.rows,
      balance_alerts: alerts,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
