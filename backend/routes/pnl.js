/* ═══════════════════════════════════════════════════════
   FIN-07 — P&L (Profit & Loss / Звіт про прибутки та збитки)
   Монтується як /api/pnl

   Автоматичний P&L поверх існуючих модулів. НЕ джерело первинних даних —
   агрегує реальні цифри з:
     • виручка послуг   → cash_operations (type=in, category=sale_service)
     • виручка товарів  → orders(status=paid) + cash_operations(sale_product)
     • сертифікати      → gift_certificate_transactions(type=issue)
     • абонементи       → subscriptions × subscription_plans.price (продані в періоді)
     • COGS матеріали   → stock_movements × product_variants.wholesale (списання)
     • ЗП відрядна      → payroll_records.percent_part
     • ЗП оклад/адмін   → payroll_records.fixed_part
     • OpEx по статтях  → cash_operations(type=out) GROUP BY category
     • амортизація/%/податки/поправки → pnl_adjustments (ручні, бо нема в первинці)

   Структура: Виручка → COGS → Валова → OpEx → EBITDA → −Аморт/−%/−Податки → Чистий.
   Кожна стаття має drilldown_query для деталізації до транзакції.

   Усі джерела через safeRows() — відсутня таблиця/колонка НЕ валить звіт (→ 0).
   Права: pnl.read / pnl.drilldown / pnl.margins.read / pnl.config.manage /
   pnl.export / pnl.generate. Owner '*' матчить усе.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');

const pool = getPool();

// safe-обгортка: будь-яка помилка (нема таблиці/колонки) → fallback, звіт не падає
async function safeRows(sql, params = [], fallback = []) {
  try { const r = await pool.query(sql, params); return r.rows; }
  catch (e) { console.warn('[pnl] query skipped:', e.message); return fallback; }
}
const num = (v) => Number(v || 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;
const pctOf = (part, whole) => whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
const errOut = (e) => process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message;

/* ── Межі періоду ────────────────────────────────────────────────────────────
   period_type: month|quarter|year|custom. Повертає {start, end} як YYYY-MM-DD
   ([start, end) — end ексклюзивний, перше число наступного періоду). */
function periodBounds(query) {
  const type = String(query.period_type || 'month').toLowerCase();
  const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  let s = query.period_start ? String(query.period_start).slice(0, 10) : null;
  const now = new Date();
  if (!s) s = fmt(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const sd = new Date(s + 'T00:00:00Z');
  let y = sd.getUTCFullYear(), m = sd.getUTCMonth() + 1, d = sd.getUTCDate();

  if (type === 'custom') {
    const end = query.period_end ? String(query.period_end).slice(0, 10)
      : fmt(y, m, d);
    // end ексклюзивний → +1 день
    const ed = new Date(end + 'T00:00:00Z'); ed.setUTCDate(ed.getUTCDate() + 1);
    return { type, start: s, end: fmt(ed.getUTCFullYear(), ed.getUTCMonth() + 1, ed.getUTCDate()), label: s };
  }
  let endY = y, endM = m;
  if (type === 'year') { const st = fmt(y, 1, 1); return { type, start: st, end: fmt(y + 1, 1, 1), label: `${y}` }; }
  if (type === 'quarter') {
    const q = Math.floor((m - 1) / 3); const qm = q * 3 + 1; const st = fmt(y, qm, 1);
    const ne = qm + 3 > 12 ? { y: y + 1, m: qm + 3 - 12 } : { y, m: qm + 3 };
    return { type, start: st, end: fmt(ne.y, ne.m, 1), label: `${y}-Q${q + 1}` };
  }
  // month (default)
  const st = fmt(y, m, 1);
  const ne = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { type, start: st, end: fmt(ne.y, ne.m, 1), label: `${y}-${String(m).padStart(2, '0')}` };
}

// Попередній період тієї ж довжини (для MoM/тренду)
function prevBounds(b) {
  const s = new Date(b.start + 'T00:00:00Z'), e = new Date(b.end + 'T00:00:00Z');
  const days = Math.round((e - s) / 86400000);
  const ps = new Date(s); ps.setUTCDate(ps.getUTCDate() - days);
  const f = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start: f(ps), end: b.start };
}
// Той самий період торік (для YoY)
function yoyBounds(b) {
  const shift = (ds) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; };
  return { start: shift(b.start), end: shift(b.end) };
}

/* ── branch-фільтр для cash_operations через cash_shifts.branch_id ────────────
   cash_operations не має branch_id напряму — тягнемо через зміну. */
function cashBranchJoin(branchId) {
  if (!branchId) return { join: '', cond: '', params: [] };
  return {
    // LEFT JOIN + OR shift_id IS NULL: операції без зміни (require_open_shift=false, #103)
    // не губляться з філіального звіту. При кількох філіях безсменні операції
    // потраплять у кожну — прийнятно, зараз філія одна.
    join: 'LEFT JOIN cash_shifts cs ON cs.id = co.shift_id',
    cond: ' AND (cs.branch_id = $3 OR co.shift_id IS NULL)',
    params: [branchId],
  };
}

