/* ═══════════════════════════════════════════════════════
   FIN-08 — Payroll / Payouts v2 (Зарплатные выплаты мастеров)
   Подключается как /api/payouts

   Дополняет существующий routes/payroll-stock.js (/api/payroll/*),
   закрывая дельту против спеки tz_modules/module_07.md:
     • PayrollRule — индивидуальные правила начисления (07.01/07.02);
     • зарплатная ведомость за период по всем мастерам (интерфейс «Ведомость»);
     • привязка KPI-бонусов (FIN-09, kpi_bonuses) к расчётам ЗП (07.04);
     • частичные выплаты одного расчёта несколькими траншами (07.07);
     • пересчёт с фиксацией в журнале (payroll.recalculated);
     • сводная история по сотруднику (карточка сотрудника);
     • экспорт расчётного листа / ведомости (07.08).

   Реальные данные: masters, appointments, orders, kpi_bonuses,
   payroll_records / payroll_schemes / payroll_payments (005/044/160/173).

   Права: payroll.read (GET) / payroll.write (мутации). Owner '*' матчит всё.
   Расчёт/начисление/ведомость/статусы/история — полноценные.
   (Внешних платёжных шлюзов модуль не вызывает — выплата = касса + журнал.)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { MATLINES_CTE } = require('../lib/payroll-base');
const { shiftDaysForMasterInRange } = require('../lib/schedule-month');
const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// Авторизация: read на GET, write на мутации. /payouts/my — самопросмотр мастером.
router.use((req, res, next) => {
  if (req.method === 'GET' && req.path === '/my') return requirePerm()(req, res, next);
  const perm = req.method === 'GET' ? 'payroll.read' : 'payroll.write';
  return requirePerm(perm)(req, res, next);
});

/* ── helpers ───────────────────────────────────────────── */
function periodRange(period) {
  // 'YYYY-MM' → {from:'YYYY-MM-01', to:'YYYY-MM-01' след. месяца (exclusive)}
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  let y, mo;
  if (m) { y = +m[1]; mo = +m[2]; }
  else { const d = new Date(); y = d.getUTCFullYear(); mo = d.getUTCMonth() + 1; }
  const from = `${y}-${String(mo).padStart(2, '0')}-01`;
  const nm = mo === 12 ? { y: y + 1, m: 1 } : { y, m: mo + 1 };
  const to = `${nm.y}-${String(nm.m).padStart(2, '0')}-01`;
  return { from, to, period: `${y}-${String(mo).padStart(2, '0')}` };
}
const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ═══════════════ 07.01/07.02 PAYROLL RULES (PayrollRule) ═══════════════ */
// Индивидуальные правила начисления поверх базовой схемы: %/фикс по услуге/категории/филиалу.

