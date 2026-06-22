/* routes/ai.js — AI-04 Analytics (AI-аналитик салона).
   LLM рассуждает ТОЛЬКО над готовым JSON-снимком метрик (никакого SQL от модели → ноль инъекций).
   Эндпоинты:
     GET  /api/ai/insights  — авто-инсайты + рекомендации (кеш 1ч)
     POST /api/ai/ask       — вопрос к данным на естественном языке
   Защита: reports.finance (видит выручку). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();

// Киевские границы суток
function kyivOffsetMin(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kiev', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const p = {}; for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month-1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

const WEEKDAYS = ['Неділя','Понеділок','Вівторок','Середа','Четвер','Пʼятниця','Субота'];

/** Собрать компактный снимок состояния салона за последние 30/90 дней. */
async function buildSnapshot() {
  const q = (sql, params=[]) => pool.query(sql, params).then(r=>r.rows).catch(()=>[]);
  const [
    rev30, revByWeekday, masters, churn, lowStock, newClients, monthSales, prevMonthSales, cancelStats
  ] = await Promise.all([
    // выручка по дням за 30 дней (услуги+товары из кассы)
    q(`SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') AS d,
              SUM(amount)::numeric AS total
       FROM cash_operations
       WHERE type='in' AND category IN ('sale_service','sale_product')
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY d ORDER BY d`),
    // выручка по дню недели (90 дней) — для загрузки
    q(`SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Europe/Kiev')::int AS dow,
              SUM(amount)::numeric AS total, COUNT(*)::int AS ops
       FROM cash_operations
       WHERE type='in' AND category IN ('sale_service','sale_product')
         AND created_at >= NOW() - INTERVAL '90 days'
       GROUP BY dow ORDER BY dow`),
    // KPI мастеров за 30 дней
    q(`SELECT m.name,
              COALESCE(SUM(a.price) FILTER (WHERE a.status='done'),0)::numeric AS revenue,
              COUNT(*) FILTER (WHERE a.status='done')::int AS done,
              COUNT(*) FILTER (WHERE a.status IN ('cancelled','noshow'))::int AS lost
       FROM masters m LEFT JOIN appointments a
         ON a.master_id=m.id AND a.starts_at >= NOW() - INTERVAL '30 days'
       WHERE m.active=true AND COALESCE(m.provides_services,true)=true
       GROUP BY m.id, m.name ORDER BY revenue DESC`),
    // отток: ≥2 визита, последний >90 дней
    q(`SELECT COUNT(*)::int AS n FROM (
         SELECT c.id FROM clients c JOIN appointments a ON a.client_id=c.id
         WHERE a.status NOT IN ('cancelled','noshow')
         GROUP BY c.id HAVING MAX(a.starts_at) < NOW() - INTERVAL '90 days' AND COUNT(a.id) >= 2
       ) t`),
    // позиции на выходе
    q(`SELECT COUNT(*)::int AS n FROM product_variants WHERE active=true AND COALESCE(stock_qty,0) <= 5`),
    // новые клиенты за 30 дней
    q(`SELECT COUNT(*)::int AS n FROM clients WHERE created_at >= NOW() - INTERVAL '30 days'`),
    // продажи текущий мес
    q(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS cnt
       FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product')
         AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`),
    // продажи прошлый мес (та же часть месяца)
    q(`SELECT COALESCE(SUM(amount),0)::numeric AS total, COUNT(*)::int AS cnt
       FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product')
         AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev') - INTERVAL '1 month'
         AND created_at <  date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev') - INTERVAL '1 month' + (NOW() - date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev'))`),
    // отмены за 30 дней
    q(`SELECT COUNT(*) FILTER (WHERE status='done')::int AS done,
              COUNT(*) FILTER (WHERE status='cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE status='noshow')::int AS noshow
       FROM appointments WHERE starts_at >= NOW() - INTERVAL '30 days'`),
  ]);

  const wd = WEEKDAYS.map((name, dow) => {
    const row = revByWeekday.find(r => r.dow === dow);
    return { day: name, revenue: row ? Math.round(Number(row.total)) : 0, ops: row ? row.ops : 0 };
  });
  const rev30arr = rev30.map(r => ({ date: r.d, total: Math.round(Number(r.total)) }));
  const totalRev30 = rev30arr.reduce((s, x) => s + x.total, 0);

  return {
    period: 'останні 30 днів',
    revenue_30d_total: totalRev30,
    revenue_by_day: rev30arr,
    revenue_by_weekday: wd,
    masters: masters.map(m => ({ name: m.name, revenue: Math.round(Number(m.revenue)), done: m.done, lost: m.lost })),
    churn_clients: churn[0]?.n || 0,
    new_clients_30d: newClients[0]?.n || 0,
    low_stock_positions: lowStock[0]?.n || 0,
    month_vs_prev: {
      this_month: Math.round(Number(monthSales[0]?.total || 0)),
      prev_month_same_period: Math.round(Number(prevMonthSales[0]?.total || 0)),
    },
    appointments_30d: cancelStats[0] || { done: 0, cancelled: 0, noshow: 0 },
  };
}

/* ── Глибокий розбір однієї теми (drill-down) ───────────────────
   Беремо РЕАЛЬНІ рядки з БД за темою (не вигадка), віддаємо моделі для
   діагнозу + плану дій. Кожна тема повертає { title, metrics, rows }:
   rows — справжній список (клієнти/майстри/товари), metrics — агрегати. */
async function drillData(topic) {
  const q = (sql, params=[]) => pool.query(sql, params).then(r=>r.rows).catch(()=>[]);
  switch (topic) {
    case 'churn': {
      // База відтоку: ≥2 візити, останній >90 днів тому. Рахуємо в CTE один раз.
      const base = `WITH churned AS (
          SELECT c.id, c.name, c.phone, COALESCE(c.total_spent,0)::numeric AS spent,
                 MAX(a.starts_at) AS last_visit,
                 COUNT(a.id) FILTER (WHERE a.status='done')::int AS visits
          FROM clients c JOIN appointments a ON a.client_id=c.id
          WHERE a.status NOT IN ('cancelled','noshow')
          GROUP BY c.id
          HAVING MAX(a.starts_at) < NOW() - INTERVAL '90 days' AND COUNT(a.id) >= 2)`;
      const [rows, byMaster, byService, agg] = await Promise.all([
        q(`${base}
           SELECT ch.id, ch.name, ch.phone, ch.spent, ch.visits,
                  (NOW()::date - ch.last_visit::date) AS days_since,
                  (SELECT s.name FROM appointments a2 JOIN services s ON s.id=a2.service_id
                     WHERE a2.client_id=ch.id AND a2.status='done' ORDER BY a2.starts_at DESC LIMIT 1) AS last_service,
                  (SELECT m.name FROM appointments a3 JOIN masters m ON m.id=a3.master_id
                     WHERE a3.client_id=ch.id AND a3.status='done' ORDER BY a3.starts_at DESC LIMIT 1) AS last_master
           FROM churned ch ORDER BY ch.spent DESC NULLS LAST, ch.last_visit ASC LIMIT 40`),
        q(`${base}
           SELECT m.name, COUNT(*)::int AS lost_clients
           FROM churned ch
           JOIN LATERAL (SELECT a.master_id FROM appointments a WHERE a.client_id=ch.id AND a.status='done' ORDER BY a.starts_at DESC LIMIT 1) lm ON true
           JOIN masters m ON m.id=lm.master_id
           GROUP BY m.name ORDER BY lost_clients DESC LIMIT 8`),
        q(`${base}
           SELECT s.name, COUNT(*)::int AS lost_clients
           FROM churned ch
           JOIN LATERAL (SELECT a.service_id FROM appointments a WHERE a.client_id=ch.id AND a.status='done' ORDER BY a.starts_at DESC LIMIT 1) ls ON true
           JOIN services s ON s.id=ls.service_id
           GROUP BY s.name ORDER BY lost_clients DESC LIMIT 8`),
        q(`${base} SELECT COUNT(*)::int AS n, COALESCE(SUM(ch.spent),0)::numeric AS potential,
                          ROUND(AVG(NOW()::date - ch.last_visit::date))::int AS avg_days FROM churned ch`),
      ]);
      return {
        title: 'Відтік клієнтів',
        metrics: {
          churned_total: agg[0]?.n || 0,
          lost_revenue_potential: Math.round(Number(agg[0]?.potential || 0)),
          avg_days_since_visit: agg[0]?.avg_days || 0,
          by_master: byMaster, by_service: byService,
        },
        rows: rows.map(r => ({ name: r.name, phone: r.phone, spent: Math.round(Number(r.spent||0)),
          visits: r.visits, days_since: r.days_since, last_service: r.last_service, last_master: r.last_master })),
        rows_label: 'Клієнти, що зникли (топ за сумою витрат)',
      };
    }
    case 'masters': {
      const rows = await q(`SELECT m.name,
          COUNT(*) FILTER (WHERE a.status='done')::int AS done,
          COUNT(*) FILTER (WHERE a.status='cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE a.status='noshow')::int AS noshow,
          COALESCE(SUM(a.price) FILTER (WHERE a.status='done'),0)::numeric AS revenue
        FROM masters m LEFT JOIN appointments a
          ON a.master_id=m.id AND a.starts_at >= NOW() - INTERVAL '90 days'
        WHERE m.active=true AND COALESCE(m.provides_services,true)=true
        GROUP BY m.id, m.name ORDER BY revenue DESC`);
      const enriched = rows.map(r => {
        const total = r.done + r.cancelled + r.noshow;
        return { name: r.name, done: r.done, cancelled: r.cancelled, noshow: r.noshow,
          revenue: Math.round(Number(r.revenue||0)),
          cancel_rate: total ? Math.round((r.cancelled + r.noshow) / total * 100) : 0 };
      });
      return { title: 'Майстри: завантаження і відміни', metrics: { period: '90 днів', count: enriched.length },
        rows: enriched, rows_label: 'Майстри за виручкою (% відмін = скасування+неявки)' };
    }
    case 'weekday': {
      const rows = await q(`SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'Europe/Kiev')::int AS dow,
          SUM(amount)::numeric AS total, COUNT(*)::int AS ops
        FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product')
          AND created_at >= NOW() - INTERVAL '90 days' GROUP BY dow`);
      const wd = WEEKDAYS.map((name, dow) => {
        const r = rows.find(x => x.dow === dow);
        return { day: name, revenue: r ? Math.round(Number(r.total)) : 0, ops: r ? r.ops : 0,
          avg_check: r && r.ops ? Math.round(Number(r.total)/r.ops) : 0 };
      });
      return { title: 'Виручка по днях тижня', metrics: { period: '90 днів' },
        rows: wd, rows_label: 'День тижня · виручка · к-сть продажів · середній чек' };
    }
    case 'low_stock': {
      const rows = await q(`SELECT pv.id, p.name AS product_name, pv.volume, COALESCE(pv.stock_qty,0)::int AS stock_qty
        FROM product_variants pv JOIN products p ON p.id=pv.product_id
        WHERE pv.active=true AND COALESCE(pv.stock_qty,0) <= 5 ORDER BY pv.stock_qty ASC LIMIT 40`);
      return { title: 'Товари на виході', metrics: { positions: rows.length },
        rows, rows_label: 'Позиції з критичним залишком (≤5)' };
    }
    case 'month_vs_prev': {
      const rows = await q(`SELECT category,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')),0)::numeric AS this_month,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev') - INTERVAL '1 month'
                    AND created_at < date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev') - INTERVAL '1 month' + (NOW() - date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev'))),0)::numeric AS prev_month
        FROM cash_operations WHERE type='in' AND category IN ('sale_service','sale_product') GROUP BY category`);
      return { title: 'Динаміка місяць-до-місяця', metrics: { note: 'та сама частина місяця' },
        rows: rows.map(r => ({ category: r.category==='sale_service'?'Послуги':'Товари',
          this_month: Math.round(Number(r.this_month)), prev_month: Math.round(Number(r.prev_month)),
          delta_pct: Number(r.prev_month) ? Math.round((Number(r.this_month)-Number(r.prev_month))/Number(r.prev_month)*100) : null })),
        rows_label: 'Категорія · цей місяць · минулий (та сама частина) · зміна %' };
    }
    case 'new_clients': {
      const rows = await q(`SELECT to_char(date_trunc('week', created_at AT TIME ZONE 'Europe/Kiev'),'YYYY-MM-DD') AS week,
          COUNT(*)::int AS n FROM clients
        WHERE created_at >= NOW() - INTERVAL '84 days' GROUP BY week ORDER BY week`);
      const repeat = await q(`SELECT COUNT(*)::int AS n FROM (
          SELECT c.id FROM clients c JOIN appointments a ON a.client_id=c.id AND a.status='done'
          WHERE c.created_at >= NOW() - INTERVAL '90 days' GROUP BY c.id HAVING COUNT(a.id) >= 2) t`);
      return { title: 'Притік нових клієнтів', metrics: { repeat_within_90d: repeat[0]?.n || 0 },
        rows, rows_label: 'Нові клієнти по тижнях (останні 12 тижнів)' };
    }
    default:
      return null;
  }
}

const DRILL_SYSTEM = `Ти — AI-аналітик салону краси. Тобі дають РЕАЛЬНІ дані по одній темі.
Зроби глибокий, але стислий розбір українською: діагноз з конкретними цифрами, ймовірні причини,
і покроковий план дій, який реально впровадити в салоні. Жодних вигадок — лише надані цифри.`;

function drillPrompt(topic, d) {
  return `Тема розбору: "${d.title}".
