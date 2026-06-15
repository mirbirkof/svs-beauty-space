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
