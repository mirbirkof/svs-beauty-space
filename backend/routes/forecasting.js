/* routes/forecasting.js — AI-08 Forecasting (прагматична версія для 1 салону).
   Прогнозування без важких ML-бібліотек: декомпозиція ряду на
   тренд (лінійна регресія по де-сезоналізованих даних) + тижнева сезонність
   (фактори по днях тижня) + святкові піки + довірчі інтервали (80%/95%
   з залишкової дисперсії). Що-якщо сценарії: зміна цін (з еластичністю),
   акція-знижка, додатковий майстер.

   Ендпоінти:
     GET  /api/forecast/revenue?horizon=7|14|30|90&explain=1 — прогноз виручки
     GET  /api/forecast/load                                  — прогноз завантаження по днях тижня + майстри
     GET  /api/forecast/demand?horizon=30                     — прогноз попиту на послуги
     POST /api/forecast/what-if                               — сценарне моделювання

   Дані рахуються на льоту з cash_operations / appointments — окремих таблиць
   не потрібно (як FIN-04). Доступ: reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();

const WEEKDAYS = ['Неділя', 'Понеділок', 'Вівторок', 'Середа', 'Четвер', 'Пʼятниця', 'Субота'];
const DAY_MS = 24 * 3600 * 1000;

// ── Святкові піки (місяць-день → множник попиту) ───────────
// Емпіричні коефіцієнти для б'юті-салону в Україні.
const HOLIDAY_BOOST = {
  '12-29': 1.5, '12-30': 1.6, '12-31': 1.4,
  '02-13': 1.4, '02-14': 1.5,
  '03-06': 1.6, '03-07': 1.9, '03-08': 1.7,
  '04-30': 1.3, '12-24': 1.3,
};

function ymdKyiv(date) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(date); // YYYY-MM-DD
}

// ── Лінійна регресія y = a*x + b ───────────────────────────
function linreg(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: 0, b: ys[0] || 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return { a: 0, b: sy / n };
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  return { a, b };
}

/** Денний ряд виручки (послуги+товари) за останні N днів, з заповненням пропусків нулями. */
async function dailyRevenueSeries(days = 120) {
  const rows = (await pool.query(
    `SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d,
            SUM(amount)::numeric AS total
       FROM cash_operations
      WHERE type='in' AND category IN ('sale_service','sale_product')
        AND created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY d ORDER BY d`, [days]
  ).then(r => r.rows).catch(() => []));
  const byDate = new Map(rows.map(r => [r.d, Math.round(Number(r.total))]));
  // суцільний ряд від першого дня з даними до вчора
  const series = [];
  if (!rows.length) return series;
  const start = new Date(rows[0].d + 'T12:00:00Z');
  const today = new Date(ymdKyiv(new Date()) + 'T12:00:00Z');
  for (let t = start.getTime(); t < today.getTime(); t += DAY_MS) {
    const d = ymdKyiv(new Date(t));
    series.push({ date: d, dow: new Date(d + 'T12:00:00Z').getUTCDay(), value: byDate.get(d) || 0 });
  }
  return series;
}

/** Декомпозиція: тижневі фактори + тренд + залишкова дисперсія. */
function decompose(series) {
  const overallAvg = series.reduce((s, x) => s + x.value, 0) / Math.max(series.length, 1);
  // фактори по днях тижня (середнє дня тижня / загальне середнє)
  const wdSum = Array(7).fill(0), wdCnt = Array(7).fill(0);
  for (const p of series) { wdSum[p.dow] += p.value; wdCnt[p.dow]++; }
  const wdFactor = Array(7).fill(1);
  for (let d = 0; d < 7; d++) {
    const avg = wdCnt[d] ? wdSum[d] / wdCnt[d] : overallAvg;
    wdFactor[d] = overallAvg > 0 ? avg / overallAvg : 1;
  }
  // тренд по де-сезоналізованому ряду
  const xs = [], ys = [];
  series.forEach((p, i) => {
    const f = wdFactor[p.dow] || 1;
    if (f > 0.05) { xs.push(i); ys.push(p.value / f); }
  });
  const { a, b } = linreg(xs, ys);
  // залишки (факт - модель) для довірчого інтервалу
  let sse = 0, m = 0;
  for (let i = 0; i < series.length; i++) {
    const fitted = (a * i + b) * (wdFactor[series[i].dow] || 1);
    const resid = series[i].value - fitted;
    sse += resid * resid; m++;
  }
  const sigma = m > 2 ? Math.sqrt(sse / (m - 2)) : overallAvg * 0.3;
  return { overallAvg, wdFactor, trendA: a, trendB: b, sigma, n: series.length };
}

