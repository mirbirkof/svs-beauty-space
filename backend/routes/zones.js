/* Зали / напрямки салону (заметка #76) — дохід/витрати/прибуток по групах майстрів.
 *
 * Модель: зал = група майстрів. Виручка послуг групується по майстру ПРОДАЖУ
 * (cash_operations.sale_service.master_id) → точно збігається із загальною виручкою
 * послуг liveFinance (на відміну від appointments.real_amount, який неповний: 218k проти 244k).
 * Комісія/оклади/матеріали рахуються ТИМИ САМИМИ формулами, що й liveFinance — тож
 * сума всіх залів дорівнює канонічним цифрам Фінцентру (нічого не «двоїться», 2+2=4).
 *
 * Витрати залу = нарахований % майстрам залу + оклади (пропорційно) + матеріали (% від
 * виручки залу) + частка спільних витрат (оренда/реклама/інше) пропорційно частці виручки.
 *
 * Mount: /api/zones (shop-api.js)
 */
const express = require('express');
const { getPool, applyTenant } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { MATLINES_CTE, COMMISSION_EXPR } = require('../lib/payroll-base');
const router = express.Router();
const pool = getPool();

// GET → читання звітів, мутації → керування (власник). owner '*' проходить завжди.
router.use((req, res, next) => requirePerm(req.method === 'GET' ? 'reports.read' : 'reports.write')(req, res, next));

// Межі періоду як у Фінцентрі/liveFinance: повний день за Києвом.
function bounds(q) {
  const today = new Date().toISOString().slice(0, 10);
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = (q.from && re.test(q.from)) ? q.from : today.slice(0, 8) + '01';
  const to = (q.to && re.test(q.to)) ? q.to : today;
  return { from, to, fromTs: `${from} 00:00:00+03`, toTs: `${to} 23:59:59+03` };
}

// Дефолтний мапінг спеціальності майстра → назва залу (для авто-засіву).
function specialtyToZone(spec) {
  const s = String(spec || '').toLowerCase();
  if (/манікюр|манікюр|nail|ніг/.test(s)) return 'Манікюр';
  if (/перукар|колорист|hair|волосс/.test(s)) return 'Перукарський зал';
  if (/лешмейкер|брів|вій|lash|brow/.test(s)) return 'Брови та вії';
  if (/масаж|massage|тіло/.test(s)) return 'Масаж та тіло';
  if (/візаж|макіяж|make/.test(s)) return 'Візаж';
  if (/адмін|admin|ресепшн/.test(s)) return null; // адміни без залу
  return 'Інші напрямки';
}
const ZONE_PALETTE = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

// Авто-засів залів із спеціальностей майстрів (ідемпотентно). Викликається з /config,
// якщо залів ще немає — щоб у Боса одразу були готові зали, які він потім перейменує.
async function seedZonesIfEmpty() {
  const have = await pool.query('SELECT COUNT(*)::int n FROM salon_zones');
  if (have.rows[0].n > 0) return;
  const masters = await pool.query(
    `SELECT id, specialty, staff_role FROM masters WHERE COALESCE(active,true)=true`);
  const byZone = new Map(); // zoneName → [masterId]
  for (const m of masters.rows) {
    if (String(m.staff_role || '').toLowerCase() === 'admin') continue;
    const zn = specialtyToZone(m.specialty);
    if (!zn) continue;
    if (!byZone.has(zn)) byZone.set(zn, []);
    byZone.get(zn).push(m.id);
  }
  let sort = 0;
  for (const [name, ids] of byZone) {
    const color = ZONE_PALETTE[sort % ZONE_PALETTE.length];
    const z = await pool.query(
      'INSERT INTO salon_zones (name, color, sort_order) VALUES ($1,$2,$3) RETURNING id', [name, color, sort++]);
    for (const mid of ids) {
      await pool.query('INSERT INTO zone_masters (zone_id, master_id) VALUES ($1,$2) ON CONFLICT (master_id) DO NOTHING', [z.rows[0].id, mid]);
    }
  }
}

