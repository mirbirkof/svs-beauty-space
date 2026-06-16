/* routes/surveys.js — MGT-09 Опитування (NPS / CSAT / CES / пост-візит / співробітники).
   Заточено під метрики задоволеності: конструктор опитувань і питань, публічне заповнення
   за токеном, авто-ескалація негативу (NPS 0-6 / CSAT 1-2), аналітика — NPS (Promoters/
   Passives/Detractors), CSAT, CES, тренд за 12 міс, розбивка по майстрах/послугах.
   Прагматика під один салон. Доступ: GET=surveys.read, мутації=surveys.write.
   Публічні ендпоінти /public/* — без авторизації (заповнює клієнт). */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
let emit = async () => {}; try { ({ emit } = require('../lib/event-bus')); } catch { /* optional */ }

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const SURVEY_TYPES = ['nps', 'csat', 'ces', 'post_visit', 'employee', 'custom'];
const SURVEY_STATUSES = ['draft', 'active', 'paused', 'closed', 'archived'];
const Q_TYPES = ['nps_scale', 'csat_scale', 'ces_scale', 'star_rating', 'single_choice', 'multi_choice', 'free_text', 'yes_no'];

// Авторизація: публічні /public/* пропускаємо, решта — read на GET, write на мутації
router.use((req, res, next) => {
  if (/^\/public(\/|$)/.test(req.path)) return next();
  const perm = req.method === 'GET' ? 'surveys.read' : 'surveys.write';
  return requirePerm(perm)(req, res, next);
});

const token = () => crypto.randomBytes(12).toString('base64url');
const num = (v) => (v == null || v === '' ? null : Number(v));

// ─────────────────────────────── СПИСОК / АГРЕГАТИ NPS-CSAT ───────────────────────────────

