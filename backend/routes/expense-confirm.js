/* routes/expense-confirm.js — Підтвердження витрат.
   Адмін бачить нараховані витрати за період (ЗП по майстрах + постійні), підтверджує/коригує
   суму — і вона проводиться в касу. Нагадування 1/15/кінець місяця (тік у shop-api).
   Доступ: GET reports.read, мутації reports.finance. */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { COMMISSION_EXPR } = require('../lib/payroll-base');

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
    // ВАЖЛИВО: помилку SQL не ковтаємо мовчки — логуємо (інакше блок тихо порожніє, кейс 06.07)
    const q = (sql, a = []) => pool.query(sql, a).then(r => r.rows)
      .catch(e => { console.error('[expense-confirm/pending] SQL:', e.message); return []; });
    const [salary, sales, recurring, confirmed] = await Promise.all([
      // нарахована ЗП по майстрах. ПОКАЗУЄМО ВСІХ активних майстрів, що мали візити
      // за період — навіть без схеми начислення (інакше майстер зникає зі списку й
      // власник його не бачить: фідбек #144 — Евеліна/Настя не відображались).
      // Для percent/hybrid рахуємо суму; без схеми amount=0 → власник вписує вручну.
      q(`WITH matlines AS (
            -- сума рядків-МАТЕРІАЛІВ по візиту. Рядок = матеріал, якщо в назві є «матеріал»
            -- і немає «без»/«врахуванн» (щоб не сплутати з «...без врахування матеріалів» — це робота).
            SELECT asv.appointment_id aid,
                   SUM(asv.price) FILTER (WHERE (LOWER(COALESCE(sc.name,'')) ~ 'матер[іи]ал'
                     AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%без%' AND LOWER(COALESCE(sc.name,'')) NOT LIKE '%врахуванн%')) mat
              FROM appointment_services asv LEFT JOIN services sc ON sc.id=asv.service_id
             GROUP BY asv.appointment_id),
          da AS (
            -- net-база візиту = ФАКТИЧНО СПЛАЧЕНЕ за послуги мінус рядки-матеріали.
            -- Це автоматично враховує знижки (сплачено менше → база менша) і віддає салону матеріали.
            SELECT a.master_id,
                   GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0)) rev_labor,
                   COALESCE(a.real_amount,a.price,0) rev_full,
                   (a.starts_at AT TIME ZONE 'Europe/Kiev')::date day_kyiv
              FROM appointments a LEFT JOIN matlines ml ON ml.aid=a.id
             WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
               AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))),
          rev AS (SELECT master_id, SUM(rev_labor) rev_labor, SUM(rev_full) rev_full,
                         COUNT(DISTINCT day_kyiv) work_days FROM da GROUP BY master_id)
          SELECT DISTINCT ON (m.id) m.id, m.name, ps.percent, ps.scheme_type, ps.percent_base,
                 ps.fixed_per_month, ps.fixed_per_day, COALESCE(rev.work_days,0)::int work_days,
                 COALESCE(rev.rev_labor,0)::numeric services_revenue,
                 COALESCE(rev.rev_full,0)::numeric services_full,
                 (COALESCE(rev.rev_full,0)-COALESCE(rev.rev_labor,0))::numeric materials_cost,
                 ROUND((${COMMISSION_EXPR('COALESCE(rev.rev_labor,0)', 'COALESCE(rev.rev_full,0)')})::numeric, 2) amount
            FROM rev JOIN masters m ON m.id=rev.master_id
            LEFT JOIN payroll_schemes ps ON ps.master_id=rev.master_id::text AND ps.is_active=TRUE
           WHERE m.active=TRUE OR ps.scheme_type IS NOT NULL -- звільнені зі схемою видно в минулих періодах
           ORDER BY m.id, ps.updated_at DESC NULLS LAST -- DISTINCT ON: одна (свіжа) схема на майстра, дубль не задвоює суму
           `, [p.from, p.to]),
      // % З ПРОДАЖУ ПРОДУКЦІЇ (правило Босса 05-06.07): банки у візитах по ПРОДАВЦЮ
      // (seller_master_id, інакше майстер візиту) + роздрібні POS-продажі майстра.
      // Фарба за грам = розхідник, % не дає. Адміни не зʼявляються (нема їх master_id).
      q(`WITH bottles AS (
            SELECT COALESCE(am.seller_master_id, a.master_id) AS mid,
                   SUM(ROUND(am.qty_used * pv.price, 2)) AS rev
              FROM appointment_materials am
              JOIN appointments a ON a.id = am.appointment_id
              JOIN product_variants pv ON pv.id = am.variant_id
              LEFT JOIN products p ON p.id = pv.product_id
              LEFT JOIN categories c ON c.id = p.category_id
             WHERE p.price_per_gram IS NULL AND pv.price IS NOT NULL
               AND a.status IN ('done','completed')
               AND a.starts_at BETWEEN $1 AND $2
               AND COALESCE(c.commissionable, TRUE) = TRUE
               -- Банка/ампула = товар. За замовчуванням % іде МАЙСТРУ ВІЗИТУ (COALESCE seller→master).
               -- Продавця вказують лише коли продав хтось інший (правило Власника 06.07). Фарба за грам — розхідник, не тут.
             GROUP BY 1),
          pos AS (
            SELECT co.master_id AS mid, SUM(co.amount) AS rev FROM cash_operations co
             WHERE co.type='in' AND co.category='sale_product' AND co.ref_type IS NULL
               AND co.master_id IS NOT NULL AND co.created_at BETWEEN $1 AND $2
             GROUP BY 1),
          tot AS (SELECT mid, SUM(rev) AS rev FROM (SELECT * FROM bottles UNION ALL SELECT * FROM pos) t GROUP BY 1)
          SELECT m.id, m.name, tot.rev::numeric AS sales_revenue,
                 MAX(ps.sales_commission_pct)::numeric AS sales_pct,
                 ROUND(tot.rev * COALESCE(ps.sales_commission_pct,0) / 100, 2)::numeric AS amount
            FROM tot JOIN masters m ON m.id = tot.mid
            LEFT JOIN payroll_schemes ps ON ps.master_id = m.id::text AND ps.is_active = TRUE
           WHERE COALESCE(ps.sales_commission_pct, 0) > 0
           GROUP BY m.id, m.name, tot.rev, ps.sales_commission_pct`, [p.from, p.to]),
      q(`SELECT id, category, amount, description, day_of_month FROM recurring_expenses WHERE active=TRUE ORDER BY category`),
      q(`SELECT ref_key, amount_paid, confirmed_at FROM expense_confirmations WHERE period=$1`, [p.period]),
    ]);
    const cmap = {}; confirmed.forEach(c => { cmap[c.ref_key] = c; });
    const salesMap = {}; sales.forEach(s => { salesMap[s.id] = s; });
    const salaryItems = salary.map(s => {
      const key = `salary:${s.id}:${p.period}`;
      const sl = salesMap[s.id]; delete salesMap[s.id];
      const salesPart = sl ? Number(sl.amount) : 0;
      const noScheme = s.scheme_type == null; // немає схеми начислення → сума не порахована автоматично
      const isNet = s.percent_base === 'net';
      const baseLbl = isNet ? ` за вирах. матеріалів` : '';
      // фікс-частина (оклад/ставка за зміну) — раніше не входила в нарахування взагалі (аудит 06.07).
      // Ставка за зміну × фактично відпрацьовані дні періоду (дні з візитами).
      const fixedPart = (s.scheme_type === 'fixed' || s.scheme_type === 'hybrid')
        ? (Number(s.fixed_per_month) || +(Number(s.fixed_per_day || 0) * Number(s.work_days || 0)).toFixed(2))
        : 0;
      return { kind: 'salary', ref_key: key, label: `ЗП ${s.name}${s.percent != null ? ` (${s.percent}%${baseLbl})` : ''}`,
        master_id: s.id, amount_calc: +(Number(s.amount) + salesPart + fixedPart).toFixed(2),
        services_part: Number(s.amount), sales_part: salesPart, fixed_part: fixedPart,
        services_revenue: Number(s.services_revenue || 0), materials_cost: Number(s.materials_cost || 0),
        percent_base: s.percent_base || 'gross', no_scheme: noScheme,
        sales_revenue: sl ? Number(sl.sales_revenue) : 0, sales_pct: sl ? Number(sl.sales_pct) : null,
        confirmed: !!cmap[key], amount_paid: cmap[key] ? Number(cmap[key].amount_paid) : null };
    });
    // майстри, у яких Є продажі, але немає послуг за період (продали з вітрини) — окремий рядок ЗП
    for (const s of Object.values(salesMap)) {
      const key = `salary:${s.id}:${p.period}`;
      salaryItems.push({ kind: 'salary', ref_key: key, label: `ЗП ${s.name} (продажі)`,
        master_id: s.id, amount_calc: Number(s.amount), services_part: 0, sales_part: Number(s.amount),
        sales_revenue: Number(s.sales_revenue), sales_pct: Number(s.sales_pct),
        confirmed: !!cmap[key], amount_paid: cmap[key] ? Number(cmap[key].amount_paid) : null });
    }
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
    await client.query('BEGIN'); await applyTenant(client); // RLS: ручний client без applyTenant бачив/писав чужих тенантів (аудит 06.07)
    // захист від ПОДВІЙНОЇ виплати: ця ж ЗП могла бути вже виплачена через «Розрахувати зарплату» (payroll_records)
    if (b.kind === 'salary' && b.master_id && b.period) {
      const dup = await client.query(
        `SELECT 1 FROM payroll_records WHERE master_id=$1::text AND status='paid'
          AND TO_CHAR(period_start,'YYYY-MM')=$2 LIMIT 1`, [String(b.master_id), b.period]);
      if (dup.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'already_paid_via_payroll',
          message: 'ЗП цього майстра за цей місяць уже виплачена через «Розрахувати зарплату». Не проводьте двічі.' });
      }
    }
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
    await client.query('BEGIN'); await applyTenant(client); // RLS-ізоляція (аудит 06.07)
    const r = await client.query('DELETE FROM expense_confirmations WHERE ref_key=$1 RETURNING cash_op_id', [req.params.refkey]);
    if (r.rows[0] && r.rows[0].cash_op_id) await client.query('DELETE FROM cash_operations WHERE id=$1', [r.rows[0].cash_op_id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

module.exports = router;
