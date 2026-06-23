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

module.exports = router;