// Поточний NPS салону (агрегат по всіх активних опитуваннях). ВАЖЛИВО: оголошено ДО '/:id'
router.get('/nps/current', async (req, res) => {
  try {
    const days = Math.min(366, Number(req.query.days) || 90);
    const r = (await q(
      `SELECT
         COUNT(*) FILTER (WHERE nps_score >= 9)::int promoters,
         COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8)::int passives,
         COUNT(*) FILTER (WHERE nps_score BETWEEN 0 AND 6)::int detractors,
         COUNT(*) FILTER (WHERE nps_score IS NOT NULL)::int total
       FROM survey_responses
       WHERE tenant_id=current_tenant_id() AND nps_score IS NOT NULL
         AND completed_at >= NOW() - ($1 || ' days')::interval`, [days]))[0];
    const total = r.total || 0;
    const nps = total ? Math.round(((r.promoters - r.detractors) / total) * 100) : null;
    res.json({ nps, promoters: r.promoters, passives: r.passives, detractors: r.detractors, total, period_days: days });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Тренд NPS помісячно за N місяців
router.get('/nps/trend', async (req, res) => {
  try {
    const months = Math.min(24, Number(req.query.months) || 12);
    const rows = await q(
      `SELECT to_char(date_trunc('month', completed_at),'YYYY-MM') AS month,
         COUNT(*) FILTER (WHERE nps_score >= 9)::int promoters,
         COUNT(*) FILTER (WHERE nps_score BETWEEN 0 AND 6)::int detractors,
         COUNT(*) FILTER (WHERE nps_score IS NOT NULL)::int total
       FROM survey_responses
       WHERE tenant_id=current_tenant_id() AND nps_score IS NOT NULL
         AND completed_at >= date_trunc('month', NOW()) - (($1-1) || ' months')::interval
       GROUP BY 1 ORDER BY 1`, [months]);
    res.json({ items: rows.map(m => ({ month: m.month, total: m.total,
      nps: m.total ? Math.round(((m.promoters - m.detractors) / m.total) * 100) : null })) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Поточний CSAT салону
router.get('/csat/current', async (req, res) => {
  try {
    const days = Math.min(366, Number(req.query.days) || 90);
    const r = (await q(
      `SELECT ROUND(AVG(csat_score)::numeric,2) avg, COUNT(*)::int total,
         COUNT(*) FILTER (WHERE csat_score >= 4)::int satisfied
       FROM survey_responses
       WHERE tenant_id=current_tenant_id() AND csat_score IS NOT NULL
         AND completed_at >= NOW() - ($1 || ' days')::interval`, [days]))[0];
    res.json({ csat_avg: r.avg ? Number(r.avg) : null, total: r.total,
      csat_percent: r.total ? Math.round((r.satisfied / r.total) * 100) : null, period_days: days });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Список опитувань
router.get('/', async (req, res) => {
  try {
    const w = ['tenant_id=current_tenant_id()', 'is_deleted=FALSE']; const p = [];
    if (req.query.type) { p.push(req.query.type); w.push(`type=$${p.length}`); }
    if (req.query.status) { p.push(req.query.status); w.push(`status=$${p.length}`); }
    const rows = await q(
      `SELECT s.*,
         (SELECT COUNT(*) FROM survey_questions sq WHERE sq.survey_id=s.id)::int questions_count,
         (SELECT COUNT(*) FROM survey_responses sr WHERE sr.survey_id=s.id AND sr.status='completed')::int completed_count,
         (SELECT ROUND(AVG(CASE WHEN s.type='nps' THEN nps_score WHEN s.type='ces' THEN ces_score ELSE csat_score END)::numeric,2)
            FROM survey_responses sr WHERE sr.survey_id=s.id AND sr.status='completed')::float avg_score
       FROM surveys s WHERE ${w.join(' AND ')} ORDER BY s.id DESC`, p);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────────── CRUD ОПИТУВАННЯ ───────────────────────────────

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: 'title required' });
    const type = SURVEY_TYPES.includes(b.type) ? b.type : 'custom';
    const row = (await q(
      `INSERT INTO surveys (title, description, type, is_anonymous, language, branding,
         trigger_type, trigger_config, cooldown_days, max_responses, target_segment_id,
         ab_test_enabled, thank_you_message, escalation_config, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'{}')::jsonb,$7,COALESCE($8,'{}')::jsonb,$9,$10,$11,$12,$13,
         COALESCE($14,'{"nps_threshold":6,"csat_threshold":2,"notify_roles":["manager"]}')::jsonb,$15)
       RETURNING *`,
      [b.title, b.description || '', type, !!b.is_anonymous, b.language || 'uk',
       b.branding ? JSON.stringify(b.branding) : null, b.trigger_type || null,
       b.trigger_config ? JSON.stringify(b.trigger_config) : null, num(b.cooldown_days) ?? 14,
       num(b.max_responses), num(b.target_segment_id), !!b.ab_test_enabled,
       b.thank_you_message || 'Дякуємо за ваш відгук!',
       b.escalation_config ? JSON.stringify(b.escalation_config) : null, req.user?.id ?? null]))[0];
    // авто-питання для типових шаблонів
    if (type === 'nps') await q(`INSERT INTO survey_questions (survey_id,question_type,text,sort_order) VALUES ($1,'nps_scale','Наскільки ймовірно, що ви порекомендуєте нас друзям? (0-10)',0)`, [row.id]);
    if (type === 'csat') await q(`INSERT INTO survey_questions (survey_id,question_type,text,sort_order) VALUES ($1,'csat_scale','Наскільки ви задоволені обслуговуванням? (1-5)',0)`, [row.id]);
    if (type === 'ces') await q(`INSERT INTO survey_questions (survey_id,question_type,text,sort_order) VALUES ($1,'ces_scale','Наскільки легко вам було вирішити питання? (1-7)',0)`, [row.id]);
    await logAction({ user: req.user, action: 'survey.create', entity: 'survey', entity_id: row.id, ip: req.ip, meta: { type } });
    await emit('survey.created', { id: row.id, type }, { entityType: 'survey', entityId: row.id, actor: String(req.user?.id || 'system') });
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Деталі опитування з питаннями
router.get('/:id(\\d+)', async (req, res) => {
  try {
    const s = (await q(`SELECT * FROM surveys WHERE id=$1 AND tenant_id=current_tenant_id() AND is_deleted=FALSE`, [req.params.id]))[0];
    if (!s) return res.status(404).json({ error: 'not found' });
    s.questions = await q(`SELECT * FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order, id`, [s.id]);
    res.json(s);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/:id(\\d+)', async (req, res) => {
  try {
    const b = req.body || {};
    const fields = []; const p = []; const set = (col, val, json) => { p.push(json && val != null ? JSON.stringify(val) : val); fields.push(`${col}=$${p.length}${json ? '::jsonb' : ''}`); };
    if (b.title != null) set('title', b.title);
    if (b.description != null) set('description', b.description);
    if (b.type != null && SURVEY_TYPES.includes(b.type)) set('type', b.type);
    if (b.is_anonymous != null) set('is_anonymous', !!b.is_anonymous);
    if (b.language != null) set('language', b.language);
    if (b.branding != null) set('branding', b.branding, true);
    if (b.trigger_type !== undefined) set('trigger_type', b.trigger_type);
    if (b.trigger_config != null) set('trigger_config', b.trigger_config, true);
    if (b.cooldown_days != null) set('cooldown_days', num(b.cooldown_days));
    if (b.max_responses !== undefined) set('max_responses', num(b.max_responses));
    if (b.target_segment_id !== undefined) set('target_segment_id', num(b.target_segment_id));
    if (b.ab_test_enabled != null) set('ab_test_enabled', !!b.ab_test_enabled);
    if (b.thank_you_message != null) set('thank_you_message', b.thank_you_message);
    if (b.escalation_config != null) set('escalation_config', b.escalation_config, true);
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.id);
    const row = (await q(`UPDATE surveys SET ${fields.join(',')}, updated_at=NOW() WHERE id=$${p.length} AND tenant_id=current_tenant_id() RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'survey.update', entity: 'survey', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const row = (await q(`UPDATE surveys SET is_deleted=TRUE, status='archived', updated_at=NOW() WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    await logAction({ user: req.user, action: 'survey.delete', entity: 'survey', entity_id: row.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Зміна статусу: activate / pause / close
for (const [path, st] of [['activate', 'active'], ['pause', 'paused'], ['close', 'closed']]) {
  router.post(`/:id(\\d+)/${path}`, async (req, res) => {
    try {
      const row = (await q(`UPDATE surveys SET status=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=current_tenant_id() AND is_deleted=FALSE RETURNING *`, [st, req.params.id]))[0];
      if (!row) return res.status(404).json({ error: 'not found' });
      await logAction({ user: req.user, action: `survey.${path}`, entity: 'survey', entity_id: row.id, ip: req.ip });
      if (st === 'active') await emit('survey.activated', { id: row.id }, { entityType: 'survey', entityId: row.id, actor: String(req.user?.id || 'system') });
      res.json(row);
    } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
  });
}

// Дублювати опитування разом із питаннями
router.post('/:id(\\d+)/duplicate', async (req, res) => {
  try {
    const src = (await q(`SELECT * FROM surveys WHERE id=$1 AND tenant_id=current_tenant_id() AND is_deleted=FALSE`, [req.params.id]))[0];
    if (!src) return res.status(404).json({ error: 'not found' });
    const copy = (await q(
      `INSERT INTO surveys (title,description,type,is_anonymous,language,branding,trigger_type,trigger_config,
         cooldown_days,max_responses,target_segment_id,ab_test_enabled,thank_you_message,escalation_config,created_by,status)
       SELECT title||' (копія)',description,type,is_anonymous,language,branding,trigger_type,trigger_config,
         cooldown_days,max_responses,target_segment_id,ab_test_enabled,thank_you_message,escalation_config,$2,'draft'
       FROM surveys WHERE id=$1 RETURNING *`, [src.id, req.user?.id ?? null]))[0];
    await q(`INSERT INTO survey_questions (survey_id,question_type,text,text_variant_b,help_text,is_required,options,skip_logic,sort_order)
             SELECT $1,question_type,text,text_variant_b,help_text,is_required,options,skip_logic,sort_order
             FROM survey_questions WHERE survey_id=$2`, [copy.id, src.id]);
    res.status(201).json(copy);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────────── ПИТАННЯ ───────────────────────────────

router.get('/:id(\\d+)/questions', async (req, res) => {
  try { res.json({ items: await q(`SELECT * FROM survey_questions WHERE survey_id=$1 AND tenant_id=current_tenant_id() ORDER BY sort_order, id`, [req.params.id]) }); }
  catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id(\\d+)/questions', async (req, res) => {
  try {
    const b = req.body || {};
    if (!Q_TYPES.includes(b.question_type)) return res.status(400).json({ error: 'bad question_type' });
    if (!b.text) return res.status(400).json({ error: 'text required' });
    const ord = b.sort_order != null ? num(b.sort_order)
      : ((await q(`SELECT COALESCE(MAX(sort_order),-1)+1 n FROM survey_questions WHERE survey_id=$1`, [req.params.id]))[0].n);
    const row = (await q(
      `INSERT INTO survey_questions (survey_id,question_type,text,text_variant_b,help_text,is_required,options,skip_logic,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, b.question_type, b.text, b.text_variant_b || null, b.help_text || null,
       b.is_required !== false, b.options ? JSON.stringify(b.options) : null,
       b.skip_logic ? JSON.stringify(b.skip_logic) : null, ord]))[0];
    res.status(201).json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/:id(\\d+)/questions/:qId(\\d+)', async (req, res) => {
  try {
    const b = req.body || {}; const fields = []; const p = [];
    const set = (c, v, j) => { p.push(j && v != null ? JSON.stringify(v) : v); fields.push(`${c}=$${p.length}${j ? '::jsonb' : ''}`); };
    if (b.question_type != null && Q_TYPES.includes(b.question_type)) set('question_type', b.question_type);
    if (b.text != null) set('text', b.text);
    if (b.text_variant_b !== undefined) set('text_variant_b', b.text_variant_b);
    if (b.help_text !== undefined) set('help_text', b.help_text);
    if (b.is_required != null) set('is_required', !!b.is_required);
    if (b.options !== undefined) set('options', b.options, true);
    if (b.skip_logic !== undefined) set('skip_logic', b.skip_logic, true);
    if (b.sort_order != null) set('sort_order', num(b.sort_order));
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    p.push(req.params.qId, req.params.id);
    const row = (await q(`UPDATE survey_questions SET ${fields.join(',')}, updated_at=NOW() WHERE id=$${p.length - 1} AND survey_id=$${p.length} RETURNING *`, p))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/:id(\\d+)/questions/:qId(\\d+)', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM survey_questions WHERE id=$1 AND survey_id=$2 RETURNING id`, [req.params.qId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────────── ВІДПРАВКА / ВІДПОВІДІ ───────────────────────────────

// Ручна відправка: створює response-токени для списку клієнтів (повертає лінки на заповнення)
router.post('/:id(\\d+)/send', async (req, res) => {
  try {
    const s = (await q(`SELECT * FROM surveys WHERE id=$1 AND tenant_id=current_tenant_id() AND is_deleted=FALSE`, [req.params.id]))[0];
    if (!s) return res.status(404).json({ error: 'not found' });
    if (s.status !== 'active') return res.status(409).json({ error: 'survey not active' });
    const clients = Array.isArray(req.body?.client_ids) ? req.body.client_ids : [];
    if (!clients.length) return res.status(400).json({ error: 'client_ids required' });
    const created = [];
    for (const cid of clients) {
      // cooldown: не слати, якщо клієнт відповідав на це опитування < cooldown_days тому
      const recent = (await q(
        `SELECT 1 FROM survey_responses WHERE survey_id=$1 AND client_id=$2
           AND created_at >= NOW() - ($3 || ' days')::interval LIMIT 1`, [s.id, num(cid), s.cooldown_days]))[0];
      if (recent) continue;
      const tk = token();
      const r = (await q(`INSERT INTO survey_responses (survey_id,token,client_id,channel,status) VALUES ($1,$2,$3,$4,'started') RETURNING id,token`, [s.id, tk, num(cid), req.body?.channel || 'web']))[0];
      created.push({ client_id: num(cid), response_id: r.id, link: `/api/surveys/public/${r.token}` });
    }
    await logAction({ user: req.user, action: 'survey.send', entity: 'survey', entity_id: s.id, ip: req.ip, meta: { sent: created.length } });
    res.json({ ok: true, sent: created.length, skipped_cooldown: clients.length - created.length, items: created });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Список відповідей
router.get('/:id(\\d+)/responses', async (req, res) => {
  try {
    const w = ['sr.survey_id=$1', 'sr.tenant_id=current_tenant_id()']; const p = [req.params.id];
    if (req.query.status) { p.push(req.query.status); w.push(`sr.status=$${p.length}`); }
    if (req.query.escalated === '1') w.push('sr.is_escalated=TRUE');
    if (req.query.master_id) { p.push(num(req.query.master_id)); w.push(`sr.master_id=$${p.length}`); }
    const limit = Math.min(500, Number(req.query.limit) || 100); const offset = Number(req.query.offset) || 0;
    p.push(limit); const li = p.length; p.push(offset); const oi = p.length;
    const rows = await q(`SELECT sr.* FROM survey_responses sr WHERE ${w.join(' AND ')} ORDER BY sr.id DESC LIMIT $${li} OFFSET $${oi}`, p);
    res.json({ items: rows, count: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Деталі однієї відповіді з розгорнутими answers
router.get('/:id(\\d+)/responses/:rId(\\d+)', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM survey_responses WHERE id=$1 AND survey_id=$2 AND tenant_id=current_tenant_id()`, [req.params.rId, req.params.id]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    r.answers = await q(`SELECT a.*, qq.text question_text, qq.question_type FROM survey_answers a JOIN survey_questions qq ON qq.id=a.question_id WHERE a.response_id=$1 ORDER BY qq.sort_order`, [r.id]);
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Оновити статус ескалації (менеджер обробляє негатив)
router.put('/:id(\\d+)/responses/:rId(\\d+)/escalation', async (req, res) => {
  try {
    const st = req.body?.escalation_status;
    if (!['new', 'contacted', 'resolved', 'unresolved'].includes(st)) return res.status(400).json({ error: 'bad escalation_status' });
    const row = (await q(
      `UPDATE survey_responses SET escalation_status=$1, escalation_note=COALESCE($2,escalation_note),
         escalation_handled_by=$3, escalation_handled_at=NOW(), updated_at=NOW()
       WHERE id=$4 AND survey_id=$5 AND tenant_id=current_tenant_id() AND is_escalated=TRUE RETURNING *`,
      [st, req.body?.note || null, req.user?.id ?? null, req.params.rId, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not found or not escalated' });
    await logAction({ user: req.user, action: 'survey.escalation', entity: 'survey_response', entity_id: row.id, ip: req.ip, meta: { status: st } });
    if (st === 'resolved') await emit('survey.escalation_resolved', { id: row.id }, { entityType: 'survey_response', entityId: row.id, actor: String(req.user?.id || 'system') });
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────────── АНАЛІТИКА ───────────────────────────────

router.get('/:id(\\d+)/analytics', async (req, res) => {
  try {
    const s = (await q(`SELECT * FROM surveys WHERE id=$1 AND tenant_id=current_tenant_id()`, [req.params.id]))[0];
    if (!s) return res.status(404).json({ error: 'not found' });
    const a = (await q(
      `SELECT COUNT(*)::int total,
         COUNT(*) FILTER (WHERE status='completed')::int completed,
         COUNT(*) FILTER (WHERE nps_score >= 9)::int promoters,
         COUNT(*) FILTER (WHERE nps_score BETWEEN 7 AND 8)::int passives,
         COUNT(*) FILTER (WHERE nps_score BETWEEN 0 AND 6)::int detractors,
         COUNT(*) FILTER (WHERE nps_score IS NOT NULL)::int nps_total,
         ROUND(AVG(csat_score)::numeric,2) csat_avg, COUNT(*) FILTER (WHERE csat_score IS NOT NULL)::int csat_total,
         ROUND(AVG(ces_score)::numeric,2) ces_avg, COUNT(*) FILTER (WHERE ces_score IS NOT NULL)::int ces_total,
         COUNT(*) FILTER (WHERE is_escalated)::int escalated
       FROM survey_responses WHERE survey_id=$1`, [s.id]))[0];
    const nps = a.nps_total ? Math.round(((a.promoters - a.detractors) / a.nps_total) * 100) : null;
    const trend = await q(
      `SELECT to_char(date_trunc('month',completed_at),'YYYY-MM') AS month, COUNT(*)::int total,
         ROUND(AVG(nps_score)::numeric,2) nps_avg, ROUND(AVG(csat_score)::numeric,2) csat_avg
       FROM survey_responses WHERE survey_id=$1 AND completed_at IS NOT NULL GROUP BY 1 ORDER BY 1`, [s.id]);
    res.json({
      survey_id: s.id, type: s.type, total: a.total, completed: a.completed,
      response_rate: a.total ? Math.round((a.completed / a.total) * 100) : null,
      nps, promoters: a.promoters, passives: a.passives, detractors: a.detractors, nps_total: a.nps_total,
      csat_avg: a.csat_avg ? Number(a.csat_avg) : null, csat_total: a.csat_total,
      ces_avg: a.ces_avg ? Number(a.ces_avg) : null, ces_total: a.ces_total,
      escalated: a.escalated, trend,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Розбивка по майстрах
router.get('/:id(\\d+)/analytics/by-master', async (req, res) => {
  try {
    const rows = await q(
      `SELECT sr.master_id, e.name master_name, COUNT(*)::int responses,
         ROUND(AVG(sr.nps_score)::numeric,2) nps_avg, ROUND(AVG(sr.csat_score)::numeric,2) csat_avg,
         COUNT(*) FILTER (WHERE sr.nps_score >= 9)::int promoters,
         COUNT(*) FILTER (WHERE sr.nps_score BETWEEN 0 AND 6)::int detractors,
         COUNT(*) FILTER (WHERE sr.nps_score IS NOT NULL)::int nps_total
       FROM survey_responses sr LEFT JOIN masters e ON e.id=sr.master_id
       WHERE sr.survey_id=$1 AND sr.master_id IS NOT NULL AND sr.status='completed'
       GROUP BY sr.master_id, e.name ORDER BY responses DESC`, [req.params.id]);
    for (const r of rows) r.nps = r.nps_total ? Math.round(((r.promoters - r.detractors) / r.nps_total) * 100) : null;
    res.json({ items: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Розбивка по послугах
router.get('/:id(\\d+)/analytics/by-service', async (req, res) => {
  try {
    const rows = await q(
      `SELECT sr.service_id, sv.name service_name, COUNT(*)::int responses,
         ROUND(AVG(sr.nps_score)::numeric,2) nps_avg, ROUND(AVG(sr.csat_score)::numeric,2) csat_avg
       FROM survey_responses sr LEFT JOIN services sv ON sv.id=sr.service_id
       WHERE sr.survey_id=$1 AND sr.service_id IS NOT NULL AND sr.status='completed'
       GROUP BY sr.service_id, sv.name ORDER BY responses DESC`, [req.params.id]);
    res.json({ items: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ─────────────────────────────── ПУБЛІЧНІ (без авторизації) ───────────────────────────────

// Отримати опитування для заповнення за токеном
router.get('/public/:token', async (req, res) => {
  try {
    const r = (await q(`SELECT * FROM survey_responses WHERE token=$1`, [req.params.token]))[0];
    if (!r) return res.status(404).json({ error: 'not found' });
    if (r.status === 'completed') return res.status(409).json({ error: 'already_completed' });
    const s = (await q(`SELECT id,title,description,type,language,branding,thank_you_message,status FROM surveys WHERE id=$1 AND is_deleted=FALSE`, [r.survey_id]))[0];
    if (!s || s.status === 'closed' || s.status === 'archived') return res.status(410).json({ error: 'survey_closed' });
    const questions = await q(`SELECT id,question_type,text,text_variant_b,help_text,is_required,options,skip_logic,sort_order FROM survey_questions WHERE survey_id=$1 ORDER BY sort_order, id`, [s.id]);
    res.json({ survey: s, questions, response_status: r.status });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Відправити відповіді
router.post('/public/:token/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    const r = (await client.query(`SELECT * FROM survey_responses WHERE token=$1`, [req.params.token])).rows[0];
    if (!r) { client.release(); return res.status(404).json({ error: 'not found' }); }
    if (r.status === 'completed') { client.release(); return res.status(409).json({ error: 'already_completed' }); }
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!answers.length) { client.release(); return res.status(400).json({ error: 'answers required' }); }

    await client.query('BEGIN');
    // зчитуємо ескалаційний поріг опитування
    const s = (await client.query(`SELECT escalation_config FROM surveys WHERE id=$1`, [r.survey_id])).rows[0] || {};
    const esc = s.escalation_config || {};
    let nps = null, csat = null, ces = null;
    for (const a of answers) {
      const qid = num(a.question_id); if (!qid) continue;
      const qq = (await client.query(`SELECT question_type FROM survey_questions WHERE id=$1 AND survey_id=$2`, [qid, r.survey_id])).rows[0];
      if (!qq) continue;
      const n = num(a.answer_numeric);
      if (qq.question_type === 'nps_scale' && n != null) nps = n;
      if (qq.question_type === 'csat_scale' && n != null) csat = n;
      if (qq.question_type === 'ces_scale' && n != null) ces = n;
      await client.query(
        `INSERT INTO survey_answers (response_id,question_id,answer_numeric,answer_text,answer_choice,answer_boolean,ab_variant,tenant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, qid, n, a.answer_text || null, a.answer_choice ? JSON.stringify(a.answer_choice) : null,
         typeof a.answer_boolean === 'boolean' ? a.answer_boolean : null, a.ab_variant || null, r.tenant_id]);
    }
    // авто-ескалація негативу
    const npsThr = esc.nps_threshold ?? 6, csatThr = esc.csat_threshold ?? 2;
    const escalate = (nps != null && nps <= npsThr) || (csat != null && csat <= csatThr);
    await client.query(
      `UPDATE survey_responses SET status='completed', nps_score=$1, csat_score=$2, ces_score=$3,
         completed_at=NOW(), ip_address=$4, user_agent=$5, is_escalated=$6,
         escalation_status=CASE WHEN $6 THEN 'new' ELSE escalation_status END, updated_at=NOW()
       WHERE id=$7`,
      [nps, csat, ces, req.ip, req.headers['user-agent'] || null, escalate, r.id]);
    await client.query(`UPDATE surveys SET response_count=response_count+1, updated_at=NOW() WHERE id=$1`, [r.survey_id]);
    // позначити клік сконвертованим (якщо є)
    await client.query('COMMIT');
    client.release();

    const tnt = String(r.tenant_id);
    await emit('survey.response_received', { survey_id: r.survey_id, response_id: r.id, nps, csat, ces }, { entityType: 'survey_response', entityId: r.id, actor: 'public', tenantId: tnt });
    if (escalate) {
      await emit('survey.negative_response', { survey_id: r.survey_id, response_id: r.id, nps, csat, client_id: r.client_id }, { entityType: 'survey_response', entityId: r.id, actor: 'public', tenantId: tnt });
      await emit('survey.escalation_created', { response_id: r.id, client_id: r.client_id }, { entityType: 'survey_response', entityId: r.id, actor: 'public', tenantId: tnt });
    }
    res.json({ ok: true, escalated: escalate });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