РЕАЛЬНІ дані салону по цій темі:
${JSON.stringify({ metrics: d.metrics, sample_rows: (d.rows||[]).slice(0, 25) }, null, 1)}

Проаналізуй і поверни СУВОРО валідний JSON (без markdown), форма:
{
  "summary": "1-2 речення: суть проблеми/ситуації з конкретними цифрами",
  "findings": [{"label":"що саме","value":"цифра/факт","note":"чому це важливо"}],
  "root_causes": ["ймовірна причина 1", "причина 2"],
  "action_plan": [{"step":"конкретна дія","detail":"як зробити","expected":"очікуваний ефект з цифрою"}],
  "kpi_to_watch": "який показник відстежувати, щоб зрозуміти що спрацювало"
}
Дай 3-5 findings, 2-4 root_causes, 3-5 кроків плану. Спирайся ЛИШЕ на надані числа.`;
}

const SYSTEM = `Ти — AI-аналітик салону краси. Аналізуєш дані та даєш власнику салону конкретні, дієві поради українською мовою.
Пиши коротко і по суті, як досвідчений керівник. Без води, без загальних фраз. Кожна порада — конкретна дія з очікуваним ефектом.
Оперуй цифрами з наданих даних. Якщо бачиш аномалію (різке падіння/зростання) — поясни ймовірну причину.`;

function insightsPrompt(snap) {
  return `Дані салону (${snap.period}):
