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

// Розподіл кредиту конверсії за 5 моделями атрибуції.
// touches: [{ source, medium, campaign, touch_at }] у хронологічному порядку. value — цінність конверсії.
function computeAttribution(touches, value) {
  const n = touches.length;
  const label = t => ({ source: t.source || null, medium: t.medium || null, campaign: t.campaign || null });
  if (!n) {
    const empty = [];
    return { first_touch: null, last_touch: null, linear: empty, time_decay: empty, position: empty };
  }
  const credited = (creditFn) => touches.map((t, i) => {
    const credit = creditFn(i);
    return { ...label(t), credit: +credit.toFixed(4), value: +(value * credit).toFixed(2) };
  });
  // time decay: 2^i, нормований
  const tdW = touches.map((_, i) => Math.pow(2, i));
  const tdSum = tdW.reduce((s, w) => s + w, 0) || 1;
  return {
    first_touch: { ...label(touches[0]), credit: 1, value: +value.toFixed(2) },
    last_touch: { ...label(touches[n - 1]), credit: 1, value: +value.toFixed(2) },
    linear: credited(() => 1 / n),
    time_decay: credited(i => tdW[i] / tdSum),
    position: credited(i => {
      if (n === 1) return 1;
      if (i === 0 || i === n - 1) return 0.4;
      return n > 2 ? 0.2 / (n - 2) : 0;
    }),
  };
}

