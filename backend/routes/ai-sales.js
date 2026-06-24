/* routes/ai-sales.js — AI-02 AI Sales (повне покриття спеки, single-salon).
   Поєднує live-аналітику на реальних даних (середній чек, мультисервіс, топ-комбо,
   конверсія по майстрах) із персистентними сутностями зі спеки:
     - ai_sales_offers          — згенеровані/відправлені пропозиції + результат
     - ai_sales_rules           — правила upsell/cross-sell (trigger→offer)
     - ai_sales_winback_chains  — цепочки повернення «засинаючих» клієнтів

   Ендпоінти (спека §API):
     GET    /offers                       список offer'ів (?client_id&type&status&from&to&limit)
     POST   /offers                        створити offer (для оператора/інтеграцій)
     POST   /offers/:id/accept             клієнт прийняв → фіксуємо виручку
     POST   /offers/:id/decline            клієнт відхилив
     GET    /recommend/:client_id          NBO для оператора/майстра (upsell+cross-sell, live)
     GET    /rules                         правила upsell/cross-sell
     POST   /rules                         створити правило
     PATCH  /rules/:id                     оновити правило
     GET    /winback/chains                цепочки win-back
     POST   /winback/chains                створити цепочку
     GET    /winback/candidates            «засинаючі» клієнти + крок цепочки (live)
     POST   /winback/run                   згенерувати win-back offer'и (graceful-стаб розсилки)
     GET    /analytics                     дашборд: live-метрики + воронка offer→accepted→paid

   Зовнішня розсилка (COM-01 Notification Hub) — graceful-стаб: offer пишемо у БД зі
   status='sent', реальну доставку делегує Notification Hub (правило проєкту дозволяє стаб).

   Права (спека §RBAC, через requirePerm; owner '*' матчить усе):
     перегляд/рекомендації  ai.sales.read  (fallback reports.read)
     правила                ai.sales.rules
     win-back               ai.sales.winback
     аналітика              ai.sales.analytics (fallback reports.finance) */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const WINDOW_DAYS = 180;
const ALIVE_STATUSES = `('cancelled','noshow')`;            // що НЕ рахуємо як візит
const ERR = (res, e, tag) => { console.error(`[ai-sales:${tag}]`, e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); };

// Права: лишаємось на існуючих reports.* (як було в попередній версії ai-sales) —
// owner '*' матчить усе, ролі manager/marketer мають reports.read/reports.finance.
// Мапінг до спеки: ai.sales.read≈reports.read, ai.sales.analytics/rules/winback≈reports.finance.