// GET /api/payouts/rules?master_id=&active=
router.get('/rules', async (req, res) => {
  try {
    const { master_id, active } = req.query;
    const where = [], args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (active === '1') where.push(`is_active=TRUE`);
    if (active === '0') where.push(`is_active=FALSE`);
    const rows = await q(
      `SELECT * FROM payroll_rules ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY master_id, priority, id`, args);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/payouts/rules — создать правило
router.post('/rules', async (req, res) => {
  try {
    const { master_id, rule_type, scope, scope_ref, percentage, fixed_amount, priority, notes } = req.body || {};
    if (!master_id) return res.status(400).json({ error: 'master_id required' });
    const rt = rule_type || 'percent_services';
    const validRT = ['percent_services', 'percent_products', 'fixed', 'percent_category', 'percent_service'];
    if (!validRT.includes(rt)) return res.status(400).json({ error: 'bad rule_type' });
    const sc = scope || 'all';
    if (!['all', 'category', 'service', 'branch'].includes(sc)) return res.status(400).json({ error: 'bad scope' });
    if (rt === 'fixed' && !(num(fixed_amount) > 0)) return res.status(400).json({ error: 'fixed_amount>0 required for fixed rule' });
    if (rt !== 'fixed' && !(num(percentage) > 0)) return res.status(400).json({ error: 'percentage>0 required for percent rule' });
    const r = await q(
      `INSERT INTO payroll_rules (master_id, rule_type, scope, scope_ref, percentage, fixed_amount, priority, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [master_id, rt, sc, scope_ref || null, percentage ?? null, fixed_amount ?? null, priority ?? 100, notes || null]);
    logAction({ user: req.user, action: 'payroll.rule.created', entity: 'payroll_rules', entity_id: r[0].id, ip: req.ip, meta: { master_id, rule_type: rt } });
    res.json({ ok: true, rule: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// PUT /api/payouts/rules/:id — обновить
router.put('/rules/:id', async (req, res) => {
  try {
    const { rule_type, scope, scope_ref, percentage, fixed_amount, priority, is_active, notes } = req.body || {};
    // та же валидация, что и в POST /rules: whitelist rule_type/scope + числовые поля
    if (rule_type !== undefined) {
      const validRT = ['percent_services', 'percent_products', 'fixed', 'percent_category', 'percent_service'];
      if (!validRT.includes(rule_type)) return res.status(400).json({ error: 'bad rule_type' });
    }
    if (scope !== undefined && !['all', 'category', 'service', 'branch'].includes(scope)) {
      return res.status(400).json({ error: 'bad scope' });
    }
    if (percentage !== undefined && percentage !== null && !(num(percentage) > 0)) {
      return res.status(400).json({ error: 'percentage must be a number > 0' });
    }
    if (fixed_amount !== undefined && fixed_amount !== null && !(num(fixed_amount) > 0)) {
      return res.status(400).json({ error: 'fixed_amount must be a number > 0' });
    }
    if (priority !== undefined && !Number.isFinite(Number(priority))) {
      return res.status(400).json({ error: 'priority must be a number' });
    }
    const sets = [], args = [];
    const set = (col, val) => { args.push(val); sets.push(`${col}=$${args.length}`); };
    if (rule_type !== undefined) set('rule_type', rule_type);
    if (scope !== undefined) set('scope', scope);
    if (scope_ref !== undefined) set('scope_ref', scope_ref);
    if (percentage !== undefined) set('percentage', percentage);
    if (fixed_amount !== undefined) set('fixed_amount', fixed_amount);
    if (priority !== undefined) set('priority', priority);
    if (is_active !== undefined) set('is_active', !!is_active);
    if (notes !== undefined) set('notes', notes);
    if (!sets.length) return res.json({ ok: true, noop: true });
    sets.push(`updated_at=now()`);
    args.push(req.params.id);
    const r = await q(`UPDATE payroll_rules SET ${sets.join(', ')} WHERE id=$${args.length} RETURNING *`, args);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'payroll.rule.updated', entity: 'payroll_rules', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, rule: r[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// DELETE /api/payouts/rules/:id
router.delete('/rules/:id', async (req, res) => {
  try {
    const r = await q(`DELETE FROM payroll_rules WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    logAction({ user: req.user, action: 'payroll.rule.deleted', entity: 'payroll_rules', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════════ 07.04 KPI BONUSES → PAYROLL ═══════════════ */
// Влить одобренные KPI-бонусы (FIN-09) за период в начисления ЗП мастера:
// создаём payroll_bonuses(kind='kpi') и помечаем kpi_bonuses как pulled.

// GET /api/payouts/kpi-bonuses?period=YYYY-MM&status=approved
router.get('/kpi-bonuses', async (req, res) => {
  try {
    const { from, to } = periodRange(req.query.period);
    const status = req.query.status || 'approved';
    const rows = await q(
      `SELECT b.*, m.name AS master_name
         FROM kpi_bonuses b JOIN masters m ON m.id=b.master_id
        WHERE b.period_start >= $1::date AND b.period_start < $2::date
          AND ($3='' OR b.status=$3)
        ORDER BY b.bonus_amount DESC`,
      [from, to, status]);
    res.json({ period: req.query.period || from.slice(0, 7), items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/payouts/kpi-bonuses/pull { period:'YYYY-MM', master_id? }
// Идемпотентно: уже pulled (pulled_at IS NOT NULL) бонусы пропускаются.
router.post('/kpi-bonuses/pull', async (req, res) => {
  const client = await pool.connect();
  try {
    const { from, to, period } = periodRange(req.body?.period);
    const masterId = req.body?.master_id || null;
    await client.query('BEGIN'); await applyTenant(client);
    const sel = await client.query(
      `SELECT b.id, b.master_id, b.bonus_amount, b.achievement_percent, b.period_start, m.name AS master_name
         FROM kpi_bonuses b JOIN masters m ON m.id=b.master_id
        WHERE b.status IN ('approved','paid') AND b.pulled_at IS NULL
          AND b.bonus_amount > 0
          AND b.period_start >= $1::date AND b.period_start < $2::date
          AND ($3::int IS NULL OR b.master_id=$3::int)
        FOR UPDATE`,
      [from, to, masterId]);
    let pulled = 0, total = 0;
    for (const b of sel.rows) {
      // создаём начисление-бонус, которое подхватит /api/payroll/calculate этого периода
      await client.query(
        `INSERT INTO payroll_bonuses (master_id, master_name, amount, kind, reason, bonus_date, created_by, created_by_name)
         VALUES ($1,$2,$3,'kpi',$4,$5::date,$6,$7)`,
        [b.master_id, b.master_name, b.bonus_amount,
         `KPI ${period} (${num(b.achievement_percent).toFixed(0)}% плана)`,
         b.period_start, req.user?.id || null, req.user?.display_name || null]);
      await client.query(`UPDATE kpi_bonuses SET pulled_at=now(), updated_at=now() WHERE id=$1`, [b.id]);
      pulled++; total += num(b.bonus_amount);
    }
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'payroll.kpi_bonus.pulled', entity: 'kpi_bonuses', entity_id: period, ip: req.ip, meta: { pulled, total } });
    res.json({ ok: true, period, pulled, total });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  } finally { client.release(); }
});

/* ═══════════════ ЗАРПЛАТНАЯ ВЕДОМОСТЬ ЗА ПЕРИОД ═══════════════ */
// Сводная ведомость по ВСЕМ мастерам за период (интерфейс «Зарплатная ведомость»).
// Берёт уже посчитанные payroll_records; если расчёта нет — показывает live-оценку
// по активной схеме (services_revenue * percent + fixed), чтобы строка не была пустой.

async function liveEstimate(masterId, from, to) {
  const s = (await q(`SELECT * FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [masterId]))[0];
  // ЄДИНА формула (lib/payroll-base, правило Босса 06.07): net = сплачене мінус рядки-матеріали,
  // gross = повний чек. Раніше рахувалось повним чеком → відомість розходилась із «Підтвердженням».
  const ob = (await q(
    `WITH matlines AS (${MATLINES_CTE})
     SELECT COUNT(*)::int AS cnt,
            COALESCE(SUM(GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0))),0)::numeric AS revenue,
            COALESCE(SUM(COALESCE(a.real_amount,a.price,0)),0)::numeric AS revenue_full
       FROM appointments a LEFT JOIN matlines ml ON ml.aid=a.id
      WHERE a.master_id=$1::int
        AND a.starts_at >= ($2||' 00:00:00+03')::timestamptz
        AND a.starts_at <  ($3||' 00:00:00+03')::timestamptz
        AND a.starts_at <= NOW()
        AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL))`,
    [masterId, from, to]))[0];
  const revenue = num(ob.revenue), cnt = ob.cnt || 0;
  const revenueFull = num(ob.revenue_full);
  let percent_part = 0, fixed_part = 0, sales_part = 0;
  if (s) {
    const base = (s.percent_base === 'gross') ? revenueFull : revenue;
    if (s.scheme_type === 'percent' || s.scheme_type === 'hybrid') percent_part = +(base * (num(s.percent) / 100)).toFixed(2);
    if (s.scheme_type === 'fixed' || s.scheme_type === 'hybrid') {
      if (s.fixed_per_month) fixed_part = num(s.fixed_per_month);
      else if (s.fixed_per_day) {
        // Блокер D2: fixed_per_day раніше ігнорувався тут → hybrid-майстер (% + ставка/день)
        // отримував авто-нарахування без фіксованої частини. Платимо за РОБОЧІ зміни з графіка
        // (fallback — фактичні робочі дні), як у payroll-stock/«Підтвердженні».
        const fromStr = String(from).slice(0, 10), toStr = String(to).slice(0, 10);
        let shifts = await shiftDaysForMasterInRange(getPool(), masterId, fromStr, toStr).catch(() => 0);
        if (!shifts) {
          const wd = await q(
            `SELECT COUNT(DISTINCT (starts_at AT TIME ZONE 'Europe/Kiev')::date)::int AS d
               FROM appointments WHERE master_id=$1::int AND status NOT IN ('cancelled','noshow')
                AND starts_at >= $2::date AND starts_at < ($3::date + 1)`, [masterId, fromStr, toStr]);
          shifts = wd[0]?.d || 0;
        }
        fixed_part = +(num(s.fixed_per_day) * shifts).toFixed(2);
      }
    }
    // % з продажу продукції — банки по продавцю + POS (та сама формула, що «Підтвердження»)
    if (num(s.sales_commission_pct) > 0) {
      const sold = (await q(
        `SELECT COALESCE((SELECT SUM(ROUND(am.qty_used*pv.price,2))
             FROM appointment_materials am
             JOIN appointments a ON a.id=am.appointment_id
             JOIN product_variants pv ON pv.id=am.variant_id
             LEFT JOIN products p ON p.id=pv.product_id
             LEFT JOIN categories c ON c.id=p.category_id
            WHERE COALESCE(am.seller_master_id, a.master_id)=$1::int
              AND p.price_per_gram IS NULL AND pv.price IS NOT NULL
              AND a.status IN ('done','completed')
              AND a.starts_at >= ($2||' 00:00:00+03')::timestamptz AND a.starts_at < ($3||' 00:00:00+03')::timestamptz
              AND COALESCE(c.commissionable,TRUE)=TRUE),0)
         + COALESCE((SELECT SUM(co.amount) FROM cash_operations co
            WHERE co.type='in' AND co.category='sale_product' AND co.ref_type IS NULL AND co.master_id=$1::int
              AND co.created_at >= ($2||' 00:00:00+03')::timestamptz AND co.created_at < ($3||' 00:00:00+03')::timestamptz),0) AS sold`,
        [masterId, from, to]))[0];
      sales_part = +(num(sold.sold) * num(s.sales_commission_pct) / 100).toFixed(2);
    }
  }
  return { services_count: cnt, services_revenue: revenue, percent_part, fixed_part, sales_part,
    total: +(percent_part + fixed_part + sales_part).toFixed(2), scheme: s ? s.scheme_type : null };
}

// GET /api/payouts/sheet?period=YYYY-MM&status=&master_id=&format=json|csv
router.get('/sheet', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.query.period);
    const statusFilter = req.query.status || '';
    const onlyMaster = req.query.master_id ? parseInt(req.query.master_id) : null;

    // существующие расчёты периода (по дате начала периода внутри месяца)
    const recArgs = [from, to];
    let recWhere = `period_start >= $1::date AND period_start < $2::date`;
    if (statusFilter) { recArgs.push(statusFilter); recWhere += ` AND status=$${recArgs.length}`; }
    if (onlyMaster) { recArgs.push(onlyMaster); recWhere += ` AND master_id=$${recArgs.length}::text`; }
    const records = await q(
      `SELECT master_id, master_name, period_start, period_end, services_count, services_revenue,
              percent_part, fixed_part, sales_part, bonus, kpi_bonus, deduction, total, status,
              (SELECT COALESCE(SUM(amount),0) FROM payroll_partial_payments p WHERE p.record_id=r.id)::numeric AS paid_so_far,
              r.id AS record_id
         FROM payroll_records r WHERE ${recWhere} ORDER BY total DESC`, recArgs);

    const haveRecord = new Set(records.map(r => String(r.master_id)));
    const rows = records.map(r => ({
      master_id: r.master_id, master_name: r.master_name, record_id: r.record_id,
      services_count: r.services_count, services_revenue: num(r.services_revenue),
      percent_part: num(r.percent_part), fixed_part: num(r.fixed_part),
      sales_part: num(r.sales_part), bonus: num(r.bonus), kpi_bonus: num(r.kpi_bonus),
      deduction: num(r.deduction), total: num(r.total),
      paid: num(r.paid_so_far), remaining: Math.max(0, num(r.total) - num(r.paid_so_far)),
      status: r.status, estimate: false
    }));

    // мастера без расчёта — live-оценка (только если не фильтруем по конкретному статусу)
    if (!statusFilter) {
      const masters = await q(
        `SELECT id, name FROM masters WHERE active=TRUE ${onlyMaster ? 'AND id=$1' : ''} ORDER BY name`,
        onlyMaster ? [onlyMaster] : []);
      for (const m of masters) {
        if (haveRecord.has(String(m.id))) continue;
        const est = await liveEstimate(m.id, from, to);
        if (!est.scheme && est.services_revenue === 0) continue;
        rows.push({
          master_id: m.id, master_name: m.name, record_id: null,
          services_count: est.services_count, services_revenue: est.services_revenue,
          percent_part: Math.round(est.percent_part), fixed_part: Math.round(est.fixed_part),
          sales_part: 0, bonus: 0, kpi_bonus: 0, deduction: 0, total: Math.round(est.total),
          paid: 0, remaining: Math.round(est.total), status: 'not_calculated', estimate: true
        });
      }
    }

    const totals = rows.reduce((a, r) => ({
      fund: a.fund + r.total, paid: a.paid + r.paid, remaining: a.remaining + r.remaining,
      revenue: a.revenue + r.services_revenue
    }), { fund: 0, paid: 0, remaining: 0, revenue: 0 });
    totals.payroll_ratio = totals.revenue > 0 ? +(totals.fund / totals.revenue * 100).toFixed(1) : 0;

    if ((req.query.format || 'json') === 'csv') {
      const head = ['master_id', 'master_name', 'services_count', 'services_revenue', 'percent_part', 'fixed_part', 'sales_part', 'bonus', 'kpi_bonus', 'deduction', 'total', 'paid', 'remaining', 'status'];
      const lines = [head.join(',')].concat(rows.map(r => head.map(h => csvCell(r[h])).join(',')));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="payroll-sheet-${period}.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }
    res.json({ period, from, to, rows, totals, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════════ 07.07 ЧАСТИЧНЫЕ ВЫПЛАТЫ ═══════════════ */
// Несколько траншей на один расчёт. Пишет расход в открытую кассу (категория salary),
// фиксирует частичную выплату, и при полном погашении переводит расчёт в 'paid'.

// GET /api/payouts/records/:id/payments — транши по расчёту
router.get('/records/:id/payments', async (req, res) => {
  try {
    const rec = (await q(`SELECT id, total, status FROM payroll_records WHERE id=$1`, [req.params.id]))[0];
    if (!rec) return res.status(404).json({ error: 'not found' });
    const parts = await q(`SELECT * FROM payroll_partial_payments WHERE record_id=$1 ORDER BY paid_at`, [req.params.id]);
    const paid = parts.reduce((a, p) => a + num(p.amount), 0);
    res.json({ record_id: rec.id, total: num(rec.total), paid, remaining: Math.max(0, num(rec.total) - paid), status: rec.status, payments: parts });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/payouts/records/:id/pay { amount, method, note } — частичная (или полная) выплата
router.post('/records/:id/pay', async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, method, note } = req.body || {};
    const amt = num(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount>0 required' });
    await client.query('BEGIN'); await applyTenant(client);
    const r0 = (await client.query(
      `SELECT id, master_id, master_name, total, period_start, period_end, status
         FROM payroll_records WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!r0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (r0.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'record cancelled' }); }
    // Розрахунок уже повністю виплачено (повна виплата через payroll-stock) — новий транш
    // = подвійна витрата. Блокуємо (зворотний бік захисту 2.2: full→partial).
    if (r0.status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_paid', message: 'Розрахунок уже повністю виплачено' }); }
    // Хвіст аудиту: виплата по розрахунку, чий період ПЕРЕТИНАЄТЬСЯ з іншим уже
    // сплаченим/автоматичним розрахунком того ж майстра (auto проводить касу одразу) —
    // це друга виплата за той самий період. Блокуємо з підказкою.
    const twin = (await client.query(
      `SELECT id, status, period_start, period_end FROM payroll_records
        WHERE master_id = $1::text AND id <> $2 AND status IN ('auto','paid')
          AND period_start <= $4::date AND period_end >= $3::date
        LIMIT 1`,
      [String(r0.master_id), r0.id, r0.period_start, r0.period_end])).rows[0];
    if (twin) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'period-already-paid', twin_record_id: twin.id,
        message: `За цей період майстру вже виплачено розрахунком #${twin.id} (статус: ${twin.status}). Скасуйте один із розрахунків.` });
    }

    const paidBefore = num((await client.query(
      `SELECT COALESCE(SUM(amount),0)::numeric s FROM payroll_partial_payments WHERE record_id=$1`, [r0.id])).rows[0].s);
    const remaining = num(r0.total) - paidBefore;
    if (amt > remaining + 0.001) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'overpay', message: 'Сумма превышает остаток к выплате', remaining });
    }

    // расход в кассу. Без відкритої зміни пишемо з shift_id NULL (як повна виплата в
    // payroll-stock), інакше видані гроші зникають з обліку каси (баг 2.3: транш без
    // відкритої зміни не потрапляв у cash_operations взагалі).
    const sh = (await client.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`)).rows[0];
    const op = await client.query(
      `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
       VALUES ($1,'out','salary',$2,$3,'payroll_partial',$4,$5,$6) RETURNING id`,
      [sh ? sh.id : null, amt, method || 'cash', r0.id, r0.master_id, `ЗП (частина) ${r0.master_name || '#' + r0.master_id}`]);
    const cashOpId = op.rows[0].id;
    const part = await client.query(
      `INSERT INTO payroll_partial_payments (record_id, master_id, master_name, amount, method, note, cash_op_id, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, paid_at`,
      [r0.id, r0.master_id, r0.master_name, amt, method || 'cash', note || null, cashOpId, req.user?.id || null, req.user?.display_name || null]);

    const paidAfter = paidBefore + amt;
    const fullyPaid = paidAfter >= num(r0.total) - 0.001;
    if (fullyPaid && r0.status !== 'paid') {
      await client.query(`UPDATE payroll_records SET status='paid' WHERE id=$1`, [r0.id]);
      // итоговая запись в историю выплат (идемпотентно)
      const exists = await client.query(`SELECT 1 FROM payroll_payments WHERE record_id=$1 LIMIT 1`, [r0.id]);
      if (!exists.rowCount) {
        await client.query(
          `INSERT INTO payroll_payments (master_id, master_name, record_id, amount, method, period_start, period_end, created_by, created_by_name, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [r0.master_id, r0.master_name, r0.id, num(r0.total), method || 'cash', r0.period_start, r0.period_end,
           req.user?.id || null, req.user?.display_name || null, 'partial payments closed']);
      }
    }
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'payroll.partial_paid', entity: 'payroll_records', entity_id: r0.id, ip: req.ip,
                meta: { amount: amt, paid: paidAfter, total: num(r0.total), fully_paid: fullyPaid } });
    res.json({ ok: true, payment_id: part.rows[0].id, paid: paidAfter, remaining: Math.max(0, num(r0.total) - paidAfter), status: fullyPaid ? 'paid' : r0.status });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  } finally { client.release(); }
});

