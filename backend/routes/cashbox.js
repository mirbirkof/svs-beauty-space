/* Cashbox: смены, операции, Z-отчёт.
   Финансовый учёт салона — приход/расход кассы по сменам.
   Подключается как /api/cashbox в shop-api.js */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, hasPermission } = require('../lib/rbac');
const { branchAndClause } = require('../lib/branch-scope');
const { liveFinance } = require('../lib/live-finance');
const { getSetting, setSetting } = require('../lib/settings');
const router = express.Router();
const pool = getPool();

// Преднабір статей (ключі) — усе інше вважаємо «своєю» статтею і запам'ятовуємо,
// щоб наступного разу вона була у випадайці (а не вписувалась щоразу заново — заметка #75).
const FIN_PRESET_KEYS = new Set([
  'sale_service', 'sale_product', 'prepayment', 'return', 'encashment_in', 'other_in',
  'salary', 'payroll', 'supplier', 'rent', 'utilities', 'refund', 'encashment_out', 'other_out',
]);
async function rememberCustomCat(type, category) {
  try {
    if (!category || FIN_PRESET_KEYS.has(category)) return;
    const cat = String(category).trim();
    if (!cat || cat === '__custom__') return;
    const cur = (await getSetting('fin_custom_cats', { in: [], out: [] })) || { in: [], out: [] };
    const list = Array.isArray(cur[type]) ? cur[type] : [];
    if (!list.some((x) => String(x).toLowerCase() === cat.toLowerCase())) {
      list.push(cat);
      cur[type] = list;
      await setSetting('fin_custom_cats', cur);
    }
  } catch (e) { console.error('rememberCustomCat', e.message); }
}
// Дата операції з тіла запиту → timestamptz на полудень за Києвом (щоб TZ-зсув не
// перекидав операцію на сусідній день). Дозволяє ставити витрату «заднім числом» (#72).
function opDateParam(body) {
  const d = body && body.date;
  return (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? `${d} 12:00:00+03` : null;
}

// Авторизация: read на GET, write на мутации
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'cashbox.read' : 'cashbox.write';
  return requirePerm(perm)(req, res, next);
});

// доступ к истории/агрегатам кассы (прошлые смены, Z-отчёты, налоги).
// admin по умолчанию НЕ имеет — видит только сегодняшнюю кассу.
// owner ('*') и роли с 'cashbox.history' — видят всё.
function requireHistory(req, res, next) {
  if (hasPermission(req.user?.permissions || [], 'cashbox.history')) return next();
  return res.status(403).json({ error: 'forbidden', need: 'cashbox.history',
    message: 'Перегляд історії та фінансової статистики доступний лише власнику' });
}

// ── helpers ────────────────────────────────────────────
async function getOpenShift(branchId) {
  const r = await pool.query(
    `SELECT * FROM cash_shifts WHERE status='open' AND (branch_id=$1 OR $1 IS NULL) ORDER BY opened_at DESC LIMIT 1`,
    [branchId || null]
  );
  return r.rows[0] || null;
}

