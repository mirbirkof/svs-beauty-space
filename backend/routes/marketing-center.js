/* routes/marketing-center.js — MKT-01 Маркетинговий центр.
   Агрегує існуючі дані (clients.source, campaigns, referrals, appointments) у єдиний дашборд:
   воронка привернення, порівняння каналів, CAC/LTV/ROI, когортний retention, інсайти.
   Плюс маркетинг-календар активностей (з пресетами свят), ручні витрати по каналах, цілі/KPI.
   НЕ створює кампанії/акції — лише зводить. Доступ: GET = reports.read, мутації = marketing.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'reports.read' : 'marketing.write';
  return requirePerm(perm)(req, res, next);
});

// period helper: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default останні 30 днів)
function period(req) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 864e5);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// Сумарні витрати на маркетинг за період: ручні (offline/channel) + виплати рефералки
async function marketingSpend(from, to) {
  const manual = (await q(
    `SELECT COALESCE(SUM(amount),0)::numeric s FROM marketing_channel_spend WHERE period_month >= date_trunc('month',$1::date) AND period_month <= $2::date`, [from, to]))[0].s;
  const ref = (await q(
    `SELECT COALESCE(SUM(reward_amount),0)::numeric s FROM referral_rewards WHERE status='issued' AND issued_at::date BETWEEN $1 AND $2`, [from, to]))[0].s;
  return { manual: Number(manual), referral: Number(ref), total: Number(manual) + Number(ref) };
}

// ── Дашборд ──
router.get('/dashboard', async (req, res) => {
  try {
    const { from, to } = period(req);
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
    const prevFrom = new Date(new Date(from) - days * 864e5).toISOString().slice(0, 10);
    const prevTo = from;

    const newClients = (await q(`SELECT COUNT(*)::int n FROM clients WHERE created_at::date BETWEEN $1 AND $2`, [from, to]))[0].n;
    const prevNew = (await q(`SELECT COUNT(*)::int n FROM clients WHERE created_at::date BETWEEN $1 AND $2`, [prevFrom, prevTo]))[0].n;
    const revenue = (await q(`SELECT COALESCE(SUM(COALESCE(real_amount,price)),0)::numeric s FROM appointments WHERE status='done' AND starts_at::date BETWEEN $1 AND $2`, [from, to]))[0].s;
    const ltv = (await q(`SELECT COALESCE(AVG(total_spent),0)::numeric s FROM clients WHERE total_spent > 0`))[0].s;
    const spend = await marketingSpend(from, to);
    const cac = newClients ? +(spend.total / newClients).toFixed(0) : 0;
    const roi = spend.total ? +((Number(revenue) - spend.total) / spend.total).toFixed(2) : null;

    // канали привернення нових клієнтів
    const channels = await q(
      `SELECT COALESCE(source,'unknown') channel, COUNT(*)::int clients
         FROM clients WHERE created_at::date BETWEEN $1 AND $2 GROUP BY source ORDER BY clients DESC LIMIT 5`, [from, to]);
    // активні кампанії
    const activeCamp = (await q(`SELECT COUNT(*)::int n FROM campaigns WHERE status IN ('scheduled','running','active')`))[0].n;
    // найближчі активності календаря
    const upcoming = await q(
      `SELECT id, title, type, start_date, channels FROM marketing_activities
         WHERE start_date >= CURRENT_DATE ORDER BY start_date LIMIT 5`);

    res.json({
      period: { from, to },
      kpi: {
        new_clients: newClients,
        new_clients_prev: prevNew,
        new_clients_delta_pct: prevNew ? +(((newClients - prevNew) / prevNew) * 100).toFixed(1) : null,
        revenue: Math.round(Number(revenue)),
        ltv: Math.round(Number(ltv)),
        marketing_spend: spend.total,
        cac, roi,
      },
      spend_breakdown: spend,
      top_channels: channels,
      active_campaigns: activeCamp,
      upcoming_activities: upcoming,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Воронка привернення ──
router.get('/funnel', async (req, res) => {
  try {
    const { from, to } = period(req);
    const clicks = (await q(`SELECT COALESCE(SUM(total_clicks),0)::int c FROM referral_codes`))[0].c;
    const leads = (await q(`SELECT COUNT(*)::int n FROM clients WHERE created_at::date BETWEEN $1 AND $2`, [from, to]))[0].n;
    const firstVisit = (await q(
      `SELECT COUNT(DISTINCT a.client_id)::int n FROM appointments a
         JOIN clients c ON c.id=a.client_id
        WHERE a.status='done' AND c.created_at::date BETWEEN $1 AND $2`, [from, to]))[0].n;
    const repeat = (await q(
      `SELECT COUNT(*)::int n FROM (
         SELECT a.client_id FROM appointments a JOIN clients c ON c.id=a.client_id
          WHERE a.status='done' AND c.created_at::date BETWEEN $1 AND $2
          GROUP BY a.client_id HAVING COUNT(*) >= 2) t`, [from, to]))[0].n;
    const stages = [
      { stage: 'clicks', label: 'Кліки по посиланнях', value: clicks },
      { stage: 'leads', label: 'Нові клієнти', value: leads },
      { stage: 'first_visit', label: 'Перший візит', value: firstVisit },
      { stage: 'repeat', label: 'Повторний візит', value: repeat },
    ];
    // конверсії між етапами
    for (let i = 1; i < stages.length; i++) {
      const prev = stages[i - 1].value;
      stages[i].conversion_pct = prev ? +((stages[i].value / prev) * 100).toFixed(1) : null;
    }
    res.json({ period: { from, to }, funnel: stages });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Порівняння каналів (клієнти, виручка, LTV, ROI) ──
router.get('/channels', async (req, res) => {
  try {
    const { from, to } = period(req);
    const rows = await q(
      `SELECT COALESCE(c.source,'unknown') channel,
              COUNT(DISTINCT c.id)::int clients,
              COALESCE(SUM(c.total_spent),0)::numeric revenue,
              COALESCE(AVG(NULLIF(c.total_spent,0)),0)::numeric ltv
         FROM clients c WHERE c.created_at::date BETWEEN $1 AND $2
        GROUP BY c.source ORDER BY clients DESC`, [from, to]);
    // витрати по каналах за період
    const spend = await q(
      `SELECT channel, COALESCE(SUM(amount),0)::numeric s FROM marketing_channel_spend
        WHERE period_month >= date_trunc('month',$1::date) AND period_month <= $2::date GROUP BY channel`, [from, to]);
    const spendMap = Object.fromEntries(spend.map(s => [s.channel, Number(s.s)]));
    const refSpend = (await q(`SELECT COALESCE(SUM(reward_amount),0)::numeric s FROM referral_rewards WHERE status='issued' AND issued_at::date BETWEEN $1 AND $2`, [from, to]))[0].s;
    spendMap.referral = (spendMap.referral || 0) + Number(refSpend);
    const out = rows.map(r => {
      const sp = spendMap[r.channel] || 0;
      return {
        channel: r.channel, clients: r.clients,
        revenue: Math.round(Number(r.revenue)), ltv: Math.round(Number(r.ltv)),
        spend: Math.round(sp), cac: r.clients ? Math.round(sp / r.clients) : 0,
        roi: sp ? +((Number(r.revenue) - sp) / sp).toFixed(2) : null,
      };
    });
    res.json({ period: { from, to }, channels: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Когортний аналіз: retention по місяцю першого візиту ──
router.get('/cohorts', async (req, res) => {
  try {
    const months = Math.min(12, parseInt(req.query.months, 10) || 6);
    // перший done-візит кожного клієнта
    const rows = await q(
      `WITH firsts AS (
         SELECT client_id, date_trunc('month', MIN(starts_at))::date AS cohort
           FROM appointments WHERE status='done' GROUP BY client_id),
       visits AS (
         SELECT a.client_id, date_trunc('month', a.starts_at)::date AS vm
           FROM appointments a WHERE a.status='done')
       SELECT f.cohort,
              COUNT(DISTINCT f.client_id)::int size,
              v.vm,
              COUNT(DISTINCT v.client_id)::int active
         FROM firsts f JOIN visits v ON v.client_id=f.client_id AND v.vm >= f.cohort
        WHERE f.cohort >= date_trunc('month', CURRENT_DATE) - ($1||' months')::interval
        GROUP BY f.cohort, v.vm ORDER BY f.cohort, v.vm`, [months]);
    // зведення у матрицю retention. Розмір когорти = активні у нульовому місяці (перший візит у всіх там).
    const map = {};
    for (const r of rows) {
      const ck = r.cohort.toISOString().slice(0, 7);
      if (!map[ck]) map[ck] = { cohort: ck, size: 0, retention: {} };
      const offset = (new Date(r.vm).getFullYear() - new Date(r.cohort).getFullYear()) * 12 + (new Date(r.vm).getMonth() - new Date(r.cohort).getMonth());
      map[ck].retention[offset] = { active: r.active };
      if (offset === 0) map[ck].size = r.active;
    }
    // pct рахуємо від розміру когорти
    for (const ck in map) {
      const size = map[ck].size || 1;
      for (const off in map[ck].retention) {
        map[ck].retention[off].pct = +((map[ck].retention[off].active / size) * 100).toFixed(0);
      }
    }
    res.json({ cohorts: Object.values(map) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Інсайти (data-driven рекомендації) ──
router.get('/insights', async (req, res) => {
  try {
    const { from, to } = period(req);
    const insights = [];
    // 1) канал з найкращим LTV
    const ch = await q(
      `SELECT COALESCE(source,'unknown') channel, COUNT(*)::int n, COALESCE(AVG(NULLIF(total_spent,0)),0)::numeric ltv
         FROM clients GROUP BY source HAVING COUNT(*) >= 5 ORDER BY ltv DESC`);
    if (ch.length >= 2) {
      const best = ch[0], avg = ch.reduce((s, x) => s + Number(x.ltv), 0) / ch.length;
      if (Number(best.ltv) > avg * 1.2)
        insights.push({ type: 'channel', severity: 'opportunity', text: `Канал «${best.channel}» дає клієнтів з LTV ${Math.round(best.ltv)}₴ — на ${Math.round((best.ltv / avg - 1) * 100)}% вище середнього. Варто посилити.`, action: 'increase_budget' });
    }
    // 2) реактивація: клієнти що зникли
    const dormant = (await q(
      `SELECT COUNT(*)::int n FROM clients WHERE last_visit_at < CURRENT_DATE - INTERVAL '90 days' AND total_spent > 0`))[0].n;
    if (dormant > 0)
      insights.push({ type: 'retention', severity: dormant > 50 ? 'warning' : 'info', text: `${dormant} клієнтів не були понад 90 днів. Запусти реактиваційну кампанію через сегменти.`, action: 'open_campaigns' });
    // 3) кампанії без запуску
    const draft = (await q(`SELECT COUNT(*)::int n FROM campaigns WHERE status='draft'`))[0].n;
    if (draft > 0)
      insights.push({ type: 'campaign', severity: 'info', text: `${draft} чернеток кампаній не запущено. Заверши або видали.`, action: 'open_campaigns' });
    // 4) реферальна ефективність
    const refRewarded = (await q(`SELECT COUNT(*)::int n FROM referrals WHERE status='rewarded' AND rewarded_at::date BETWEEN $1 AND $2`, [from, to]))[0].n;
    if (refRewarded > 0)
      insights.push({ type: 'referral', severity: 'opportunity', text: `Реферальна програма привела ${refRewarded} клієнтів за період — працює. Розкажи про неї більшій кількості клієнтів.`, action: 'open_referral' });
    res.json({ generated_at: new Date().toISOString(), insights });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── UTM-генератор ──
router.post('/utm', async (req, res) => {
  try {
    const { base_url, source, medium, campaign, term, content } = req.body || {};
    if (!base_url || !source || !medium) return res.status(400).json({ error: 'base_url, source, medium обовʼязкові' });
    const p = new URLSearchParams();
    p.set('utm_source', source); p.set('utm_medium', medium);
    if (campaign) p.set('utm_campaign', campaign);
    if (term) p.set('utm_term', term);
    if (content) p.set('utm_content', content);
    const sep = base_url.includes('?') ? '&' : '?';
    res.json({ url: `${base_url}${sep}${p.toString()}` });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Маркетинг-календар ──
const HOLIDAY_PRESETS = [
  { title: '8 Березня', type: 'holiday', month: 3, day: 8 },
  { title: 'День матері', type: 'holiday', month: 5, day: 11 },
  { title: 'Чорна пʼятниця', type: 'seasonal', month: 11, day: 28 },
  { title: 'Новий рік', type: 'holiday', month: 12, day: 31 },
  { title: 'День закоханих', type: 'holiday', month: 2, day: 14 },
  { title: 'Хеловін', type: 'seasonal', month: 10, day: 31 },
];
router.get('/calendar/presets', (_req, res) => {
  const year = new Date().getFullYear();
  res.json({ presets: HOLIDAY_PRESETS.map(h => ({ ...h, date: `${year}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}` })) });
});

router.get('/calendar', async (req, res) => {
  try {
    const w = [], p = [];
    if (req.query.from) { p.push(req.query.from); w.push(`start_date >= $${p.length}`); }
    if (req.query.to) { p.push(req.query.to); w.push(`start_date <= $${p.length}`); }
    if (req.query.type) { p.push(req.query.type); w.push(`type = $${p.length}`); }
    const rows = await q(`SELECT * FROM marketing_activities ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY start_date LIMIT 300`, p);
    res.json({ activities: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/calendar', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !b.start_date) return res.status(400).json({ error: 'title і start_date обовʼязкові' });
    const r = await q(
      `INSERT INTO marketing_activities (title, type, channels, start_date, end_date, budget, owner_name, campaign_id, promo_id, recurrence, color, description, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'planned')) RETURNING *`,
      [b.title, b.type || 'campaign', b.channels || null, b.start_date, b.end_date || null, b.budget || 0, b.owner_name || null,
       b.campaign_id || null, b.promo_id || null, b.recurrence || null, b.color || null, b.description || null, b.status]);
    logAction({ user: req.user, action: 'marketing.activity_create', entity: 'marketing_activity', entity_id: r[0].id, ip: req.ip }).catch(() => {});
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/calendar/:id', async (req, res) => {
  try {
    const allowed = ['title', 'type', 'channels', 'start_date', 'end_date', 'budget', 'owner_name', 'campaign_id', 'promo_id', 'recurrence', 'color', 'description', 'status'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'нічого оновлювати' });
    vals.push(parseInt(req.params.id, 10));
    const r = await q(`UPDATE marketing_activities SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.length) return res.status(404).json({ error: 'не знайдено' });
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/calendar/:id', async (req, res) => {
  try {
    await q(`DELETE FROM marketing_activities WHERE id=$1`, [parseInt(req.params.id, 10)]);
    logAction({ user: req.user, action: 'marketing.activity_delete', entity: 'marketing_activity', entity_id: req.params.id, ip: req.ip }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Витрати по каналах (offline ручний ввід) ──
router.get('/spend', async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM marketing_channel_spend ORDER BY period_month DESC, channel LIMIT 200`);
    res.json({ spend: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/spend', async (req, res) => {
  try {
    const { channel, period_month, amount, note } = req.body || {};
    if (!channel || !period_month) return res.status(400).json({ error: 'channel і period_month обовʼязкові' });
    const mon = String(period_month).slice(0, 7) + '-01';
    const r = await q(
      `INSERT INTO marketing_channel_spend (channel, period_month, amount, note) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, channel, period_month) DO UPDATE SET amount=EXCLUDED.amount, note=EXCLUDED.note RETURNING *`,
      [channel, mon, amount || 0, note || null]);
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Цілі/KPI ──
router.get('/goals', async (req, res) => {
  try {
    const mon = (req.query.month ? String(req.query.month).slice(0, 7) : new Date().toISOString().slice(0, 7)) + '-01';
    const goals = await q(`SELECT * FROM marketing_goals WHERE period_month=$1 ORDER BY metric`, [mon]);
    // факт по метриках
    const monStart = mon, monEnd = new Date(new Date(mon).getFullYear(), new Date(mon).getMonth() + 1, 0).toISOString().slice(0, 10);
    const newC = (await q(`SELECT COUNT(*)::int n FROM clients WHERE created_at::date BETWEEN $1 AND $2`, [monStart, monEnd]))[0].n;
    const rev = (await q(`SELECT COALESCE(SUM(price),0)::numeric s FROM appointments WHERE status='done' AND starts_at::date BETWEEN $1 AND $2`, [monStart, monEnd]))[0].s;
    const fact = { new_clients: newC, revenue: Math.round(Number(rev)) };
    res.json({ month: mon.slice(0, 7), goals: goals.map(g => ({ ...g, actual: fact[g.metric] ?? null })) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/goals', async (req, res) => {
  try {
    const { month, metric, target_value } = req.body || {};
    if (!month || !metric || target_value == null) return res.status(400).json({ error: 'month, metric, target_value обовʼязкові' });
    const mon = String(month).slice(0, 7) + '-01';
    const r = await q(
      `INSERT INTO marketing_goals (period_month, metric, target_value) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, period_month, metric) DO UPDATE SET target_value=EXCLUDED.target_value RETURNING *`,
      [mon, metric, target_value]);
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