/* ═══════════════ ПЕРЕСЧЁТ С ЖУРНАЛОМ (payroll.recalculated) ═══════════════ */
// Пересчитывает существующий расчёт (draft/approved) по текущим данным appointments+схеме,
// фиксируя старый/новый total в payroll_recalc_log. Выплаченный период не трогаем
// (бизнес-правило: выплаченный период блокируется).

// POST /api/payouts/records/:id/recalculate { reason }
router.post('/records/:id/recalculate', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const r0 = (await client.query(`SELECT * FROM payroll_records WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!r0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (r0.status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'paid_locked', message: 'Выплаченный период заблокирован от пересчёта' }); }

    const from = String(r0.period_start).slice(0, 10);
    const toExcl = (await client.query(`SELECT ($1::date + INTERVAL '1 day')::date AS d`, [String(r0.period_end).slice(0, 10)])).rows[0].d;
    const s = (await client.query(`SELECT * FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE LIMIT 1`, [r0.master_id])).rows[0];
    if (!s) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'no active scheme for master' }); }

    const ob = (await client.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(COALESCE(real_amount, price)),0)::numeric AS revenue
         FROM appointments
        WHERE master_id=$1::int AND starts_at >= $2::date AND starts_at < $3::date
          AND (status IN ('done','completed') OR (status='confirmed' AND real_synced_at IS NOT NULL))`,
      [r0.master_id, from, toExcl])).rows[0];
    const services_count = ob.cnt || 0, services_revenue = num(ob.revenue);
    let percent_part = 0, fixed_part = num(r0.fixed_part);
    if (s.scheme_type === 'percent' || s.scheme_type === 'hybrid') percent_part = services_revenue * (num(s.percent) / 100);

    const oldTotal = num(r0.total);
    await client.query(
      `UPDATE payroll_records SET services_count=$2, services_revenue=$3, percent_part=$4 WHERE id=$1`,
      [r0.id, services_count, services_revenue, percent_part]);
    const newTotal = num((await client.query(`SELECT total FROM payroll_records WHERE id=$1`, [r0.id])).rows[0].total);

    await client.query(
      `INSERT INTO payroll_recalc_log (record_id, master_id, old_total, new_total, reason, snapshot, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r0.id, r0.master_id, oldTotal, newTotal, req.body?.reason || null,
       JSON.stringify({ services_count, services_revenue, percent_part, fixed_part, bonus: num(r0.bonus), deduction: num(r0.deduction) }),
       req.user?.id || null, req.user?.display_name || null]);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'payroll.recalculated', entity: 'payroll_records', entity_id: r0.id, ip: req.ip, meta: { old_total: oldTotal, new_total: newTotal } });
    res.json({ ok: true, record_id: r0.id, old_total: oldTotal, new_total: newTotal,
               breakdown: { services_count, services_revenue, percent_part, fixed_part } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  } finally { client.release(); }
});

// GET /api/payouts/records/:id/recalc-log — журнал пересчётов расчёта
router.get('/records/:id/recalc-log', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM payroll_recalc_log WHERE record_id=$1 ORDER BY created_at DESC`, [req.params.id]);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════════ ОТМЕНА РАСЧЁТА (CANCELLED) ═══════════════ */
// Аннулировать расчёт (не выплаченный): вернуть учтённые бонусы/штрафы/авансы в пул.
router.post('/records/:id/cancel', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const r0 = (await client.query(`SELECT id, status FROM payroll_records WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!r0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (r0.status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'paid_locked', message: 'Выплаченный период нельзя аннулировать' }); }
    // вернуть начисления в пул (unapply)
    await client.query(`UPDATE payroll_bonuses   SET applied_record_id=NULL WHERE applied_record_id=$1`, [r0.id]);
    await client.query(`UPDATE payroll_penalties SET applied_record_id=NULL WHERE applied_record_id=$1`, [r0.id]);
    await client.query(`UPDATE payroll_advances  SET settled=FALSE, settled_record_id=NULL WHERE settled_record_id=$1`, [r0.id]);
    await client.query(`UPDATE payroll_records SET status='cancelled' WHERE id=$1`, [r0.id]);
    await client.query('COMMIT');
    logAction({ user: req.user, action: 'payroll.cancelled', entity: 'payroll_records', entity_id: r0.id, ip: req.ip });
    res.json({ ok: true, record_id: r0.id, status: 'cancelled' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message });
  } finally { client.release(); }
});

/* ═══════════════ СВОДНАЯ ИСТОРИЯ ПО СОТРУДНИКУ ═══════════════ */
// Карточка сотрудника: начисления + бонусы + штрафы + авансы + выплаты + KPI + баланс.
router.get('/history/:masterId', async (req, res) => {
  try {
    const mid = parseInt(req.params.masterId);
    if (!mid) return res.status(400).json({ error: 'bad masterId' });
    const limit = Math.min(parseInt(req.query.limit) || 24, 100);
    const [master, records, bonuses, penalties, advances, payments, partials, kpi] = await Promise.all([
      q(`SELECT id, name, specialty FROM masters WHERE id=$1`, [mid]),
      q(`SELECT id, period_start, period_end, services_count, services_revenue, percent_part, fixed_part, sales_part, bonus, kpi_bonus, deduction, total, status, created_at
           FROM payroll_records WHERE master_id=$1::text ORDER BY period_start DESC LIMIT $2`, [mid, limit]),
      q(`SELECT id, amount, kind, reason, bonus_date, applied_record_id FROM payroll_bonuses WHERE master_id=$1 ORDER BY bonus_date DESC LIMIT 100`, [mid]),
      q(`SELECT id, amount, kind, reason, penalty_date, applied_record_id FROM payroll_penalties WHERE master_id=$1 ORDER BY penalty_date DESC LIMIT 100`, [mid]),
      q(`SELECT id, amount, reason, issued_at, settled FROM payroll_advances WHERE master_id=$1 ORDER BY issued_at DESC LIMIT 100`, [mid]),
      q(`SELECT id, amount, method, paid_at, period_start, period_end FROM payroll_payments WHERE master_id=$1::text ORDER BY paid_at DESC LIMIT 100`, [mid]),
      q(`SELECT record_id, amount, method, paid_at FROM payroll_partial_payments WHERE master_id=$1 ORDER BY paid_at DESC LIMIT 100`, [mid]),
      q(`SELECT id, period_start, period_end, achievement_percent, bonus_amount, status, pulled_at FROM kpi_bonuses WHERE master_id=$1 ORDER BY period_start DESC LIMIT 24`, [mid])
    ]);
    if (!master[0]) return res.status(404).json({ error: 'master not found' });
    const accrued = records.reduce((a, r) => a + num(r.total), 0);
    const paid = payments.reduce((a, p) => a + num(p.amount), 0);
    res.json({
      master: master[0],
      balance: { accrued, paid, debt: accrued - paid, open_advances: advances.filter(a => !a.settled).reduce((a, x) => a + num(x.amount), 0) },
      records, bonuses, penalties, advances, payments, partial_payments: partials, kpi_bonuses: kpi
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════════ 07.08 ЭКСПОРТ РАСЧЁТНОГО ЛИСТА ═══════════════ */
// CSV-расчётный лист по конкретному расчёту: начисления + удержания + итог.
router.get('/payslip/:id/export', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM payroll_records WHERE id=$1`, [req.params.id]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    const bonuses = await q(`SELECT amount, kind, reason, bonus_date FROM payroll_bonuses WHERE applied_record_id=$1 ORDER BY bonus_date`, [r.id]);
    const penalties = await q(`SELECT amount, kind, reason, penalty_date FROM payroll_penalties WHERE applied_record_id=$1 ORDER BY penalty_date`, [r.id]);
    const advances = await q(`SELECT amount, reason, issued_at FROM payroll_advances WHERE settled_record_id=$1 ORDER BY issued_at`, [r.id]);

    const lines = [];
    lines.push(['Расчётный лист', `#${r.id}`].map(csvCell).join(','));
    lines.push(['Сотрудник', r.master_name || ('#' + r.master_id)].map(csvCell).join(','));
    lines.push(['Период', `${String(r.period_start).slice(0, 10)} — ${String(r.period_end).slice(0, 10)}`].map(csvCell).join(','));
    lines.push(['Статус', r.status].map(csvCell).join(','));
    lines.push('');
    lines.push(['Начисления', 'Сумма'].join(','));
    lines.push(['Услуги (' + r.services_count + ' визитов, выручка ' + num(r.services_revenue) + ')', num(r.percent_part)].map(csvCell).join(','));
    lines.push(['Ставка/оклад', num(r.fixed_part)].map(csvCell).join(','));
    lines.push(['Комиссия с продаж', num(r.sales_part)].map(csvCell).join(','));
    for (const b of bonuses) lines.push(['Бонус: ' + (b.reason || b.kind), num(b.amount)].map(csvCell).join(','));
    lines.push('');
    lines.push(['Удержания', 'Сумма'].join(','));
    for (const p of penalties) lines.push(['Штраф: ' + (p.reason || p.kind), num(p.amount)].map(csvCell).join(','));
    for (const a of advances) lines.push(['Аванс: ' + (a.reason || ''), num(a.amount)].map(csvCell).join(','));
    lines.push(['Итого удержано', num(r.deduction)].map(csvCell).join(','));
    lines.push('');
    lines.push(['К ВЫПЛАТЕ', num(r.total)].map(csvCell).join(','));

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${r.id}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════════ MASTER SELF-VIEW ═══════════════ */
// GET /api/payouts/my — мастер видит свою сводку (баланс + расчёты + транши).
router.get('/my', async (req, res) => {
  try {
    const mid = req.user?.master_id;
    if (!mid) return res.status(403).json({ error: 'no master linked to this account' });
    const [records, payments, partials, kpi] = await Promise.all([
      q(`SELECT id, period_start, period_end, services_count, services_revenue, total, status FROM payroll_records WHERE master_id=$1::text ORDER BY period_start DESC LIMIT 24`, [mid]),
      q(`SELECT amount, method, paid_at, period_start, period_end FROM payroll_payments WHERE master_id=$1::text ORDER BY paid_at DESC LIMIT 50`, [mid]),
      q(`SELECT record_id, amount, method, paid_at FROM payroll_partial_payments WHERE master_id=$1 ORDER BY paid_at DESC LIMIT 50`, [mid]),
      q(`SELECT period_start, achievement_percent, bonus_amount, status FROM kpi_bonuses WHERE master_id=$1 ORDER BY period_start DESC LIMIT 12`, [mid])
    ]);
    const accrued = records.reduce((a, r) => a + num(r.total), 0);
    const paid = payments.reduce((a, p) => a + num(p.amount), 0);
    res.json({ master_id: mid, balance: { accrued, paid, debt: accrued - paid }, records, payments, partial_payments: partials, kpi_bonuses: kpi });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ═══════════ АВТО-РОЗРАХУНОК ЗАРПЛАТИ (виплати 1-го і 16-го) ═══════════
   Період: 16-го → за [1..15] цього міс; 1-го → за [16..кінець] минулого міс.
   Рахує по реальній схемі майстра (liveEstimate), створює payroll_record (status='auto')
   і проводить витрату ЗП у касу. Ідемпотентно по (master, period_start). */
function kyivYMD() {
  const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day };
}
function payPeriodFor(y, m, payDay) {
  const pad = n => String(n).padStart(2, '0');
  if (payDay === 16) return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-16`, label: `1–15.${pad(m)}.${y}` };
  const pm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return { from: `${pm.y}-${pad(pm.m)}-16`, to: `${y}-${pad(m)}-01`, label: `16–кін.${pad(pm.m)}.${pm.y}` };
}
async function autoPayrollRun({ force = false, dry = false } = {}) {
  const t = kyivYMD();
  if (!force && t.d !== 1 && t.d !== 16) return { skipped: true, reason: 'not-payday', day: t.d };
  const payDay = (t.d === 1 || t.d === 16) ? t.d : (t.d > 16 ? 16 : 1);
  const { from, to, label } = payPeriodFor(t.y, t.m, payDay);
  const masters = await q(`SELECT id, name FROM masters WHERE active=TRUE ORDER BY name`);
  let posted = 0, skipped = 0, fund = 0; const lines = [];
  for (const mst of masters) {
    const est = await liveEstimate(mst.id, from, to);
    if (!(est.total > 0)) continue;
    const exists = await q(`SELECT 1 FROM payroll_records WHERE master_id=$1::text AND period_start=$2::date LIMIT 1`, [String(mst.id), from]);
    if (exists.length) { skipped++; continue; }
    fund += Math.round(est.total); lines.push(`${mst.name}: ${Math.round(est.total)}₴`);
    if (dry) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const pr = await client.query(
        `INSERT INTO payroll_records (master_id, master_name, period_start, period_end, services_count, services_revenue, percent_part, fixed_part, total, status)
         VALUES ($1::text,$2,$3::date,($4::date - interval '1 day'),$5,$6,$7,$8,$9,'auto') RETURNING id`,
        [String(mst.id), mst.name, from, to, est.services_count, est.services_revenue, Math.round(est.percent_part), Math.round(est.fixed_part), Math.round(est.total)]);
      await client.query(
        `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
         VALUES (NULL,'out','salary',$1,'cash','auto_payroll',$2,$3,$4)`,
        [Math.round(est.total), pr.rows[0].id, mst.id, `ЗП ${mst.name} (авто, ${label})`]);
      await client.query('COMMIT'); posted++;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); console.error('[auto-payroll]', mst.name, e.message); }
    finally { client.release(); }
  }
  return { posted, skipped, fund, period: { from, to, label }, masters: masters.length, lines, dry };
}

// POST /api/payouts/auto-run?dry=1 — ручний запуск/прев'ю авто-розрахунку
router.post('/auto-run', async (req, res) => {
  try {
    const dry = req.query.dry === '1' || req.body?.dry === true;
    const r = await autoPayrollRun({ force: true, dry });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.autoPayrollRun = autoPayrollRun;
