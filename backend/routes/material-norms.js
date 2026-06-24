/* routes/material-norms.js — SAL-08 Procedure Materials.
   Нормативные карты расхода (с коэффициентами длина/густота), журнал фактического
   расхода с отклонениями факт-vs-норма, расчёт себестоимости и маржинальности услуг,
   прогноз закупки. Себестоимость = wholesale (опт) товара пропорционально расходу.
   Базовый service_consumables (027) остаётся для простой привязки; здесь — полный слой.
   Доступ: GET — settings.read нет, оставляю открытым для master-UI; мутации — settings.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const W = requirePerm('settings.write');

const parseVol = (v) => { const m = String(v || '').match(/[\d.]+/); return m ? parseFloat(m[0]) : null; };
function lengthCoeff(m, len) {
  return ({ short: m.coeff_short, medium: m.coeff_medium, long: m.coeff_long, extra_long: m.coeff_extra_long }[len]) ?? m.coeff_medium;
}
function densityCoeff(m, dens) {
  return ({ thin: m.coeff_thin, normal: m.coeff_normal, thick: m.coeff_thick }[dens]) ?? m.coeff_normal;
}
// себестоимость порции: опт.цена * (расход / объём упаковки). Если объём не распарсить — опт за 1 шт.
function unitCost(variant, qty) {
  const cost = Number(variant.wholesale ?? variant.price ?? 0);
  const pkg = parseVol(variant.volume);
  if (pkg && pkg > 0) return +(cost * qty / pkg).toFixed(2);
  return +(cost * qty).toFixed(2);
}

// ═══ НОРМАТИВНЫЕ КАРТЫ ═══════════════════════════════════════════════════════

// GET / — список карт
router.get('/', async (req, res) => {
  try {
    const where = []; const vals = [];
    if (req.query.service_id) { vals.push(req.query.service_id); where.push(`n.service_id=$${vals.length}`); }
    if (req.query.status) { vals.push(req.query.status); where.push(`n.status=$${vals.length}`); }
    if (req.query.search) { vals.push(`%${req.query.search}%`); where.push(`n.name ILIKE $${vals.length}`); }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const W2 = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const items = await q(
      `SELECT n.*, s.name AS service_name,
              (SELECT COUNT(*) FROM procedure_materials pm WHERE pm.norm_id=n.id)::int AS materials_count
         FROM material_norms n LEFT JOIN services s ON s.id=n.service_id
         ${W2} ORDER BY n.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, vals);
    const total = (await q(`SELECT COUNT(*)::int c FROM material_norms n ${W2}`, vals))[0].c;
    res.json({ items, total });
  } catch (e) { console.error('[material-norms]', e.message); res.status(500).json({ error: e.message }); }
});

// GET /by-service/:serviceId
router.get('/by-service/:serviceId(\\d+)', async (req, res) => {
  try {
    res.json({ items: await q(`SELECT * FROM material_norms WHERE service_id=$1 ORDER BY status, name`, [req.params.serviceId]) });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /:id — карта с материалами
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const norm = (await q(`SELECT * FROM material_norms WHERE id=$1`, [req.params.id]))[0];
    if (!norm) return res.status(404).json({ error: 'not-found' });
    const materials = await q(
      `SELECT pm.*, p.name AS product_name, pv.volume, pv.sku, pv.wholesale, pv.price, pv.stock_qty
         FROM procedure_materials pm
         JOIN product_variants pv ON pv.id=pm.variant_id
         LEFT JOIN products p ON p.id=pv.product_id
        WHERE pm.norm_id=$1 ORDER BY pm.sort_order, pm.id`, [req.params.id]);
    res.json({ norm, materials });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST / — создать карту + материалы
router.post('/', W, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name обовʼязковий' });
    await client.query('BEGIN');
    const norm = (await client.query(
      `INSERT INTO material_norms (service_id,service_variant,name,description,status,created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'active'),$6) RETURNING *`,
      [b.service_id || null, b.service_variant || null, b.name, b.description || null, b.status || null, b.created_by || null]
    )).rows[0];
    for (const m of (b.materials || [])) {
      if (!m.variant_id || m.quantity == null) continue;
      await client.query(
        `INSERT INTO procedure_materials (norm_id,variant_id,quantity,unit,coeff_short,coeff_medium,coeff_long,coeff_extra_long,coeff_thin,coeff_normal,coeff_thick,is_required,sort_order)
         VALUES ($1,$2,$3,COALESCE($4,'g'),COALESCE($5,0.70),COALESCE($6,1.00),COALESCE($7,1.50),COALESCE($8,2.00),COALESCE($9,0.80),COALESCE($10,1.00),COALESCE($11,1.30),COALESCE($12,TRUE),COALESCE($13,0))
         ON CONFLICT (norm_id,variant_id) DO NOTHING`,
        [norm.id, m.variant_id, m.quantity, m.unit, m.coeff_short, m.coeff_medium, m.coeff_long, m.coeff_extra_long, m.coeff_thin, m.coeff_normal, m.coeff_thick, m.is_required, m.sort_order]
      );
    }
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'material.norm.create', entity: 'material_norm', entity_id: norm.id });
    res.status(201).json(norm);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// PATCH /:id — обновить карту (+опц. полная замена материалов)
router.patch('/:id(\\d+)', W, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    await client.query('BEGIN');
    const set = [], vals = [];
    for (const f of ['service_id', 'service_variant', 'name', 'description', 'status']) {
      if (b[f] !== undefined) { set.push(`${f}=$${vals.length + 1}`); vals.push(b[f]); }
    }
    if (set.length) {
      set.push('updated_at=NOW()'); vals.push(id);
      await client.query(`UPDATE material_norms SET ${set.join(', ')} WHERE id=$${vals.length}`, vals);
    }
    if (Array.isArray(b.materials)) {
      await client.query(`DELETE FROM procedure_materials WHERE norm_id=$1`, [id]);
      for (const m of b.materials) {
        if (!m.variant_id || m.quantity == null) continue;
        await client.query(
          `INSERT INTO procedure_materials (norm_id,variant_id,quantity,unit,coeff_short,coeff_medium,coeff_long,coeff_extra_long,coeff_thin,coeff_normal,coeff_thick,is_required,sort_order)
           VALUES ($1,$2,$3,COALESCE($4,'g'),COALESCE($5,0.70),COALESCE($6,1.00),COALESCE($7,1.50),COALESCE($8,2.00),COALESCE($9,0.80),COALESCE($10,1.00),COALESCE($11,1.30),COALESCE($12,TRUE),COALESCE($13,0))`,
          [id, m.variant_id, m.quantity, m.unit, m.coeff_short, m.coeff_medium, m.coeff_long, m.coeff_extra_long, m.coeff_thin, m.coeff_normal, m.coeff_thick, m.is_required, m.sort_order]
        );
      }
    }
    await client.query('COMMIT');
    const norm = (await q(`SELECT * FROM material_norms WHERE id=$1`, [id]))[0];
    if (!norm) return res.status(404).json({ error: 'not-found' });
    res.json(norm);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// DELETE /:id — архивировать
router.delete('/:id(\\d+)', W, async (req, res) => {
  try {
    const row = (await q(`UPDATE material_norms SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /:id/duplicate — дублировать карту с материалами
router.post('/:id(\\d+)/duplicate', W, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    await client.query('BEGIN');
    const src = (await client.query(`SELECT * FROM material_norms WHERE id=$1`, [id])).rows[0];
    if (!src) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    const copy = (await client.query(
      `INSERT INTO material_norms (service_id,service_variant,name,description,status,created_by)
       VALUES ($1,$2,$3,$4,'draft',$5) RETURNING *`,
      [src.service_id, src.service_variant, src.name + ' (копія)', src.description, src.created_by]
    )).rows[0];
    await client.query(
      `INSERT INTO procedure_materials (norm_id,variant_id,quantity,unit,coeff_short,coeff_medium,coeff_long,coeff_extra_long,coeff_thin,coeff_normal,coeff_thick,is_required,sort_order)
       SELECT $1,variant_id,quantity,unit,coeff_short,coeff_medium,coeff_long,coeff_extra_long,coeff_thin,coeff_normal,coeff_thick,is_required,sort_order
         FROM procedure_materials WHERE norm_id=$2`, [copy.id, id]);
    await client.query('COMMIT');
    res.status(201).json({ id: copy.id });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ═══ ФАКТИЧЕСКИЙ РАСХОД (ЖУРНАЛ) ═════════════════════════════════════════════

// GET /consumption — лог расхода
router.get('/consumption', async (req, res) => {
  try {
    const where = ['mcl.reversed=FALSE']; const vals = [];
    for (const [k, col] of [['branch_id', 'mcl.branch_id'], ['employee_id', 'mcl.employee_id'], ['variant_id', 'mcl.variant_id'], ['product_id', 'p.id']]) {
      if (req.query[k]) { vals.push(req.query[k]); where.push(`${col}=$${vals.length}`); }
    }
    if (req.query.date_from) { vals.push(req.query.date_from); where.push(`mcl.created_at::date >= $${vals.length}`); }
    if (req.query.date_to) { vals.push(req.query.date_to); where.push(`mcl.created_at::date <= $${vals.length}`); }
    if (req.query.deviation_only === 'true') where.push(`mcl.deviation_pct IS NOT NULL AND ABS(mcl.deviation_pct) > 0`);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const W2 = 'WHERE ' + where.join(' AND ');
    const items = await q(
      `SELECT mcl.*, p.name AS product_name, pv.volume
         FROM material_consumption_log mcl
         JOIN product_variants pv ON pv.id=mcl.variant_id
         LEFT JOIN products p ON p.id=pv.product_id
         ${W2} ORDER BY mcl.created_at DESC LIMIT ${limit} OFFSET ${offset}`, vals);
    const total = (await q(`SELECT COUNT(*)::int c FROM material_consumption_log mcl JOIN product_variants pv ON pv.id=mcl.variant_id LEFT JOIN products p ON p.id=pv.product_id ${W2}`, vals))[0].c;
    res.json({ items, total });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /consumption/write-off — списание по визиту (авто из норм + ручные правки)
// Body: { appointment_id, service_id?, hair_length?, hair_density?, items?:[{variant_id,actual_quantity,deviation_reason,deviation_note}] }
router.post('/consumption/write-off', W, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.appointment_id) return res.status(400).json({ error: 'appointment_id обовʼязковий' });
    await client.query('BEGIN');
    // контекст визита
    const ap = (await client.query(`SELECT id, service_id, master_id, client_id FROM appointments WHERE id=$1`, [b.appointment_id])).rows[0];
    const serviceId = b.service_id || ap?.service_id;
    // активная норма услуги
    const norm = (await client.query(
      `SELECT id FROM material_norms WHERE service_id=$1 AND status='active' ORDER BY id LIMIT 1`, [serviceId])).rows[0];
    const lenC = b.hair_length || 'medium';
    const denC = b.hair_density || 'normal';
    const manual = {}; for (const it of (b.items || [])) manual[it.variant_id] = it;
    const logged = [];
    if (norm) {
      const mats = (await client.query(
        `SELECT pm.*, pv.wholesale, pv.price, pv.volume, pv.stock_qty FROM procedure_materials pm
           JOIN product_variants pv ON pv.id=pm.variant_id WHERE pm.norm_id=$1`, [norm.id])).rows;
      for (const m of mats) {
        const normQty = +(Number(m.quantity) * lengthCoeff(m, lenC) * densityCoeff(m, denC)).toFixed(2);
        const mi = manual[m.variant_id];
        const actualQty = mi && mi.actual_quantity != null ? Number(mi.actual_quantity) : null;
        const usedQty = actualQty != null ? actualQty : normQty;
        const dev = actualQty != null && normQty > 0 ? +(((actualQty - normQty) / normQty) * 100).toFixed(1) : null;
        const costNorm = unitCost(m, normQty);
        const costActual = unitCost(m, usedQty);
        const row = (await client.query(
          `INSERT INTO material_consumption_log
             (appointment_id,service_id,employee_id,branch_id,client_id,variant_id,norm_quantity,actual_quantity,unit,deviation_pct,deviation_reason,deviation_note,cost_norm,cost_actual,auto_written_off)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [b.appointment_id, serviceId, ap?.master_id || null, b.branch_id || null, ap?.client_id || null, m.variant_id,
           normQty, actualQty, m.unit, dev, mi?.deviation_reason || null, mi?.deviation_note || null, costNorm, costActual, actualQty == null]
        )).rows[0];
        // склад: списываем целыми единицами только для pcs/pair
        if ((m.unit === 'pcs' || m.unit === 'pair') && Number.isFinite(usedQty)) {
          await client.query(`UPDATE product_variants SET stock_qty = stock_qty - $1 WHERE id=$2`, [Math.round(usedQty), m.variant_id]);
        }
        logged.push(row);
      }
    }
    await client.query('COMMIT');
    await logAction({ user: req.user, action: 'material.writeoff', entity: 'appointment', entity_id: b.appointment_id, meta: { items: logged.length } });
    res.json({ ok: true, written: logged.length, items: logged, norm_found: !!norm });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// POST /consumption/reverse — отмена списания визита
router.post('/consumption/reverse', W, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    if (!b.appointment_id) return res.status(400).json({ error: 'appointment_id обовʼязковий' });
    await client.query('BEGIN');
    const rows = (await client.query(
      `SELECT * FROM material_consumption_log WHERE appointment_id=$1 AND reversed=FALSE`, [b.appointment_id])).rows;
    for (const r of rows) {
      if ((r.unit === 'pcs' || r.unit === 'pair')) {
        const back = Math.round(Number(r.actual_quantity ?? r.norm_quantity));
        await client.query(`UPDATE product_variants SET stock_qty = stock_qty + $1 WHERE id=$2`, [back, r.variant_id]);
      }
    }
    await client.query(`UPDATE material_consumption_log SET reversed=TRUE WHERE appointment_id=$1 AND reversed=FALSE`, [b.appointment_id]);
    await client.query('COMMIT');
    res.json({ ok: true, reversed: rows.length });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// GET /consumption/report?group_by=product|service|employee
router.get('/consumption/report', async (req, res) => {
  try {
    const gb = { product: 'mcl.variant_id', service: 'mcl.service_id', employee: 'mcl.employee_id' }[req.query.group_by] || 'mcl.variant_id';
    const where = ['mcl.reversed=FALSE']; const vals = [];
    if (req.query.branch_id) { vals.push(req.query.branch_id); where.push(`mcl.branch_id=$${vals.length}`); }
    if (req.query.date_from) { vals.push(req.query.date_from); where.push(`mcl.created_at::date >= $${vals.length}`); }
    if (req.query.date_to) { vals.push(req.query.date_to); where.push(`mcl.created_at::date <= $${vals.length}`); }
    const rows = await q(
      `SELECT ${gb} AS group_key,
              COALESCE(SUM(mcl.norm_quantity),0)::numeric AS norm_total,
              COALESCE(SUM(COALESCE(mcl.actual_quantity,mcl.norm_quantity)),0)::numeric AS actual_total,
              COALESCE(SUM(COALESCE(mcl.cost_actual,mcl.cost_norm)),0)::numeric AS cost
         FROM material_consumption_log mcl
        WHERE ${where.join(' AND ')} GROUP BY ${gb} ORDER BY cost DESC`, vals);
    rows.forEach(r => {
      r.norm_total = Number(r.norm_total); r.actual_total = Number(r.actual_total); r.cost = Number(r.cost);
      r.deviation_pct = r.norm_total > 0 ? +(((r.actual_total - r.norm_total) / r.norm_total) * 100).toFixed(1) : 0;
    });
    res.json({ rows, totals: { cost: rows.reduce((s, r) => s + r.cost, 0) } });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /consumption/forecast?days_ahead=14 — прогноз расхода по будущим записям
router.get('/consumption/forecast', async (req, res) => {
  try {
    const days = parseInt(req.query.days_ahead, 10) || 14;
    // средний дневной расход по факту за прошлые 30 дней на вариант
    const rows = await q(
      `SELECT mcl.variant_id, p.name AS product_name, pv.stock_qty, pv.volume,
              COALESCE(SUM(COALESCE(mcl.actual_quantity,mcl.norm_quantity)),0)::numeric AS used_30d
         FROM material_consumption_log mcl
         JOIN product_variants pv ON pv.id=mcl.variant_id
         LEFT JOIN products p ON p.id=pv.product_id
        WHERE mcl.reversed=FALSE AND mcl.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY mcl.variant_id, p.name, pv.stock_qty, pv.volume`);
    const items = rows.map(r => {
      const perDay = Number(r.used_30d) / 30;
      const pkg = parseVol(r.volume) || 1;
      const stockUnits = Number(r.stock_qty) * pkg; // запас в тех же единицах что расход
      const forecastQty = +(perDay * days).toFixed(2);
      const daysUntilEmpty = perDay > 0 ? Math.floor(stockUnits / perDay) : null;
      return { product_id: r.variant_id, product_name: r.product_name, forecast_qty: forecastQty, stock_qty: Number(r.stock_qty), days_until_empty: daysUntilEmpty };
    }).sort((a, b) => (a.days_until_empty ?? 1e9) - (b.days_until_empty ?? 1e9));
    res.json({ days_ahead: days, items });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ═══ СЕБЕСТОИМОСТЬ И МАРЖА ═══════════════════════════════════════════════════

// GET /service/:id/cost — себестоимость услуги по активной норме
router.get('/service/:id(\\d+)/cost', async (req, res) => {
  try {
    const sid = Number(req.params.id);
    const service = (await q(`SELECT id, name, price FROM services WHERE id=$1`, [sid]))[0];
    if (!service) return res.status(404).json({ error: 'service not-found' });
    const norm = (await q(`SELECT id FROM material_norms WHERE service_id=$1 AND status='active' ORDER BY id LIMIT 1`, [sid]))[0];
    let materials = [], normCost = 0;
    if (norm) {
      const mats = await q(
        `SELECT pm.quantity, pm.unit, pv.id AS variant_id, p.name AS product_name, pv.wholesale, pv.price, pv.volume
           FROM procedure_materials pm JOIN product_variants pv ON pv.id=pm.variant_id
           LEFT JOIN products p ON p.id=pv.product_id WHERE pm.norm_id=$1`, [norm.id]);
      materials = mats.map(m => { const c = unitCost(m, Number(m.quantity)); normCost += c; return { ...m, cost: c }; });
    }
    normCost = +normCost.toFixed(2);
    // средняя фактическая себестоимость по логу
    const avgActual = Number((await q(
      `SELECT COALESCE(AVG(per_visit),0)::numeric avg FROM (
         SELECT appointment_id, SUM(COALESCE(cost_actual,cost_norm)) per_visit
           FROM material_consumption_log WHERE service_id=$1 AND reversed=FALSE
          GROUP BY appointment_id) t`, [sid]))[0].avg);
    const price = Number(service.price || 0);
    const margin = price > 0 ? +(((price - normCost) / price) * 100).toFixed(1) : null;
    res.json({ service, norm_cost: normCost, avg_actual_cost: +avgActual.toFixed(2), margin_pct: margin, materials });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// GET /reports/profitability — маржинальность всех услуг с нормами
router.get('/reports/profitability', async (req, res) => {
  try {
    const norms = await q(
      `SELECT DISTINCT n.service_id, s.name, s.price FROM material_norms n
         JOIN services s ON s.id=n.service_id WHERE n.status='active' AND n.service_id IS NOT NULL`);
    const items = [];
    for (const s of norms) {
      const mats = await q(
        `SELECT pm.quantity, pv.wholesale, pv.price, pv.volume FROM procedure_materials pm
           JOIN product_variants pv ON pv.id=pm.variant_id
          WHERE pm.norm_id IN (SELECT id FROM material_norms WHERE service_id=$1 AND status='active')`, [s.service_id]);
      let cost = 0; for (const m of mats) cost += unitCost(m, Number(m.quantity));
      cost = +cost.toFixed(2);
      const price = Number(s.price || 0);
      items.push({ service_id: s.service_id, service: s.name, revenue: price, cost, margin_pct: price > 0 ? +(((price - cost) / price) * 100).toFixed(1) : null });
    }
    items.sort((a, b) => (b.margin_pct ?? -1e9) - (a.margin_pct ?? -1e9));
    res.json({ items, totals: { count: items.length } });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