/* ════════════════ АГРЕГАЦІЯ З РЕАЛЬНИХ ДАНИХ ════════════════════════════════ */
// Повертає масив line_items {section, category, label, amount, sort_order, drilldown_query}
async function aggregate(start, end, branchId) {
  const cb = cashBranchJoin(branchId);
  const p = [start, end, ...cb.params];

  // ── REVENUE ───────────────────────────────────────────────────────────────
  // Послуги: cash_operations sale_service
  const svc = await safeRows(
    `SELECT COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='in' AND co.category='sale_service'
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}`, p);
  // Товари: orders(paid) + cash_operations sale_product (роздріб без замовлення)
  // Товары-заказы: только 'paid' — как в едином cash-эталоне (lib/live-finance):
  // выручка = фактически полученные деньги. Гарантирует идентичность P&L и Dashboard.
  const ordRev = await safeRows(
    `SELECT COALESCE(SUM(total),0)::numeric s FROM orders
      WHERE status = 'paid' AND created_at >= $1 AND created_at < $2`, [start, end]);
  const prodCash = await safeRows(
    `SELECT COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='in' AND co.category='sale_product'
        AND co.ref_type IS DISTINCT FROM 'order'
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}`, p);
  // Сертифікати: gift_certificate_transactions issue (продаж/випуск).
  // НЕ виручка, а аванс (зобовʼязання салону): виручка визнається при погашенні,
  // коли послуга пробивається в касу повною ціною (sale_service). Інакше подвійний
  // рахунок: issue + оплата послуги (аудит 02.07 #8). Показуємо довідковим рядком.
  const cert = await safeRows(
    `SELECT COALESCE(SUM(amount),0)::numeric s FROM gift_certificate_transactions
      WHERE type='issue' AND created_at >= $1 AND created_at < $2`, [start, end]);
  // Повернення (сторно продажів при видаленні оплаченого запису, category='refund',
  // type='out'). Для закритих змін оригінальний прихід лишається в касі, а повернення
  // не віднімалось ніде → прибуток завищений (аудит v8, M3). Віднімаємо з виручки.
  const refunds = await safeRows(
    `SELECT COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='out' AND co.category='refund'
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}`, p);
  // Абонементи: виручка = РЕАЛЬНО сплачене в касу (category='sale_subscription':
  // продаж + платежі + продовження + апгрейди). Аудит v6: раніше рахувалось по
  // subscription_plans.price × продані — це (а) двоїло суму з «Іншими доходами», куди
  // sale_subscription теж потрапляв, і (б) додавало ФАНТОМ для trial (безкоштовні,
  // is_trial → фактично 0, але бралась повна ціна плану). Каса визнає рівно факт.
  const subs = await safeRows(
    `SELECT COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='in' AND co.category='sale_subscription'
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}`, p);
  // Інші доходи: cash_operations type=in решта категорій.
  // sale_certificate виключено: продаж сертифіката вже врахований довідковим рядком
  // «Сертифікати (аванси)» з gift_certificate_transactions — інакше та сама сума
  // потрапляла у звіт двічі (і в «Інші доходи», і в рядок сертифікатів).
  const otherIn = await safeRows(
    `SELECT COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='in'
        AND co.category NOT IN ('sale_service','sale_product','sale_certificate','sale_subscription')
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}`, p);

  // ── COGS ──────────────────────────────────────────────────────────────────
  // Матеріали: списання зі складу × оптова ціна
  const mat = await safeRows(
    // знак delta сохраняем (-delta): service-reverse (возврат при unpay) УМЕНЬШАЕТ COGS,
    // иначе цикл unpay→pay считает списание дважды (как в live-finance.js)
    `SELECT COALESCE(SUM(-sm.delta * CASE
              WHEN p.price_per_gram IS NOT NULL AND p.cost_per_gram IS NOT NULL THEN p.cost_per_gram
              WHEN COALESCE(pv.unit_ml,0) > 1 THEN COALESCE(pv.wholesale,0) / pv.unit_ml
              ELSE COALESCE(pv.wholesale,0) END),0)::numeric s
       FROM stock_movements sm JOIN product_variants pv ON pv.id = sm.variant_id
       LEFT JOIN products p ON p.id = pv.product_id
      WHERE (sm.reason IN ('sale','order','consumption','writeoff') OR sm.reason LIKE 'order:%'
             OR sm.reason LIKE 'service:%' OR sm.reason LIKE 'service-reverse:%')
        AND sm.created_at >= $1 AND sm.created_at < $2`, [start, end]);
  // ЗП відрядна (percent_part) — перетин періоду нарахування з [start,end)
  const salPiece = await safeRows(
    `SELECT COALESCE(SUM(percent_part),0)::numeric s FROM payroll_records
      WHERE status IN ('approved','paid') AND period_start < $2 AND period_end >= $1`, [start, end]);

  // ── OPEX ──────────────────────────────────────────────────────────────────
  // ЗП оклад/фікс (fixed_part + bonus − deduction адмін частина)
  const salFixed = await safeRows(
    `SELECT COALESCE(SUM(fixed_part + COALESCE(bonus,0) - COALESCE(deduction,0)),0)::numeric s
       FROM payroll_records
      WHERE status IN ('approved','paid') AND period_start < $2 AND period_end >= $1`, [start, end]);
  // ЗП, проведена через «Підтвердження витрат» (у payroll_records НЕ потрапляє) —
  // касові операції ref_type='expense_confirm' категорії salary (аудит 06.07: випадала з P&L)
  const salConfirmed = await safeRows(
    `SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations
      WHERE type='out' AND category='salary' AND ref_type='expense_confirm'
        AND created_at >= $1 AND created_at < $2`, [start, end]);
  // OpEx-витрати по категоріях cash_operations type=out (крім зарплати — вона з payroll)
  const opexCats = await safeRows(
    `SELECT co.category, COALESCE(SUM(co.amount),0)::numeric s
       FROM cash_operations co ${cb.join}
      WHERE co.type='out' AND co.category NOT IN ('salary','refund','encashment_out')
        AND co.created_at >= $1 AND co.created_at < $2${cb.cond}
      GROUP BY co.category ORDER BY s DESC`, p);

  // ── РУЧНІ КОРИГУВАННЯ (амортизація / % / податки / поправки) ───────────────
  const adj = await safeRows(
    `SELECT section, category, label, COALESCE(SUM(amount),0)::numeric s
       FROM pnl_adjustments
      WHERE period_start < $2 AND period_end >= $1
        AND ($3::int IS NULL OR branch_id IS NULL OR branch_id = $3::int)
      GROUP BY section, category, label`, [start, end, branchId || null]);

  const OPEX_LABELS = {
    rent: 'Оренда', utilities: 'Комунальні послуги', marketing: 'Маркетинг і реклама',
    supplier: 'Закупівлі', supplies: 'Розхідні (госп.)', equipment: 'Закупівля обладнання',
    software: 'Підписки і ПЗ', communication: 'Звʼязок та інтернет', other_out: 'Інші операційні',
  };

  const items = [];
  const add = (section, category, label, amount, sort_order, dq) =>
    items.push({ section, category, label, amount: round2(amount), sort_order, drilldown_query: dq });

  // revenue
  add('revenue', 'services', 'Виручка від послуг', num(svc[0]?.s), 10, { source: 'cash_operations', type: 'in', category: 'sale_service' });
  add('revenue', 'products', 'Виручка від товарів', num(ordRev[0]?.s) + num(prodCash[0]?.s), 20, { source: 'orders+cash_operations', category: 'sale_product' });
  // Сертифікати — довідкова секція 'memo': НЕ входить у total_revenue (summarize
  // рахує лише revenue/cogs/opex/other). Каса не змінюється — це лише подання звіту.
  add('memo', 'certificates', 'Сертифікати (аванси, не входять у виручку)', num(cert[0]?.s), 60, { source: 'gift_certificate_transactions', type: 'issue' });
  add('revenue', 'subscriptions', 'Виручка від абонементів', num(subs[0]?.s), 40, { source: 'subscriptions' });
  add('revenue', 'other_income', 'Інші доходи', num(otherIn[0]?.s), 50, { source: 'cash_operations', type: 'in', category: 'other_in' });
  // повернення — відʼємний потік, зменшує total_revenue (M3)
  if (num(refunds[0]?.s) > 0)
    add('revenue', 'refund', 'Повернення (сторно продажів)', -num(refunds[0]?.s), 55, { source: 'cash_operations', type: 'out', category: 'refund' });
  // cogs
  add('cogs', 'materials', 'Розхідні матеріали', num(mat[0]?.s), 110, { source: 'stock_movements' });
  add('cogs', 'salary_piece', 'Зарплата майстрів (відрядна)', num(salPiece[0]?.s), 120, { source: 'payroll_records', part: 'percent_part' });
  // ЗП, проведена через «Підтвердження витрат» — окремий рядок (у payroll_records її нема; аудит 06.07)
  add('cogs', 'salary_confirmed', 'Зарплата майстрів (через підтвердження)', num(salConfirmed[0]?.s), 121, { source: 'cash_operations', ref_type: 'expense_confirm' });
  // opex: salary fixed
  add('opex', 'salary_fixed', 'Зарплати (оклад + адмін)', num(salFixed[0]?.s), 210, { source: 'payroll_records', part: 'fixed_part' });
  let so = 220;
  for (const c of opexCats) {
    add('opex', c.category, OPEX_LABELS[c.category] || c.category, num(c.s), so, { source: 'cash_operations', type: 'out', category: c.category });
    so += 10;
  }
  // adjustments (other section: depreciation/interest/taxes тощо)
  for (const a of adj) {
    add(a.section || 'other', a.category, a.label, num(a.s), 900, { source: 'pnl_adjustments', category: a.category });
  }
  return items;
}

