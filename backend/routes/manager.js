/* routes/manager.js — Панель керуючого (KPI однією картиною).
   GET /api/manager/kpi — оборот місяця vs план, закриття заявок, рекламації,
   нові/втрачені клієнти, активні майстри. Доступ: reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { shiftDaysByMaster } = require('../lib/schedule-month');
const llm = require('../lib/llm');
const { TOOLS } = require('../lib/agent-tools');
const { getSetting, setSetting } = require('../lib/settings');

const router = express.Router();
const pool = getPool();

// ── Налаштування «мозку» помічника (провайдер/модель/свій ключ) ──
const AI_PROVIDERS = ['gemini', 'openrouter', 'groq'];
async function aiConfig() {
  const provider = await getSetting('ai_provider', null);
  const model = await getSetting('ai_model', null);
  const apiKey = await getSetting('ai_api_key', null);
  const cfg = {};
  if (provider && AI_PROVIDERS.includes(provider)) cfg.provider = provider;
  if (model) cfg.model = model;
  if (apiKey) cfg.apiKey = apiKey;
  return cfg;
}

router.get('/ai-settings', requirePerm('reports.finance'), async (req, res) => {
  try {
    res.json({
      provider: (await getSetting('ai_provider', '')) || 'auto',
      model: (await getSetting('ai_model', '')) || '',
      has_key: !!(await getSetting('ai_api_key', null)),
      providers: AI_PROVIDERS,
    });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

router.post('/ai-settings', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    const provider = AI_PROVIDERS.includes(b.provider) ? b.provider : '';
    await setSetting('ai_provider', provider);
    await setSetting('ai_model', (b.model || '').toString().slice(0, 80));
    if (b.api_key != null) await setSetting('ai_api_key', String(b.api_key).slice(0, 200)); // '' очищає
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'internal' }); }
});

// Помічник керуючого (v1): командний чат тільки з читаючими інструментами.
// ReAct-цикл, без деструктивних дій — безпечно. Дії з підтвердженням — наступний крок.
const ASSISTANT_TOOLS = [
  // читання
  'get_cashbox', 'get_month_plan', 'get_closure', 'get_clients_to_rebook', 'get_services', 'get_client', 'get_masters',
  // дії (потребують підтвердження)
  'create_expense', 'add_bonus', 'add_penalty',
];
const _label = (tool, args) => {
  if (tool === 'create_expense') return `Внести витрату ${args.amount} грн (${args.category || 'other'})${args.description ? ' — ' + args.description : ''}`;
  if (tool === 'add_bonus') return `Премія майстру #${args.master_id}: ${args.amount} грн${args.reason ? ' — ' + args.reason : ''}`;
  if (tool === 'add_penalty') return `Штраф майстру #${args.master_id}: ${args.amount} грн${args.reason ? ' — ' + args.reason : ''}`;
  return `${tool} ${JSON.stringify(args || {})}`;
};

router.post('/assistant', requirePerm('reports.finance'), async (req, res) => {
  try {
    if (!llm.available()) return res.status(503).json({ error: 'ai_unconfigured', answer: 'AI поки не налаштований.' });

    // Фаза 2: підтверджена дія — виконуємо напряму.
    const cf = req.body && req.body.confirm;
    if (cf && cf.tool) {
      const t = TOOLS[cf.tool];
      if (!t || !ASSISTANT_TOOLS.includes(cf.tool) || !t.is_destructive) return res.status(400).json({ error: 'bad_confirm' });
      let out; try { out = await t.impl(cf.args || {}); } catch (e) { out = { error: e.message }; }
      const ok = out && !out.error;
      return res.json({ answer: ok ? `✅ Виконано: ${_label(cf.tool, cf.args)}` : `❌ Не вдалося: ${(out && out.error) || 'помилка'}` });
    }

    const question = String((req.body && req.body.message) || '').trim().slice(0, 500);
    if (!question) return res.status(400).json({ error: 'no_message' });

    const catalog = ASSISTANT_TOOLS.map(n => `- ${n}: ${TOOLS[n].description}`).join('\n');
    const PAGES = { dashboard:'Дашборд', journal:'Журнал записів', pipeline:'Воронка візитів', shifts:'Зміни / Табель', services:'Послуги', svccats:'Категорії послуг', clients:'Усі клієнти', waitlist:'Лист очікування', repeat:'Повторні візити', blacklist:'Чорний список', orders:'Замовлення', giftcerts:'Сертифікати', subscriptions:'Абонементи', finance:'Доходи і витрати', fincenter:'Фінансовий центр', cashflow:'Грошовий потік', budgets:'Бюджети', contractors:'Контрагенти', reminders:'Нагадування', promos:'Акції / Промокоди', reviews:'Відгуки', payroll:'Зарплата', plan:'План місяця', products:'Товари', stock:'Залишки на складі', purchasing:'Закупівлі', suppliers:'Постачальники', qcontrol:'Контроль якості', callcenter:'Колл-центр', viber:'Viber', branding:'Брендинг', mobileapp:'Мобільний застосунок', sync:'BeautyPro синхро', mysub:'Моя підписка', settings:'Налаштування' };
    // Розділи, що відкриваються окремим вікном (embed). Значення: [назва, url]
    const EMBEDS = { cashbox:['Каса магазину','/admin/crm-extra.html#cashbox'], reports:['Звіти (P&L, RFM)','/admin/crm-extra.html#reports'], bi:['Конструктор звітів','/admin/bi.html'], exportcsv:['Експорт CSV','/admin/export.html'], masters:['Майстри / Співробітники','/admin/crm-extra.html#users'], inventory:['Інвентаризація','/admin/crm-extra.html#inventory'], msgcenter:['Центр повідомлень','/admin/crm-marketing.html#center'], segments:['Сегменти','/admin/crm-marketing.html#segments'], campaigns:['Кампанії / Розсилки','/admin/crm-marketing.html#campaigns'], triggers:['Авто-тригери','/admin/crm-marketing.html#triggers'], videostudio:['AI Відеостудія','/admin/video-studio.html'], integrations:['Інтеграції','/admin/integrations.html'], audit:['Аудит','/admin/crm-extra.html#audit'], monitoring:['Системний статус','/admin/monitoring.html'], branches:['Управління магазинами','/admin/crm-extra.html#branches'], access:['Доступ до проєкту','/admin/crm-extra.html#users-access'], migrate:['Міграція з іншої CRM','/admin/crm-migrate.html'], checklist:['Чек-лист зміни','/admin/shift-checklist.html'] };
    const system = `Ти — помічник керуючого салону краси в CRM. Відповідай українською, коротко, цифрами.
Інструменти:
${catalog}
Сторінки для відкриття (open_page): ${Object.entries(PAGES).map(([k,v])=>`${k}=${v}`).join(', ')}
Розділи в окремому вікні (open_page тим самим форматом): ${Object.entries(EMBEDS).map(([k,v])=>`${k}=${v[0]}`).join(', ')}
Працюй покроково. Відповідай ЛИШЕ валідним JSON:
{"action":"tool","tool":"<імʼя>","args":{...}}  — викликати інструмент
{"action":"open_page","page":"<ключ>","response":"<коротко що відкрив>"}  — відкрити сторінку CRM на екрані (коли просять «відкрий/покажи/перейди»)
{"action":"final","response":"<відповідь людині>"}  — фінальна відповідь
Для дій, що змінюють дані (create_expense/add_bonus/add_penalty), спочатку за потреби знайди id через get_masters, потім виклич інструмент дії — система сама попросить підтвердження в людини.`;

    const cfg = await aiConfig();
    // Контекст попередніх реплік (заметка #83 — бот має памʼятати діалог)
    const hist = Array.isArray(req.body && req.body.history) ? req.body.history.slice(-8) : [];
    const trail = [];
    for (const h of hist) {
      if (h && h.text) trail.push(`${h.role === 'assistant' ? 'ASSISTANT' : 'USER'}: ${String(h.text).slice(0, 300)}`);
    }
    trail.push(`USER: ${question}`);
    let answer = null, pending = null;
    for (let step = 0; step < 6; step++) {
      const prompt = system + '\n\n' + trail.join('\n\n') + '\n\nASSISTANT (тільки JSON):';
      const d = await llm.askJSON(prompt, { system, maxTokens: 900, ...cfg }).catch(() => null);
      if (!d || !d.action) { answer = 'Не вдалося обробити запит.'; break; }
      if (d.action === 'final') { answer = d.response || ''; break; }
      if (d.action === 'open_page' && d.page) {
        if (PAGES[d.page]) return res.json({ navigate: { page: d.page, label: PAGES[d.page] }, answer: d.response || `Відкриваю «${PAGES[d.page]}»` });
        if (EMBEDS[d.page]) return res.json({ navigate: { embed: EMBEDS[d.page][1], label: EMBEDS[d.page][0] }, answer: d.response || `Відкриваю «${EMBEDS[d.page][0]}»` });
      }
      if (d.action === 'tool') {
        const t = TOOLS[d.tool];
        if (!t || !ASSISTANT_TOOLS.includes(d.tool)) { trail.push(`OBSERVATION: інструмент недоступний.`); continue; }
        // деструктивне — не виконуємо, повертаємо на підтвердження
        if (t.is_destructive) { pending = { tool: d.tool, args: d.args || {}, label: _label(d.tool, d.args || {}) }; break; }
        let out; try { out = await t.impl(d.args || {}); } catch (e) { out = { error: e.message }; }
        trail.push(`ASSISTANT: ${JSON.stringify(d)}`);
        trail.push(`OBSERVATION: ${JSON.stringify(out).slice(0, 1500)}`);
        continue;
      }
      break;
    }
    if (pending) return res.json({ pending });
    res.json({ question, answer: answer || 'Готово.' });
  } catch (e) { console.error('[manager/assistant]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

router.get('/kpi', requirePerm('reports.finance'), async (req, res) => {
  try {
    const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);
    const kyiv = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kiev' });
    const ym = kyiv().slice(0, 7);
    const [year, month] = ym.split('-').map(Number);

    // 1) Оборот місяця (каса: послуги+товари)
    const revRow = (await q(
      `SELECT COALESCE(SUM(amount),0)::numeric v
         FROM cash_operations
        WHERE type='in' AND category IN ('sale_service','sale_product')
          AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0] || { v: 0 };
    const revenue = Number(revRow.v);

    // 2) План місяця = Σ(plan_per_shift × змін у графіку) по активних майстрах
    let plan = 0;
    try {
      const plans = await q(
        `SELECT mp.master_id, mp.plan_per_shift, mp.plan_total, mp.auto_from_shifts
           FROM master_monthly_plans mp JOIN masters m ON m.id=mp.master_id AND COALESCE(m.active,true)=true
          WHERE mp.year=$1 AND mp.month=$2`, [year, month]);
      const grid = await shiftDaysByMaster(pool, ym).catch(() => new Map());
      for (const p of plans) {
        plan += p.auto_from_shifts ? Math.round(Number(p.plan_per_shift) * (grid.get(p.master_id) || 0)) : Number(p.plan_total);
      }
    } catch (_) { plan = 0; }
    const planPct = plan > 0 ? Math.round(revenue / plan * 100) : null;

    // 3) Закриття заявок (без bp_deleted синк-артефактів)
    const clRow = (await q(
      `SELECT COUNT(*) FILTER (WHERE status IN ('done','confirmed'))::int served,
              COUNT(*) FILTER (WHERE status IN ('noshow','cancelled'))::int lost
         FROM appointments
        WHERE starts_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')
          AND starts_at <= NOW() AND bp_state IS DISTINCT FROM 'bp_deleted'`))[0] || { served: 0, lost: 0 };
    const clFin = clRow.served + clRow.lost;
    const closurePct = clFin > 0 ? Math.round(clRow.served / clFin * 100) : null;

    // 4) Рекламації (відгуки ≤3★) + середній рейтинг за місяць
    const revw = (await q(
      `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE rating<=3)::int neg,
              ROUND(AVG(rating)::numeric,1) avg_rating
         FROM reviews WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0]
      || { total: 0, neg: 0, avg_rating: null };

    // 5) Нові клієнти = ті, чий ПЕРШИЙ візит припав на цей місяць
    // (за датою створення не можна — там тисячі імпортованих контактів без візитів).
    const newCl = (await q(
      `WITH firsts AS (
         SELECT client_id, MIN(starts_at) first_visit
           FROM appointments
          WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL
          GROUP BY client_id)
       SELECT COUNT(*)::int n FROM firsts
        WHERE first_visit >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')`))[0] || { n: 0 };

    // 6) Активні майстри
    const mast = (await q(`SELECT COUNT(*)::int n FROM masters WHERE COALESCE(active,true)=true`))[0] || { n: 0 };

    res.json({
      period: ym,
      revenue, plan, plan_pct: planPct,
      closure: { pct: closurePct, served: clRow.served, finished: clFin, target: 80 },
      reviews: { total: Number(revw.total), negative: Number(revw.neg), avg_rating: revw.avg_rating != null ? Number(revw.avg_rating) : null },
      clients_new: Number(newCl.n),
      masters_active: Number(mast.n),
    });
  } catch (e) { console.error('[manager/kpi]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

// GET /api/manager/staff-metrics — метрики по кожному майстру за місяць:
// візити, унікальні клієнти, повторні візити %, середній чек, відміни.
router.get('/staff-metrics', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.name,
              COUNT(*) FILTER (WHERE a.status IN ('done','confirmed'))::int visits,
              COUNT(DISTINCT a.client_id) FILTER (WHERE a.status IN ('done','confirmed'))::int uniq,
              COUNT(*) FILTER (WHERE a.status='cancelled')::int cancelled,
              COALESCE(SUM(COALESCE(a.real_amount,a.price,0)) FILTER (WHERE a.status IN ('done','confirmed')),0)::numeric revenue
         FROM masters m
         LEFT JOIN appointments a ON a.master_id=m.id
              AND a.starts_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Kiev')
              AND a.bp_state IS DISTINCT FROM 'bp_deleted'
        WHERE COALESCE(m.active,true)=true
        GROUP BY m.id, m.name
       HAVING COUNT(*) FILTER (WHERE a.status IN ('done','confirmed')) > 0
        ORDER BY revenue DESC`);
    const items = r.rows.map(x => {
      const visits = x.visits, uniq = x.uniq, rev = Number(x.revenue);
      const finished = visits + x.cancelled;
      return {
        master_id: x.id, name: x.name, visits, unique_clients: uniq,
        revenue: Math.round(rev),
        avg_check: visits > 0 ? Math.round(rev / visits) : 0,
        repeat_pct: visits > 0 ? Math.round((visits - uniq) / visits * 100) : 0,
        cancelled: x.cancelled,
        cancel_pct: finished > 0 ? Math.round(x.cancelled / finished * 100) : 0,
      };
    });
    res.json({ period: new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Kiev' }).slice(0, 7), items });
  } catch (e) { console.error('[manager/staff-metrics]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); }
});

module.exports = router;