// ── Дашборд ──
router.get('/dashboard', async (req, res) => {
  try {
    const { from, to } = period(req);
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
    const prevFrom = new Date(new Date(from) - days * 864e5).toISOString().slice(0, 10);
    const prevTo = from;

    // "Новий клієнт" = ПЕРШИЙ реальний візит у періоді (не clients.created_at = дата імпорту бази).
    const FIRST_VISIT = `SELECT client_id, MIN(starts_at)::date fv FROM appointments
                           WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL GROUP BY client_id`;
    const newClients = (await q(`SELECT COUNT(*)::int n FROM (${FIRST_VISIT}) t WHERE fv BETWEEN $1 AND $2`, [from, to]))[0].n;
    const prevNew = (await q(`SELECT COUNT(*)::int n FROM (${FIRST_VISIT}) t WHERE fv BETWEEN $1 AND $2`, [prevFrom, prevTo]))[0].n;
    // Виручка — з КАСИ (BeautyPro лишає візити 'confirmed', тому appointments.price WHERE done недораховує).
    const revenue = (await q(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations
                                WHERE type='in' AND category IN ('sale_service','sale_product')
                                  AND created_at::date BETWEEN $1 AND $2`, [from, to]))[0].s;
    const ltv = (await q(`SELECT COALESCE(AVG(total_spent),0)::numeric s FROM clients WHERE total_spent > 0`))[0].s;
    const spend = await marketingSpend(from, to);
    const cac = newClients ? +(spend.total / newClients).toFixed(0) : 0;
    const roi = spend.total ? +((Number(revenue) - spend.total) / spend.total).toFixed(2) : null;

    // канали привернення нових клієнтів
    const channels = await q(
      `SELECT COALESCE(c.source,'unknown') channel, COUNT(*)::int clients
         FROM clients c JOIN (${FIRST_VISIT}) f ON f.client_id=c.id
        WHERE f.fv BETWEEN $1 AND $2 GROUP BY c.source ORDER BY clients DESC LIMIT 5`, [from, to]);
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
    // Лід / перший візит / повторний — усе за датою ПЕРШОГО реального візиту (не created_at = дата імпорту).
    const FV = `SELECT client_id, MIN(starts_at)::date fv, COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow'))::int cnt
                  FROM appointments WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL GROUP BY client_id`;
    const leads = (await q(`SELECT COUNT(*)::int n FROM (${FV}) t WHERE fv BETWEEN $1 AND $2`, [from, to]))[0].n;
    const firstVisit = (await q(`SELECT COUNT(*)::int n FROM (${FV}) t WHERE fv BETWEEN $1 AND $2 AND cnt >= 1`, [from, to]))[0].n;
    const repeat = (await q(`SELECT COUNT(*)::int n FROM (${FV}) t WHERE fv BETWEEN $1 AND $2 AND cnt >= 2`, [from, to]))[0].n;
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
         FROM clients c
         JOIN (SELECT client_id, MIN(starts_at)::date fv FROM appointments
                WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL GROUP BY client_id) f
           ON f.client_id=c.id
        WHERE f.fv BETWEEN $1 AND $2
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
           FROM appointments WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW() GROUP BY client_id),
       visits AS (
         SELECT a.client_id, date_trunc('month', a.starts_at)::date AS vm
           FROM appointments a WHERE a.status NOT IN ('cancelled','noshow') AND a.starts_at <= NOW())
       SELECT f.cohort,
              v.vm,
              COUNT(DISTINCT v.client_id)::int active,
              COALESCE(SUM(rev.amount),0)::numeric revenue
         FROM firsts f JOIN visits v ON v.client_id=f.client_id AND v.vm >= f.cohort
         LEFT JOIN cash_operations rev ON rev.type='in'
              AND rev.category IN ('sale_service','sale_product')
              AND date_trunc('month', rev.created_at)::date = v.vm
         WHERE f.cohort >= date_trunc('month', CURRENT_DATE) - ($1||' months')::interval
        GROUP BY f.cohort, v.vm ORDER BY f.cohort, v.vm`, [months]);
    // зведення у матрицю retention + LTV. Розмір когорти = активні у нульовому місяці.
    const map = {};
    for (const r of rows) {
      const ck = r.cohort.toISOString().slice(0, 7);
      if (!map[ck]) map[ck] = { cohort: ck, size: 0, retention: {}, ltv: {} };
      const offset = (new Date(r.vm).getFullYear() - new Date(r.cohort).getFullYear()) * 12 + (new Date(r.vm).getMonth() - new Date(r.cohort).getMonth());
      map[ck].retention[offset] = { active: r.active, revenue: Math.round(Number(r.revenue)) };
      if (offset === 0) map[ck].size = r.active;
    }
    // pct retention + кумулятивний LTV на клієнта когорти
    for (const ck in map) {
      const size = map[ck].size || 1;
      let cum = 0;
      const offs = Object.keys(map[ck].retention).map(Number).sort((a, b) => a - b);
      for (const off of offs) {
        map[ck].retention[off].pct = +((map[ck].retention[off].active / size) * 100).toFixed(0);
        cum += map[ck].retention[off].revenue || 0;
        map[ck].ltv[off] = Math.round(cum / size);
      }
    }
    res.json({ metric: req.query.metric || 'retention', cohorts: Object.values(map) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Інсайти — повний персистентний модуль нижче (marketing_insights). Старий inline-варіант прибрано.

// ── UTM-генератор ──
router.post('/utm', async (req, res) => {
  try {
    const { base_url, source, medium, campaign, term, content, shorten } = req.body || {};
    if (!base_url || !source || !medium) return res.status(400).json({ error: 'base_url, source, medium обовʼязкові' });
    const p = new URLSearchParams();
    p.set('utm_source', source); p.set('utm_medium', medium);
    if (campaign) p.set('utm_campaign', campaign);
    if (term) p.set('utm_term', term);
    if (content) p.set('utm_content', content);
    const sep = base_url.includes('?') ? '&' : '?';
    const full = `${base_url}${sep}${p.toString()}`;
    // короткий лінк — graceful: вбудований детермінований slug (зовнішній shortener = окрема INF-інтеграція)
    let short = null;
    if (shorten) {
      const slug = require('crypto').createHash('sha1').update(full).digest('hex').slice(0, 7);
      short = `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/u/${slug}`;
    }
    res.json({ full_url: full, url: full, short_url: short });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── UTM: реєстрація касання клієнта (multi-touch) ──
// POST /utm/track  { client_id?, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
//                    full_url, landing_page, referrer, ip_address, user_agent, device_type, is_converting_touch }
router.post('/utm/track', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.utm_source && !b.utm_medium && !b.utm_campaign && !b.full_url)
      return res.status(400).json({ error: 'потрібна хоча б одна UTM-мітка або full_url' });
    // порядковий номер касання для клієнта
    let touchNo = 1;
    if (b.client_id) {
      touchNo = (await q(`SELECT COALESCE(MAX(touch_number),0)+1 n FROM utm_tracking WHERE client_id=$1`, [b.client_id]))[0].n;
    }
    const r = await q(
      `INSERT INTO utm_tracking
         (client_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          full_url, landing_page, referrer, ip_address, user_agent, device_type,
          touch_number, is_converting_touch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14,false)) RETURNING *`,
      [b.client_id || null, b.utm_source || null, b.utm_medium || null, b.utm_campaign || null,
       b.utm_term || null, b.utm_content || null, b.full_url || null, b.landing_page || null,
       b.referrer || null, b.ip_address || null, b.user_agent || null, b.device_type || null,
       touchNo, b.is_converting_touch]);
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── UTM: зведений звіт source/medium/campaign з метриками + модель атрибуції ──
// GET /utm/report?from&to&group_by=source|medium|campaign&attribution_model=first_touch|last_touch|linear|time_decay|position
router.get('/utm/report', async (req, res) => {
  try {
    const { from, to } = period(req);
    const gbAllowed = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign' };
    const gb = gbAllowed[req.query.group_by] || 'utm_source';
    const model = ['first_touch', 'last_touch', 'linear', 'time_decay', 'position'].includes(req.query.attribution_model)
      ? req.query.attribution_model : 'last_touch';

    // Касання у періоді з привʼязкою до клієнта; рахуємо клієнтів / перші візити / виручку.
    // first_visit/last_visit для time_decay і position беруться з touch_number у межах клієнта.
    const touches = await q(
      `SELECT u.client_id, u.touch_number,
              COALESCE(u.${gb},'(none)') grp,
              c.total_spent, c.source AS client_source,
              fv.fv
         FROM utm_tracking u
         LEFT JOIN clients c ON c.id=u.client_id
         LEFT JOIN (SELECT client_id, MIN(starts_at)::date fv FROM appointments
                     WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL GROUP BY client_id) fv
                ON fv.client_id=u.client_id
        WHERE u.touch_at::date BETWEEN $1 AND $2`, [from, to]);

    // кредит касання за моделлю (спрощено на рівні клієнта: к-сть касань і позиція)
    const perClient = {};
    for (const t of touches) {
      (perClient[t.client_id || `anon_${t.touch_number}`] ||= []).push(t);
    }
    const agg = {}; // grp -> { clients:Set, credit, revenue, first_visits:Set }
    for (const cid in perClient) {
      const arr = perClient[cid].sort((a, b) => a.touch_number - b.touch_number);
      const n = arr.length;
      const rev = Number(arr[0].total_spent || 0);
      arr.forEach((t, i) => {
        let credit = 0;
        if (model === 'first_touch') credit = i === 0 ? 1 : 0;
        else if (model === 'last_touch') credit = i === n - 1 ? 1 : 0;
        else if (model === 'linear') credit = 1 / n;
        else if (model === 'time_decay') credit = Math.pow(2, i) ; // більше ваги пізнішим
        else if (model === 'position') credit = n === 1 ? 1 : (i === 0 || i === n - 1 ? 0.4 : (n > 2 ? 0.2 / (n - 2) : 0));
        const g = (agg[t.grp] ||= { grp: t.grp, clients: new Set(), credit: 0, revenue: 0, first_visits: new Set() });
        g.clients.add(cid);
        g.credit += credit;
        g.revenue += rev * credit;
        if (t.fv && t.fv >= from && t.fv <= to) g.first_visits.add(cid);
      });
    }
    // нормалізація time_decay (сума кредитів на клієнта = 1)
    if (model === 'time_decay') {
      // перерахунок: для кожного клієнта сума 2^i, нормуємо
      for (const g of Object.values(agg)) { g.credit = 0; g.revenue = 0; }
      for (const cid in perClient) {
        const arr = perClient[cid].sort((a, b) => a.touch_number - b.touch_number);
        const weights = arr.map((_, i) => Math.pow(2, i));
        const sum = weights.reduce((s, w) => s + w, 0) || 1;
        const rev = Number(arr[0].total_spent || 0);
        arr.forEach((t, i) => {
          const credit = weights[i] / sum;
          const g = agg[t.grp];
          g.credit += credit; g.revenue += rev * credit;
        });
      }
    }
    // витрати по каналу (зіставлення з marketing_budget/channel_spend за utm_source≈channel)
    const spendRows = await q(
      `SELECT channel, COALESCE(SUM(amount),0)::numeric s FROM marketing_channel_spend
        WHERE period_month >= date_trunc('month',$1::date) AND period_month <= $2::date GROUP BY channel`, [from, to]);
    const spendMap = Object.fromEntries(spendRows.map(s => [s.channel, Number(s.s)]));

    const rows = Object.values(agg).map(g => {
      const cost = spendMap[g.grp] || 0;
      const revenue = Math.round(g.revenue);
      return {
        [req.query.group_by || 'source']: g.grp,
        clients: g.clients.size,
        first_visits: g.first_visits.size,
        attributed_credit: +g.credit.toFixed(2),
        revenue, cost: Math.round(cost),
        roi: cost ? +((revenue - cost) / cost).toFixed(2) : null,
      };
    }).sort((a, b) => b.revenue - a.revenue);
    const total = rows.reduce((t, r) => ({
      clients: t.clients + r.clients, revenue: t.revenue + r.revenue, cost: t.cost + r.cost,
    }), { clients: 0, revenue: 0, cost: 0 });
    res.json({ period: { from, to }, group_by: req.query.group_by || 'source', attribution_model: model, rows, total });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Атрибуція конкретного клієнта (всі 5 моделей) ──
// GET /attribution/:client_id
router.get('/attribution/:client_id', async (req, res) => {
  try {
    const cid = parseInt(req.params.client_id, 10);
    if (!cid) return res.status(400).json({ error: 'невірний client_id' });
    const touches = await q(
      `SELECT id, utm_source, utm_medium, utm_campaign, touch_number, touch_at, is_converting_touch
         FROM utm_tracking WHERE client_id=$1 ORDER BY touch_number`, [cid]);
    // конверсії клієнта = візити (first/repeat) з суми total_spent
    const conv = await q(
      `SELECT MIN(starts_at) first_visit, COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow'))::int visits
         FROM appointments WHERE client_id=$1`, [cid]);
    const cl = (await q(`SELECT total_spent FROM clients WHERE id=$1`, [cid]))[0] || {};
    const value = Number(cl.total_spent || 0);

    const byModel = computeAttribution(touches.map(t => ({
      source: t.utm_source, medium: t.utm_medium, campaign: t.utm_campaign, touch_at: t.touch_at,
    })), value);

    // персист (idempotent оновлення останньої конверсії клієнта)
    await q(
      `INSERT INTO attribution_data (client_id, conversion_type, conversion_value, conversion_at, touches,
          attribution_first_touch, attribution_last_touch, attribution_linear, attribution_time_decay, attribution_position)
       VALUES ($1,'purchase',$2,NOW(),$3,$4,$5,$6,$7,$8)`,
      [cid, value, JSON.stringify(touches),
       JSON.stringify(byModel.first_touch), JSON.stringify(byModel.last_touch),
       JSON.stringify(byModel.linear), JSON.stringify(byModel.time_decay), JSON.stringify(byModel.position)]
    ).catch(() => {});

    res.json({
      client_id: cid,
      touches,
      conversions: [{ type: 'lifetime', value, first_visit: conv[0]?.first_visit, visits: conv[0]?.visits || 0 }],
      attribution_by_model: byModel,
    });
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
    // факт: нові — за першим візитом, виручка — з каси (а не appointments.price WHERE done)
    const newC = (await q(`SELECT COUNT(*)::int n FROM (
                             SELECT client_id, MIN(starts_at)::date fv FROM appointments
                              WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL GROUP BY client_id
                           ) t WHERE fv BETWEEN $1 AND $2`, [monStart, monEnd]))[0].n;
    const rev = (await q(`SELECT COALESCE(SUM(amount),0)::numeric s FROM cash_operations
                            WHERE type='in' AND category IN ('sale_service','sale_product')
                              AND created_at::date BETWEEN $1 AND $2`, [monStart, monEnd]))[0].s;
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

// ── Бюджет маркетингу (план/факт/committed + workflow) ─────────────────────────
const BUDGET_CHANNELS = ['telegram', 'sms', 'email', 'viber', 'google_ads', 'meta_ads', 'instagram', 'referral', 'offline', 'other'];

function periodEnd(periodType, startStr) {
  const d = new Date(startStr);
  if (periodType === 'year') return new Date(d.getFullYear(), 11, 31).toISOString().slice(0, 10);
  if (periodType === 'quarter') return new Date(d.getFullYear(), d.getMonth() + 3, 0).toISOString().slice(0, 10);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

// Факт витрат по каналу за період = ручні (marketing_channel_spend) + рефералка (для referral).
async function actualSpendByChannel(channel, from, to) {
  const manual = (await q(
    `SELECT COALESCE(SUM(amount),0)::numeric s FROM marketing_channel_spend
      WHERE channel=$1 AND period_month >= date_trunc('month',$2::date) AND period_month <= $3::date`,
    [channel, from, to]))[0].s;
  let extra = 0;
  if (channel === 'referral') {
    extra = Number((await q(`SELECT COALESCE(SUM(reward_amount),0)::numeric s FROM referral_rewards WHERE status='issued' AND issued_at::date BETWEEN $1 AND $2`, [from, to]))[0].s);
  }
  return Number(manual) + extra;
}

router.get('/budget', async (req, res) => {
  try {
    const w = [], p = [];
    if (req.query.period_type) { p.push(req.query.period_type); w.push(`period_type=$${p.length}`); }
    if (req.query.period_start) { p.push(String(req.query.period_start).slice(0, 7) + '-01'); w.push(`period_start=$${p.length}`); }
    if (req.query.channel) { p.push(req.query.channel); w.push(`channel=$${p.length}`); }
    const rows = await q(`SELECT * FROM marketing_budget ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY period_start DESC, channel`, p);
    // підтягуємо актуальний факт по кожному рядку
    const budgets = [];
    for (const b of rows) {
      const spent = await actualSpendByChannel(b.channel, b.period_start, b.period_end);
      budgets.push({ ...b, budget_spent: spent, remaining: +(Number(b.budget_planned) - spent).toFixed(2) });
    }
    const totals = budgets.reduce((t, b) => ({
      planned: t.planned + Number(b.budget_planned),
      spent: t.spent + Number(b.budget_spent),
      committed: t.committed + Number(b.budget_committed),
    }), { planned: 0, spent: 0, committed: 0 });
    totals.remaining = +(totals.planned - totals.spent).toFixed(2);
    res.json({ budgets, totals });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/budget', async (req, res) => {
  try {
    const b = req.body || {};
    const periodType = ['month', 'quarter', 'year'].includes(b.period_type) ? b.period_type : 'month';
    if (!b.period_start || !Array.isArray(b.items) || !b.items.length)
      return res.status(400).json({ error: 'period_start і items[] обовʼязкові' });
    const start = String(b.period_start).slice(0, 7) + '-01';
    const end = b.period_end || periodEnd(periodType, start);
    const out = [];
    for (const it of b.items) {
      if (!it.channel || !BUDGET_CHANNELS.includes(it.channel)) continue;
      const r = await q(
        `INSERT INTO marketing_budget (period_type, period_start, period_end, channel, budget_planned)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, period_start, channel)
           DO UPDATE SET budget_planned=EXCLUDED.budget_planned, period_type=EXCLUDED.period_type,
                         period_end=EXCLUDED.period_end, updated_at=NOW()
         RETURNING *`,
        [periodType, start, end, it.channel, it.budget_planned || 0]);
      out.push(r[0]);
    }
    logAction({ user: req.user, action: 'marketing.budget_upsert', entity: 'marketing_budget', entity_id: start, ip: req.ip }).catch(() => {});
    res.json({ budgets: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/budget/:id', async (req, res) => {
  try {
    const allowed = ['budget_planned', 'budget_committed', 'status', 'notes'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'нічого оновлювати' });
    vals.push(parseInt(req.params.id, 10));
    const r = await q(`UPDATE marketing_budget SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.length) return res.status(404).json({ error: 'не знайдено' });
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Утвердження бюджету (workflow). Тільки marketing.write (мутація).
router.post('/budget/:id/approve', async (req, res) => {
  try {
    const approver = (req.user && (req.user.name || req.user.email || String(req.user.id))) || 'system';
    const r = await q(
      `UPDATE marketing_budget SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
        WHERE id=$2 RETURNING *`, [approver, parseInt(req.params.id, 10)]);
    if (!r.length) return res.status(404).json({ error: 'не знайдено' });
    logAction({ user: req.user, action: 'marketing.budget_approve', entity: 'marketing_budget', entity_id: req.params.id, ip: req.ip }).catch(() => {});
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Зведені кампанії з усіх модулів (overview) ────────────────────────────────
// Синхронізує marketing-campaigns (MKT-03 campaigns) + рефералку у marketing_campaigns_overview не зберігаємо
// окремо — обчислюємо «на льоту» поверх campaigns/referrals (НЕ створюємо кампанії, лише зводимо).
router.get('/campaigns', async (req, res) => {
  try {
    const { from, to } = period(req);
    const w = ['1=1'], p = [];
    if (req.query.status) { p.push(req.query.status); w.push(`c.status=$${p.length}`); }
    if (req.query.channel) { p.push(req.query.channel); w.push(`c.channel=$${p.length}`); }
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const sortMap = { roi: 'roi', spend: 'spend', revenue: 'revenue' };
    const sortBy = sortMap[req.query.sort_by] || 'revenue';

    const camps = await q(
      `SELECT c.id, c.name, c.status, c.channel, c.scheduled_at, c.launched_at, c.done_at,
              c.audience_size, c.enqueued
         FROM campaigns c WHERE ${w.join(' AND ')}
        ORDER BY c.created_at DESC`, p);

    // виручка/витрати по кожній кампанії — поки агрегуємо доступне:
    // витрати = з marketing_channel_spend по каналу кампанії за період; виручка = клієнти з UTM utm_campaign=name.
    const enriched = [];
    for (const c of camps) {
      const cost = await actualSpendByChannel(c.channel, from, to);
      const revRow = (await q(
        `SELECT COALESCE(SUM(cl.total_spent),0)::numeric s, COUNT(DISTINCT cl.id)::int n
           FROM utm_tracking u JOIN clients cl ON cl.id=u.client_id
          WHERE u.utm_campaign=$1`, [c.name]))[0];
      const revenue = Math.round(Number(revRow.s));
      enriched.push({
        id: c.id, source_module: 'MKT-03', name: c.name, type: 'campaign',
        status: c.status, channels: c.channel ? [c.channel] : [],
        started_at: c.launched_at, ended_at: c.done_at,
        audience_size: c.audience_size, enqueued: c.enqueued,
        attributed_clients: revRow.n,
        budget_spent: Math.round(cost), revenue,
        roi: cost ? +((revenue - cost) / cost).toFixed(2) : null,
      });
    }
    enriched.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
    const paged = enriched.slice(offset, offset + limit);
    const summary = enriched.reduce((s, c) => ({
      total_spend: s.total_spend + (c.budget_spent || 0),
      total_revenue: s.total_revenue + (c.revenue || 0),
      _roiSum: s._roiSum + (c.roi || 0), _roiN: s._roiN + (c.roi != null ? 1 : 0),
    }), { total_spend: 0, total_revenue: 0, _roiSum: 0, _roiN: 0 });
    res.json({
      period: { from, to },
      campaigns: paged, total: enriched.length,
      summary: { total_spend: summary.total_spend, total_revenue: summary.total_revenue, avg_roi: summary._roiN ? +(summary._roiSum / summary._roiN).toFixed(2) : null },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/campaigns/:id', async (req, res) => {
  try {
    const { from, to } = period(req);
    const c = (await q(`SELECT * FROM campaigns WHERE id=$1`, [parseInt(req.params.id, 10)]))[0];
    if (!c) return res.status(404).json({ error: 'не знайдено' });
    const cost = await actualSpendByChannel(c.channel, from, to);
    const revRow = (await q(
      `SELECT COALESCE(SUM(cl.total_spent),0)::numeric s, COUNT(DISTINCT cl.id)::int n
         FROM utm_tracking u JOIN clients cl ON cl.id=u.client_id WHERE u.utm_campaign=$1`, [c.name]))[0];
    const revenue = Math.round(Number(revRow.s));
    res.json({
      campaign: c,
      stats: {
        attributed_clients: revRow.n, budget_spent: Math.round(cost), revenue,
        roi: cost ? +((revenue - cost) / cost).toFixed(2) : null,
        audience_size: c.audience_size, enqueued: c.enqueued, skipped: c.skipped,
      },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Сегментація аудиторії на РЕАЛЬНИХ clients/appointments ─────────────────────
// POST /audience/preview { filters: { gender?, age_min?, age_max?, last_visit_before?, last_visit_after?,
//   total_spent_min?, total_spent_max?, service_ids?:[], tags?:[], tags_mode?:'any'|'all', source? } }
// Повертає розмір аудиторії + семпл (для кампаній/рассилок). Реальні дані, без зовнішніх каналів.
router.post('/audience/preview', async (req, res) => {
  try {
    const f = (req.body && req.body.filters) || {};
    const w = ['1=1'], p = [];
    // вік за birthday
    if (f.age_min != null) { p.push(f.age_min); w.push(`c.birthday IS NOT NULL AND date_part('year', age(c.birthday)) >= $${p.length}`); }
    if (f.age_max != null) { p.push(f.age_max); w.push(`c.birthday IS NOT NULL AND date_part('year', age(c.birthday)) <= $${p.length}`); }
    // останній візит
    if (f.last_visit_before) { p.push(f.last_visit_before); w.push(`c.last_visit_at < $${p.length}`); }
    if (f.last_visit_after) { p.push(f.last_visit_after); w.push(`c.last_visit_at >= $${p.length}`); }
    // сума витрат
    if (f.total_spent_min != null) { p.push(f.total_spent_min); w.push(`c.total_spent >= $${p.length}`); }
    if (f.total_spent_max != null) { p.push(f.total_spent_max); w.push(`c.total_spent <= $${p.length}`); }
    // джерело
    if (f.source) { p.push(f.source); w.push(`c.source = $${p.length}`); }
    // теги
    if (Array.isArray(f.tags) && f.tags.length) {
      p.push(f.tags);
      w.push(f.tags_mode === 'all' ? `c.tags @> $${p.length}` : `c.tags && $${p.length}`);
    }
    // фільтр за послугами (через appointments)
    let svcJoin = '';
    if (Array.isArray(f.service_ids) && f.service_ids.length) {
      p.push(f.service_ids);
      svcJoin = `JOIN appointments ap ON ap.client_id=c.id AND ap.service_id = ANY($${p.length}) AND ap.status NOT IN ('cancelled','noshow')`;
    }
    const base = `FROM clients c ${svcJoin} WHERE ${w.join(' AND ')}`;
    const size = (await q(`SELECT COUNT(DISTINCT c.id)::int n ${base}`, p))[0].n;
    const sample = await q(
      `SELECT DISTINCT c.id, c.name, c.phone, c.total_spent, c.last_visit_at, c.tags, c.source ${base} ORDER BY c.id LIMIT 25`, p);
    res.json({ size, sample, filters: f });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Інсайти (персистентні) ────────────────────────────────────────────────────
// Генерує/оновлює інсайти у marketing_insights з dedup_key (idempotent) на основі реальних даних.
async function generateInsights() {
  const created = [];
  const upsert = async (ins) => {
    const r = await q(
      `INSERT INTO marketing_insights (type, title, description, data, suggested_action, action_module, priority, dedup_key, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_DATE + INTERVAL '30 days')
       ON CONFLICT (tenant_id, dedup_key)
         DO UPDATE SET description=EXCLUDED.description, data=EXCLUDED.data, priority=EXCLUDED.priority,
                       valid_until=EXCLUDED.valid_until, generated_at=NOW(), updated_at=NOW()
       RETURNING *`,
      [ins.type, ins.title, ins.description, JSON.stringify(ins.data || {}), ins.suggested_action || null,
       ins.action_module || null, ins.priority || 0, ins.dedup_key]);
    created.push(r[0]);
  };
  // 1) найкращий канал за LTV
  const ch = await q(`SELECT COALESCE(source,'unknown') channel, COUNT(*)::int n, COALESCE(AVG(NULLIF(total_spent,0)),0)::numeric ltv
                        FROM clients GROUP BY source HAVING COUNT(*) >= 5 ORDER BY ltv DESC`);
  if (ch.length >= 2) {
    const best = ch[0], avg = ch.reduce((s, x) => s + Number(x.ltv), 0) / ch.length;
    if (Number(best.ltv) > avg * 1.2)
      await upsert({ type: 'channel', priority: 2, dedup_key: `channel_ltv_${best.channel}`,
        title: `Канал «${best.channel}» — найкращий LTV`,
        description: `Клієнти з «${best.channel}» мають LTV ${Math.round(best.ltv)}₴ — на ${Math.round((best.ltv / avg - 1) * 100)}% вище середнього. Варто збільшити бюджет.`,
        suggested_action: 'increase_budget', action_module: 'MKT-01', data: { channel: best.channel, ltv: Math.round(best.ltv) } });
  }
  // 2) сплячі клієнти
  const dormant = (await q(`SELECT COUNT(*)::int n FROM clients WHERE last_visit_at < CURRENT_DATE - INTERVAL '90 days' AND total_spent > 0`))[0].n;
  if (dormant > 0)
    await upsert({ type: 'retention', priority: dormant > 50 ? 2 : 1, dedup_key: 'retention_dormant',
      title: `${dormant} сплячих клієнтів`, description: `${dormant} клієнтів не відвідували понад 90 днів. Запусти реактиваційну кампанію.`,
      suggested_action: 'reactivation_campaign', action_module: 'MKT-03', data: { dormant } });
  // 3) чернетки кампаній
  const draft = (await q(`SELECT COUNT(*)::int n FROM campaigns WHERE status='draft'`))[0].n;
  if (draft > 0)
    await upsert({ type: 'campaign', priority: 0, dedup_key: 'campaign_drafts',
      title: `${draft} незапущених кампаній`, description: `${draft} чернеток кампаній не запущено. Заверши або видали.`,
      suggested_action: 'review_drafts', action_module: 'MKT-03', data: { draft } });
  // 4) оптимальний час рассилки (за відвідуваністю по днях тижня)
  const dow = await q(`SELECT EXTRACT(DOW FROM starts_at)::int d, COUNT(*)::int n FROM appointments
                        WHERE status NOT IN ('cancelled','noshow') AND starts_at > NOW() - INTERVAL '90 days'
                        GROUP BY d ORDER BY n DESC LIMIT 1`);
  if (dow.length) {
    const names = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
    await upsert({ type: 'timing', priority: 1, dedup_key: 'timing_best_dow',
      title: 'Оптимальний день для активностей', description: `Найбільше візитів припадає на ${names[dow[0].d]} — плануй рассилки/акції на цей день.`,
      suggested_action: 'schedule', action_module: 'MKT-01', data: { dow: dow[0].d, visits: dow[0].n } });
  }
  return created;
}

router.get('/insights', async (req, res) => {
  try {
    const w = ['(valid_until IS NULL OR valid_until >= CURRENT_DATE)'], p = [];
    if (req.query.status) { p.push(req.query.status); w.push(`status=$${p.length}`); }
    else { w.push(`status='new'`); }
    if (req.query.type) { p.push(req.query.type); w.push(`type=$${p.length}`); }
    if (req.query.priority != null) { p.push(parseInt(req.query.priority, 10)); w.push(`priority=$${p.length}`); }
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    let rows = await q(`SELECT * FROM marketing_insights WHERE ${w.join(' AND ')} ORDER BY priority DESC, generated_at DESC LIMIT ${limit}`, p);
    // якщо нових немає — згенерувати на льоту
    if (!rows.length && (!req.query.status || req.query.status === 'new')) {
      await generateInsights().catch(() => {});
      rows = await q(`SELECT * FROM marketing_insights WHERE ${w.join(' AND ')} ORDER BY priority DESC, generated_at DESC LIMIT ${limit}`, p);
    }
    res.json({ generated_at: new Date().toISOString(), insights: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Примусова перегенерація (batch job ендпоінт). Мутація → marketing.write.
router.post('/insights/generate', async (req, res) => {
  try {
    const created = await generateInsights();
    res.json({ generated: created.length, insights: created });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/insights/:id', async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (!['new', 'accepted', 'rejected', 'dismissed'].includes(status))
      return res.status(400).json({ error: 'status: new|accepted|rejected|dismissed' });
    const r = await q(`UPDATE marketing_insights SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [status, parseInt(req.params.id, 10)]);
    if (!r.length) return res.status(404).json({ error: 'не знайдено' });
    logAction({ user: req.user, action: 'marketing.insight_status', entity: 'marketing_insight', entity_id: req.params.id, ip: req.ip, meta: { status } }).catch(() => {});
    res.json(r[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