/** Прогноз на horizon днів уперед. */
function forecast(series, horizon) {
  const dc = decompose(series);
  const n = series.length;
  const out = [];
  let sum = 0, lo80sum = 0, hi80sum = 0, lo95sum = 0, hi95sum = 0;
  for (let h = 1; h <= horizon; h++) {
    const idx = n - 1 + h;
    const future = new Date(new Date(series[series.length - 1].date + 'T12:00:00Z').getTime() + h * DAY_MS);
    const d = ymdKyiv(future);
    const dow = future.getUTCDay();
    const md = d.slice(5); // MM-DD
    const holiday = HOLIDAY_BOOST[md] || 1;
    let point = (dc.trendA * idx + dc.trendB) * (dc.wdFactor[dow] || 1) * holiday;
    if (point < 0) point = 0;
    // інтервал розширюється з горизонтом
    const widen = Math.sqrt(1 + h / 30);
    const band80 = 1.2816 * dc.sigma * widen;
    const band95 = 1.9600 * dc.sigma * widen;
    const pt = Math.round(point);
    const lo80 = Math.max(0, Math.round(point - band80));
    const hi80 = Math.round(point + band80);
    const lo95 = Math.max(0, Math.round(point - band95));
    const hi95 = Math.round(point + band95);
    out.push({ date: d, weekday: WEEKDAYS[dow], point: pt, lo80, hi80, lo95, hi95, holiday: holiday > 1 ? holiday : undefined });
    sum += pt; lo80sum += lo80; hi80sum += hi80; lo95sum += lo95; hi95sum += hi95;
  }
  return {
    horizon, daily: out,
    total: sum, total_lo80: lo80sum, total_hi80: hi80sum, total_lo95: lo95sum, total_hi95: hi95sum,
    model: {
      trend_per_day: Math.round(dc.trendA),
      avg_daily_now: Math.round(dc.trendA * (n - 1) + dc.trendB),
      sigma: Math.round(dc.sigma),
      weekday_factors: dc.wdFactor.map((f, i) => ({ day: WEEKDAYS[i], factor: +f.toFixed(2) })),
      based_on_days: n,
    },
  };
}