// Згорнути line_items у підсумки P&L
function summarize(items) {
  const sum = (sec) => items.filter(i => i.section === sec).reduce((a, i) => a + i.amount, 0);
  const total_revenue = round2(sum('revenue'));
  const total_cogs = round2(sum('cogs'));
  const gross_profit = round2(total_revenue - total_cogs);
  const total_opex = round2(sum('opex'));
  const ebitda = round2(gross_profit - total_opex);
  // other-секція: амортизація/проценти/податки (з pnl_adjustments)
  const findOther = (cat) => items.filter(i => i.section === 'other' && i.category === cat).reduce((a, i) => a + i.amount, 0);
  const depreciation = round2(findOther('depreciation'));
  const interest = round2(findOther('interest'));
  const taxes = round2(findOther('taxes'));
  const otherAdj = round2(items.filter(i => i.section === 'other' && !['depreciation', 'interest', 'taxes'].includes(i.category)).reduce((a, i) => a + i.amount, 0));
  const net_profit = round2(ebitda - depreciation - interest - taxes - otherAdj);
  return {
    total_revenue, total_cogs, gross_profit, total_opex, ebitda,
    depreciation, interest, taxes, other_adjustments: otherAdj, net_profit,
    gross_margin: pctOf(gross_profit, total_revenue),
    net_margin: pctOf(net_profit, total_revenue),
  };
}