// ── Аналітика по залах за період ───────────────────────────────────────
// GET /api/zones?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', async (req, res) => {
  try {
    await seedZonesIfEmpty();
    const { from, to, fromTs, toTs } = bounds(req.query);
    const days = Math.max(1, Math.round((new Date(toTs) - new Date(fromTs)) / 86400000));

    const [zonesR, mapR, revR, commR, fixedR, finSetR, prodR, cogsR, otherR] = await Promise.all([
      pool.query('SELECT id, name, color, sort_order FROM salon_zones WHERE active=true ORDER BY sort_order, id'),
      pool.query('SELECT zone_id, master_id FROM zone_masters'),
      // виручка послуг по майстру (= джерело правди по виручці)
      pool.query(`SELECT master_id, COALESCE(SUM(amount),0)::float rev, COUNT(*)::int cnt
                    FROM cash_operations
                   WHERE type='in' AND category IN ('sale_service','sale_product') AND created_at BETWEEN $1 AND $2
                     AND master_id IS NOT NULL -- зал = продажі майстра; без майстра → бакет «магазин» (інакше двоїлось, аудит 06.07)
                   GROUP BY master_id`, [fromTs, toTs]),
      // нарахований % по майстру — ТА САМА формула, що в liveFinance
      pool.query(`WITH matlines AS (${MATLINES_CTE}),
                  da AS (
                    SELECT a.master_id,
                           GREATEST(0, COALESCE(a.real_amount,a.price,0) - COALESCE(ml.mat,0)) rev_labor,
                           COALESCE(a.real_amount,a.price,0) rev_full
                      FROM appointments a LEFT JOIN matlines ml ON ml.aid=a.id
                     WHERE a.starts_at BETWEEN $1 AND $2 AND a.starts_at <= NOW()
                       AND (a.status IN ('done','completed') OR (a.status='confirmed' AND a.real_synced_at IS NOT NULL)))
                  SELECT da.master_id,
                         COALESCE(SUM(${COMMISSION_EXPR('da.rev_labor','da.rev_full')}),0)::float comm
                    FROM da LEFT JOIN payroll_schemes ps ON ps.master_id=da.master_id::text AND ps.is_active=TRUE
                   GROUP BY da.master_id`, [fromTs, toTs]),
      // фікс-оклади по майстру: fixed_per_month (пропорц. періоду) + fixed_per_day × зміни графіка
      pool.query(`WITH sched AS (
                    SELECT master_id, COUNT(*)::int shifts FROM master_schedule_days
                     WHERE work_date >= $1::date AND work_date <= $2::date GROUP BY master_id)
                  SELECT m.id master_id,
                         COALESCE(SUM(COALESCE(ps.fixed_per_month,0)),0)::float fx_month,
                         COALESCE(SUM(COALESCE(ps.fixed_per_day,0) * COALESCE(sc.shifts,0)),0)::float fx_day
                    FROM payroll_schemes ps JOIN masters m ON m.id::text=ps.master_id
                    LEFT JOIN sched sc ON sc.master_id=m.id
                   WHERE ps.is_active=TRUE AND ps.scheme_type IN ('fixed','hybrid') AND m.active=TRUE
                   GROUP BY m.id`, [String(fromTs).slice(0,10), String(toTs).slice(0,10)]),
      pool.query(`SELECT value FROM app_settings WHERE key='finance'`),
      // товари (магазин) — окремий бакет
      pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE category='sale_product' AND ref_type IS DISTINCT FROM 'order' AND master_id IS NULL),0)::float cash_prod
                    FROM cash_operations WHERE type='in' AND created_at BETWEEN $1 AND $2`, [fromTs, toTs]),
      pool.query(`SELECT COALESCE(SUM(ABS(sm.delta)*COALESCE(pv.wholesale,0)),0)::float g
                    FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id
                   WHERE (sm.reason IN ('sale','order') OR sm.reason LIKE 'order:%') AND sm.delta<0
                     AND sm.created_at BETWEEN $1 AND $2`, [fromTs, toTs]),
      // спільні витрати каси (без зарплат — її замінює нарахований %) для алокації по залах
      pool.query(`SELECT COALESCE(SUM(amount),0)::float s FROM cash_operations
                   WHERE type='out' AND category NOT IN ('salary','payroll') AND created_at BETWEEN $1 AND $2`, [fromTs, toTs]),
    ]);

    const ordR = await pool.query(`SELECT COALESCE(SUM(total),0)::float s FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`, [fromTs, toTs]);

    // % з продажу продукції по майстру (банки по продавцю + POS) — щоб сума залів = Фінцентр (аудит 06.07)
    const salesCommR = await pool.query(`
      WITH bottles AS (
        SELECT COALESCE(am.seller_master_id, a.master_id) AS mid, SUM(ROUND(am.qty_used*pv.price,2)) AS rev
          FROM appointment_materials am JOIN appointments a ON a.id=am.appointment_id
          JOIN product_variants pv ON pv.id=am.variant_id
          LEFT JOIN products p ON p.id=pv.product_id LEFT JOIN categories c ON c.id=p.category_id
         WHERE p.price_per_gram IS NULL AND pv.price IS NOT NULL AND a.status IN ('done','completed')
           AND a.starts_at BETWEEN $1 AND $2 AND COALESCE(c.commissionable,TRUE)=TRUE GROUP BY 1),
      pos AS (
        SELECT co.master_id AS mid, SUM(co.amount) AS rev FROM cash_operations co
         WHERE co.type='in' AND co.category='sale_product' AND co.ref_type IS NULL AND co.master_id IS NOT NULL
           AND co.created_at BETWEEN $1 AND $2 GROUP BY 1),
      tot AS (SELECT mid, SUM(rev) rev FROM (SELECT * FROM bottles UNION ALL SELECT * FROM pos) t GROUP BY 1)
      SELECT tot.mid AS master_id, ROUND(tot.rev*COALESCE(ps.sales_commission_pct,0)/100,2)::float comm
        FROM tot LEFT JOIN payroll_schemes ps ON ps.master_id=tot.mid::text AND ps.is_active=TRUE
       WHERE COALESCE(ps.sales_commission_pct,0)>0`, [fromTs, toTs]);

    const materialPct = Number(finSetR.rows[0]?.value?.material_pct || 0);
    const sharedTotal = Number(otherR.rows[0]?.s || 0);

    // master_id → zone_id
    const m2z = new Map();
    for (const r of mapR.rows) m2z.set(Number(r.master_id), r.zone_id);

    // акумулятори по залах + «без залу»
    const acc = new Map(); // zone_id → {revenue, count, commission}
    for (const z of zonesR.rows) acc.set(z.id, { revenue: 0, count: 0, commission: 0 });
    const unassigned = { revenue: 0, count: 0, commission: 0 };

    for (const r of revR.rows) {
      const zid = r.master_id != null ? m2z.get(Number(r.master_id)) : undefined;
      const bucket = zid && acc.has(zid) ? acc.get(zid) : unassigned;
      bucket.revenue += r.rev; bucket.count += r.cnt;
    }
    for (const r of commR.rows) {
      const zid = r.master_id != null ? m2z.get(Number(r.master_id)) : undefined;
      const bucket = zid && acc.has(zid) ? acc.get(zid) : unassigned;
      bucket.commission += r.comm;
    }
    for (const r of fixedR.rows) {
      const zid = m2z.get(Number(r.master_id));
      const bucket = zid && acc.has(zid) ? acc.get(zid) : unassigned;
      bucket.commission += Number(r.fx_month) * (days / 30) + Number(r.fx_day);
    }
    for (const r of salesCommR.rows) {
      const zid = r.master_id != null ? m2z.get(Number(r.master_id)) : undefined;
      const bucket = zid && acc.has(zid) ? acc.get(zid) : unassigned;
      bucket.commission += Number(r.comm);
    }

    const totalSvcRev = [...acc.values()].reduce((a, b) => a + b.revenue, 0) + unassigned.revenue;
    const build = (name, color, b) => {
      const revenue = Math.round(b.revenue);
      const commission = Math.round(b.commission);
      const materials = Math.round(b.revenue * materialPct / 100);
      // спільні витрати — пропорційно частці виручки послуг залу
      const shared = totalSvcRev > 0 ? Math.round(sharedTotal * b.revenue / totalSvcRev) : 0;
      const expense = commission + materials + shared;
      const profit = revenue - expense;
      return { name, color, revenue, count: b.count, commission, materials, shared,
        expense, profit, margin_pct: revenue > 0 ? Math.round(profit / revenue * 100) : 0 };
    };

    const zones = zonesR.rows.map(z => ({ id: z.id, ...build(z.name, z.color, acc.get(z.id)) }));
    if (unassigned.revenue > 0 || unassigned.commission > 0) {
      zones.push({ id: null, ...build('Без залу', '#9ca3af', unassigned) });
    }

    // магазин (товари) — окремий бакет, не зал майстрів
    const prodRev = Math.round(Number(prodR.rows[0]?.cash_prod || 0) + Number(ordR.rows[0]?.s || 0));
    const cogs = Math.round(Number(cogsR.rows[0]?.g || 0));
    const shop = { revenue: prodRev, cogs, profit: prodRev - cogs };

    const totals = {
      revenue: zones.reduce((a, z) => a + z.revenue, 0) + shop.revenue,
      expense: zones.reduce((a, z) => a + z.expense, 0) + shop.cogs,
      profit: zones.reduce((a, z) => a + z.profit, 0) + shop.profit,
      services_revenue: Math.round(totalSvcRev),
    };

    res.json({ from, to, material_pct: materialPct, shared_total: Math.round(sharedTotal), zones, shop, totals });
  } catch (e) { console.error('[zones] analytics', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// ── Керування залами ───────────────────────────────────────────────────
// GET /api/zones/config — зали + їх майстри + майстри без залу (для UI керування)
router.get('/config', async (req, res) => {
  try {
    await seedZonesIfEmpty();
    const zones = (await pool.query('SELECT id, name, color, sort_order FROM salon_zones WHERE active=true ORDER BY sort_order, id')).rows;
    const masters = (await pool.query(`SELECT id, name, specialty FROM masters WHERE COALESCE(active,true)=true ORDER BY name`)).rows;
    const map = (await pool.query('SELECT zone_id, master_id FROM zone_masters')).rows;
    const m2z = new Map(map.map(r => [Number(r.master_id), r.zone_id]));
    const out = zones.map(z => ({ ...z, masters: masters.filter(m => m2z.get(m.id) === z.id) }));
    const unassigned = masters.filter(m => !m2z.has(m.id));
    res.json({ zones: out, unassigned });
  } catch (e) { console.error('[zones] config', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// POST /api/zones — створити зал
router.post('/', async (req, res) => {
  try {
    const { name, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const c = /^#[0-9a-fA-F]{6}$/.test(String(color || '')) ? String(color).toLowerCase() : ZONE_PALETTE[0];
    const so = (await pool.query('SELECT COALESCE(MAX(sort_order),-1)+1 n FROM salon_zones')).rows[0].n;
    const r = await pool.query('INSERT INTO salon_zones (name,color,sort_order) VALUES ($1,$2,$3) RETURNING *', [String(name).trim(), c, so]);
    res.json({ ok: true, zone: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// PATCH /api/zones/:id — перейменувати / колір / порядок
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {}; const sets = []; const p = [];
    if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'name empty' }); p.push(String(b.name).trim()); sets.push(`name=$${p.length}`); }
    if (b.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) return res.status(400).json({ error: 'bad color' }); p.push(String(b.color).toLowerCase()); sets.push(`color=$${p.length}`); }
    if (b.sort_order !== undefined) { p.push(Number(b.sort_order) || 0); sets.push(`sort_order=$${p.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing-to-update' });
    p.push(id);
    const r = await pool.query(`UPDATE salon_zones SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, zone: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// DELETE /api/zones/:id — видалити зал (майстри стають «без залу»)
router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM salon_zones WHERE id=$1', [id]); // zone_masters — ON DELETE CASCADE
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// PUT /api/zones/:id/masters — задати склад залу (майстри переходять сюди з інших залів)
router.put('/:id/masters', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const ids = Array.isArray(req.body?.master_ids) ? req.body.master_ids.map(Number).filter(Boolean) : [];
    await client.query('BEGIN'); await applyTenant(client); // RLS-ізоляція (аудит 06.07)
    const z = await client.query('SELECT id FROM salon_zones WHERE id=$1', [id]);
    if (!z.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not-found' }); }
    // прибираємо цих майстрів з будь-яких залів і призначаємо в цей (UNIQUE master_id)
    if (ids.length) {
      await client.query('DELETE FROM zone_masters WHERE master_id = ANY($1::int[])', [ids]);
      for (const mid of ids) await client.query('INSERT INTO zone_masters (zone_id, master_id) VALUES ($1,$2)', [id, mid]);
    }
    // майстри, яких прибрали з цього залу (були тут, але не в новому списку) — лишаються без залу
    await client.query('DELETE FROM zone_masters WHERE zone_id=$1 AND NOT (master_id = ANY($2::int[]))', [id, ids.length ? ids : [0]]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
  finally { client.release(); }
});

module.exports = router;