// ── GET /revenue ───────────────────────────────────────────
router.get('/revenue', requirePerm('reports.finance'), async (req, res) => {
  try {
    const horizon = Math.min(Math.max(parseInt(req.query.horizon, 10) || 30, 7), 90);
    const series = await dailyRevenueSeries(120);
    if (series.length < 14) {
      return res.json({ ok: true, enough_data: false, message: 'Замало історії для прогнозу (потрібно ≥2 тижні даних).', history_days: series.length });
    }
    const fc = forecast(series, horizon);
    // факт за минулі дні для overlay (останні 30)
    const recent = series.slice(-30).map(p => ({ date: p.date, value: p.value }));
    const payload = {
      ok: true, enough_data: true, generated_at: new Date().toISOString(),
      ...fc, recent_actual: recent,
    };
    if (req.query.explain === '1' && llm.available()) {
      try {
        const prompt = `Прогноз виручки салону на ${horizon} днів: загалом ${fc.total} грн (інтервал 80%: ${fc.total_lo80}–${fc.total_hi80} грн).
Тренд: ${fc.model.trend_per_day >= 0 ? '+' : ''}${fc.model.trend_per_day} грн/день. Поточна середня: ${fc.model.avg_daily_now} грн/день.
Фактори днів тижня: ${fc.model.weekday_factors.map(w => `${w.day}=${w.factor}`).join(', ')}.
Дай керівнику салону 2-3 короткі практичні висновки українською (звичайний текст, без markdown). На що звернути увагу, які дні слабкі, що можна зробити.`;
        fc.ai_summary = await llm.ask(prompt, { maxTokens: 500 });
        payload.ai_summary = fc.ai_summary;
      } catch (e) { console.error('[forecast:explain]', e.message); }
    }
    res.json(payload);
  } catch (e) {
    console.error('[forecast:revenue]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /load — прогноз завантаження ───────────────────────
router.get('/load', requirePerm('reports.finance'), async (req, res) => {
  try {
    // записи по днях тижня та годинах (90 днів, без скасованих)
    const [byDow, byHour, masters] = await Promise.all([
      pool.query(
        `SELECT EXTRACT(DOW FROM starts_at AT TIME ZONE 'Europe/Kiev')::int AS dow,
                COUNT(*)::int AS appts,
                COUNT(DISTINCT to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD'))::int AS days
           FROM appointments
          WHERE status NOT IN ('cancelled','noshow')
            AND starts_at >= NOW() - INTERVAL '90 days'
          GROUP BY dow ORDER BY dow`).then(r => r.rows).catch(() => []),
      pool.query(
        `SELECT EXTRACT(HOUR FROM starts_at AT TIME ZONE 'Europe/Kiev')::int AS hr,
                COUNT(*)::int AS appts
           FROM appointments
          WHERE status NOT IN ('cancelled','noshow')
            AND starts_at >= NOW() - INTERVAL '90 days'
          GROUP BY hr ORDER BY hr`).then(r => r.rows).catch(() => []),
      pool.query(
        `SELECT m.name,
                COUNT(*) FILTER (WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW())::int AS done,
                COUNT(DISTINCT to_char(a.starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD')) FILTER (WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW())::int AS work_days
           FROM masters m LEFT JOIN appointments a
             ON a.master_id=m.id AND a.starts_at >= NOW() - INTERVAL '90 days'
          WHERE m.active=true AND COALESCE(m.provides_services,true)=true
          GROUP BY m.id, m.name ORDER BY done DESC`).then(r => r.rows).catch(() => []),
    ]);
    const dows = WEEKDAYS.map((name, dow) => {
      const row = byDow.find(r => r.dow === dow);
      const days = row ? row.days : 0;
      const avg = days ? (row.appts / days) : 0;
      return { day: name, avg_appts_per_day: +avg.toFixed(1), observed_days: days };
    });
    const maxAvg = Math.max(...dows.map(d => d.avg_appts_per_day), 1);
    dows.forEach(d => { d.load_pct = Math.round((d.avg_appts_per_day / maxAvg) * 100); });
    const peakHours = byHour.filter(h => h.hr >= 8 && h.hr <= 21).sort((a, b) => b.appts - a.appts).slice(0, 3).map(h => `${h.hr}:00`);
    const mastersOut = masters.map(m => ({
      name: m.name, done_90d: m.done, work_days: m.work_days,
      avg_per_day: m.work_days ? +(m.done / m.work_days).toFixed(1) : 0,
    }));
    res.json({
      ok: true,
      by_weekday: dows,
      busiest_day: dows.reduce((a, b) => b.avg_appts_per_day > a.avg_appts_per_day ? b : a, dows[0]),
      slowest_day: dows.filter(d => d.observed_days > 0).reduce((a, b) => b.avg_appts_per_day < a.avg_appts_per_day ? b : a, dows.find(d => d.observed_days > 0) || dows[0]),
      peak_hours: peakHours,
      masters: mastersOut,
    });
  } catch (e) {
    console.error('[forecast:load]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /demand — прогноз попиту на послуги ────────────────
router.get('/demand', requirePerm('reports.finance'), async (req, res) => {
  try {
    const horizon = Math.min(Math.max(parseInt(req.query.horizon, 10) || 30, 7), 90);
    // попит по послугах: останні 60 днів → екстраполяція на horizon
    const rows = await pool.query(
      `SELECT COALESCE(NULLIF(a.services_text,''), s.name, 'Послуга #'||a.service_id) AS service,
              COUNT(*)::int AS cnt,
              COALESCE(SUM(COALESCE(a.real_amount,a.price)),0)::numeric AS revenue
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
        WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW() AND a.starts_at >= NOW() - INTERVAL '60 days'
        GROUP BY service ORDER BY cnt DESC LIMIT 15`
    ).then(r => r.rows).catch(() => []);
    const scale = horizon / 60;
    const out = rows.map(r => ({
      service: r.service,
      last_60d: r.cnt,
      forecast_next: Math.round(r.cnt * scale),
      avg_price: r.cnt ? Math.round(Number(r.revenue) / r.cnt) : 0,
      forecast_revenue: Math.round(Number(r.revenue) * scale),
    }));
    res.json({ ok: true, horizon, services: out });
  } catch (e) {
    console.error('[forecast:demand]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── POST /what-if — сценарне моделювання ───────────────────
router.post('/what-if', requirePerm('reports.finance'), async (req, res) => {
  try {
    const { scenario, horizon: h, pct, elasticity, days, uplift_pct, master_fill_pct } = req.body || {};
    const horizon = Math.min(Math.max(parseInt(h, 10) || 30, 7), 90);
    const series = await dailyRevenueSeries(120);
    if (series.length < 14) return res.json({ ok: true, enough_data: false, message: 'Замало історії для сценарію.' });
    const base = forecast(series, horizon);
    const baseTotal = base.total;
    let projected = baseTotal, assumptions = {}, label = '';

    if (scenario === 'price') {
      const p = Number(pct) || 0;                 // зміна ціни, %
      const el = elasticity != null ? Number(elasticity) : -0.4; // еластичність попиту
      const demandChange = el * (p / 100);        // частка зміни попиту
      const factor = (1 + p / 100) * (1 + demandChange);
      projected = Math.round(baseTotal * factor);
      label = `Зміна цін на ${p > 0 ? '+' : ''}${p}%`;
      assumptions = { price_change_pct: p, elasticity: el, expected_demand_change_pct: +(demandChange * 100).toFixed(1) };
    } else if (scenario === 'discount') {
      const p = Math.abs(Number(pct) || 0);       // знижка, %
      const d = Math.min(Math.max(parseInt(days, 10) || 14, 1), horizon);
      const up = uplift_pct != null ? Number(uplift_pct) : 30; // приріст попиту від акції, %
      const dailyBase = baseTotal / horizon;
      const promoRev = dailyBase * d * (1 - p / 100) * (1 + up / 100);
      const restRev = dailyBase * (horizon - d);
      projected = Math.round(promoRev + restRev);
      label = `Акція -${p}% на ${d} днів`;
      assumptions = { discount_pct: p, promo_days: d, expected_uplift_pct: up };
    } else if (scenario === 'add_master') {
      // інкремент = середня денна виручка майстра × заповнюваність × дні
      const mrow = await pool.query(
        `SELECT COALESCE(AVG(daily),0)::numeric AS avg_daily FROM (
           SELECT a.master_id, to_char(a.starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') d,
                  SUM(COALESCE(a.real_amount,a.price)) daily
             FROM appointments a
            WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW() AND a.starts_at >= NOW() - INTERVAL '60 days'
            GROUP BY a.master_id, d) t`
      ).then(r => Number(r.rows[0]?.avg_daily || 0)).catch(() => 0);
      const fill = master_fill_pct != null ? Number(master_fill_pct) / 100 : 0.5;
      const workDays = Math.round(horizon * 6 / 7); // ~6 робочих днів на тиждень
      const incr = Math.round(mrow * fill * workDays);
      projected = baseTotal + incr;
      label = `Додатковий майстер (${Math.round(fill * 100)}% завантаження)`;
      assumptions = { avg_master_daily_revenue: Math.round(mrow), fill_rate_pct: Math.round(fill * 100), work_days: workDays, added_revenue: incr };
    } else {
      return res.status(400).json({ error: 'unknown_scenario', allowed: ['price', 'discount', 'add_master'] });
    }

    const delta = projected - baseTotal;
    res.json({
      ok: true, enough_data: true, scenario, label, horizon,
      baseline_total: baseTotal, projected_total: projected,
      delta, delta_pct: baseTotal ? +((delta / baseTotal) * 100).toFixed(1) : 0,
      assumptions,
      note: 'Оцінка ґрунтується на історичних даних і припущеннях про еластичність/приріст. Реальний результат залежить від ринку.',
    });
  } catch (e) {
    console.error('[forecast:what-if]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /seasonality — тижнева + місячна сезонність + свята ─
router.get('/seasonality', requirePerm('reports.finance'), async (req, res) => {
  try {
    const series = await dailyRevenueSeries(365);
    if (series.length < 14) return res.json({ enough_data: false });
    const dc = decompose(series);
    // місячні фактори
    const monSum = Array(12).fill(0), monCnt = Array(12).fill(0);
    for (const p of series) { const m = +p.date.slice(5, 7) - 1; monSum[m] += p.value; monCnt[m]++; }
    const overall = dc.overallAvg || 1;
    const MONTHS = ['Січ', 'Лют', 'Бер', 'Кві', 'Тра', 'Чер', 'Лип', 'Сер', 'Вер', 'Жов', 'Лис', 'Гру'];
    const monthly = monSum.map((s, i) => ({ month: MONTHS[i], factor: monCnt[i] ? +((s / monCnt[i]) / overall).toFixed(2) : null }));
    res.json({
      enough_data: true, based_on_days: series.length,
      weekday: dc.wdFactor.map((f, i) => ({ day: WEEKDAYS[i], factor: +f.toFixed(2) })),
      monthly,
      holidays: Object.entries(HOLIDAY_BOOST).map(([d, m]) => ({ date: d, boost: m })),
    });
  } catch (e) { console.error('[forecast:seasonality]', e); res.status(500).json({ error: 'internal' }); }
});

// ── GET /capacity — прогноз завантаження потужностей ───────
router.get('/capacity', requirePerm('reports.finance'), async (req, res) => {
  try {
    const horizon = Math.min(Math.max(parseInt(req.query.horizon, 10) || 14, 7), 60);
    // За 60 днів: для кожного дня тижня рахуємо середню зайнятість (хв) і
    // середню к-сть майстрів, що РЕАЛЬНО працювали того дня → реалістична потужність.
    const rows = (await pool.query(
      `WITH per_day AS (
         SELECT to_char(starts_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') d,
                EXTRACT(DOW FROM starts_at AT TIME ZONE 'Europe/Kiev')::int dow,
                SUM(EXTRACT(EPOCH FROM (ends_at - starts_at))/60) busy_min,
                COUNT(DISTINCT master_id) masters
           FROM appointments
          WHERE status NOT IN ('cancelled','noshow') AND starts_at >= NOW() - INTERVAL '60 days'
          GROUP BY d, dow)
       SELECT dow,
              AVG(busy_min)::numeric avg_busy_min,
              AVG(masters)::numeric avg_masters,
              COUNT(*)::int days
         FROM per_day GROUP BY dow`).then(r => r.rows).catch(() => []));
    // Загальна к-сть активних майстрів — стеля потужності (колонка active, не is_active).
    const mastersR = await pool.query(`SELECT COUNT(*)::int c FROM masters WHERE COALESCE(active,true)=true`).then(r => r.rows).catch(() => [{ c: 0 }]);
    const activeMasters = Math.max(Number(mastersR[0]?.c || 0), 1);
    const byDow = new Map(rows.map(r => [r.dow, {
      busy: Number(r.avg_busy_min) || 0,
      // майстрів того дня: фактичні, але не більше активних і не менше 1
      masters: Math.min(Math.max(Math.round(Number(r.avg_masters) || 0), 1), activeMasters),
    }]));
    const today = new Date(ymdKyiv(new Date()) + 'T12:00:00Z');
    const out = [];
    for (let h = 1; h <= horizon; h++) {
      const fd = new Date(today.getTime() + h * DAY_MS); const dow = fd.getUTCDay();
      const info = byDow.get(dow) || { busy: 0, masters: 1 };
      const busy = Math.round(info.busy);
      const cap = info.masters * 8 * 60; // 8-годинний робочий день на майстра
      out.push({ date: ymdKyiv(fd), weekday: WEEKDAYS[dow], busy_min: busy, masters: info.masters, capacity_min: cap, utilization_pct: cap ? +((busy / cap) * 100).toFixed(1) : 0 });
    }
    res.json({ enough_data: rows.length > 0, active_masters: activeMasters, masters: activeMasters, capacity_min_per_day: activeMasters * 8 * 60, horizon, daily: out });
  } catch (e) { console.error('[forecast:capacity]', e); res.status(500).json({ error: 'internal' }); }
});

// ── GET /anomalies — аномалії денної виручки (z-score) ──────
router.get('/anomalies', requirePerm('reports.finance'), async (req, res) => {
  try {
    const series = await dailyRevenueSeries(120);
    if (series.length < 14) return res.json({ enough_data: false, anomalies: [] });
    const dc = decompose(series);
    const anomalies = [];
    series.forEach((p, i) => {
      const fitted = (dc.trendA * i + dc.trendB) * (dc.wdFactor[p.dow] || 1);
      const resid = p.value - fitted;
      const z = dc.sigma > 0 ? resid / dc.sigma : 0;
      if (Math.abs(z) >= 2.5) anomalies.push({ date: p.date, weekday: WEEKDAYS[p.dow], value: p.value, expected: Math.round(fitted), deviation_pct: fitted > 0 ? +((resid / fitted) * 100).toFixed(0) : null, z: +z.toFixed(1), type: z > 0 ? 'spike' : 'drop' });
    });
    res.json({ enough_data: true, threshold_z: 2.5, count: anomalies.length, anomalies: anomalies.slice(-30) });
  } catch (e) { console.error('[forecast:anomalies]', e); res.status(500).json({ error: 'internal' }); }
});

// ── Бектест: hold-out останніх K днів, MAPE ────────────────
async function backtest(holdout = 14) {
  const series = await dailyRevenueSeries(150);
  if (series.length < holdout + 21) return null;
  const train = series.slice(0, series.length - holdout);
  const actual = series.slice(series.length - holdout);
  const fc = forecast(train, holdout);
  let apeSum = 0, n = 0, sse = 0;
  for (let i = 0; i < holdout; i++) {
    const a = actual[i].value, p = fc.daily[i].point;
    if (a > 0) { apeSum += Math.abs(a - p) / a; n++; }
    sse += (a - p) * (a - p);
  }
  return { holdout, mape: n ? +((apeSum / n) * 100).toFixed(1) : null, rmse: Math.round(Math.sqrt(sse / holdout)), points: holdout };
}

// ── GET /accuracy — точність моделі (MAPE на hold-out) ─────
router.get('/accuracy', requirePerm('reports.finance'), async (req, res) => {
  try {
    const bt = await backtest(Math.min(Math.max(parseInt(req.query.holdout, 10) || 14, 7), 30));
    if (!bt) return res.json({ enough_data: false });
    res.json({ enough_data: true, ...bt, quality: bt.mape == null ? 'unknown' : bt.mape < 15 ? 'good' : bt.mape < 30 ? 'fair' : 'poor' });
  } catch (e) { console.error('[forecast:accuracy]', e); res.status(500).json({ error: 'internal' }); }
});

// ── MODELS реєстр ──────────────────────────────────────────
router.get('/models', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM ai_forecast_models ORDER BY is_active DESC, id`).catch(() => ({ rows: [] }));
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

router.post('/models/:id/train', requirePerm('reports.finance'), async (req, res) => {
  try {
    const bt = await backtest(14);
    const metrics = bt ? { mape: bt.mape, rmse: bt.rmse, backtest_at: new Date().toISOString() } : { error: 'not_enough_data' };
    const r = await pool.query(`UPDATE ai_forecast_models SET metrics=$1, trained_at=NOW() WHERE id=$2 RETURNING *`, [JSON.stringify(metrics), req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, model: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

router.get('/models/:id/backtest', requirePerm('reports.finance'), async (req, res) => {
  try {
    const bt = await backtest(Math.min(Math.max(parseInt(req.query.holdout, 10) || 14, 7), 30));
    if (!bt) return res.json({ enough_data: false });
    res.json({ enough_data: true, model_id: +req.params.id, ...bt });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

// ── SCENARIOS (персист + calculate + compare) ──────────────
router.get('/scenarios', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM ai_forecast_scenarios ORDER BY id DESC LIMIT 100`).catch(() => ({ rows: [] }));
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

router.post('/scenarios', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !['price_change', 'discount', 'extra_master', 'custom'].includes(b.type)) return res.status(400).json({ error: 'name+type required' });
    const r = await pool.query(
      `INSERT INTO ai_forecast_scenarios (name, type, params, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.name, b.type, JSON.stringify(b.params || {}), req.user?.id || null]);
    res.json({ ok: true, scenario: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

// Розрахунок впливу сценарію на базовий прогноз (та сама логіка, що /what-if)
function applyScenario(baseTotal, type, params) {
  const p = params || {};
  if (type === 'price_change') {
    const pct = Number(p.price_change_pct || 0) / 100;       // +/- ціна
    const elasticity = Number(p.elasticity ?? -0.5);          // еластичність попиту
    const demandChange = elasticity * pct;
    return baseTotal * (1 + pct) * (1 + demandChange);
  }
  if (type === 'discount') {
    const disc = Number(p.discount_pct || 0) / 100;
    const uplift = Number(p.demand_uplift_pct ?? 30) / 100;   // приріст попиту від акції
    return baseTotal * (1 - disc) * (1 + uplift);
  }
  if (type === 'extra_master') {
    const extra = Number(p.extra_masters || 1);
    const perMaster = Number(p.revenue_per_master_pct ?? 15) / 100;
    return baseTotal * (1 + extra * perMaster);
  }
  // custom — прямий множник
  return baseTotal * (1 + Number(p.delta_pct || 0) / 100);
}

router.post('/scenarios/:id/calculate', requirePerm('reports.finance'), async (req, res) => {
  try {
    const sc = (await pool.query(`SELECT * FROM ai_forecast_scenarios WHERE id=$1`, [req.params.id]).catch(() => ({ rows: [] }))).rows[0];
    if (!sc) return res.status(404).json({ error: 'not-found' });
    const horizon = Math.min(Math.max(parseInt(req.body?.horizon, 10) || 30, 7), 90);
    const series = await dailyRevenueSeries(120);
    if (series.length < 14) return res.json({ enough_data: false });
    const fc = forecast(series, horizon);
    const projected = Math.round(applyScenario(fc.total, sc.type, sc.params));
    const result = {
      horizon, baseline_total: fc.total, projected_total: projected,
      delta: projected - fc.total, delta_pct: fc.total ? +(((projected - fc.total) / fc.total) * 100).toFixed(1) : 0,
      calculated_at: new Date().toISOString(),
    };
    await pool.query(`UPDATE ai_forecast_scenarios SET result=$1, calculated_at=NOW() WHERE id=$2`, [JSON.stringify(result), sc.id]);
    res.json({ ok: true, enough_data: true, scenario: { id: sc.id, name: sc.name, type: sc.type }, ...result });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

router.get('/scenarios/:id/compare', requirePerm('reports.finance'), async (req, res) => {
  try {
    const sc = (await pool.query(`SELECT * FROM ai_forecast_scenarios WHERE id=$1`, [req.params.id]).catch(() => ({ rows: [] }))).rows[0];
    if (!sc) return res.status(404).json({ error: 'not-found' });
    if (!sc.result) return res.json({ calculated: false, hint: 'спочатку POST /scenarios/:id/calculate' });
    res.json({ calculated: true, scenario: { id: sc.id, name: sc.name, type: sc.type, params: sc.params }, comparison: sc.result });
  } catch (e) { console.error(e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
