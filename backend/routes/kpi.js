/* ═══════════════════════════════════════════════════════
   FIN-09 — KPI Employees (KPI сотрудников / мастеров)
   Подключается как /api/kpi

   Прагматична single-salon версія поверх masters/appointments:
   - каталог метрик (kpi_metrics, сід 9 шт);
   - плани/таргети на період (kpi_targets);
   - факт рахується НАЖИВО з appointments/reviews за період;
   - щоденні снепшоти (kpi_actuals) для графіків/історії;
   - рейтинг сотрудників (зважена сума виконання планів);
   - лідерборд, бейджі, бонуси за KPI (передача у FIN-08).

   Права: kpi.read (GET) / kpi.write (зміни). Owner '*' матчить усе.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/* ── helpers ───────────────────────────────────────────── */
function periodRange(period) {
  // period 'YYYY-MM' → {from:'YYYY-MM-01', to: перше число наступного місяця}
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || '').trim());
  let y, mo;
  if (m) { y = +m[1]; mo = +m[2]; }
  else { const d = new Date(); y = d.getUTCFullYear(); mo = d.getUTCMonth() + 1; }
  const from = `${y}-${String(mo).padStart(2, '0')}-01`;
  const nm = mo === 12 ? { y: y + 1, m: 1 } : { y, m: mo + 1 };
  const to = `${nm.y}-${String(nm.m).padStart(2, '0')}-01`;
  return { from, to, period: `${y}-${String(mo).padStart(2, '0')}` };
}

