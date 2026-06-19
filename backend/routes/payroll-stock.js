/* Payroll + Stock operations: схемы ЗП мастеров, начисления, поставки, списания материалов
   Подключается в dikidi-server.js */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const router = express.Router();
const pool = getPool();

// Авторизация: read на GET, write на мутации
router.use((req, res, next) => {
  // Роутер смонтирован на общий '/api' — охраняем ТОЛЬКО свои пути,
  // иначе guard глушит все /api/* роуты, смонтированные ниже (логин и т.д.)
  if (!/^\/(payroll|stock|suppliers)(\/|$)/.test(req.path)) return next();
  // /payroll/my — самопросмотр мастером: достаточно авторизации (фильтр по своему master_id)
  if (req.method === 'GET' && req.path === '/payroll/my') return requirePerm()(req, res, next);
  const area = req.path.startsWith('/stock') ? 'stock' : 'payroll';
  const perm = req.method === 'GET' ? `${area}.read` : `${area}.write`;
  return requirePerm(perm)(req, res, next);
});

/* ═══════════════ PAYROLL SCHEMES ═══════════════ */

// POST /api/payroll/schemes — создать/обновить схему
router.post('/payroll/schemes', async (req, res) => {
  try {
    const { master_id, master_name, scheme_type, percent, fixed_per_day, fixed_per_month, sales_commission_pct, notes } = req.body || {};
    if (!master_id || !scheme_type) return res.status(400).json({ error: 'master_id, scheme_type required' });
    if (!['percent', 'fixed', 'hybrid'].includes(scheme_type)) return res.status(400).json({ error: 'bad scheme_type' });
    // деактивируем старые схемы для этого мастера
    await pool.query(`UPDATE payroll_schemes SET is_active=FALSE WHERE master_id=$1`, [master_id]);
    const r = await pool.query(
      `INSERT INTO payroll_schemes (master_id, master_name, scheme_type, percent, fixed_per_day, fixed_per_month, sales_commission_pct, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING id`,
      [master_id, master_name || null, scheme_type, percent || null, fixed_per_day || null, fixed_per_month || null, sales_commission_pct || 0, notes || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/payroll/schemes — все активные
router.get('/payroll/schemes', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM payroll_schemes WHERE is_active=TRUE ORDER BY master_name, master_id`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// POST /api/payroll/calculate — рассчитать ЗП за период
router.post('/payroll/calculate', async (req, res) => {
  try {
    const { master_id, period_start, period_end, force } = req.body || {};
    if (!master_id || !period_start || !period_end) return res.status(400).json({ error: 'master_id, period_start, period_end required' });

    // 0. защита от двойного начисления: период не должен пересекаться с уже существующим
    //    расчётом этого мастера (кроме отменённых). Иначе один визит оплачивается дважды.
    //    force=true — осознанный пересчёт (фронт должен сначала удалить/отменить старый).
    if (!force) {
      const overlap = await pool.query(
        `SELECT id, period_start, period_end, status, total FROM payroll_records
          WHERE master_id=$1 AND status <> 'cancelled'
            AND period_start <= $3::date AND period_end >= $2::date
          ORDER BY period_start LIMIT 5`,
        [master_id, period_start, period_end]
      );
      if (overlap.rows.length) {
        return res.status(409).json({
          error: 'period_overlap',
          message: 'Период пересекается с существующим расчётом ЗП — иначе визиты оплатятся дважды. Удалите старый расчёт или используйте перерасчёт.',
          conflicts: overlap.rows
        });
      }
    }

    // 1. найти активную схему
    const scheme = await pool.query(
      `SELECT * FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE LIMIT 1`,
      [master_id]
    );
    if (!scheme.rows[0]) return res.status(400).json({ error: 'no active scheme for master' });
    const s = scheme.rows[0];

    // 2. посчитать услуги мастера за период (из appointments — реальные визиты салона)
    //    online_bookings = только онлайн-записи с сайта (почти пусто), выручка живёт в appointments.
    //    Считаем ТОЛЬКО фактически оказанные+оплаченные визиты:
    //      - done / completed — явно закрытые салоном (источник правды);
    //      - confirmed — ТОЛЬКО при наличии пруфа оплаты (real_synced_at): синк продаж BeautyPro
    //        ставит done при матче оплаты, поэтому confirmed без real_synced_at = деньги не прошли.
    //    Это исключает оплату % за визиты, которые не состоялись / не оплачены.
    //    cancelled / noshow / booked (будущие) — не оплачиваются.
    // Виручка для ЗП — по ФАКТИЧНО сплаченому (real_amount із продажу BeautyPro),
    // якщо факт невідомий — планова ціна. Майстер отримує % з реально отриманих грошей,
    // а не з планової ціни (знижки/зміна послуги мають зменшувати базу).
    const ob = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(COALESCE(real_amount, price)), 0)::numeric AS revenue
       FROM appointments
       WHERE master_id = $1::int
         AND starts_at >= $2::date
         AND starts_at <  ($3::date + INTERVAL '1 day')
         AND (status IN ('done','completed') OR (status='confirmed' AND real_synced_at IS NOT NULL))`,
      [master_id, period_start, period_end]
    );
    const services_count = ob.rows[0]?.cnt || 0;
    const services_revenue = parseFloat(ob.rows[0]?.revenue || 0);

    // 3. рассчитать части
    let percent_part = 0, fixed_part = 0;
    if (s.scheme_type === 'percent' || s.scheme_type === 'hybrid') {
      percent_part = services_revenue * (parseFloat(s.percent || 0) / 100);
    }
    if (s.scheme_type === 'fixed' || s.scheme_type === 'hybrid') {
      if (s.fixed_per_month) fixed_part = parseFloat(s.fixed_per_month);
      else if (s.fixed_per_day) {
        const days = Math.ceil((new Date(period_end) - new Date(period_start)) / 86400000) + 1;
        fixed_part = parseFloat(s.fixed_per_day) * days;
      }
    }

    // 3b. комиссия с продаж продукции (orders.seller_master_id за период)
    let sales_revenue = 0, sales_part = 0;
    const salesPct = parseFloat(s.sales_commission_pct || 0);
    if (salesPct > 0) {
      // считаем по строкам заказа: расходники (краски, окисники, знебарвлення, пігменти, завивка) комиссию не дают
      const so = await pool.query(
        `SELECT COALESCE(SUM(oi.line_total), 0)::numeric AS revenue
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         LEFT JOIN product_variants pv ON pv.id = oi.variant_id
         LEFT JOIN products p ON p.id = pv.product_id
         LEFT JOIN categories c ON c.id = p.category_id
         WHERE o.seller_master_id = $1::int
           AND o.status NOT IN ('cancelled', 'refunded')
           AND o.created_at >= $2::date
           AND o.created_at <  ($3::date + INTERVAL '1 day')
           AND COALESCE(c.commissionable, TRUE) = TRUE`,
        [master_id, period_start, period_end]
      );
      sales_revenue = parseFloat(so.rows[0]?.revenue || 0);
      sales_part = sales_revenue * (salesPct / 100);
    }

    // 3c. собрать бонусы/штрафы/авансы периода, ещё не учтённые в других расчётах
    const bonusRows = await pool.query(
      `SELECT id, amount FROM payroll_bonuses
        WHERE master_id=$1 AND applied_record_id IS NULL
          AND bonus_date >= $2::date AND bonus_date < ($3::date + INTERVAL '1 day')`,
      [master_id, period_start, period_end]
    );
    const penaltyRows = await pool.query(
      `SELECT id, amount FROM payroll_penalties
        WHERE master_id=$1 AND applied_record_id IS NULL
          AND penalty_date >= $2::date AND penalty_date < ($3::date + INTERVAL '1 day')`,
      [master_id, period_start, period_end]
    );
    const advanceRows = await pool.query(
      `SELECT id, amount FROM payroll_advances
        WHERE master_id=$1 AND settled=FALSE
          AND issued_at >= $2::date AND issued_at < ($3::date + INTERVAL '1 day')`,
      [master_id, period_start, period_end]
    );
    const bonus_sum   = bonusRows.rows.reduce((a, r) => a + parseFloat(r.amount || 0), 0);
    const penalty_sum = penaltyRows.rows.reduce((a, r) => a + parseFloat(r.amount || 0), 0);
    const advance_sum = advanceRows.rows.reduce((a, r) => a + parseFloat(r.amount || 0), 0);
    const deduction   = penalty_sum + advance_sum; // штрафы + ранее выданные авансы

    // 4. записать в payroll_records (draft)
    const rec = await pool.query(
      `INSERT INTO payroll_records (master_id, master_name, period_start, period_end,
                                    services_count, services_revenue, percent_part, fixed_part,
                                    sales_revenue, sales_part, bonus, deduction, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft') RETURNING id, total`,
      [master_id, s.master_name, period_start, period_end, services_count, services_revenue, percent_part, fixed_part, sales_revenue, sales_part, bonus_sum, deduction]
    );
    const record_id = rec.rows[0].id;

    // 5. пометить учтённые начисления как применённые к этому расчёту
    if (bonusRows.rows.length)
      await pool.query(`UPDATE payroll_bonuses SET applied_record_id=$1 WHERE id = ANY($2::int[])`, [record_id, bonusRows.rows.map(r => r.id)]);
    if (penaltyRows.rows.length)
      await pool.query(`UPDATE payroll_penalties SET applied_record_id=$1 WHERE id = ANY($2::int[])`, [record_id, penaltyRows.rows.map(r => r.id)]);
    if (advanceRows.rows.length)
      await pool.query(`UPDATE payroll_advances SET settled=TRUE, settled_record_id=$1 WHERE id = ANY($2::int[])`, [record_id, advanceRows.rows.map(r => r.id)]);

    logAction({ user: req.user, action: 'payroll.calculated', entity: 'payroll_records', entity_id: record_id, ip: req.ip,
                meta: { master_id, period_start, period_end, total: rec.rows[0].total } });
    res.json({ ok: true, record_id, total: rec.rows[0].total,
               breakdown: { services_count, services_revenue, percent_part, fixed_part, sales_revenue, sales_part, bonus_sum, penalty_sum, advance_sum } });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// GET /api/payroll/records — список начислений
router.get('/payroll/records', async (req, res) => {
  try {
    const { master_id, status, limit = 100 } = req.query;
    const where = [];
    const args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (status) { args.push(status); where.push(`status=$${args.length}`); }
    args.push(parseInt(limit));
    const sql = `SELECT * FROM payroll_records ${where.length ? 'WHERE '+where.join(' AND ') : ''}
                 ORDER BY period_start DESC LIMIT $${args.length}`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// PATCH /api/payroll/records/:id — изменить статус (approve/paid)
router.patch('/payroll/records/:id', async (req, res) => {
  try {
    const { status, bonus, deduction, notes } = req.body || {};
    const sets = [];
    const args = [];
    if (status && ['draft', 'approved', 'paid'].includes(status)) { args.push(status); sets.push(`status=$${args.length}`); }
    if (typeof bonus === 'number') { args.push(bonus); sets.push(`bonus=$${args.length}`); }
    if (typeof deduction === 'number') { args.push(deduction); sets.push(`deduction=$${args.length}`); }
    if (notes !== undefined) { args.push(notes); sets.push(`notes=$${args.length}`); }
    if (!sets.length) return res.json({ ok: true, noop: true });
    args.push(req.params.id);
    await pool.query(`UPDATE payroll_records SET ${sets.join(', ')} WHERE id=$${args.length}`, args);

    // авто-расход в открытую кассовую смену + запись в историю выплат при выплате ЗП
    if (status === 'paid') {
      try {
        const rec = await pool.query(`SELECT id, master_id, master_name, total, period_start, period_end FROM payroll_records WHERE id=$1`, [req.params.id]);
        const r0 = rec.rows[0];
        if (r0 && +r0.total > 0) {
          const sh = await pool.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
          if (sh.rows[0]) {
            await pool.query(
              `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
               VALUES ($1,'out','salary',$2,'cash','payroll',$3,$4,$5)`,
              [sh.rows[0].id, r0.total, r0.id, r0.master_id, `ЗП ${r0.master_name||'#'+r0.master_id}`]
            );
          }
          // история выплат (идемпотентно: одна выплата на расчёт)
          const exists = await pool.query(`SELECT 1 FROM payroll_payments WHERE record_id=$1 LIMIT 1`, [r0.id]);
          if (!exists.rowCount) {
            await pool.query(
              `INSERT INTO payroll_payments (master_id, master_name, record_id, amount, method, period_start, period_end, created_by, created_by_name)
               VALUES ($1,$2,$3,$4,'cash',$5,$6,$7,$8)`,
              [r0.master_id, r0.master_name, r0.id, r0.total, r0.period_start, r0.period_end, req.user?.id || null, req.user?.display_name || null]
            );
          }
        }
      } catch (e) { console.warn('[payroll-cashbox]', e.message); }
    }

    logAction({ user: req.user, action: status === 'paid' ? 'payroll.paid' : (status === 'approved' ? 'payroll.approved' : 'payroll.updated'),
                entity: 'payroll_records', entity_id: req.params.id, ip: req.ip, meta: { status, bonus, deduction } });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ BONUSES / PENALTIES / ADVANCES ═══════════════ */

// helper: универсальный CRUD-фабрикатор для бонусов/штрафов
function dateCol(kind) { return kind === 'bonus' ? 'bonus_date' : 'penalty_date'; }
function tableFor(kind) { return kind === 'bonus' ? 'payroll_bonuses' : 'payroll_penalties'; }

['bonus', 'penalty'].forEach((kind) => {
  const table = tableFor(kind);
  const dcol = dateCol(kind);
  const path = kind === 'bonus' ? 'bonuses' : 'penalties';

  // POST /api/payroll/bonuses | /api/payroll/penalties
  router.post(`/payroll/${path}`, async (req, res) => {
    try {
      const { master_id, master_name, amount, kind: subkind, reason, date } = req.body || {};
      if (!master_id || !(amount > 0)) return res.status(400).json({ error: 'master_id, amount>0 required' });
      const defaultKind = kind === 'bonus' ? 'onetime' : 'manual';
      const r = await pool.query(
        `INSERT INTO ${table} (master_id, master_name, amount, kind, reason, ${dcol}, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8) RETURNING id`,
        [master_id, master_name || null, amount, subkind || defaultKind, reason || null, date || null, req.user?.id || null, req.user?.display_name || null]
      );
      logAction({ user: req.user, action: kind === 'bonus' ? 'bonus.created' : 'penalty.created', entity: table, entity_id: r.rows[0].id, ip: req.ip, meta: { master_id, amount } });
      res.json({ ok: true, id: r.rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  });

  // GET — список с фильтрами master_id / from / to / applied
  router.get(`/payroll/${path}`, async (req, res) => {
    try {
      const { master_id, from, to, applied } = req.query;
      const where = [], args = [];
      if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
      if (from) { args.push(from); where.push(`${dcol} >= $${args.length}::date`); }
      if (to) { args.push(to); where.push(`${dcol} < ($${args.length}::date + INTERVAL '1 day')`); }
      if (applied === '0') where.push(`applied_record_id IS NULL`);
      if (applied === '1') where.push(`applied_record_id IS NOT NULL`);
      const sql = `SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${dcol} DESC, id DESC LIMIT 300`;
      const r = await pool.query(sql, args);
      res.json({ items: r.rows, count: r.rows.length });
    } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  });

  // DELETE — нельзя удалять уже учтённое в расчёте
  router.delete(`/payroll/${path}/:id`, async (req, res) => {
    try {
      const chk = await pool.query(`SELECT applied_record_id FROM ${table} WHERE id=$1`, [req.params.id]);
      if (!chk.rows[0]) return res.status(404).json({ error: 'not found' });
      if (chk.rows[0].applied_record_id) return res.status(409).json({ error: 'already applied to a payroll record' });
      await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  });
});

// ── Авансы ──
router.post('/payroll/advances', async (req, res) => {
  try {
    const { master_id, master_name, amount, reason, method, issued_at } = req.body || {};
    if (!master_id || !(amount > 0)) return res.status(400).json({ error: 'master_id, amount>0 required' });
    const r = await pool.query(
      `INSERT INTO payroll_advances (master_id, master_name, amount, reason, method, issued_at, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date,CURRENT_DATE),$7,$8) RETURNING id`,
      [master_id, master_name || null, amount, reason || null, method || 'cash', issued_at || null, req.user?.id || null, req.user?.display_name || null]
    );
    // авто-расход аванса в открытую кассовую смену
    try {
      const sh = await pool.query(`SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`);
      if (sh.rows[0]) {
        await pool.query(
          `INSERT INTO cash_operations (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description)
           VALUES ($1,'out','salary',$2,$3,'advance',$4,$5,$6)`,
          [sh.rows[0].id, amount, method || 'cash', r.rows[0].id, master_id, `Аванс ${master_name || '#' + master_id}`]
        );
      }
    } catch (e) { console.warn('[advance-cashbox]', e.message); }
    logAction({ user: req.user, action: 'advance.created', entity: 'payroll_advances', entity_id: r.rows[0].id, ip: req.ip, meta: { master_id, amount } });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/payroll/advances', async (req, res) => {
  try {
    const { master_id, settled } = req.query;
    const where = [], args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (settled === '0') where.push(`settled=FALSE`);
    if (settled === '1') where.push(`settled=TRUE`);
    const sql = `SELECT * FROM payroll_advances ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY issued_at DESC, id DESC LIMIT 300`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/payroll/advances/:id', async (req, res) => {
  try {
    const chk = await pool.query(`SELECT settled FROM payroll_advances WHERE id=$1`, [req.params.id]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'not found' });
    if (chk.rows[0].settled) return res.status(409).json({ error: 'already settled in a payroll record' });
    await pool.query(`DELETE FROM payroll_advances WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ PAYMENTS HISTORY ═══════════════ */

router.get('/payroll/payments', async (req, res) => {
  try {
    const { master_id, from, to } = req.query;
    const where = [], args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (from) { args.push(from); where.push(`paid_at >= $${args.length}::date`); }
    if (to) { args.push(to); where.push(`paid_at < ($${args.length}::date + INTERVAL '1 day')`); }
    const sql = `SELECT * FROM payroll_payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY paid_at DESC LIMIT 300`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ FINANCIAL ANALYTICS ═══════════════ */

// GET /api/payroll/statistics?from=&to= — фонд оплаты труда, начислено, выплачено, задолженность
router.get('/payroll/statistics', async (req, res) => {
  try {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    // расчёты за период (по дате начала периода)
    const recs = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt, COALESCE(SUM(total),0)::numeric AS sum_total,
              COALESCE(SUM(services_revenue),0)::numeric AS rev
         FROM payroll_records
        WHERE period_start >= $1::date AND period_start <= $2::date
        GROUP BY status`,
      [from, to]
    );
    let accrued = 0, paid = 0, draft = 0, approved = 0, revenue = 0;
    for (const r of recs.rows) {
      const t = parseFloat(r.sum_total);
      accrued += t; revenue += parseFloat(r.rev);
      if (r.status === 'paid') paid += t;
      else if (r.status === 'approved') approved += t;
      else if (r.status === 'draft') draft += t;
    }
    // по мастерам — эффективность (выручка vs начислено)
    const byMaster = await pool.query(
      `SELECT master_id, master_name,
              COALESCE(SUM(total),0)::numeric AS payroll,
              COALESCE(SUM(services_revenue),0)::numeric AS revenue,
              COALESCE(SUM(services_count),0)::int AS visits
         FROM payroll_records
        WHERE period_start >= $1::date AND period_start <= $2::date
        GROUP BY master_id, master_name
        ORDER BY revenue DESC`,
      [from, to]
    );
    const advOpen = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM payroll_advances WHERE settled=FALSE`);
    res.json({
      period: { from, to },
      fund: accrued,                      // фонд оплаты труда (начислено всего)
      accrued, paid, debt: accrued - paid, // задолженность = начислено − выплачено
      draft, approved, revenue,
      payroll_ratio: revenue > 0 ? +(accrued / revenue * 100).toFixed(1) : 0, // % ЗП от выручки
      open_advances: parseFloat(advOpen.rows[0].s),
      by_master: byMaster.rows.map(m => ({
        ...m,
        payroll: parseFloat(m.payroll), revenue: parseFloat(m.revenue),
        ratio: parseFloat(m.revenue) > 0 ? +(parseFloat(m.payroll) / parseFloat(m.revenue) * 100).toFixed(1) : 0
      }))
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ PAYSLIP (расчётный лист) ═══════════════ */

// GET /api/payroll/payslip/:id — детализация начислений и удержаний по расчёту
router.get('/payroll/payslip/:id', async (req, res) => {
  try {
    const rec = await pool.query(`SELECT * FROM payroll_records WHERE id=$1`, [req.params.id]);
    const r = rec.rows[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    const scheme = await pool.query(`SELECT scheme_type, percent, fixed_per_day, fixed_per_month, sales_commission_pct FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE LIMIT 1`, [r.master_id]);
    const bonuses = await pool.query(`SELECT id, amount, kind, reason, bonus_date FROM payroll_bonuses WHERE applied_record_id=$1 ORDER BY bonus_date`, [r.id]);
    const penalties = await pool.query(`SELECT id, amount, kind, reason, penalty_date FROM payroll_penalties WHERE applied_record_id=$1 ORDER BY penalty_date`, [r.id]);
    const advances = await pool.query(`SELECT id, amount, reason, issued_at FROM payroll_advances WHERE settled_record_id=$1 ORDER BY issued_at`, [r.id]);
    const payment = await pool.query(`SELECT amount, method, paid_at, created_by_name FROM payroll_payments WHERE record_id=$1 ORDER BY paid_at DESC LIMIT 1`, [r.id]);
    res.json({
      record: r,
      scheme: scheme.rows[0] || null,
      earnings: {
        services: { count: r.services_count, revenue: parseFloat(r.services_revenue), part: parseFloat(r.percent_part) },
        fixed: parseFloat(r.fixed_part),
        sales: { revenue: parseFloat(r.sales_revenue || 0), part: parseFloat(r.sales_part || 0) },
        bonuses: bonuses.rows
      },
      deductions: {
        penalties: penalties.rows,
        advances: advances.rows,
        total: parseFloat(r.deduction)
      },
      total: parseFloat(r.total),
      payment: payment.rows[0] || null
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ MASTER SELF-VIEW ═══════════════ */

// GET /api/payroll/my — мастер видит свои начисления/бонусы/штрафы/авансы/выплаты
router.get('/payroll/my', async (req, res) => {
  try {
    const mid = req.user?.master_id;
    if (!mid) return res.status(403).json({ error: 'no master linked to this account' });
    const [records, bonuses, penalties, advances, payments, scheme] = await Promise.all([
      pool.query(`SELECT id, period_start, period_end, services_count, services_revenue, total, status FROM payroll_records WHERE master_id=$1 ORDER BY period_start DESC LIMIT 24`, [mid]),
      pool.query(`SELECT amount, kind, reason, bonus_date FROM payroll_bonuses WHERE master_id=$1 ORDER BY bonus_date DESC LIMIT 50`, [mid]),
      pool.query(`SELECT amount, kind, reason, penalty_date FROM payroll_penalties WHERE master_id=$1 ORDER BY penalty_date DESC LIMIT 50`, [mid]),
      pool.query(`SELECT amount, reason, issued_at, settled FROM payroll_advances WHERE master_id=$1 ORDER BY issued_at DESC LIMIT 50`, [mid]),
      pool.query(`SELECT amount, method, paid_at, period_start, period_end FROM payroll_payments WHERE master_id=$1 ORDER BY paid_at DESC LIMIT 50`, [mid]),
      pool.query(`SELECT * FROM payroll_schemes WHERE master_id=$1 AND is_active=TRUE LIMIT 1`, [mid])
    ]);

    // Живая оценка текущего месяца — чтобы мастер видел сколько уже наработал,
    // даже если хозяин ещё не закрыл расчётный период. Формула = как в /calculate.
    let current = null;
    const s = scheme.rows[0];
    if (s) {
      const ob = await pool.query(
        `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(COALESCE(real_amount, price)),0)::numeric AS revenue
           FROM appointments
          WHERE master_id=$1::int AND (status IN ('done','completed') OR (status='confirmed' AND real_synced_at IS NOT NULL))
            AND starts_at >= date_trunc('month', NOW())
            AND starts_at <  (date_trunc('month', NOW()) + INTERVAL '1 month')`, [mid]);
      const cnt = ob.rows[0]?.cnt || 0;
      const revenue = parseFloat(ob.rows[0]?.revenue || 0);
      let percent_part = 0, fixed_part = 0;
      if (s.scheme_type === 'percent' || s.scheme_type === 'hybrid') percent_part = revenue * (parseFloat(s.percent || 0) / 100);
      if (s.scheme_type === 'fixed' || s.scheme_type === 'hybrid') {
        if (s.fixed_per_month) fixed_part = parseFloat(s.fixed_per_month);
        else if (s.fixed_per_day) {
          const days = new Date().getDate();
          fixed_part = parseFloat(s.fixed_per_day) * days;
        }
      }
      const bsum = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM payroll_bonuses WHERE master_id=$1 AND applied_record_id IS NULL AND bonus_date >= date_trunc('month',NOW())`, [mid]);
      const psum = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM payroll_penalties WHERE master_id=$1 AND applied_record_id IS NULL AND penalty_date >= date_trunc('month',NOW())`, [mid]);
      const asum = await pool.query(`SELECT COALESCE(SUM(amount),0)::numeric s FROM payroll_advances WHERE master_id=$1 AND settled=FALSE AND issued_at >= date_trunc('month',NOW())`, [mid]);
      const bonus = parseFloat(bsum.rows[0].s), penalty = parseFloat(psum.rows[0].s), advance = parseFloat(asum.rows[0].s);
      const earned = percent_part + fixed_part + bonus;
      current = {
        period_start: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10),
        services_count: cnt, services_revenue: revenue,
        scheme_type: s.scheme_type, percent: parseFloat(s.percent || 0),
        percent_part: Math.round(percent_part), fixed_part: Math.round(fixed_part),
        bonus, penalty, advance,
        earned: Math.round(earned),
        to_pay: Math.round(earned - penalty - advance),
        estimate: true
      };
    }
    res.json({ master_id: mid, current, records: records.rows, bonuses: bonuses.rows, penalties: penalties.rows, advances: advances.rows, payments: payments.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ SUPPLIERS ═══════════════ */

router.post('/suppliers', async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await pool.query(
      `INSERT INTO suppliers (name, phone, email, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
      [name, phone || null, email || null, notes || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/suppliers', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM suppliers ORDER BY name`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/suppliers/:id', async (req, res) => {
  try {
    const { name, phone, email, notes } = req.body || {};
    const r = await pool.query(
      `UPDATE suppliers SET name=COALESCE($2,name), phone=$3, email=$4, notes=$5 WHERE id=$1 RETURNING id`,
      [req.params.id, name || null, phone || null, email || null, notes || null]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/suppliers/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM suppliers WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ STOCK RECEIPTS (поставки) ═══════════════ */

router.post('/stock/receipts', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { supplier_id, invoice_no, items, notes } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'items array required' });
    }
    const total = items.reduce((s, it) => s + (parseFloat(it.qty) * parseFloat(it.unit_cost)), 0);
    const rcp = await client.query(
      `INSERT INTO stock_receipts (supplier_id, invoice_no, total_cost, notes)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [supplier_id || null, invoice_no || null, total, notes || null]
    );
    const receipt_id = rcp.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO stock_receipt_items (receipt_id, product_id, product_name, qty, unit_cost)
         VALUES ($1,$2,$3,$4,$5)`,
        [receipt_id, it.product_id || null, it.product_name || null, it.qty, it.unit_cost]
      );
      // и обновляем stock в products если есть product_id
      if (it.product_id) {
        await client.query(
          `UPDATE products SET stock = COALESCE(stock,0) + $1 WHERE id=$2`,
          [it.qty, it.product_id]
        );
        await client.query(
          `INSERT INTO stock_movements (product_id, delta, reason, notes)
           VALUES ($1,$2,'receipt',$3)`,
          [it.product_id, it.qty, `receipt #${receipt_id}`]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, receipt_id, total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

router.get('/stock/receipts', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.*, s.name AS supplier_name,
              (SELECT COUNT(*)::int FROM stock_receipt_items WHERE receipt_id=r.id) AS items_count
       FROM stock_receipts r LEFT JOIN suppliers s ON s.id=r.supplier_id
       ORDER BY r.received_at DESC LIMIT 200`
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/stock/receipts/:id', async (req, res) => {
  try {
    const head = await pool.query(
      `SELECT r.*, s.name AS supplier_name FROM stock_receipts r LEFT JOIN suppliers s ON s.id=r.supplier_id WHERE r.id=$1`,
      [req.params.id]
    );
    if (!head.rows[0]) return res.status(404).json({ error: 'not found' });
    const items = await pool.query(`SELECT * FROM stock_receipt_items WHERE receipt_id=$1 ORDER BY id`, [req.params.id]);
    res.json({ ...head.rows[0], items: items.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

/* ═══════════════ MATERIAL CONSUMPTION (списания мастером) ═══════════════ */

router.post('/stock/consumption', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { appointment_id, master_id, product_id, product_name, qty, unit_cost } = req.body || {};
    if (!qty || qty <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'qty > 0 required' });
    }
    const r = await client.query(
      `INSERT INTO material_consumption (appointment_id, master_id, product_id, product_name, qty, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, total_cost`,
      [appointment_id || null, master_id || null, product_id || null, product_name || null, qty, unit_cost || null]
    );
    if (product_id) {
      await client.query(`UPDATE products SET stock = GREATEST(COALESCE(stock,0) - $1, 0) WHERE id=$2`, [qty, product_id]);
      await client.query(
        `INSERT INTO stock_movements (product_id, delta, reason, notes)
         VALUES ($1,$2,'consumption',$3)`,
        [product_id, -qty, `master ${master_id || 'unknown'} appointment ${appointment_id || '?'}`]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, id: r.rows[0].id, total_cost: r.rows[0].total_cost });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  } finally { client.release(); }
});

router.get('/stock/consumption', async (req, res) => {
  try {
    const { master_id, from, to, limit = 200 } = req.query;
    const where = [];
    const args = [];
    if (master_id) { args.push(master_id); where.push(`master_id=$${args.length}`); }
    if (from) { args.push(from); where.push(`consumed_at >= $${args.length}::date`); }
    if (to) { args.push(to); where.push(`consumed_at < ($${args.length}::date + INTERVAL '1 day')`); }
    args.push(parseInt(limit));
    const sql = `SELECT * FROM material_consumption ${where.length ? 'WHERE '+where.join(' AND ') : ''}
                 ORDER BY consumed_at DESC LIMIT $${args.length}`;
    const r = await pool.query(sql, args);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