// Повний звіт за період (line_items + totals)
async function buildReport(b, branchId) {
  const items = await aggregate(b.start, b.end, branchId);
  const totals = summarize(items);
  return { items, totals };
}

/* ════════════════ ROUTES ════════════════════════════════════════════════════ */

// ── GET /api/pnl ── Повний звіт P&L за період ────────────────────────────────
router.get('/', requirePerm('pnl.read'), async (req, res) => {
  try {
    const b = periodBounds(req.query);
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const cur = await buildReport(b, branchId);

    // prev-period suma по кожній статті (для тренду в таблиці)
    let prevMap = {};
    if (req.query.with_prev !== '0') {
      const pb = prevBounds(b);
      const prevItems = await aggregate(pb.start, pb.end, branchId);
      for (const it of prevItems) prevMap[`${it.section}:${it.category}`] = it.amount;
    }
    const line_items = cur.items.map(it => ({
      ...it,
      prev_period_amount: prevMap[`${it.section}:${it.category}`] ?? null,
      trend: (() => {
        const pv = prevMap[`${it.section}:${it.category}`];
        if (pv == null) return null;
        if (it.amount > pv) return 'up';
        if (it.amount < pv) return 'down';
        return 'flat';
      })(),
    }));

    res.json({
      period: { type: b.type, start: b.start, end: b.end, label: b.label },
      branch_id: branchId,
      report: cur.totals,
      line_items,
    });
  } catch (e) { console.error('[pnl] GET /', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/compare ── Порівняння двох періодів (MoM / YoY / довільні) ──
router.get('/compare', requirePerm('pnl.read'), async (req, res) => {
  try {
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const b2 = periodBounds({ period_type: req.query.period_type, period_start: req.query.period2_start || req.query.period_start });
    let b1;
    const mode = String(req.query.mode || '').toLowerCase();
    if (req.query.period1_start) {
      b1 = periodBounds({ period_type: req.query.period_type, period_start: req.query.period1_start });
    } else if (mode === 'yoy') {
      const y = yoyBounds(b2); b1 = { ...b2, start: y.start, end: y.end, label: `${b2.label} (YoY)` };
    } else { // MoM / попередній період тієї ж довжини
      const pb = prevBounds(b2); b1 = { ...b2, start: pb.start, end: pb.end, label: `${b2.label} (prev)` };
    }
    const [r1, r2] = await Promise.all([buildReport(b1, branchId), buildReport(b2, branchId)]);
    const keys = Object.keys(r2.totals);
    const diff = {}, diff_percent = {};
    for (const k of keys) {
      diff[k] = round2(num(r2.totals[k]) - num(r1.totals[k]));
      diff_percent[k] = num(r1.totals[k]) !== 0 ? round2((num(r2.totals[k]) - num(r1.totals[k])) / Math.abs(num(r1.totals[k])) * 100) : (num(r2.totals[k]) ? 100 : 0);
    }
    res.json({
      period1: { period: { start: b1.start, end: b1.end, label: b1.label }, report: r1.totals },
      period2: { period: { start: b2.start, end: b2.end, label: b2.label }, report: r2.totals },
      diff, diff_percent,
    });
  } catch (e) { console.error('[pnl] GET /compare', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/plan-fact ── План (FIN-05 budget) vs Факт по статтях ────────
router.get('/plan-fact', requirePerm('pnl.read'), async (req, res) => {
  try {
    const b = periodBounds(req.query);
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const cur = await buildReport(b, branchId);

    // План: реальні таблиці бюджету FIN-05 (budgets/budget_items/budget_categories).
    // Категорію бюджету розгортаємо в кассові категорії через bc.cashbox_categories (нема мапінгу — беремо name).
    const budget = await safeRows(
      `SELECT cc AS category, COALESCE(SUM(bi.plan_amount),0)::numeric plan
         FROM budget_items bi
         JOIN budgets bg ON bg.id = bi.budget_id
              AND bg.status <> 'archived'
              AND bg.period_start <= $1 AND bg.period_end >= $1
         JOIN budget_categories bc ON bc.id = bi.category_id
         CROSS JOIN LATERAL unnest(
           CASE WHEN COALESCE(array_length(bc.cashbox_categories,1),0) = 0
                THEN ARRAY[bc.name] ELSE bc.cashbox_categories END) cc
        WHERE bi.month = date_trunc('month', $1::date)::date
        GROUP BY cc`, [b.start], []);
    const budgetMap = {};
    for (const r of budget) budgetMap[r.category] = num(r.plan);

    const line_items = cur.items.map(it => {
      const plan = budgetMap[it.category] ?? null;
      const fact = it.amount;
      const d = plan == null ? null : round2(fact - plan);
      const dp = plan ? round2((fact - plan) / Math.abs(plan) * 100) : null;
      // для доходів краще ↑, для витрат краще ↓
      const isRevenue = it.section === 'revenue';
      const status = d == null ? null : ((isRevenue ? d >= 0 : d <= 0) ? 'green' : 'red');
      return { section: it.section, category: it.category, label: it.label, plan, fact, diff: d, diff_percent: dp, status };
    });
    res.json({ period: { start: b.start, end: b.end, label: b.label }, branch_id: branchId, line_items });
  } catch (e) { console.error('[pnl] GET /plan-fact', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/drilldown ── Деталізація статті до транзакцій ───────────────
router.get('/drilldown', requirePerm('pnl.drilldown'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(+req.query.limit || 50, 1), 500);
    const offset = Math.max(+req.query.offset || 0, 0);
    const branchId = req.query.branch_id ? +req.query.branch_id : null;

    // Період: або з report_id (збережений), або з query
    let start, end;
    if (req.query.report_id) {
      const rep = await safeRows(`SELECT to_char(period_start,'YYYY-MM-DD') ps, to_char(period_end,'YYYY-MM-DD') pe, branch_id FROM pnl_reports WHERE id=$1`, [+req.query.report_id]);
      if (!rep.length) return res.status(404).json({ error: 'report not found' });
      start = rep[0].ps; end = rep[0].pe;
    } else {
      const b = periodBounds(req.query); start = b.start; end = b.end;
    }
    const section = req.query.section, category = req.query.category;
    if (!category) return res.status(400).json({ error: 'category required' });

    let transactions = [];
    const cb = cashBranchJoin(branchId);
    const baseP = [start, end, ...cb.params, limit, offset];
    const lo = `LIMIT $${cb.params.length + 3} OFFSET $${cb.params.length + 4}`;

    if (section === 'revenue' && category === 'services') {
      transactions = await safeRows(
        `SELECT co.created_at AS date, COALESCE(co.description,'Послуга') AS description, co.amount, co.method, 'cash_operations' AS source
           FROM cash_operations co ${cb.join}
          WHERE co.type='in' AND co.category='sale_service' AND co.created_at >= $1 AND co.created_at < $2${cb.cond}
          ORDER BY co.created_at DESC ${lo}`, baseP);
    } else if (section === 'revenue' && category === 'products') {
      transactions = await safeRows(
        `SELECT created_at AS date, ('Замовлення #'||id) AS description, total AS amount, payment_method AS method, 'orders' AS source
           FROM orders WHERE status = 'paid' AND created_at >= $1 AND created_at < $2
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (category === 'certificates') { // секція 'memo' (раніше revenue)
      transactions = await safeRows(
        `SELECT created_at AS date, ('Сертифікат GC#'||gc_id) AS description, amount, 'gift' AS method, 'gift_certificate_transactions' AS source
           FROM gift_certificate_transactions WHERE type='issue' AND created_at >= $1 AND created_at < $2
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (section === 'revenue' && category === 'subscriptions') {
      transactions = await safeRows(
        `SELECT su.sold_at AS date, ('Абонемент '||su.subscription_number) AS description, sp.price AS amount, 'subscription' AS method, 'subscriptions' AS source
           FROM subscriptions su JOIN subscription_plans sp ON sp.id=su.plan_id
          WHERE su.status<>'cancelled' AND su.sold_at >= $1 AND su.sold_at < $2
          ORDER BY su.sold_at DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (section === 'cogs' && category === 'materials') {
      transactions = await safeRows(
        `SELECT sm.created_at AS date, (COALESCE(pr.name,'товар')||' ×'||ABS(sm.delta)) AS description,
                (-sm.delta * CASE
                   WHEN pr.price_per_gram IS NOT NULL AND pr.cost_per_gram IS NOT NULL THEN pr.cost_per_gram
                   WHEN COALESCE(pv.unit_ml,0) > 1 THEN COALESCE(pv.wholesale,0) / pv.unit_ml
                   ELSE COALESCE(pv.wholesale,0) END)::numeric AS amount, sm.reason AS method, 'stock_movements' AS source
           FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id
           LEFT JOIN products pr ON pr.id=pv.product_id
          -- тот же фильтр причин, что и в сводке — иначе категория не сходится с итогом
          WHERE (sm.reason IN ('sale','order','consumption','writeoff') OR sm.reason LIKE 'order:%'
                 OR sm.reason LIKE 'service:%' OR sm.reason LIKE 'service-reverse:%')
            AND sm.created_at >= $1 AND sm.created_at < $2
          ORDER BY sm.created_at DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (section === 'cogs' && category === 'salary_piece') {
      transactions = await safeRows(
        `SELECT created_at AS date, (COALESCE(master_name,'майстер')||' (відрядна)') AS description, percent_part AS amount, status AS method, 'payroll_records' AS source
           FROM payroll_records WHERE status IN ('approved','paid') AND period_start < $2 AND period_end >= $1
          ORDER BY period_start DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (section === 'opex' && category === 'salary_fixed') {
      transactions = await safeRows(
        `SELECT created_at AS date, (COALESCE(master_name,'співробітник')||' (оклад)') AS description, (fixed_part + COALESCE(bonus,0) - COALESCE(deduction,0)) AS amount, status AS method, 'payroll_records' AS source
           FROM payroll_records WHERE status IN ('approved','paid') AND period_start < $2 AND period_end >= $1
          ORDER BY period_start DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else if (section === 'other') {
      transactions = await safeRows(
        `SELECT created_at AS date, label AS description, amount, category AS method, 'pnl_adjustments' AS source
           FROM pnl_adjustments WHERE category=$3 AND period_start < $2 AND period_end >= $1
          ORDER BY created_at DESC LIMIT $4 OFFSET $5`, [start, end, category, limit, offset]);
    } else if (section === 'cogs' && category === 'salary_confirmed') {
      // ЗП через «Підтвердження витрат»: реальні рядки мають category='salary' +
      // ref_type='expense_confirm' — загальна гілка шукала category='salary_confirmed'
      // і повертала 0 рядків (аудит v8)
      transactions = await safeRows(
        `SELECT created_at AS date, COALESCE(description,'ЗП (підтвердження)') AS description,
                amount, method, 'cash_operations' AS source
           FROM cash_operations
          WHERE type='out' AND category='salary' AND ref_type='expense_confirm'
            AND created_at >= $1 AND created_at < $2
          ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [start, end, limit, offset]);
    } else {
      // OpEx по категорії з cash_operations (out)
      transactions = await safeRows(
        `SELECT co.created_at AS date, COALESCE(co.description, co.category) AS description, co.amount, co.method, 'cash_operations' AS source
           FROM cash_operations co ${cb.join}
          WHERE co.type='out' AND co.category=$${cb.params.length + 3} AND co.created_at >= $1 AND co.created_at < $2${cb.cond}
          ORDER BY co.created_at DESC LIMIT $${cb.params.length + 4} OFFSET $${cb.params.length + 5}`,
        [start, end, ...cb.params, category, limit, offset]);
    }
    res.json({
      section, category, period: { start, end },
      transactions: transactions.map(t => ({ date: t.date, description: t.description, amount: round2(t.amount), method: t.method, source: t.source })),
      limit, offset,
    });
  } catch (e) { console.error('[pnl] GET /drilldown', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/margins ── Маржинальний аналіз (category|master|branch) ─────
router.get('/margins', requirePerm('pnl.margins.read'), async (req, res) => {
  try {
    const from = req.query.from ? String(req.query.from).slice(0, 10) : periodBounds(req.query).start;
    const to = req.query.to ? String(req.query.to).slice(0, 10) : periodBounds(req.query).end;
    const groupBy = ['category', 'master', 'branch'].includes(req.query.group_by) ? req.query.group_by : 'category';
    let items = [];

    if (groupBy === 'master') {
      // Виручка майстра (appointments done × price) − його ЗП (payroll percent+fixed)
      const rev = await safeRows(
        `SELECT a.master_id AS key, COALESCE(m.name,'майстер #'||a.master_id) AS name,
                COALESCE(SUM(a.price) FILTER (WHERE a.status='done'),0)::numeric revenue
           FROM appointments a LEFT JOIN masters m ON m.id=a.master_id
          WHERE a.starts_at >= $1 AND a.starts_at < $2
          GROUP BY a.master_id, m.name`, [from, to]);
      const pay = await safeRows(
        `SELECT master_id AS key, COALESCE(SUM(percent_part+fixed_part+COALESCE(bonus,0)-COALESCE(deduction,0)),0)::numeric cost
           FROM payroll_records WHERE period_start < $2 AND period_end >= $1 GROUP BY master_id`, [from, to]);
      const payMap = {}; for (const p of pay) payMap[String(p.key)] = num(p.cost);
      items = rev.map(r => {
        const revenue = num(r.revenue), costs = payMap[String(r.key)] || 0, margin = round2(revenue - costs);
        return { key: r.key, name: r.name, revenue: round2(revenue), costs: round2(costs), margin, margin_percent: pctOf(margin, revenue) };
      });
    } else if (groupBy === 'branch') {
      const rows = await safeRows(
        `SELECT cs.branch_id AS key, COALESCE(b.name, CASE WHEN cs.branch_id IS NOT NULL THEN 'філія #'||cs.branch_id ELSE 'Без зміни' END) AS name,
                COALESCE(SUM(co.amount) FILTER (WHERE co.type='in'),0)::numeric revenue,
                COALESCE(SUM(co.amount) FILTER (WHERE co.type='out'),0)::numeric costs
           FROM cash_operations co LEFT JOIN cash_shifts cs ON cs.id=co.shift_id
           LEFT JOIN branches b ON b.id=cs.branch_id
          WHERE co.created_at >= $1 AND co.created_at < $2
          GROUP BY cs.branch_id, b.name`, [from, to]);
      items = rows.map(r => {
        const revenue = num(r.revenue), costs = num(r.costs), margin = round2(revenue - costs);
        return { key: r.key, name: r.name, revenue: round2(revenue), costs: round2(costs), margin, margin_percent: pctOf(margin, revenue) };
      });
    } else {
      // category: маржа по категоріях послуг (services.category) — виручка − матеріали (грубо нема прив'язки матеріалів до послуги, тому costs=0 безпечно)
      const rows = await safeRows(
        `SELECT COALESCE(s.category,'інше') AS name,
                COALESCE(SUM(a.price) FILTER (WHERE a.status='done'),0)::numeric revenue,
                COUNT(*) FILTER (WHERE a.status='done')::int cnt
           FROM appointments a LEFT JOIN services s ON s.id=a.service_id
          WHERE a.starts_at >= $1 AND a.starts_at < $2
          GROUP BY s.category ORDER BY revenue DESC`, [from, to]);
      items = rows.map(r => {
        const revenue = num(r.revenue), costs = 0, margin = round2(revenue - costs);
        return { name: r.name, count: r.cnt, revenue: round2(revenue), costs, margin, margin_percent: pctOf(margin, revenue) };
      });
    }
    // ранжування: найприбутковіші зверху
    items.sort((a, b) => b.margin - a.margin);
    res.json({ from, to, group_by: groupBy, items });
  } catch (e) { console.error('[pnl] GET /margins', e); res.status(500).json({ error: errOut(e) }); }
});

// ── POST /api/pnl/generate ── Примусова генерація + збереження знімка ────────
router.post('/generate', requirePerm('pnl.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const b = periodBounds({ period_type: body.period_type, period_start: body.period_start, period_end: body.period_end });
    const branchId = body.branch_id ? +body.branch_id : null;
    const { items, totals } = await buildReport(b, branchId);

    // upsert pnl_reports
    const rep = await pool.query(
      `INSERT INTO pnl_reports (branch_id, period_type, period_start, period_end,
          total_revenue, total_cogs, gross_profit, total_opex, ebitda,
          depreciation, interest, taxes, net_profit, gross_margin, net_margin, generated_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())
       ON CONFLICT (branch_id, period_type, period_start) DO UPDATE SET
          period_end=EXCLUDED.period_end, total_revenue=EXCLUDED.total_revenue, total_cogs=EXCLUDED.total_cogs,
          gross_profit=EXCLUDED.gross_profit, total_opex=EXCLUDED.total_opex, ebitda=EXCLUDED.ebitda,
          depreciation=EXCLUDED.depreciation, interest=EXCLUDED.interest, taxes=EXCLUDED.taxes,
          net_profit=EXCLUDED.net_profit, gross_margin=EXCLUDED.gross_margin, net_margin=EXCLUDED.net_margin,
          generated_at=now(), updated_at=now()
       RETURNING id`,
      [branchId, b.type, b.start, b.end, totals.total_revenue, totals.total_cogs, totals.gross_profit,
       totals.total_opex, totals.ebitda, totals.depreciation, totals.interest, totals.taxes,
       totals.net_profit, totals.gross_margin, totals.net_margin]);
    const reportId = rep.rows[0].id;

    // refresh line_items
    await pool.query(`DELETE FROM pnl_line_items WHERE report_id=$1`, [reportId]);
    for (const it of items) {
      await pool.query(
        `INSERT INTO pnl_line_items (report_id, section, category, label, amount, sort_order, drilldown_query)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [reportId, it.section, it.category, it.label, it.amount, it.sort_order, JSON.stringify(it.drilldown_query || {})]);
    }
    res.json({ ok: true, report_id: reportId, period: { type: b.type, start: b.start, end: b.end }, report: totals, line_items_count: items.length });
  } catch (e) { console.error('[pnl] POST /generate', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/config ── Конфіг структури P&L ─────────────────────────────
router.get('/config', requirePerm('pnl.read'), async (req, res) => {
  try {
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const rows = await safeRows(
      `SELECT * FROM pnl_config WHERE branch_id IS NOT DISTINCT FROM $1 ORDER BY id LIMIT 1`, [branchId]);
    if (!rows.length && branchId) {
      const glob = await safeRows(`SELECT * FROM pnl_config WHERE branch_id IS NULL ORDER BY id LIMIT 1`);
      return res.json(glob[0] || { line_items_config: [], auto_generate: true });
    }
    res.json(rows[0] || { line_items_config: [], auto_generate: true });
  } catch (e) { console.error('[pnl] GET /config', e); res.status(500).json({ error: errOut(e) }); }
});

// ── PUT /api/pnl/config ── Оновити конфіг ───────────────────────────────────
router.put('/config', requirePerm('pnl.config.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const branchId = body.branch_id ? +body.branch_id : null;
    const r = await pool.query(
      `INSERT INTO pnl_config (branch_id, line_items_config, auto_generate, auto_generate_day, auto_send_to, updated_at)
       VALUES ($1, COALESCE($2::jsonb,'[]'::jsonb), COALESCE($3,true), COALESCE($4,1), COALESCE($5::int[],'{}'), now())
       ON CONFLICT (branch_id) DO UPDATE SET
         line_items_config=COALESCE(EXCLUDED.line_items_config, pnl_config.line_items_config),
         auto_generate=EXCLUDED.auto_generate, auto_generate_day=EXCLUDED.auto_generate_day,
         auto_send_to=EXCLUDED.auto_send_to, updated_at=now()
       RETURNING *`,
      [branchId,
       body.line_items_config != null ? JSON.stringify(body.line_items_config) : null,
       body.auto_generate, body.auto_generate_day,
       Array.isArray(body.auto_send_to) ? body.auto_send_to : null]);
    res.json({ ok: true, config: r.rows[0] });
  } catch (e) { console.error('[pnl] PUT /config', e); res.status(500).json({ error: errOut(e) }); }
});

// ── POST /api/pnl/export ── Експорт CSV (Excel-сумісний) / JSON (для PDF) ────
router.post('/export', requirePerm('pnl.export'), async (req, res) => {
  try {
    const body = req.body || {};
    const format = String(body.format || 'xlsx').toLowerCase();
    let b, branchId = body.branch_id ? +body.branch_id : null, totals, items;

    if (body.report_id) {
      const rep = await safeRows(`SELECT * FROM pnl_reports WHERE id=$1`, [+body.report_id]);
      if (!rep.length) return res.status(404).json({ error: 'report not found' });
      const r = rep[0]; branchId = r.branch_id;
      b = { type: r.period_type, start: String(r.period_start).slice(0, 10), end: String(r.period_end).slice(0, 10), label: String(r.period_start).slice(0, 10) };
      totals = {
        total_revenue: num(r.total_revenue), total_cogs: num(r.total_cogs), gross_profit: num(r.gross_profit),
        total_opex: num(r.total_opex), ebitda: num(r.ebitda), depreciation: num(r.depreciation),
        interest: num(r.interest), taxes: num(r.taxes), net_profit: num(r.net_profit),
        gross_margin: num(r.gross_margin), net_margin: num(r.net_margin),
      };
      items = await safeRows(`SELECT section, category, label, amount, sort_order FROM pnl_line_items WHERE report_id=$1 ORDER BY sort_order`, [+body.report_id]);
    } else {
      b = periodBounds({ period_type: body.period_type, period_start: body.period_start, period_end: body.period_end });
      const built = await buildReport(b, branchId);
      totals = built.totals; items = built.items;
    }

    if (format === 'json' || format === 'pdf') {
      // JSON-структура — фронт/PDF-генератор (INF-10) рендерить фірмовий шаблон
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="pnl-${b.label}.json"`);
      return res.send(JSON.stringify({ title: 'P&L (Звіт про прибутки та збитки)', period: b, branch_id: branchId, report: totals, line_items: items }, null, 2));
    }

    // CSV (Excel-сумісний, з BOM для кирилиці)
    const SECTION_LABELS = { revenue: 'ВИРУЧКА', cogs: 'СОБІВАРТІСТЬ', opex: 'ОПЕРАЦІЙНІ ВИТРАТИ', other: 'ІНШЕ' };
    const esc = (v) => { const s = String(v == null ? '' : v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = ['Секція;Стаття;Сума'];
    let curSec = null;
    for (const it of items) {
      if (it.section !== curSec) { curSec = it.section; lines.push(`${esc(SECTION_LABELS[curSec] || curSec)};;`); }
      lines.push(`;${esc(it.label)};${round2(it.amount)}`);
    }
    lines.push('');
    lines.push(`ВИРУЧКА (Revenue);;${totals.total_revenue}`);
    lines.push(`СОБІВАРТІСТЬ (COGS);;${totals.total_cogs}`);
    lines.push(`ВАЛОВА ПРИБУТОК (Gross Profit);;${totals.gross_profit}`);
    lines.push(`ОПЕРАЦІЙНІ ВИТРАТИ (OpEx);;${totals.total_opex}`);
    lines.push(`EBITDA;;${totals.ebitda}`);
    lines.push(`Амортизація;;${totals.depreciation}`);
    lines.push(`Проценти;;${totals.interest}`);
    lines.push(`Податки;;${totals.taxes}`);
    lines.push(`ЧИСТИЙ ПРИБУТОК (Net Profit);;${totals.net_profit}`);
    lines.push(`Валова маржа %;;${totals.gross_margin}`);
    lines.push(`Чиста маржа %;;${totals.net_margin}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pnl-${b.label}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { console.error('[pnl] POST /export', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/summary ── Коротка зведення (для віджета FIN-04 / Telegram) ─
router.get('/summary', requirePerm('pnl.read'), async (req, res) => {
  try {
    const b = periodBounds(req.query);
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const cur = await buildReport(b, branchId);
    const pb = prevBounds(b);
    const prev = await buildReport(pb, branchId);
    const change = (c, p) => p !== 0 ? round2((c - p) / Math.abs(p) * 100) : (c ? 100 : 0);
    res.json({
      period: { start: b.start, end: b.end, label: b.label },
      revenue: cur.totals.total_revenue,
      expenses: round2(cur.totals.total_cogs + cur.totals.total_opex),
      net_profit: cur.totals.net_profit,
      net_margin: cur.totals.net_margin,
      vs_prev: {
        revenue_pct: change(cur.totals.total_revenue, prev.totals.total_revenue),
        net_profit_pct: change(cur.totals.net_profit, prev.totals.net_profit),
      },
    });
  } catch (e) { console.error('[pnl] GET /summary', e); res.status(500).json({ error: errOut(e) }); }
});

// ── GET /api/pnl/reports ── Список збережених знімків ───────────────────────
router.get('/reports', requirePerm('pnl.read'), async (req, res) => {
  try {
    const branchId = req.query.branch_id ? +req.query.branch_id : null;
    const rows = await safeRows(
      `SELECT id, branch_id, period_type, to_char(period_start,'YYYY-MM-DD') period_start,
              to_char(period_end,'YYYY-MM-DD') period_end, total_revenue, net_profit, net_margin, generated_at
         FROM pnl_reports
        WHERE ($1::int IS NULL OR branch_id IS NOT DISTINCT FROM $1::int)
        ORDER BY period_start DESC LIMIT 60`, [branchId]);
    res.json({ reports: rows });
  } catch (e) { console.error('[pnl] GET /reports', e); res.status(500).json({ error: errOut(e) }); }
});

module.exports = router;