// Розрахунок усіх метрик майстра за період [from, to). Повертає {code: value|null}
async function computePeriod(masterId, from, to) {
  const a = (await q(
    `SELECT
       COUNT(*) FILTER (WHERE status='done')::int AS visits,
       COALESCE(SUM(price) FILTER (WHERE status='done'),0)::numeric AS revenue,
       COUNT(*) FILTER (WHERE status='noshow')::int AS noshow,
       COUNT(*)::int AS total_appts,
       COUNT(DISTINCT client_id) FILTER (WHERE status='done' AND client_id IS NOT NULL)::int AS distinct_clients,
       COALESCE(SUM(duration_min) FILTER (WHERE status IN ('done','confirmed','booked')),0)::int AS busy_min,
       COUNT(DISTINCT date(starts_at)) FILTER (WHERE status IN ('done','confirmed','booked'))::int AS work_days
     FROM appointments WHERE master_id=$1 AND starts_at >= $2 AND starts_at < $3`,
    [masterId, from, to]))[0];

  const rep = (await q(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT client_id FROM appointments
        WHERE master_id=$1 AND status='done' AND client_id IS NOT NULL AND starts_at>=$2 AND starts_at<$3
        GROUP BY client_id HAVING COUNT(*)>1) t`, [masterId, from, to]))[0].c;

  const nc = (await q(
    `SELECT COUNT(DISTINCT a.client_id)::int AS c FROM appointments a
      WHERE a.master_id=$1 AND a.client_id IS NOT NULL AND a.starts_at>=$2 AND a.starts_at<$3
        AND NOT EXISTS (SELECT 1 FROM appointments a2 WHERE a2.client_id=a.client_id AND a2.starts_at<$2)`,
    [masterId, from, to]))[0].c;

  let rating = null;
  try {
    const r = (await q(
      `SELECT ROUND(AVG(rating)::numeric,2) AS r FROM reviews
        WHERE master_id=$1::text AND status='published' AND created_at>=$2 AND created_at<$3`,
      [masterId, from, to]))[0];
    rating = r && r.r !== null ? Number(r.r) : null;
  } catch { rating = null; }

  const revenue = Number(a.revenue);
  const visits = a.visits;
  const occupancy = a.work_days > 0 ? Math.round((a.busy_min / (a.work_days * 480)) * 1000) / 10 : 0;
  return {
    revenue,
    visits,
    avg_check: visits > 0 ? Math.round(revenue / visits) : 0,
    occupancy,
    repeat_rate: a.distinct_clients > 0 ? Math.round((rep / a.distinct_clients) * 1000) / 10 : 0,
    noshow_rate: a.total_appts > 0 ? Math.round((a.noshow / a.total_appts) * 1000) / 10 : 0,
    new_clients: nc,
    rating,
    product_sales: null   // orders не привʼязані до майстра у поточній схемі → не відстежуємо
  };
}

// % виконання плану з урахуванням напрямку метрики
function achievement(actual, target, direction) {
  if (actual === null || actual === undefined) return null;
  if (!target || Number(target) === 0) return actual > 0 ? 100 : 0;
  const a = Number(actual), t = Number(target);
  const pct = direction === 'lower'
    ? (a <= t ? 100 : Math.round((t / a) * 100))
    : Math.round((a / t) * 100);
  return pct;
}

/* ── авторизація: GET=read, інше=write ── */
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'kpi.read' : 'kpi.write';
  return requirePerm(perm)(req, res, next);
});

/* ── GET /api/kpi/metrics — каталог метрик ── */
router.get('/metrics', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM kpi_metrics ORDER BY default_weight DESC, code`);
    res.json({ metrics: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/metrics — створити кастомну метрику ── */
router.post('/metrics', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.code || !b.name) return res.status(400).json({ error: 'code_and_name_required' });
    const row = (await q(
      `INSERT INTO kpi_metrics (code, name, description, unit, direction, agg, applicable_roles, default_weight)
       VALUES ($1,$2,$3,COALESCE($4,'count'),COALESCE($5,'higher'),COALESCE($6,'sum'),$7,COALESCE($8,1.0))
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description,
         unit=EXCLUDED.unit, direction=EXCLUDED.direction, agg=EXCLUDED.agg,
         applicable_roles=EXCLUDED.applicable_roles, default_weight=EXCLUDED.default_weight, updated_at=now()
       RETURNING *`,
      [b.code, b.name, b.description || null, b.unit, b.direction, b.agg,
       Array.isArray(b.applicable_roles) ? b.applicable_roles : null, b.default_weight]))[0];
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/employees — KPI усіх майстрів за період ── */
router.get('/employees', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.query.period);
    const metrics = await q(`SELECT code, name, unit, direction, default_weight FROM kpi_metrics WHERE active=true`);
    const mMap = new Map(metrics.map(m => [m.code, m]));
    const masters = await q(`SELECT id, name FROM masters WHERE active=true ORDER BY name`);
    const targets = await q(`SELECT master_id, metric_code, target_value, weight FROM kpi_targets WHERE period_start=$1`, [from]);
    const tMap = new Map();
    for (const t of targets) tMap.set(`${t.master_id}:${t.metric_code}`, t);

    const out = [];
    for (const m of masters) {
      const vals = await computePeriod(m.id, from, to);
      const mrows = [], scoreParts = [];
      for (const [code, meta] of mMap) {
        const actual = vals[code] ?? null;
        const t = tMap.get(`${m.id}:${code}`);
        const target = t ? Number(t.target_value) : null;
        const pct = target !== null ? achievement(actual, target, meta.direction) : null;
        mrows.push({ code, name: meta.name, unit: meta.unit, direction: meta.direction, target, actual, percent: pct });
        if (pct !== null) {
          const w = t && t.weight != null ? Number(t.weight) : Number(meta.default_weight) || 0;
          scoreParts.push({ w, v: Math.min(pct, 150) });
        }
      }
      const wSum = scoreParts.reduce((s, p) => s + p.w, 0);
      const total_score = wSum > 0
        ? Math.round(scoreParts.reduce((s, p) => s + p.w * p.v, 0) / wSum)
        : null;
      out.push({ id: m.id, name: m.name, metrics: mrows, total_score, _revenue: vals.revenue });
    }
    // ранг: за total_score (де є плани), інакше за виручкою
    out.sort((a, b) => {
      if (a.total_score !== null && b.total_score !== null) return b.total_score - a.total_score;
      if (a.total_score !== null) return -1;
      if (b.total_score !== null) return 1;
      return b._revenue - a._revenue;
    });
    out.forEach((e, i) => { e.rank = i + 1; delete e._revenue; });
    res.json({ period, employees: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/leaderboard — лідерборд ── */
router.get('/leaderboard', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.query.period);
    const metric = req.query.metric || 'revenue';
    const masters = await q(`SELECT id, name, avatar FROM masters WHERE active=true`);
    const leaders = [];
    for (const m of masters) {
      const vals = await computePeriod(m.id, from, to);
      let value;
      if (metric === 'total') {
        // зважена сума виконання планів
        const ts = await q(`SELECT metric_code, target_value, weight FROM kpi_targets WHERE master_id=$1 AND period_start=$2`, [m.id, from]);
        const metaRows = await q(`SELECT code, direction, default_weight FROM kpi_metrics WHERE active=true`);
        const dirMap = new Map(metaRows.map(r => [r.code, r]));
        let num = 0, den = 0;
        for (const t of ts) {
          const meta = dirMap.get(t.metric_code); if (!meta) continue;
          const pct = achievement(vals[t.metric_code], Number(t.target_value), meta.direction);
          if (pct === null) continue;
          const w = t.weight != null ? Number(t.weight) : Number(meta.default_weight) || 0;
          num += w * Math.min(pct, 150); den += w;
        }
        value = den > 0 ? Math.round(num / den) : 0;
      } else {
        value = vals[metric] ?? 0;
      }
      leaders.push({ employee: { id: m.id, name: m.name, avatar: m.avatar }, value });
    }
    leaders.sort((a, b) => Number(b.value) - Number(a.value));
    leaders.forEach((l, i) => l.rank = i + 1);
    res.json({ period, metric, leaders });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/bonuses — бонуси за період ── */
router.get('/bonuses', async (req, res) => {
  try {
    const params = [], wh = [];
    if (req.query.period) { const { from } = periodRange(req.query.period); params.push(from); wh.push(`b.period_start=$${params.length}`); }
    if (req.query.status) { params.push(req.query.status); wh.push(`b.status=$${params.length}`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const rows = await q(
      `SELECT b.*, m.name AS master_name FROM kpi_bonuses b JOIN masters m ON m.id=b.master_id
       ${where} ORDER BY b.period_start DESC, b.bonus_amount DESC`, params);
    res.json({ bonuses: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/bonuses/calculate — порахувати бонуси за період ──
   Схема: { scheme:'threshold'|'progressive', thresholds:[{at, bonus}], base_amount } */
router.post('/bonuses/calculate', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.body?.period);
    const scheme = req.body?.scheme || 'threshold';
    const thresholds = Array.isArray(req.body?.thresholds) && req.body.thresholds.length
      ? req.body.thresholds.slice().sort((a, b) => a.at - b.at)
      : [{ at: 100, bonus: Number(req.body?.base_amount) || 0 }];
    const masters = await q(`SELECT id FROM masters WHERE active=true`);
    const metaRows = await q(`SELECT code, direction, default_weight FROM kpi_metrics WHERE active=true`);
    const dirMap = new Map(metaRows.map(r => [r.code, r]));
    const result = [];
    for (const m of masters) {
      const ts = await q(`SELECT metric_code, target_value, weight FROM kpi_targets WHERE master_id=$1 AND period_start=$2`, [m.id, from]);
      if (!ts.length) continue;
      const vals = await computePeriod(m.id, from, to);
      let num = 0, den = 0;
      for (const t of ts) {
        const meta = dirMap.get(t.metric_code); if (!meta) continue;
        const pct = achievement(vals[t.metric_code], Number(t.target_value), meta.direction);
        if (pct === null) continue;
        const w = t.weight != null ? Number(t.weight) : Number(meta.default_weight) || 0;
        num += w * pct; den += w;
      }
      const achievementPct = den > 0 ? Math.round(num / den) : 0;
      // визначаємо бонус
      let bonus = 0;
      if (scheme === 'progressive') {
        for (const th of thresholds) if (achievementPct >= th.at) bonus = Number(th.bonus) || 0;
      } else { // threshold: один поріг
        const th = thresholds[0];
        if (achievementPct >= (th.at || 100)) bonus = Number(th.bonus) || 0;
      }
      const row = (await q(
        `INSERT INTO kpi_bonuses (master_id, period_start, period_end, achievement_percent, bonus_amount, bonus_scheme, status)
         VALUES ($1,$2,$3,$4,$5,$6,'calculated')
         ON CONFLICT (master_id, period_start) DO UPDATE SET period_end=EXCLUDED.period_end,
           achievement_percent=EXCLUDED.achievement_percent, bonus_amount=EXCLUDED.bonus_amount,
           bonus_scheme=EXCLUDED.bonus_scheme, status='calculated', updated_at=now()
         RETURNING *`,
        [m.id, from, to, achievementPct, bonus, JSON.stringify({ scheme, thresholds })]))[0];
      result.push(row);
    }
    res.json({ ok: true, period, calculated: result.length, bonuses: result });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/bonuses/approve — утвердити бонуси ── */
router.post('/bonuses/approve', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.bonus_ids) ? req.body.bonus_ids.filter(n => Number.isInteger(+n)) : [];
    if (!ids.length) return res.status(400).json({ error: 'bonus_ids_required' });
    const rows = await q(
      `UPDATE kpi_bonuses SET status='approved', updated_at=now() WHERE id=ANY($1::int[]) AND status='calculated' RETURNING id`,
      [ids]);
    await logAction({ user: req.user, action: 'kpi.bonuses.approve', entity: 'kpi_bonuses', entity_id: ids.join(','), ip: req.ip });
    res.json({ ok: true, approved: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/targets — встановити план ── */
router.post('/targets', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.master_id || !b.metric_code || b.target_value === undefined)
      return res.status(400).json({ error: 'master_id, metric_code, target_value required' });
    const { from, to } = b.period ? periodRange(b.period) : { from: b.period_start, to: b.period_end };
    const row = (await q(
      `INSERT INTO kpi_targets (master_id, metric_code, period_start, period_end, target_value, weight, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,1.0),$7,now())
       ON CONFLICT (master_id, metric_code, period_start) DO UPDATE SET
         period_end=EXCLUDED.period_end, target_value=EXCLUDED.target_value, weight=EXCLUDED.weight,
         approved_by=EXCLUDED.approved_by, approved_at=now(), updated_at=now()
       RETURNING *`,
      [b.master_id, b.metric_code, from, to, b.target_value, b.weight, req.user?.id || null]))[0];
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/targets/bulk — масова установка планів ── */
router.post('/targets/bulk', async (req, res) => {
  try {
    const b = req.body || {};
    const emps = Array.isArray(b.employees) ? b.employees : [];
    if (!emps.length) return res.status(400).json({ error: 'employees_required' });
    const { from, to } = b.period ? periodRange(b.period) : { from: b.period_start, to: b.period_end };
    let count = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const e of emps) {
        for (const t of (e.targets || [])) {
          if (!t.metric_code || t.target_value === undefined) continue;
          await client.query(
            `INSERT INTO kpi_targets (master_id, metric_code, period_start, period_end, target_value, weight, approved_by, approved_at)
             VALUES ($1,$2,$3,$4,$5,COALESCE($6,1.0),$7,now())
             ON CONFLICT (master_id, metric_code, period_start) DO UPDATE SET
               period_end=EXCLUDED.period_end, target_value=EXCLUDED.target_value, weight=EXCLUDED.weight, updated_at=now()`,
            [e.employee_id, t.metric_code, from, to, t.target_value, t.weight, req.user?.id || null]);
          count++;
        }
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    res.json({ ok: true, targets_set: count });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── POST /api/kpi/calculate — зберегти щоденний снепшот факту ──
   Body: { master_id, date } або { date } для всіх активних майстрів. */
router.post('/calculate', async (req, res) => {
  try {
    const date = req.body?.date || new Date().toISOString().slice(0, 10);
    const from = date, to = `${date} 23:59:59.999`;
    const dayTo = (await q(`SELECT ($1::date + INTERVAL '1 day')::timestamptz AS t`, [date]))[0].t;
    const ids = req.body?.master_id
      ? [req.body.master_id]
      : (await q(`SELECT id FROM masters WHERE active=true`)).map(r => r.id);
    let saved = 0;
    for (const id of ids) {
      const vals = await computePeriod(id, from, dayTo);
      for (const [code, value] of Object.entries(vals)) {
        if (value === null || value === undefined) continue;
        await q(
          `INSERT INTO kpi_actuals (master_id, metric_code, date, value, calculated_at)
           VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (master_id, metric_code, date) DO UPDATE SET value=EXCLUDED.value, calculated_at=now()`,
          [id, code, date, value]);
        saved++;
      }
    }
    res.json({ ok: true, date, employees: ids.length, snapshots: saved });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/employees/:id/history — історія метрики ── */
router.get('/employees/:id(\\d+)/history', async (req, res) => {
  try {
    const metric = req.query.metric || 'revenue';
    const params = [req.params.id, metric], wh = [`master_id=$1`, `metric_code=$2`];
    if (req.query.from) { params.push(req.query.from + '-01'); wh.push(`date >= $${params.length}::date`); }
    if (req.query.to) { const { to } = periodRange(req.query.to); params.push(to); wh.push(`date < $${params.length}::date`); }
    const rows = await q(`SELECT date, value FROM kpi_actuals WHERE ${wh.join(' AND ')} ORDER BY date`, params);
    res.json({ metric, data: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/employees/:id/compare — порівняння з іншими ── */
router.get('/employees/:id(\\d+)/compare', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.query.period);
    let withIds = req.query['compare_with'] || req.query.compare_with || [];
    if (!Array.isArray(withIds)) withIds = [withIds];
    const ids = [req.params.id, ...withIds].filter(Boolean).map(Number).filter(Number.isInteger);
    const uniq = [...new Set(ids)].slice(0, 5);
    const data = [];
    for (const id of uniq) {
      const m = (await q(`SELECT id, name FROM masters WHERE id=$1`, [id]))[0];
      if (!m) continue;
      const vals = await computePeriod(id, from, to);
      data.push({ id, name: m.name, metrics: vals });
    }
    res.json({ period, employees: data });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

/* ── GET /api/kpi/employees/:id — KPI конкретного майстра ── */
router.get('/employees/:id(\\d+)', async (req, res) => {
  try {
    const { from, to, period } = periodRange(req.query.period);
    const m = (await q(`SELECT id, name, avatar FROM masters WHERE id=$1`, [req.params.id]))[0];
    if (!m) return res.status(404).json({ error: 'not_found' });
    const metrics = await q(`SELECT code, name, unit, direction, default_weight FROM kpi_metrics WHERE active=true`);
    const vals = await computePeriod(m.id, from, to);
    const targets = await q(`SELECT metric_code, target_value, weight FROM kpi_targets WHERE master_id=$1 AND period_start=$2`, [m.id, from]);
    const tMap = new Map(targets.map(t => [t.metric_code, t]));
    const mrows = [], scoreParts = [];
    for (const meta of metrics) {
      const actual = vals[meta.code] ?? null;
      const t = tMap.get(meta.code);
      const target = t ? Number(t.target_value) : null;
      const pct = target !== null ? achievement(actual, target, meta.direction) : null;
      mrows.push({ code: meta.code, name: meta.name, unit: meta.unit, direction: meta.direction, target, actual, percent: pct });
      if (pct !== null) {
        const w = t && t.weight != null ? Number(t.weight) : Number(meta.default_weight) || 0;
        scoreParts.push({ w, v: Math.min(pct, 150) });
      }
    }
    const wSum = scoreParts.reduce((s, p) => s + p.w, 0);
    const total_score = wSum > 0 ? Math.round(scoreParts.reduce((s, p) => s + p.w * p.v, 0) / wSum) : null;
    const achievements = await q(`SELECT badge_code, badge_name, earned_at, period FROM kpi_achievements WHERE master_id=$1 ORDER BY earned_at DESC LIMIT 20`, [m.id]);
    // тренд виручки: цей період vs попередній
    const prev = periodRange(prevPeriod(period));
    const prevVals = await computePeriod(m.id, prev.from, prev.to);
    const trend = prevVals.revenue > 0 ? Math.round(((vals.revenue - prevVals.revenue) / prevVals.revenue) * 100) : null;
    res.json({ employee: m, period, metrics: mrows, total_score, trend_revenue_pct: trend, achievements });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

function prevPeriod(period) {
  const [y, mo] = period.split('-').map(Number);
  const pm = mo === 1 ? { y: y - 1, m: 12 } : { y, m: mo - 1 };
  return `${pm.y}-${String(pm.m).padStart(2, '0')}`;
}

module.exports = router;