${JSON.stringify(snap, null, 1)}

Проаналізуй і поверни СУВОРО валідний JSON такої структури (без markdown):
{
  "summary": "1-2 речення: загальний стан салону зараз",
  "insights": [
    {"type":"good|warning|critical","title":"коротко","detail":"пояснення з цифрами"}
  ],
  "recommendations": [
    {"action":"конкретна дія","why":"очікуваний ефект з цифрами"}
  ]
}
Дай 2-4 insights і 2-4 recommendations. Звертай увагу на: дні тижня з низькою виручкою, мастерів з високим % відмін, відтік клієнтів, товари на виході, динаміку місяць-до-місяця.`;
}

// ── Кеш инсайтов (per-process, 1ч) ─────────────────────────
let _cache = { at: 0, data: null, key: '' };
const CACHE_MS = 60 * 60 * 1000;

// GET /api/ai/insights?fresh=1
router.get('/insights', requirePerm('reports.finance'), async (req, res) => {
  try {
    if (!llm.available()) return res.status(503).json({ error: 'ai_unconfigured', message: 'LLM-ключ не налаштовано на сервері' });
    const fresh = req.query.fresh === '1';
    if (!fresh && _cache.data && (Date.now() - _cache.at) < CACHE_MS) {
      return res.json({ ..._cache.data, cached: true });
    }
    const snapshot = await buildSnapshot();
    let ai = null;
    try { ai = await llm.askJSON(insightsPrompt(snapshot), { system: SYSTEM, maxTokens: 1800 }); }
    catch (e) { console.error('[ai:insights] llm fail', e.message); }

    const payload = {
      generated_at: new Date().toISOString(),
      snapshot: {
        revenue_30d: snapshot.revenue_30d_total,
        new_clients: snapshot.new_clients_30d,
        churn: snapshot.churn_clients,
        low_stock: snapshot.low_stock_positions,
        month_vs_prev: snapshot.month_vs_prev,
      },
      ...(ai || { summary: 'AI тимчасово недоступний — показано лише цифри.', insights: [], recommendations: [] }),
      ai_ok: !!ai,
      cached: false,
    };
    if (ai) { _cache = { at: Date.now(), data: payload }; }
    res.json(payload);
  } catch (e) {
    console.error('[ai:insights]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /api/ai/drill { topic } — глибокий розбір однієї теми на РЕАЛЬНИХ даних.
// Кеш per-topic 30хв (важче за insights, але теж не часто змінюється).
const DRILL_TOPICS = ['churn','masters','weekday','low_stock','month_vs_prev','new_clients'];
let _drillCache = {};
const DRILL_CACHE_MS = 30 * 60 * 1000;
router.post('/drill', requirePerm('reports.finance'), async (req, res) => {
  try {
    const topic = String(req.body?.topic || '').trim();
    if (!DRILL_TOPICS.includes(topic)) return res.status(400).json({ error: 'unknown_topic' });
    const fresh = req.query.fresh === '1' || req.body?.fresh === true;
    const c = _drillCache[topic];
    if (!fresh && c && (Date.now() - c.at) < DRILL_CACHE_MS) return res.json({ ...c.data, cached: true });

    const d = await drillData(topic);
    if (!d) return res.status(400).json({ error: 'unknown_topic' });
    // Якщо даних немає зовсім — чесно кажемо, без виклику LLM.
    if (!d.rows || !d.rows.length) {
      return res.json({ topic, title: d.title, metrics: d.metrics, rows: [], rows_label: d.rows_label,
        summary: 'Поки немає даних для цієї теми — нема що аналізувати.', findings: [], root_causes: [], action_plan: [], ai_ok: false });
    }
    let ai = null;
    if (llm.available()) {
      try { ai = await llm.askJSON(drillPrompt(topic, d), { system: DRILL_SYSTEM, maxTokens: 1800 }); }
      catch (e) { console.error('[ai:drill] llm fail', e.message); }
    }
    const payload = {
      topic, title: d.title, metrics: d.metrics, rows: d.rows, rows_label: d.rows_label,
      generated_at: new Date().toISOString(),
      ...(ai || { summary: 'AI тимчасово недоступний — нижче лише реальні цифри.', findings: [], root_causes: [], action_plan: [], kpi_to_watch: '' }),
      ai_ok: !!ai, cached: false,
    };
    if (ai) _drillCache[topic] = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (e) {
    console.error('[ai:drill]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// POST /api/ai/ask { question }
router.post('/ask', requirePerm('reports.finance'), async (req, res) => {
  try {
    if (!llm.available()) return res.status(503).json({ error: 'ai_unconfigured' });
    const question = String(req.body?.question || '').trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: 'no_question' });
    const snapshot = await buildSnapshot();
    const prompt = `Дані салону (${snapshot.period}):
${JSON.stringify(snapshot, null, 1)}

Питання керівника: "${question}"

Дай чітку коротку відповідь українською на основі цих даних. Якщо даних бракує — скажи чесно чого саме бракує. Оперуй цифрами. Пиши звичайним текстом без markdown-розмітки (без зірочок, решіток, списків з *).`;
    let answer = null;
    try { answer = await llm.ask(prompt, { system: SYSTEM, maxTokens: 1200 }); }
    catch (e) { console.error('[ai:ask] llm fail', e.message); return res.status(502).json({ error: 'llm_failed' }); }
    res.json({ question, answer });
  } catch (e) {
    console.error('[ai:ask]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