// ── GET /analytics — дашборд продажів (live + воронка offer'ів) ──────────────
router.get('/analytics', requirePerm('reports.finance'), async (req, res) => {
  try {
    const W = Math.min(Math.max(parseInt(req.query.days, 10) || WINDOW_DAYS, 30), 730);
    const [overall, byMaster, combos] = await Promise.all([
      pool.query(`
        WITH visits AS (
          SELECT client_id, starts_at::date d, COUNT(*) svc, SUM(COALESCE(real_amount,price)) tot
            FROM appointments
           WHERE status NOT IN ${ALIVE_STATUSES} AND starts_at <= NOW() AND price>0 AND starts_at >= NOW() - ($1 || ' days')::interval
           GROUP BY client_id, starts_at::date
        )
        SELECT COUNT(*)::int visits,
               ROUND(AVG(tot))::int avg_check,
               ROUND(AVG(svc), 2)::float avg_services,
               ROUND(100.0 * COUNT(*) FILTER (WHERE svc>=2) / NULLIF(COUNT(*),0), 1)::float multi_pct,
               ROUND(SUM(tot))::bigint revenue
          FROM visits`, [W]).then(r => r.rows[0] || {}).catch(() => ({})),
      pool.query(`
        WITH visits AS (
          SELECT master_id, client_id, starts_at::date d, SUM(COALESCE(real_amount,price)) tot, COUNT(*) svc
            FROM appointments
           WHERE status NOT IN ${ALIVE_STATUSES} AND starts_at <= NOW() AND price>0 AND starts_at >= NOW() - ($1 || ' days')::interval
           GROUP BY master_id, client_id, starts_at::date
        )
        SELECT m.name,
               COUNT(*)::int visits,
               ROUND(AVG(v.tot))::int avg_check,
               ROUND(100.0 * COUNT(*) FILTER (WHERE v.svc>=2) / NULLIF(COUNT(*),0), 1)::float multi_pct
          FROM visits v JOIN masters m ON m.id=v.master_id
         GROUP BY m.name HAVING COUNT(*) >= 10
         ORDER BY avg_check DESC`, [W]).then(r => r.rows).catch(() => []),
      pool.query(`
        WITH pairs AS (
          SELECT a.service_id s1, b.service_id s2, (a.price + b.price) val
            FROM appointments a
            JOIN appointments b ON a.client_id=b.client_id AND a.starts_at::date=b.starts_at::date AND a.service_id < b.service_id
           WHERE a.status NOT IN ${ALIVE_STATUSES} AND b.status NOT IN ${ALIVE_STATUSES}
             AND a.starts_at <= NOW() AND b.starts_at <= NOW() AND a.price>0 AND b.price>0
             AND a.starts_at >= NOW() - ($1 || ' days')::interval
        )
        SELECT sa.name n1, sb.name n2, COUNT(*)::int cnt, ROUND(SUM(val))::int revenue
          FROM pairs p LEFT JOIN services sa ON sa.id=p.s1 LEFT JOIN services sb ON sb.id=p.s2
         GROUP BY sa.name, sb.name
         ORDER BY revenue DESC LIMIT 8`, [W]).then(r => r.rows).catch(() => []),
    ]);

    // воронка по persisted offer'ах: offer→accepted→paid, дод.виручка, ROI, top, by_type
    const params = [];
    const wh = [];
    if (req.query.from) { params.push(req.query.from); wh.push(`created_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); wh.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (req.query.type) { params.push(req.query.type); wh.push(`type = $${params.length}`); }
    const ofWhere = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const [funnel, byType, topOffers] = await Promise.all([
      q(`SELECT COUNT(*)::int total,
                COUNT(*) FILTER (WHERE status='sent')::int sent,
                COUNT(*) FILTER (WHERE status='accepted')::int accepted,
                COUNT(*) FILTER (WHERE status='declined')::int declined,
                COALESCE(SUM(result_revenue) FILTER (WHERE status='accepted'),0)::numeric revenue
           FROM ai_sales_offers ${ofWhere}`, params).then(r => r[0]).catch(() => ({})),
      q(`SELECT type,
                COUNT(*)::int total,
                COUNT(*) FILTER (WHERE status='accepted')::int accepted,
                COALESCE(SUM(result_revenue) FILTER (WHERE status='accepted'),0)::numeric revenue
           FROM ai_sales_offers ${ofWhere} GROUP BY type ORDER BY revenue DESC`, params).catch(() => []),
      q(`SELECT COALESCE(s.name, p.name, o.offer_text, 'offer') AS label, o.type,
                COUNT(*)::int shown,
                COUNT(*) FILTER (WHERE o.status='accepted')::int accepted,
                COALESCE(SUM(o.result_revenue) FILTER (WHERE o.status='accepted'),0)::numeric revenue
           FROM ai_sales_offers o
           LEFT JOIN services s ON s.id=o.offer_service_id
           LEFT JOIN products p ON p.id=o.offer_product_id
           ${ofWhere}
          GROUP BY label, o.type ORDER BY accepted DESC, shown DESC LIMIT 10`, params).catch(() => []),
    ]);

    const responded = (funnel.accepted || 0) + (funnel.declined || 0);
    const convRate = responded > 0 ? Math.round((funnel.accepted / responded) * 1000) / 1000 : 0;
    const addRevenue = Number(funnel.revenue || 0);
    // ROI: дод.виручка vs умовна вартість AI-пропозицій (стаб: 0.5 грн/відправку)
    const COST_PER_OFFER = 0.5;
    const cost = (funnel.sent || 0) * COST_PER_OFFER;
    const roi = cost > 0 ? Math.round(((addRevenue - cost) / cost) * 100) / 100 : null;

    // оцінка потенціалу крос-селу (live, без offer'ів)
    const curMulti = overall.multi_pct || 0;
    const visits = overall.visits || 0;
    const avgCheck = overall.avg_check || 0;
    const singleVisits = Math.round(visits * (1 - curMulti / 100));
    const extraVisits = Math.round(singleVisits * 0.10);     // 10% одиночних
    const opportunity = Math.round(extraVisits * avgCheck * 0.40); // додаткова ≈ 40% чека

    res.json({
      ok: true,
      window_days: W,
      overall: {
        visits, avg_check: avgCheck,
        avg_services: overall.avg_services || 0,
        multi_service_pct: curMulti,
        revenue: Number(overall.revenue || 0),
      },
      by_master: byMaster.map(m => ({ name: m.name, visits: m.visits, avg_check: m.avg_check, multi_service_pct: m.multi_pct })),
      top_combos: combos.map(c => ({ a: c.n1 || '—', b: c.n2 || '—', count: c.cnt, revenue: c.revenue })),
      cross_sell_opportunity: {
        current_multi_pct: curMulti,
        single_service_pct: Math.round((100 - curMulti) * 10) / 10,
        single_service_visits: singleVisits,
        potential_extra_visits: extraVisits,
        potential_revenue: opportunity,
        hint: opportunity > 0
          ? `${Math.round(100 - curMulti)}% візитів — лише одна послуга. Якщо допродати додаткову послугу хоча б 10% із них — орієнтовно +${opportunity.toLocaleString('uk-UA')} грн`
          : 'Майже всі візити вже мультисервісні',
      },
      // §02.04 — воронка по фактичних offer'ах
      offers_funnel: {
        total_offers: funnel.total || 0,
        sent: funnel.sent || 0,
        accepted: funnel.accepted || 0,
        declined: funnel.declined || 0,
        conversion_rate: convRate,
        additional_revenue: addRevenue,
        roi,
        by_type: byType.map(t => ({
          type: t.type, total: t.total, accepted: t.accepted, revenue: Number(t.revenue),
          conversion: t.total > 0 ? Math.round((t.accepted / t.total) * 1000) / 1000 : 0,
        })),
        top_offers: topOffers.map(t => ({
          label: t.label, type: t.type, shown: t.shown, accepted: t.accepted, revenue: Number(t.revenue),
        })),
      },
    });
  } catch (e) { ERR(res, e, 'analytics'); }
});

// ── GET /offers — список пропозицій ─────────────────────────────────────────
router.get('/offers', requirePerm('reports.read'), async (req, res) => {
  try {
    const params = [];
    const wh = [];
    if (req.query.client_id) { params.push(parseInt(req.query.client_id, 10)); wh.push(`o.client_id = $${params.length}`); }
    if (req.query.type) { params.push(req.query.type); wh.push(`o.type = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); wh.push(`o.status = $${params.length}`); }
    if (req.query.from) { params.push(req.query.from); wh.push(`o.created_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); wh.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await q(`
      SELECT o.*, c.name AS client_name, s.name AS service_name, p.name AS product_name
        FROM ai_sales_offers o
        LEFT JOIN clients c ON c.id=o.client_id
        LEFT JOIN services s ON s.id=o.offer_service_id
        LEFT JOIN products p ON p.id=o.offer_product_id
        ${where}
       ORDER BY o.created_at DESC LIMIT ${limit}`, params);
    res.json({ ok: true, offers: rows });
  } catch (e) { ERR(res, e, 'offers:list'); }
});

// ── POST /offers — створити пропозицію (оператор/інтеграція) ─────────────────
router.post('/offers', requirePerm('reports.read'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.type) return res.status(400).json({ error: 'type_required' });
    if (!['upsell', 'cross_sell', 'win_back', 'nbo'].includes(b.type)) return res.status(400).json({ error: 'bad_type' });
    const row = (await q(`
      INSERT INTO ai_sales_offers
        (client_id, type, offer_type, offer_service_id, offer_product_id, rule_id, offer_text, channel, confidence, ab_variant, status, sent_at)
      VALUES ($1,$2,COALESCE($3,'service'),$4,$5,$6,$7,$8,$9,$10,
              CASE WHEN $8 IS NULL THEN 'pending' ELSE 'sent' END,
              CASE WHEN $8 IS NULL THEN NULL ELSE now() END)
      RETURNING *`,
      [b.client_id || null, b.type, b.offer_type, b.offer_service_id || null, b.offer_product_id || null,
       b.rule_id || null, b.offer_text || null, b.channel || null,
       b.confidence != null ? Number(b.confidence) : null, b.ab_variant || (Math.random() < 0.5 ? 'A' : 'B')]))[0];
    logAction({ user: req.user, action: 'ai_sales.offer.create', entity: 'ai_sales_offer', entity_id: row.id }).catch(() => {});
    res.json({ ok: true, offer: row });
  } catch (e) { ERR(res, e, 'offers:create'); }
});

// ── POST /offers/:id/accept — клієнт прийняв ────────────────────────────────
router.post('/offers/:id/accept', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const b = req.body || {};
    const row = (await q(`
      UPDATE ai_sales_offers
         SET status='accepted', responded_at=now(), updated_at=now(),
             result_revenue=COALESCE($2, result_revenue),
             result_appointment_id=COALESCE($3, result_appointment_id),
             result_order_id=COALESCE($4, result_order_id)
       WHERE id=$1 AND status NOT IN ('accepted','declined','expired')
       RETURNING *`,
      [id, b.revenue != null ? Number(b.revenue) : null, b.appointment_id || null, b.order_id || null]))[0];
    if (!row) return res.status(404).json({ error: 'not_found_or_closed' });
    logAction({ user: req.user, action: 'ai_sales.offer.accept', entity: 'ai_sales_offer', entity_id: id, meta: { revenue: row.result_revenue } }).catch(() => {});
    res.json({ ok: true, offer: row });
  } catch (e) { ERR(res, e, 'offers:accept'); }
});

// ── POST /offers/:id/decline — клієнт відхилив ──────────────────────────────
router.post('/offers/:id/decline', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const row = (await q(`
      UPDATE ai_sales_offers SET status='declined', responded_at=now(), updated_at=now()
       WHERE id=$1 AND status NOT IN ('accepted','declined','expired') RETURNING *`, [id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found_or_closed' });
    logAction({ user: req.user, action: 'ai_sales.offer.decline', entity: 'ai_sales_offer', entity_id: id }).catch(() => {});
    res.json({ ok: true, offer: row });
  } catch (e) { ERR(res, e, 'offers:decline'); }
});

// ── GET /rules — правила upsell/cross-sell ──────────────────────────────────
router.get('/rules', requirePerm('reports.read'), async (req, res) => {
  try {
    const rows = await q(`
      SELECT r.*, ts.name AS trigger_service_name, os.name AS offer_service_name, p.name AS offer_product_name
        FROM ai_sales_rules r
        LEFT JOIN services ts ON ts.id=r.trigger_service_id
        LEFT JOIN services os ON os.id=r.offer_service_id
        LEFT JOIN products p  ON p.id=r.offer_product_id
       ORDER BY r.active DESC, r.priority DESC, r.id DESC`);
    res.json({ ok: true, rules: rows });
  } catch (e) { ERR(res, e, 'rules:list'); }
});

// ── POST /rules — створити правило ──────────────────────────────────────────
router.post('/rules', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.offer_service_id && !b.offer_product_id) return res.status(400).json({ error: 'offer_service_id_or_offer_product_id_required' });
    const row = (await q(`
      INSERT INTO ai_sales_rules
        (branch_id, type, trigger_service_id, offer_service_id, offer_product_id, discount_percent, min_confidence, message_template, active, priority)
      VALUES ($1, COALESCE($2,'cross_sell'), $3, $4, $5, $6, COALESCE($7,0.300), $8, COALESCE($9,true), COALESCE($10,0))
      RETURNING *`,
      [b.branch_id || null, b.type, b.trigger_service_id || null, b.offer_service_id || null, b.offer_product_id || null,
       b.discount_percent != null ? Number(b.discount_percent) : null,
       b.min_confidence != null ? Number(b.min_confidence) : null, b.message_template || null,
       b.active, b.priority]))[0];
    logAction({ user: req.user, action: 'ai_sales.rule.create', entity: 'ai_sales_rule', entity_id: row.id }).catch(() => {});
    res.json({ ok: true, rule: row });
  } catch (e) { ERR(res, e, 'rules:create'); }
});

// ── PATCH /rules/:id — оновити правило ──────────────────────────────────────
router.patch('/rules/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const b = req.body || {};
    const sets = [], params = [];
    const allow = ['branch_id', 'type', 'trigger_service_id', 'offer_service_id', 'offer_product_id', 'discount_percent', 'min_confidence', 'message_template', 'active', 'priority'];
    for (const k of allow) if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(id);
    const row = (await q(`UPDATE ai_sales_rules SET ${sets.join(', ')}, updated_at=now() WHERE id=$${params.length} RETURNING *`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, rule: row });
  } catch (e) { ERR(res, e, 'rules:update'); }
});

// ── GET /winback/chains — цепочки win-back ──────────────────────────────────
router.get('/winback/chains', requirePerm('reports.read'), async (req, res) => {
  try {
    res.json({ ok: true, chains: await q(`SELECT * FROM ai_sales_winback_chains ORDER BY active DESC, id DESC`) });
  } catch (e) { ERR(res, e, 'winback:chains'); }
});

// ── POST /winback/chains — створити цепочку ─────────────────────────────────
router.post('/winback/chains', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name_required' });
    const steps = Array.isArray(b.steps) ? b.steps : [];
    const row = (await q(`
      INSERT INTO ai_sales_winback_chains (branch_id, name, steps, active)
      VALUES ($1,$2,$3::jsonb,COALESCE($4,true)) RETURNING *`,
      [b.branch_id || null, b.name, JSON.stringify(steps), b.active]))[0];
    logAction({ user: req.user, action: 'ai_sales.winback.create', entity: 'ai_sales_winback_chain', entity_id: row.id }).catch(() => {});
    res.json({ ok: true, chain: row });
  } catch (e) { ERR(res, e, 'winback:create'); }
});

// ── GET /winback/candidates — «засинаючі» клієнти + крок цепочки (live) ──────
router.get('/winback/candidates', requirePerm('reports.read'), async (req, res) => {
  try {
    const minDays = Math.max(parseInt(req.query.min_days, 10) || 30, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    // активна цепочка → пороги кроків
    const chain = (await q(`SELECT * FROM ai_sales_winback_chains WHERE active=true ORDER BY id LIMIT 1`))[0];
    const steps = chain && Array.isArray(chain.steps) ? chain.steps : [];
    // клієнти без візиту > minDays днів; рахуємо середній інтервал між візитами для персоналізації
    const rows = await q(`
      WITH last AS (
        SELECT a.client_id,
               MAX(a.starts_at) AS last_visit,
               COUNT(*)::int AS visits,
               (MAX(a.starts_at) - MIN(a.starts_at)) AS span
          FROM appointments a
         WHERE a.status NOT IN ${ALIVE_STATUSES} AND a.starts_at <= NOW() AND a.client_id IS NOT NULL
         GROUP BY a.client_id
      )
      SELECT l.client_id, c.name, c.phone, c.telegram_id, c.email, c.tags,
             l.last_visit, l.visits,
             EXTRACT(DAY FROM (NOW() - l.last_visit))::int AS days_since,
             CASE WHEN l.visits > 1 THEN ROUND(EXTRACT(EPOCH FROM l.span)/86400.0/(l.visits-1))::int END AS avg_interval_days
        FROM last l JOIN clients c ON c.id=l.client_id
       WHERE l.last_visit < NOW() - ($1 || ' days')::interval
         AND NOT COALESCE(c.tags @> ARRAY['no_marketing']::text[], false)   -- стоп-лист
       ORDER BY l.last_visit ASC
       LIMIT ${limit}`, [minDays]);

    const pickChannel = (c) => c.telegram_id ? 'telegram' : (c.phone ? 'sms' : (c.email ? 'email' : 'master'));
    const pickStep = (days) => {
      // обираємо найбільший крок, поріг якого вже досягнуто
      let chosen = null;
      for (let i = 0; i < steps.length; i++) if (days >= (steps[i].day || 0)) chosen = { index: i, ...steps[i] };
      return chosen;
    };
    res.json({
      ok: true,
      chain_id: chain ? chain.id : null,
      count: rows.length,
      candidates: rows.map(c => {
        const step = pickStep(c.days_since);
        return {
          client_id: c.client_id, name: c.name, channel: pickChannel(c),
          days_since: c.days_since, visits: c.visits, avg_interval_days: c.avg_interval_days,
          last_visit: c.last_visit,
          suggested_step: step ? { index: step.index, day: step.day, offer_type: step.offer_type, discount: step.discount } : null,
          message: step && step.template
            ? step.template.replace('{name}', c.name || 'клієнте')
            : `${c.name || 'Клієнт'}, давно вас не бачили (${c.days_since} дн.). Запросимо назад?`,
        };
      }),
    });
  } catch (e) { ERR(res, e, 'winback:candidates'); }
});

// ── POST /winback/run — згенерувати win-back offer'и (graceful-стаб розсилки) ─
// Створює рядки в ai_sales_offers (status='sent'); реальну доставку робить COM-01.
router.post('/winback/run', requirePerm('reports.finance'), async (req, res) => {
  try {
    const minDays = Math.max(parseInt((req.body || {}).min_days, 10) || 35, 1);
    const limit = Math.min(parseInt((req.body || {}).limit, 10) || 50, 200);
    const chain = (await q(`SELECT * FROM ai_sales_winback_chains WHERE active=true ORDER BY id LIMIT 1`))[0];
    const steps = chain && Array.isArray(chain.steps) ? chain.steps : [];
    const cands = await q(`
      WITH last AS (
        SELECT client_id, MAX(starts_at) AS last_visit
          FROM appointments
         WHERE status NOT IN ${ALIVE_STATUSES} AND starts_at <= NOW() AND client_id IS NOT NULL
         GROUP BY client_id)
      SELECT l.client_id, c.name, c.telegram_id, c.phone, c.email,
             EXTRACT(DAY FROM (NOW() - l.last_visit))::int AS days_since
        FROM last l JOIN clients c ON c.id=l.client_id
       WHERE l.last_visit < NOW() - ($1 || ' days')::interval
         AND NOT COALESCE(c.tags @> ARRAY['no_marketing']::text[], false)
         -- не дублюємо: за останні 14 днів win-back цьому клієнту ще не слали
         AND NOT EXISTS (SELECT 1 FROM ai_sales_offers o
                          WHERE o.client_id=l.client_id AND o.type='win_back'
                            AND o.created_at > NOW() - INTERVAL '14 days')
       ORDER BY l.last_visit ASC LIMIT ${limit}`, [minDays]);

    const pickChannel = (c) => c.telegram_id ? 'telegram' : (c.phone ? 'sms' : (c.email ? 'email' : 'master'));
    const pickStep = (days) => { let s = null; for (let i = 0; i < steps.length; i++) if (days >= (steps[i].day || 0)) s = { index: i, ...steps[i] }; return s; };

    let created = 0;
    for (const c of cands) {
      const step = pickStep(c.days_since);
      const text = step && step.template ? step.template.replace('{name}', c.name || 'клієнте')
        : `${c.name || 'Клієнт'}, давно вас не бачили. Запрошуємо назад!`;
      await q(`
        INSERT INTO ai_sales_offers (client_id, type, offer_type, chain_id, chain_step, offer_text, channel, status, sent_at, ab_variant)
        VALUES ($1,'win_back',$2,$3,$4,$5,$6,'sent',now(),$7)`,
        [c.client_id, step && step.offer_type === 'discount' ? 'discount' : 'service',
         chain ? chain.id : null, step ? step.index : null, text, pickChannel(c), Math.random() < 0.5 ? 'A' : 'B']);
      created++;
    }
    // graceful-стаб: фактична доставка делегується COM-01 Notification Hub
    logAction({ user: req.user, action: 'ai_sales.winback.run', entity: 'ai_sales_winback_chain', entity_id: chain ? chain.id : null, meta: { created } }).catch(() => {});
    res.json({ ok: true, created, delivery: 'queued_to_notification_hub_stub', chain_id: chain ? chain.id : null });
  } catch (e) { ERR(res, e, 'winback:run'); }
});

// ── GET /recommend/:client_id — NBO для оператора/майстра (upsell+cross-sell) ─
router.get('/recommend/:client_id', requirePerm('reports.read'), async (req, res) => {
  try {
    const cid = parseInt(req.params.client_id, 10);
    if (!cid) return res.status(400).json({ error: 'bad_id' });
    const persist = req.query.persist === '1' || req.query.persist === 'true';

    const mine = await q(
      `SELECT DISTINCT a.service_id, s.category, s.price
         FROM appointments a JOIN services s ON s.id=a.service_id
        WHERE a.client_id=$1 AND a.status NOT IN ${ALIVE_STATUSES} AND a.starts_at <= NOW() AND a.service_id IS NOT NULL`, [cid]).catch(() => []);
    const myIds = mine.map(m => m.service_id);
    const myCats = [...new Set(mine.map(m => m.category).filter(Boolean))];

    // UPSELL: дорожча послуга в категорії, яку клієнт уже відвідує, але цю ще не брав
    let upsell = [];
    if (myCats.length) {
      upsell = await q(`
        SELECT s.id, s.name, s.category, s.price
          FROM services s
         WHERE s.active=true AND s.category = ANY($1)
           ${myIds.length ? 'AND s.id <> ALL($2)' : ''}
           AND s.price > COALESCE((
             SELECT AVG(price) FROM appointments WHERE client_id=$3 AND status NOT IN ${ALIVE_STATUSES} AND starts_at <= NOW() AND service_id IS NOT NULL
           ), 0)
         ORDER BY s.price DESC LIMIT 3`,
        myIds.length ? [myCats, myIds, cid] : [myCats, cid]).catch(() => []);
    }

    // CROSS-SELL: правила зі спеки мають пріоритет, далі co-occurrence
    let ruleBased = [];
    if (myIds.length) {
      ruleBased = await q(`
        SELECT r.id AS rule_id, r.offer_service_id, s.name, s.category, s.price, r.discount_percent, r.message_template, r.min_confidence
          FROM ai_sales_rules r JOIN services s ON s.id=r.offer_service_id
         WHERE r.active=true AND r.type IN ('cross_sell','upsell')
           AND r.trigger_service_id = ANY($1) AND r.offer_service_id <> ALL($1)
         ORDER BY r.priority DESC LIMIT 4`, [myIds]).catch(() => []);
    }
    let crossSell = [];
    if (myIds.length) {
      crossSell = await q(`
        WITH cs AS (
          SELECT DISTINCT client_id, service_id FROM appointments
           WHERE status NOT IN ${ALIVE_STATUSES} AND starts_at <= NOW() AND service_id IS NOT NULL AND client_id IS NOT NULL
        )
        SELECT b.service_id, s.name, s.price, COUNT(DISTINCT a.client_id)::int score
          FROM cs a JOIN cs b ON a.client_id=b.client_id
          LEFT JOIN services s ON s.id=b.service_id
         WHERE a.service_id = ANY($1) AND b.service_id <> ALL($1) AND a.client_id<>$2
         GROUP BY b.service_id, s.name, s.price
         ORDER BY score DESC LIMIT 4`, [myIds, cid]).catch(() => []);
    }
    const csMax = crossSell.length ? crossSell[0].score : 1;
    const ruleIds = new Set(ruleBased.map(r => r.offer_service_id));

    const offers = [
      ...upsell.map(u => ({
        type: 'upsell', offer_type: 'service', service_id: u.id,
        name: u.name || `Послуга #${u.id}`,
        price: u.price != null ? Math.round(Number(u.price)) : null,
        confidence: 0.4,
        reason: `Преміум-послуга в категорії «${u.category}», яку клієнт відвідує`,
      })),
      ...ruleBased.map(r => ({
        type: 'cross_sell', offer_type: 'service', service_id: r.offer_service_id, rule_id: r.rule_id,
        name: r.name || `Послуга #${r.offer_service_id}`,
        price: r.price != null ? Math.round(Number(r.price)) : null,
        discount_percent: r.discount_percent != null ? Number(r.discount_percent) : null,
        confidence: r.min_confidence != null ? Number(r.min_confidence) : 0.5,
        reason: r.message_template || 'Рекомендовано правилом допродажу',
      })),
      ...crossSell.filter(c => !ruleIds.has(c.service_id)).map(c => ({
        type: 'cross_sell', offer_type: 'service', service_id: c.service_id,
        name: c.name || `Послуга #${c.service_id}`,
        price: c.price != null ? Math.round(Number(c.price)) : null,
        confidence: Math.round((c.score / csMax) * 1000) / 1000,
        reason: 'Часто беруть разом клієнти зі схожими послугами',
        score: c.score,
      })),
    ];

    // §02.03 NBO: опційно зберегти найкращу пропозицію в ai_sales_offers (для трекінгу)
    let saved = null;
    if (persist && offers.length) {
      const best = offers.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
      saved = (await q(`
        INSERT INTO ai_sales_offers (client_id, type, offer_type, offer_service_id, rule_id, offer_text, confidence, ab_variant, status)
        VALUES ($1,$2,'service',$3,$4,$5,$6,$7,'pending') RETURNING id`,
        [cid, best.type, best.service_id || null, best.rule_id || null, best.reason, best.confidence || null,
         Math.random() < 0.5 ? 'A' : 'B']).catch(() => []))[0] || null;
    }

    res.json({ ok: true, client_id: cid, offers, saved_offer_id: saved ? saved.id : null });
  } catch (e) { ERR(res, e, 'recommend'); }
});

module.exports = router;