async function recalcShiftTotals(shiftId) {
  const r = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN type='in' THEN amount ELSE 0 END),0) AS total_in,
       COALESCE(SUM(CASE WHEN type='out' THEN amount ELSE 0 END),0) AS total_out,
       COALESCE(SUM(CASE WHEN type='in' AND method='cash' THEN amount ELSE 0 END),0) AS cash_in,
       COALESCE(SUM(CASE WHEN type='out' AND method='cash' THEN amount ELSE 0 END),0) AS cash_out
     FROM cash_operations WHERE shift_id=$1`,
    [shiftId]
  );
  return r.rows[0];
}

// ── SHIFTS ─────────────────────────────────────────────

// POST /api/cashbox/shifts/open — открыть смену
router.post('/shifts/open', async (req, res) => {
  try {
    const { branch_id, opened_by, opening_cash, notes } = req.body || {};
    const existing = await getOpenShift(branch_id);
    if (existing) return res.status(409).json({ error: 'shift-already-open', shift: existing });
    const r = await pool.query(
      `INSERT INTO cash_shifts (branch_id, opened_by, opening_cash, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [branch_id || null, opened_by || null, opening_cash || 0, notes || null]
    );
    res.json({ ok: true, shift: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/shifts/current — текущая открытая
router.get('/shifts/current', async (req, res) => {
  try {
    const branchId = req.query.branch_id ? Number(req.query.branch_id) : null;
    const shift = await getOpenShift(branchId);
    if (!shift) return res.json({ shift: null });
    const totals = await recalcShiftTotals(shift.id);
    const expected = Number(shift.opening_cash) + Number(totals.cash_in) - Number(totals.cash_out);
    res.json({ shift, totals, expected_cash: expected });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/today?date=YYYY-MM-DD — зведення каси за день (готівка/безготівка/разом)
// Без date — поточний день (доступно адміну). З date в минулому — лише власник (історія).
router.get('/today', async (req, res) => {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const reqDate = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : todayStr;
    // минулі/майбутні дні — це історія, доступна лише власнику (cashbox.history)
    if (reqDate !== todayStr && !hasPermission(req.user?.permissions || [], 'cashbox.history')) {
      return res.status(403).json({ error: 'forbidden', need: 'cashbox.history',
        message: 'Каса за минулі дні доступна лише власнику' });
    }
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN type='in'  AND method='cash' THEN amount ELSE 0 END),0)::float AS cash,
         COALESCE(SUM(CASE WHEN type='in'  AND method<>'cash' THEN amount ELSE 0 END),0)::float AS cashless,
         COALESCE(SUM(CASE WHEN type='in'  THEN amount ELSE 0 END),0)::float AS total_in,
         COALESCE(SUM(CASE WHEN type='out' THEN amount ELSE 0 END),0)::float AS total_out,
         COUNT(*) FILTER (WHERE type='in')::int AS ops_in
       FROM cash_operations
       WHERE created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 day')`,
      [reqDate]
    );
    const row = r.rows[0];
    res.json({
      date: reqDate,
      cash: row.cash,
      cashless: row.cashless,
      total: row.total_in,            // загальна каса за день (прихід)
      total_out: row.total_out,
      net: row.total_in - row.total_out,
      ops_in: row.ops_in,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Людські назви категорій операцій (DIKIDI-style)
const FIN_CAT_LABELS = {
  sale_service: 'Послуги', sale_product: 'Продажі товарів', prepayment: 'Передоплата',
  return: 'Повернення коштів', encashment_in: 'Внесення в касу', other_in: 'Інші надходження',
  salary: 'Виплата зарплати', supplier: 'Товари / постачальники', rent: 'Оренда',
  utilities: 'Комунальні послуги', refund: 'Повернення клієнту', encashment_out: 'Інкасація',
  other_out: 'Інші витрати',
};

// GET /api/cashbox/finance?from=YYYY-MM-DD&to=YYYY-MM-DD — фінансовий огляд (DIKIDI-style)
// Залишок на початок + Доходи/Витрати за категоріями + залишок на кінець + операції.
// Доступ — лише власник (cashbox.history): це загальна фінансова статистика.
router.get('/finance', requireHistory, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let { from, to } = req.query;
    if (!from) from = today.slice(0, 8) + '01';   // початок поточного місяця
    if (!to) to = today;
    const params = [from, to];

    // залишок на початок: усі in − out до дати from (розділ готівка / безготівка)
    const open = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN method='cash'  AND type='in' THEN amount WHEN method='cash'  AND type='out' THEN -amount ELSE 0 END),0)::float AS cash,
         COALESCE(SUM(CASE WHEN method<>'cash' AND type='in' THEN amount WHEN method<>'cash' AND type='out' THEN -amount ELSE 0 END),0)::float AS cashless
       FROM cash_operations WHERE created_at < $1::date`, [from]);

    // доходи/витрати в періоді за категоріями + спосіб оплати
    const cats = await pool.query(
      `SELECT type, category,
              SUM(amount)::float AS amount,
              SUM(CASE WHEN method='cash'  THEN amount ELSE 0 END)::float AS cash,
              SUM(CASE WHEN method<>'cash' THEN amount ELSE 0 END)::float AS cashless
       FROM cash_operations
       WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
       GROUP BY type, category`, params);

    // список операцій
    const ops = await pool.query(
      `SELECT o.id, o.type, o.category, o.amount::float AS amount, o.method, o.description, o.created_at,
              m.name AS master_name
       FROM cash_operations o LEFT JOIN masters m ON m.id = o.master_id
       WHERE o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day')
       ORDER BY o.created_at DESC LIMIT 300`, params);

    // Оборот послуг по відділах (нормалізація вільного тексту specialty у відділ).
    // Джерело — те саме cash_operations sale_service, що й revenue.services → суми збігаються.
    const DEPT_CASE = `CASE
        WHEN lower(coalesce(m.specialty,'')) ~ 'перукар|колорист|стиліст|барбер|голов' THEN 'Перукарський'
        WHEN lower(coalesce(m.specialty,'')) ~ 'манікюр|нігт|педикюр|nail' THEN 'Нігтьовий сервіс'
        WHEN lower(coalesce(m.specialty,'')) ~ 'візаж|бров|брів|леш|вії|макіяж|permanent|перманент' THEN 'Візаж, брови, вії'
        WHEN lower(coalesce(m.specialty,'')) ~ 'масаж|тіло|косметолог|догляд|spa|спа|епіляц|депіляц' THEN 'Тіло і догляд'
        ELSE 'Інше / не вказано' END`;
    const svcDept = await pool.query(
      `SELECT ${DEPT_CASE} AS dept,
              SUM(o.amount)::float AS amount,
              COUNT(DISTINCT o.master_id)::int AS masters
       FROM cash_operations o LEFT JOIN masters m ON m.id = o.master_id
       WHERE o.type='in' AND o.category='sale_service'
         AND o.created_at >= $1::date AND o.created_at < ($2::date + INTERVAL '1 day')
       GROUP BY dept HAVING SUM(o.amount) > 0 ORDER BY amount DESC`, params);

    // Касовий рух (для балансу готівки/безготівки — реальні гроші в касі)
    const cashIn = { cash: 0, cashless: 0 }, cashOut = { cash: 0, cashless: 0 };
    for (const r of cats.rows) {
      const b = r.type === 'in' ? cashIn : cashOut;
      b.cash += r.cash; b.cashless += r.cashless;
    }

    // ЄДИНЕ джерело правди (lib/live-finance) — щоб Доходи/Витрати/результат збігались
    // з Дашбордом, Фінцентром і P&L. Витрати = матеріали + нарахований % майстрам + інші витрати.
    // Верхня межа = кінець вибраного дня (повний день). Виручка = всі гроші за день;
    // нарахований % майстрам усередині liveFinance і так капається на NOW() (майбутні послуги не рахуються).
    const fin = await liveFinance(pool, `${from} 00:00:00+03`, `${to} 23:59:59+03`);
    // Розбивка послуг по відділах, масштабована до єдиного джерела правди
    // (fin.revenue.services) — щоб сума сегментів точно = рядку «Послуги».
    const svcRaw = svcDept.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const svcScale = svcRaw > 0 ? fin.revenue.services / svcRaw : 1;
    const svcSegs = svcDept.rows.map(r => ({
      category: 'svc_dept:' + r.dept,
      label: r.dept,
      amount: Math.round(Number(r.amount) * svcScale * 100) / 100,
      masters: r.masters,
      dept: true,
    }));
    const income = {
      total: fin.revenue.total, cash: cashIn.cash, cashless: cashIn.cashless,
      services_total: fin.revenue.services,
      by_category: [
        ...svcSegs,
        { category: 'sale_product', label: 'Товари', amount: fin.revenue.products },
      ].filter(x => x.amount > 0),
    };
    const expense = {
      total: fin.expenses.total, cash: cashOut.cash, cashless: cashOut.cashless,
      by_category: fin.expenses.by_category.map(x => ({ category: x.category, label: x.label, amount: x.sum })),
    };

    const o = open.rows[0];
    const opening = { cash: o.cash, cashless: o.cashless, total: o.cash + o.cashless };
    const closing = {
      cash: opening.cash + cashIn.cash - cashOut.cash,
      cashless: opening.cashless + cashIn.cashless - cashOut.cashless,
    };
    closing.total = closing.cash + closing.cashless;

    res.json({
      from, to, opening, income, expense, closing,
      result: income.total - expense.total,
      transactions: ops.rows.map(t => ({
        id: t.id, type: t.type, category: t.category, label: FIN_CAT_LABELS[t.category] || t.category,
        method: t.method, amount: t.amount, description: t.description,
        master_name: t.master_name, created_at: t.created_at,
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/shifts — история смен (только владелец)
router.get('/shifts', requireHistory, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // Аудит #2: привязанный к филиалу видит только свои смены (no-op для owner/одно-салона)
    const b = branchAndClause(req, 'branch_id', 1);
    const r = await pool.query(
      `SELECT id, branch_id, opened_by, opened_at, closed_at, opening_cash, closing_cash,
              expected_cash, difference, status
       FROM cash_shifts WHERE 1=1${b.sql} ORDER BY opened_at DESC LIMIT $${1 + b.params.length}`,
      [...b.params, limit]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/shifts/:id — детали смены
router.get('/shifts/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = await pool.query(`SELECT * FROM cash_shifts WHERE id=$1`, [id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'not-found' });
    // закрытую (прошлую) смену видит только владелец
    if (s.rows[0].status !== 'open' && !hasPermission(req.user?.permissions || [], 'cashbox.history')) {
      return res.status(403).json({ error: 'forbidden', need: 'cashbox.history', message: 'Минулі зміни доступні лише власнику' });
    }
    const ops = await pool.query(
      `SELECT * FROM cash_operations WHERE shift_id=$1 ORDER BY created_at`,
      [id]
    );
    const totals = await recalcShiftTotals(id);
    res.json({ shift: s.rows[0], operations: ops.rows, totals });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/cashbox/shifts/:id/close — закрыть смену + Z-отчёт
router.post('/shifts/:id/close', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const { closing_cash, closed_by, notes } = req.body || {};

    await client.query('BEGIN'); await applyTenant(client);
    const s = await client.query(`SELECT * FROM cash_shifts WHERE id=$1 FOR UPDATE`, [id]);
    if (!s.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    if (s.rows[0].status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not-open' }); }

    const totals = await recalcShiftTotals(id);
    const opening = Number(s.rows[0].opening_cash);
    const expected = opening + Number(totals.cash_in) - Number(totals.cash_out);
    const closing = closing_cash != null ? Number(closing_cash) : expected;
    const diff = closing - expected;

    await client.query(
      `UPDATE cash_shifts SET status='closed', closed_at=NOW(), closing_cash=$1,
       expected_cash=$2, difference=$3, notes=COALESCE($4,notes) WHERE id=$5`,
      [closing, expected, diff, notes || null, id]
    );

    // Z-отчёт: подробная сводка по категориям
    const breakdown = await client.query(
      `SELECT type, category, method, COUNT(*) AS cnt, SUM(amount) AS total
       FROM cash_operations WHERE shift_id=$1 GROUP BY type, category, method`,
      [id]
    );
    const byCategory = {};
    let servicesTotal = 0, productsTotal = 0, salaryTotal = 0, supplierTotal = 0;
    let cardIn = 0, transferIn = 0;
    for (const row of breakdown.rows) {
      const key = `${row.type}_${row.category}`;
      byCategory[key] = (byCategory[key] || 0) + Number(row.total);
      if (row.type === 'in' && row.category === 'sale_service') servicesTotal += Number(row.total);
      if (row.type === 'in' && row.category === 'sale_product') productsTotal += Number(row.total);
      if (row.type === 'out' && row.category === 'salary') salaryTotal += Number(row.total);
      if (row.type === 'out' && row.category === 'supplier') supplierTotal += Number(row.total);
      if (row.type === 'in' && row.method === 'card') cardIn += Number(row.total);
      if (row.type === 'in' && row.method === 'transfer') transferIn += Number(row.total);
    }
    const opsCnt = await client.query(`SELECT COUNT(*)::int AS n FROM cash_operations WHERE shift_id=$1`, [id]);

    const z = await client.query(
      `INSERT INTO z_reports (shift_id, branch_id, period_start, period_end,
         total_in, total_out, cash_in, cash_out, card_in, transfer_in,
         services_total, products_total, salary_total, supplier_total,
         operations_cnt, opening_cash, closing_cash, expected_cash, difference,
         raw_breakdown, closed_by)
       VALUES ($1,$2,$3,NOW(),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING *`,
      [id, s.rows[0].branch_id, s.rows[0].opened_at,
       totals.total_in, totals.total_out, totals.cash_in, totals.cash_out, cardIn, transferIn,
       servicesTotal, productsTotal, salaryTotal, supplierTotal,
       opsCnt.rows[0].n, opening, closing, expected, diff,
       JSON.stringify(byCategory), closed_by || null]
    );

    await client.query('COMMIT');
    res.json({ ok: true, shift_id: id, z_report: z.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally {
    client.release();
  }
});

// GET /api/cashbox/categories — збережені «свої» статті доходів/витрат (заметка #75).
// Адміну достатньо cashbox.read. Повертає { in:[...], out:[...] }.
router.get('/categories', async (req, res) => {
  try {
    const cur = (await getSetting('fin_custom_cats', { in: [], out: [] })) || { in: [], out: [] };
    res.json({ in: Array.isArray(cur.in) ? cur.in : [], out: Array.isArray(cur.out) ? cur.out : [] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/cashbox/categories — прибрати «свою» статтю зі списку (на майбутнє; UI може не показувати).
router.delete('/categories', requireHistory, async (req, res) => {
  try {
    const { type, category } = req.body || {};
    if (!['in', 'out'].includes(type) || !category) return res.status(400).json({ error: 'type, category required' });
    const cur = (await getSetting('fin_custom_cats', { in: [], out: [] })) || { in: [], out: [] };
    cur[type] = (Array.isArray(cur[type]) ? cur[type] : []).filter((x) => String(x).toLowerCase() !== String(category).toLowerCase());
    await setSetting('fin_custom_cats', cur);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/category-colors — кольори категорій для діаграм (заметка #73).
router.get('/category-colors', async (req, res) => {
  try {
    const cur = (await getSetting('fin_cat_colors', {})) || {};
    res.json(cur);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/cashbox/category-colors — задати довільний колір категорії (#73).
router.post('/category-colors', async (req, res) => {
  try {
    const { category, color } = req.body || {};
    if (!category || !/^#[0-9a-fA-F]{6}$/.test(String(color || ''))) {
      return res.status(400).json({ error: 'category, color(#rrggbb) required' });
    }
    const cur = (await getSetting('fin_cat_colors', {})) || {};
    cur[String(category)] = String(color).toLowerCase();
    await setSetting('fin_cat_colors', cur);
    res.json({ ok: true, colors: cur });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── OPERATIONS ─────────────────────────────────────────

// POST /api/cashbox/operations — добавить операцию (приход/расход)
router.post('/operations', async (req, res) => {
  // Транзакція з блокуванням рядка зміни (FOR UPDATE) — закриває TOCTOU: раніше
  // перевірка статусу зміни і вставка операції були ДВА окремих запити, між якими
  // зміну могли закрити (close() теж бере FOR UPDATE) → операція падала в уже
  // закриту зміну, ламаючи Z-звіт і зведення каси. Тепер вони серіалізуються.
  const client = await pool.connect();
  try {
    const { shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, allow_no_shift, ext_ref } = req.body || {};
    if (!type || !category || !amount) return res.status(400).json({ error: 'type, category, amount required' });
    if (!['in', 'out'].includes(type)) return res.status(400).json({ error: 'bad type' });
    if (Number(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    await client.query('BEGIN'); await applyTenant(client);

    // Блокуємо рядок зміни на час операції. Якщо shift_id не передали — беремо
    // поточну відкриту зміну і одразу її локимо (FOR UPDATE у тому ж SELECT).
    let shiftRow;
    if (!shift_id) {
      const open = await client.query(
        `SELECT id, status FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`
      );
      shiftRow = open.rows[0];
      // Ручна операція без відкритої зміни. Каса працює з cash_operations напряму
      // (фінансовий огляд /finance не залежить від зміни), тому витрату/дохід можна
      // провести і поза зміною — shift_id лишається NULL (колонка nullable, міграція 139).
      // POS-чекаут і Z-звіт це не зачіпає: вони завжди передають shift_id або відкриту зміну.
      // #103: зміна тепер НЕобов'язкова за замовчуванням — каса магазину і салону
      // спільна, і вимога відкритої зміни блокувала оплати. Хто хоче суворий режим —
      // вмикає app_settings.require_open_shift = 'true' (тоді як раніше: 400 без зміни).
      if (!shiftRow) {
        const requireShift = String(await getSetting('require_open_shift', false)) === 'true';
        if (allow_no_shift || !requireShift) {
          shiftRow = { id: null, status: 'none' };
        } else {
          await client.query('ROLLBACK'); return res.status(400).json({ error: 'no-open-shift' });
        }
      }
    } else {
      const chk = await client.query(`SELECT id, status FROM cash_shifts WHERE id=$1 FOR UPDATE`, [shift_id]);
      shiftRow = chk.rows[0];
      if (!shiftRow) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'shift-not-found' }); }
      if (shiftRow.status !== 'open') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'shift-closed' }); }
    }

    const createdAt = opDateParam(req.body); // дата «заднім числом» (#72) або NULL → NOW()
    // ext_ref (POS-кошик тощо): повторний POST з тим самим ref НЕ дублює операцію —
    // унікальний індекс ux_cash_ops_ext_ref (міграція 218). Повертаємо існуючу.
    const extRef = ext_ref ? String(ext_ref).slice(0, 120) : null;
    if (extRef) {
      const dup = await client.query(`SELECT * FROM cash_operations WHERE ext_ref=$1 LIMIT 1`, [extRef]);
      if (dup.rows[0]) { await client.query('ROLLBACK'); return res.json({ ok: true, already: true, operation: dup.rows[0], stock_qty: null }); }
    }
    const r = await client.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, created_at, ext_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE($10::timestamptz, NOW()), $11) RETURNING *`,
      [shiftRow.id, type, category, amount, method || 'cash', ref_type || null, ref_id || null, master_id || null, description || null, createdAt, extRef]
    );

    // Продаж товару через касу → списуємо зі складу в ТІЙ ЖЕ транзакції.
    // Раніше каса писала лише гроші, а залишок не змінювався — розсинхрон обліку.
    // variant_id/qty передає UI каси (пікер товару); без variant_id — поведінка як раніше.
    let stockAfter = null;
    const vId = Number(req.body.variant_id);
    if (type === 'in' && category === 'sale_product' && Number.isFinite(vId) && vId > 0) {
      const q = Number(req.body.qty) > 0 ? Number(req.body.qty) : 1;
      const upd = await client.query(
        `UPDATE product_variants
            SET stock_qty = GREATEST(0, COALESCE(stock_qty,0) - $1)
          WHERE id = $2
        RETURNING id, stock_qty`, [q, vId]
      );
      if (upd.rows[0]) {
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, notes)
           VALUES ($1, $2, 'sale', $3)`,
          [vId, -q, 'каса: продаж товару, операція #' + r.rows[0].id]
        );
        stockAfter = upd.rows[0].stock_qty;
      }
    }
    await client.query('COMMIT');
    await rememberCustomCat(type, category); // запам'ятати «свою» статтю (#75)
    res.json({ ok: true, operation: r.rows[0], stock_qty: stockAfter });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally {
    client.release();
  }
});

// GET /api/cashbox/operations?shift_id=N — операции по смене
router.get('/operations', async (req, res) => {
  try {
    const shiftId = Number(req.query.shift_id);
    if (!shiftId) return res.status(400).json({ error: 'shift_id required' });
    // операции прошлой (закрытой) смены — только владелец
    const sh = await pool.query(`SELECT status FROM cash_shifts WHERE id=$1`, [shiftId]);
    if (sh.rows[0] && sh.rows[0].status !== 'open' && !hasPermission(req.user?.permissions || [], 'cashbox.history')) {
      return res.status(403).json({ error: 'forbidden', need: 'cashbox.history', message: 'Минулі операції доступні лише власнику' });
    }
    const r = await pool.query(
      `SELECT * FROM cash_operations WHERE shift_id=$1 ORDER BY created_at`,
      [shiftId]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/cashbox/operations/:id — редактировать операцию (категория, сумма, метод,
// мастер, описание). Разрешено для операций в ОТКРЫТОЙ смене или ручных (shift_id NULL).
// Это закрывает требование «редактировать абсолютно всё»: записанную продажу/расход
// можно поправить без удаления и пересоздания.
router.patch('/operations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // LEFT JOIN: ручные операции имеют shift_id=NULL и не должны выпадать из выборки.
    const op = await pool.query(
      `SELECT o.*, s.status AS shift_status FROM cash_operations o
       LEFT JOIN cash_shifts s ON s.id=o.shift_id WHERE o.id=$1`, [id]
    );
    if (!op.rows[0]) return res.status(404).json({ error: 'not-found' });
    // shift_id NULL → ручная операция (редактируется всегда); иначе смена обязана быть открытой.
    if (op.rows[0].shift_id != null && op.rows[0].shift_status !== 'open') {
      return res.status(400).json({ error: 'shift-closed' });
    }

    const b = req.body || {};
    const sets = []; const params = [];
    const setCol = (c, v) => { params.push(v); sets.push(`${c}=$${params.length}`); };

    if (b.type !== undefined) {
      if (!['in', 'out'].includes(b.type)) return res.status(400).json({ error: 'bad type' });
      setCol('type', b.type);
    }
    if (b.amount !== undefined) {
      if (Number(b.amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });
      setCol('amount', b.amount);
    }
    if (b.category !== undefined) {
      if (!String(b.category).trim()) return res.status(400).json({ error: 'category required' });
      setCol('category', String(b.category).trim());
    }
    if (b.method !== undefined) setCol('method', b.method || 'cash');
    if (b.master_id !== undefined) setCol('master_id', b.master_id || null);
    if (b.description !== undefined) setCol('description', b.description || null);
    // дата операції (можна правити «заднім числом» — #72)
    if (b.date !== undefined) {
      const cd = opDateParam(b);
      if (!cd) return res.status(400).json({ error: 'bad date' });
      setCol('created_at', cd);
    }

    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    params.push(id);
    const r = await pool.query(
      `UPDATE cash_operations SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params
    );
    if (b.category !== undefined) await rememberCustomCat(r.rows[0].type, r.rows[0].category); // #75
    res.json({ ok: true, operation: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// DELETE /api/cashbox/operations/:id — удалить (открытая смена или ручная операция)
router.delete('/operations/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // LEFT JOIN: ручные операции (shift_id NULL) раньше выпадали из INNER JOIN
    // и не удалялись («not-found»). Теперь удаляются корректно.
    const op = await pool.query(
      `SELECT o.*, s.status AS shift_status FROM cash_operations o
       LEFT JOIN cash_shifts s ON s.id=o.shift_id WHERE o.id=$1`, [id]
    );
    if (!op.rows[0]) return res.status(404).json({ error: 'not-found' });
    if (op.rows[0].shift_id != null && op.rows[0].shift_status !== 'open') {
      return res.status(400).json({ error: 'shift-closed' });
    }
    await pool.query(`DELETE FROM cash_operations WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Z-REPORTS ──────────────────────────────────────────

// GET /api/cashbox/z-reports — список (только владелец)
router.get('/z-reports', requireHistory, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const r = await pool.query(
      `SELECT * FROM z_reports ORDER BY period_end DESC LIMIT $1`, [limit]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/cashbox/z-reports/:id (только владелец)
router.get('/z-reports/:id', requireHistory, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM z_reports WHERE id=$1`, [Number(req.params.id)]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ report: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── TAXES ──────────────────────────────────────────────

router.get('/taxes', requireHistory, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM tax_records ORDER BY period_start DESC`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/taxes', async (req, res) => {
  try {
    const { period_start, period_end, type, base_amount, tax_amount, notes } = req.body || {};
    if (!period_start || !period_end || !type) return res.status(400).json({ error: 'period_start, period_end, type required' });
    const r = await pool.query(
      `INSERT INTO tax_records (period_start, period_end, type, base_amount, tax_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [period_start, period_end, type, base_amount || 0, tax_amount || 0, notes || null]
    );
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/taxes/:id/pay', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { paid_amount } = req.body || {};
    const r = await pool.query(
      `UPDATE tax_records SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE id=$2 RETURNING *`,
      [paid_amount || null, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, record: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
