/* routes/expense-confirm.js — Підтвердження витрат.
   Адмін бачить нараховані витрати за період (ЗП по майстрах + постійні), підтверджує/коригує
   суму — і вона проводиться в касу. Нагадування 1/15/кінець місяця (тік у shop-api).
   Доступ: GET reports.read, мутації reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'reports.read' : 'reports.finance';
  return requirePerm(perm)(req, res, next);
});

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function periodOf(req) {
  const today = kyivToday();
  const dRe = /^\d{4}-\d{2}-\d{2}$/;
  const fromD = (req.query.from && dRe.test(req.query.from)) ? req.query.from : today.slice(0, 8) + '01';
  const toD = (req.query.to && dRe.test(req.query.to)) ? req.query.to : today;
  return { fromD, toD, period: fromD.slice(0, 7), from: `${fromD} 00:00:00+03`, to: `${toD} 23:59:59+03` };
}

// GET /pending?from=&to= — список витрат до підтвердження за період
router.get('/pending', async (req, res) => {
  try {
    const p = periodOf(req);
    const q = (sql, a = []) => pool.query(sql, a).then(r => r.rows).catch(() => []);
    const [salary, recurring, confirmed] = await Promise.all([
      // нарахована ЗП по майстрах (виручка×% схеми, лише за послуги що пройшли)
      q(`WITH da AS (SELECT a.master_id, COALESCE(a.real_amount,a.price,0) rev FROM appointments a
            WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
              AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL)))
          SELECT m.id, m.name, MAX(ps.percent) percent,
                 ROUND(SUM(CASE WHEN ps.scheme_type IN ('percent','hybrid') THEN da.rev*COALESCE(ps.percent,0)/100 ELSE 0 END))::numeric amount
            FROM da JOIN masters m ON m.id=da.master_id
            LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE
           GROUP BY m.id, m.name
          HAVING SUM(CASE WHEN ps.scheme_type IN ('percent','hybrid') THEN da.rev*COALESCE(ps.percent,0)/100 ELSE 0 END) > 0
           ORDER BY amount DESC`, [p.from, p.to]),
      q(`SELECT id, category, amount, description, day_of_month FROM recurring_expenses WHERE active=TRUE ORDER BY category`),
      q(`SELECT ref_key, amount_paid, confirmed_at FROM expense_confirmations WHERE period=$1`, [p.period]),
    ]);
    const cmap = {}; confirmed.forEach(c => { cmap[c.ref_key] = c; });
    const salaryItems = salary.map(s => {
      const key = `salary:${s.id}:${p.period}`;
      return { kind: 'salary', ref_key: key, label: `ЗП ${s.name}${s.percent != null ? ` (${s.percent}%)` : ''}`,
        master_id: s.id, amount_calc: Number(s.amount), confirmed: !!cmap[key], amount_paid: cmap[key] ? Number(cmap[key].amount_paid) : null };
    });
    const recItems = recurring.map(r => {
      const key = `recurring:${r.id}:${p.period}`;
      const lbl = { rent: 'Оренда', utilities: 'Комуналка', marketing: 'Маркетинг' }[r.category] || r.category;
      return { kind: 'recurring', ref_key: key, label: `${lbl}${r.description ? ' · ' + r.description : ''}`,
        amount_calc: Number(r.amount), confirmed: !!cmap[key], amount_paid: cmap[key] ? Number(cmap[key].amount_paid) : null };
    });
    const all = [...salaryItems, ...recItems];
    res.json({
      period: { from: p.fromD, to: p.toD, ym: p.period },
      items: all,
      summary: {
        total_calc: all.reduce((a, x) => a + x.amount_calc, 0),
        total_confirmed: all.filter(x => x.confirmed).reduce((a, x) => a + (x.amount_paid || 0), 0),
        pending_count: all.filter(x => !x.confirmed).length,
      },
    });
  } catch (e) { console.error('[expense-confirm/pending]', e); res.status(500).json({ error: e.message }); }
});

// POST /confirm — підтвердити/провести витрату. body: {kind, ref_key, label, amount, period, category, master_id}
router.post('/confirm', async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.ref_key || !(Number(b.amount) > 0)) return res.status(400).json({ error: 'ref_key і amount обовʼязкові' });
    await client.query('BEGIN');
    // ідемпотентність: якщо вже підтверджено — повертаємо існуюче
    const ex = await client.query('SELECT * FROM expense_confirmations WHERE ref_key=$1 FOR UPDATE', [b.ref_key]);
    if (ex.rows[0]) { await client.query('COMMIT'); return res.json({ ok: true, already: true, confirmation: ex.rows[0] }); }
    const cat = b.kind === 'salary' ? 'salary' : (b.category || 'other');
    const desc = (b.label || 'Витрата') + ` (підтв. ${b.period || ''})`;
    const op = await client.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, master_id, description)
       VALUES (NULL,'out',$1,$2,'cash','expense_confirm',$3,$4) RETURNING id`,
      [cat, Number(b.amount), b.master_id || null, desc]);
    const conf = await client.query(
      `INSERT INTO expense_confirmations (kind, ref_key, period, label, amount_calc, amount_paid, cash_op_id, confirmed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.kind || 'other', b.ref_key, b.period || kyivToday().slice(0, 7), b.label || null,
       b.amount_calc != null ? Number(b.amount_calc) : null, Number(b.amount), op.rows[0].id,
       (req.staff && req.staff.name) || (req.user && req.user.display_name) || null]);
    await client.query('COMMIT');
    res.json({ ok: true, confirmation: conf.rows[0] });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('[expense-confirm/confirm]', e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// DELETE /confirm/:refkey — скасувати підтвердження (прибрати касову операцію)
router.delete('/confirm/:refkey(*)', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('DELETE FROM expense_confirmations WHERE ref_key=$1 RETURNING cash_op_id', [req.params.refkey]);
    if (r.rows[0] && r.rows[0].cash_op_id) await client.query('DELETE FROM cash_operations WHERE id=$1', [r.rows[0].cash_op_id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

module.exports = router;
