/* routes/ai-call-analysis.js — AI-09 AI Call Analysis (анализ телефонных разговоров).
   Прагматично: вход = ТЕКСТ транскрипта (менеджер вставляет разговор) или audio_url
   (best-effort транскрипция Gemini, если ключ есть). Дальше всё реально:
   NLP-анализ (тема/intent/sentiment/entities/outcome/objections/summary/CRM-подсказка),
   оценка по скрипту (checklist + 4 шкалы + overall + coaching tips), коучинг по администраторам,
   рейтинг, сводная аналитика, полнотекстовый поиск по транскриптам.
   Анализ делает LLM (lib/llm.js, askJSON) — модель не пишет SQL, инъекций нет.
   Эндпоинты под /api/ai/calls:
     POST /transcribe          — принять разговор (текст/аудио) → транскрипт + анализ + скоринг
     GET  /recordings[/:id]    — список / детали (транскрипт+анализ+оценка)
     GET  /search              — полнотекстовый поиск по транскриптам
     GET  /scores/ranking      — рейтинг администраторов
     GET  /coaching/:operator  — персональные рекомендации
     GET/POST/PUT /scripts     — эталонные скрипты
     GET  /analytics           — сводка
   Доступ: чтение/аналитика reports.read; запуск анализа/скрипты reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const canRead = requirePerm('reports.read');
const canManage = requirePerm('reports.finance');

const DEFAULT_STEPS = [
  { order: 1, name: 'greeting', description: 'Привітався за стандартом, назвав салон', weight: 0.12 },
  { order: 2, name: 'needs_clarification', description: 'Уточнив потребу клієнта', weight: 0.18 },
  { order: 3, name: 'time_offered', description: 'Запропонував конкретний час', weight: 0.22 },
  { order: 4, name: 'upsell_offered', description: 'Запропонував додаткову послугу/товар', weight: 0.20 },
  { order: 5, name: 'objection_handled', description: 'Опрацював заперечення, а не промовчав', weight: 0.16 },
  { order: 6, name: 'farewell', description: 'Попрощався за стандартом', weight: 0.12 },
];

/** best-effort транскрипция аудио через Gemini (inline по URL не качаем — только если передан текст). */
// Для прагматичности транскрипция аудио-файлов не реализована (нет телефонии-источника).
// Основной путь — текстовый транскрипт. Возвращаем сообщение, если прислали только audio_url.

/** Разобрать сырой текст разговора в реплики по строкам "Оператор:/Клієнт:". */
function parseTranscript(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  const turns = [];
  const reOp = /^(оператор|адміністратор|администратор|operator|admin|менеджер)\s*[:\-]/i;
  const reCl = /^(клієнт|клиент|client|гость|гість)\s*[:\-]/i;
  for (const l of lines) {
    if (reOp.test(l)) turns.push({ speaker: 'operator', text: l.replace(reOp, '').trim() });
    else if (reCl.test(l)) turns.push({ speaker: 'client', text: l.replace(reCl, '').trim() });
    else if (turns.length) turns[turns.length - 1].text += ' ' + l;
    else turns.push({ speaker: 'unknown', text: l });
  }
  return turns;
}

const ANALYSIS_SYSTEM = `Ти — аналітик телефонних розмов салону краси. Аналізуєш діалог оператора з клієнтом.
Повертаєш СУВОРО валідний JSON без markdown. Не вигадуй фактів, яких немає в розмові.`;

/** LLM-анализ разговора → объект анализа + оценки. */
async function analyzeCall(fullText, steps) {
  const stepList = steps.map(s => `${s.name} (${s.description})`).join('; ');
  const prompt = `Проаналізуй телефонну розмову салону краси й поверни JSON:
{
 "topic": "booking|inquiry|complaint|cancel|reschedule|follow_up|other",
 "intent": "book_appointment|cancel_appointment|reschedule|ask_price|ask_availability|complain|request_callback|other",
 "sentiment": "positive|neutral|negative",
 "sentiment_score": число -1.0..1.0,
 "outcome": "booked|not_booked|will_callback|complaint_resolved|escalated|info_provided",
 "entities": {"service":"","master":"","date":"","time":"","client_name":"","client_phone":""},
 "objections": ["дорого","немає зручного часу", ...],
 "keywords": ["до 8 ключових слів"],
 "summary": "3-5 речень стисло про суть розмови",
 "is_escalation": true/false,
 "crm_suggestion": {"action":"create_appointment|update_client|none","service":"","datetime":"","client_phone":""},
 "checklist": {"greeting":true/false,"needs_clarification":true/false,"time_offered":true/false,"upsell_offered":true/false,"objection_handled":true/false,"farewell":true/false},
 "politeness_score": 1..10,
 "empathy_score": 1..10,
 "efficiency_score": 1..10,
 "upsell_score": 1..10,
 "weak_points": ["назви етапів скрипту, де оператор схибив"],
 "ai_notes": "короткий коментар до оцінки",
 "coaching_tips": ["1-3 конкретні поради оператору з прикладами фраз"]
}
Етапи еталонного скрипта для checklist: ${stepList}.
Розмова:
${fullText.slice(0, 6000)}`;
  return llm.askJSON(prompt, { system: ANALYSIS_SYSTEM, maxTokens: 1400 });
}

/** Взвешенный overall и compliance% из checklist + шкал. */
function computeScores(a, steps) {
  const checklist = a.checklist || {};
  let done = 0, total = 0;
  for (const s of steps) { total += s.weight; if (checklist[s.name]) done += s.weight; }
  const compliance = total ? Math.round((done / total) * 1000) / 10 : null;
  const pol = num(a.politeness_score), emp = num(a.empathy_score), eff = num(a.efficiency_score), ups = num(a.upsell_score);
  const parts = [pol, emp, eff, ups].filter(v => v != null);
  // overall = среднее шкал (40%) + compliance в 10-балльной (60%)
  const scaleAvg = parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : null;
  let overall = null;
  if (scaleAvg != null && compliance != null) overall = Math.round((scaleAvg * 0.4 + (compliance / 10) * 0.6) * 10) / 10;
  else if (scaleAvg != null) overall = Math.round(scaleAvg * 10) / 10;
  return { compliance, pol, emp, eff, ups, overall };
}
function num(v) { const n = Number(v); return isNaN(n) ? null : Math.max(0, Math.min(10, n)); }

// ── POST /transcribe — принять разговор и проанализировать ──
router.post('/transcribe', canManage, async (req, res) => {
  const started = Date.now();
  try {
    const { transcript_text, audio_url, call_id, branch_id, operator_id, operator_name, client_id, client_phone, direction = 'inbound', language = 'uk', script_id } = req.body || {};
    if (!transcript_text && !audio_url) return res.status(400).json({ error: 'потрібен transcript_text (текст розмови) або audio_url' });
    if (!transcript_text && audio_url) return res.status(501).json({ error: 'транскрипція аудіо не підключена (немає телефонії-джерела). Передайте transcript_text — текст розмови.' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний (немає API-ключів)' });

    // recording
    const rec = (await q(
      `INSERT INTO ai_call_recordings (call_id, branch_id, operator_id, operator_name, client_id, client_phone, direction, audio_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'analyzing') RETURNING id`,
      [call_id || null, branch_id || null, operator_id || null, operator_name || null, client_id || null, client_phone || null, direction, audio_url || null]
    ))[0];

    const turns = parseTranscript(transcript_text);
    const fullText = turns.map(t => `${t.speaker}: ${t.text}`).join('\n');
    const tr = (await q(
      `INSERT INTO ai_call_transcripts (recording_id, language, transcript, full_text, word_count, stt_model)
       VALUES ($1,$2,$3,$4,$5,'manual_text') RETURNING id`,
      [rec.id, language, JSON.stringify(turns), fullText, fullText.split(/\s+/).length]
    ))[0];

    // активный скрипт
    let steps = DEFAULT_STEPS;
    const scr = script_id
      ? await q(`SELECT id, steps FROM ai_call_scripts WHERE id=$1`, [script_id]).catch(() => [])
      : await q(`SELECT id, steps FROM ai_call_scripts WHERE is_active=true ORDER BY id LIMIT 1`).catch(() => []);
    const usedScriptId = scr[0]?.id || null;
    if (scr[0]?.steps && Array.isArray(scr[0].steps) && scr[0].steps.length) steps = scr[0].steps;

    const a = await analyzeCall(fullText, steps);
    if (!a) {
      await q(`UPDATE ai_call_recordings SET status='error', error_message='LLM не повернув аналіз' WHERE id=$1`, [rec.id]).catch(() => {});
      return res.status(502).json({ error: 'не вдалося проаналізувати розмову' });
    }

    const an = (await q(
      `INSERT INTO ai_call_analysis (transcript_id, recording_id, topic, intent, sentiment, sentiment_score, outcome, entities, objections, keywords, summary, is_escalation, crm_suggestion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [tr.id, rec.id, a.topic || 'other', a.intent || 'other', a.sentiment || 'neutral',
       a.sentiment_score != null ? a.sentiment_score : null, a.outcome || 'info_provided',
       JSON.stringify(a.entities || {}), a.objections || [], a.keywords || [], a.summary || null,
       !!a.is_escalation, a.crm_suggestion ? JSON.stringify(a.crm_suggestion) : null]
    ))[0];

    const sc = computeScores(a, steps);
    const compl = (await q(
      `INSERT INTO ai_script_compliance (analysis_id, script_id, operator_id, checklist, compliance_percent, politeness_score, empathy_score, efficiency_score, upsell_score, overall_score, weak_points, ai_notes, coaching_tips)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, overall_score, compliance_percent`,
      [an.id, usedScriptId, operator_id || null, JSON.stringify(a.checklist || {}), sc.compliance,
       sc.pol, sc.emp, sc.eff, sc.ups, sc.overall, a.weak_points || [], a.ai_notes || null, a.coaching_tips || []]
    ))[0];

    await q(`UPDATE ai_call_recordings SET status='completed', processing_time_ms=$2 WHERE id=$1`, [rec.id, Date.now() - started]).catch(() => {});

    res.json({
      recording_id: rec.id,
      analysis: { topic: a.topic, intent: a.intent, sentiment: a.sentiment, outcome: a.outcome, summary: a.summary, entities: a.entities, objections: a.objections, is_escalation: !!a.is_escalation, crm_suggestion: a.crm_suggestion },
      scoring: { overall_score: compl.overall_score, compliance_percent: compl.compliance_percent, politeness: sc.pol, empathy: sc.emp, efficiency: sc.eff, upsell: sc.ups, weak_points: a.weak_points, coaching_tips: a.coaching_tips },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /recordings — список ───────────────────────────────
router.get('/recordings', canRead, async (req, res) => {
  try {
    const { operator_id, status, topic, outcome, sentiment, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const w = [], p = [];
    if (operator_id) { p.push(operator_id); w.push(`r.operator_id=$${p.length}`); }
    if (status) { p.push(status); w.push(`r.status=$${p.length}`); }
    if (topic) { p.push(topic); w.push(`an.topic=$${p.length}`); }
    if (outcome) { p.push(outcome); w.push(`an.outcome=$${p.length}`); }
    if (sentiment) { p.push(sentiment); w.push(`an.sentiment=$${p.length}`); }
    if (from) { p.push(from); w.push(`r.created_at >= $${p.length}`); }
    if (to) { p.push(to); w.push(`r.created_at <= $${p.length}`); }
    p.push(limit);
    const rows = await q(
      `SELECT r.id, r.operator_name, r.client_phone, r.direction, r.status, r.created_at,
              an.topic, an.intent, an.sentiment, an.outcome, an.summary,
              sc.overall_score, sc.compliance_percent
         FROM ai_call_recordings r
         LEFT JOIN ai_call_analysis an ON an.recording_id=r.id
         LEFT JOIN ai_script_compliance sc ON sc.analysis_id=an.id
        ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
        ORDER BY r.created_at DESC LIMIT $${p.length}`, p);
    res.json({ items: rows, total: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /recordings/:id — детали ───────────────────────────
router.get('/recordings/:id', canRead, async (req, res) => {
  try {
    const rec = (await q(`SELECT * FROM ai_call_recordings WHERE id=$1`, [req.params.id]))[0];
    if (!rec) return res.status(404).json({ error: 'запис не знайдено' });
    const tr = (await q(`SELECT transcript, full_text, language, word_count FROM ai_call_transcripts WHERE recording_id=$1 ORDER BY id DESC LIMIT 1`, [rec.id]))[0] || null;
    const an = (await q(`SELECT * FROM ai_call_analysis WHERE recording_id=$1 ORDER BY id DESC LIMIT 1`, [rec.id]))[0] || null;
    const sc = an ? (await q(`SELECT * FROM ai_script_compliance WHERE analysis_id=$1 ORDER BY id DESC LIMIT 1`, [an.id]))[0] || null : null;
    res.json({ recording: rec, transcript: tr, analysis: an, compliance: sc });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /search — полнотекстовый поиск ─────────────────────
router.get('/search', canRead, async (req, res) => {
  try {
    const term = String(req.query.q || '').trim();
    if (!term) return res.status(400).json({ error: 'параметр q обовʼязковий' });
    const tokens = (term.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 10);
    if (!tokens.length) return res.json({ items: [] });
    const orQuery = tokens.join(' | ');
    const rows = await q(
      `SELECT t.recording_id, r.operator_name, an.topic, r.created_at,
              ts_headline('simple', t.full_text, to_tsquery('simple',$1), 'MaxFragments=1,MaxWords=18,MinWords=6') AS snippet
         FROM ai_call_transcripts t
         JOIN ai_call_recordings r ON r.id=t.recording_id
         LEFT JOIN ai_call_analysis an ON an.recording_id=r.id
        WHERE t.tsv @@ to_tsquery('simple',$1)
        ORDER BY r.created_at DESC LIMIT 30`, [orQuery]).catch(() => []);
    res.json({ items: rows, total: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /scores/ranking — рейтинг администраторов ──────────
router.get('/scores/ranking', canRead, async (req, res) => {
  try {
    const days = req.query.period === 'month' ? 30 : req.query.period === 'quarter' ? 90 : 7;
    const rows = await q(
      `SELECT sc.operator_id, r.operator_name,
              COUNT(*)::int calls, ROUND(AVG(sc.overall_score),1) avg_score,
              ROUND(AVG(sc.compliance_percent),1) avg_compliance,
              ROUND(100.0 * COUNT(*) FILTER (WHERE an.outcome='booked') / NULLIF(COUNT(*),0),1) conversion_rate,
              ROUND(100.0 * COUNT(*) FILTER (WHERE (sc.checklist->>'upsell_offered')='true') / NULLIF(COUNT(*),0),1) upsell_rate
         FROM ai_script_compliance sc
         JOIN ai_call_analysis an ON an.id=sc.analysis_id
         JOIN ai_call_recordings r ON r.id=an.recording_id
        WHERE sc.created_at >= NOW() - ($1||' days')::interval
        GROUP BY sc.operator_id, r.operator_name
        ORDER BY avg_score DESC NULLS LAST`, [days]).catch(() => []);
    res.json({ ranking: rows, period_days: days });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /coaching/:operator — персональные рекомендации ────
router.get('/coaching/:operator', canRead, async (req, res) => {
  try {
    const days = req.query.period === 'month' ? 30 : 7;
    const op = req.params.operator;
    const [agg, weak, tips, salon] = await Promise.all([
      q(`SELECT COUNT(*)::int calls, ROUND(AVG(overall_score),1) avg_score,
                ROUND(100.0*COUNT(*) FILTER (WHERE (checklist->>'upsell_offered')='true')/NULLIF(COUNT(*),0),1) upsell_rate
           FROM ai_script_compliance WHERE operator_id=$1 AND created_at >= NOW()-($2||' days')::interval`, [op, days]),
      q(`SELECT unnest(weak_points) wp, COUNT(*)::int cnt FROM ai_script_compliance
          WHERE operator_id=$1 AND created_at >= NOW()-($2||' days')::interval GROUP BY wp ORDER BY cnt DESC LIMIT 5`, [op, days]),
      q(`SELECT DISTINCT unnest(coaching_tips) tip FROM ai_script_compliance
          WHERE operator_id=$1 AND created_at >= NOW()-($2||' days')::interval LIMIT 6`, [op, days]),
      q(`SELECT ROUND(AVG(overall_score),1) salon_avg FROM ai_script_compliance WHERE created_at >= NOW()-($1||' days')::interval`, [days]),
    ]);
    const a = agg[0] || {};
    const callsTotal = a.calls || 0;
    res.json({
      operator_id: op,
      total_calls: callsTotal,
      avg_score: a.avg_score,
      upsell_rate: a.upsell_rate,
      salon_avg_score: salon[0]?.salon_avg || null,
      top_weak_points: weak.map(w => ({ area: w.wp, occurrence_pct: callsTotal ? Math.round(100 * w.cnt / callsTotal) : null })),
      coaching_tips: tips.map(t => t.tip),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Scripts CRUD ───────────────────────────────────────────
router.get('/scripts', canRead, async (req, res) => {
  try {
    const rows = await q(`SELECT id, name, scenario, jsonb_array_length(steps) steps_count, is_active FROM ai_call_scripts ORDER BY is_active DESC, name`);
    res.json({ scripts: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.post('/scripts', canManage, async (req, res) => {
  try {
    const { name, scenario = 'inbound_booking', steps, branch_id, is_active = true } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name обовʼязковий' });
    const useSteps = Array.isArray(steps) && steps.length ? steps : DEFAULT_STEPS;
    const row = (await q(
      `INSERT INTO ai_call_scripts (branch_id, name, scenario, steps, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, scenario`,
      [branch_id || null, name, scenario, JSON.stringify(useSteps), !!is_active, req.user?.id || null]
    ))[0];
    res.json({ script: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});
router.put('/scripts/:id', canManage, async (req, res) => {
  try {
    const sets = ['updated_at=NOW()'], p = [];
    for (const k of ['name', 'scenario', 'is_active']) if (req.body[k] !== undefined) { p.push(req.body[k]); sets.push(`${k}=$${p.length}`); }
    if (req.body.steps !== undefined) { p.push(JSON.stringify(req.body.steps)); sets.push(`steps=$${p.length}::jsonb`); }
    if (p.length === 1) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_call_scripts SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING id, name, scenario, is_active`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ script: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /analytics — сводка ────────────────────────────────
router.get('/analytics', canRead, async (req, res) => {
  try {
    const { from, to } = req.query;
    const w = [], p = [];
    if (from) { p.push(from); w.push(`r.created_at >= $${p.length}`); }
    if (to) { p.push(to); w.push(`r.created_at <= $${p.length}`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [tot, sent, decline, byOp] = await Promise.all([
      q(`SELECT COUNT(*)::int total_calls,
                ROUND(100.0*COUNT(*) FILTER (WHERE an.outcome='booked')/NULLIF(COUNT(*),0),1) conversion_rate,
                ROUND(AVG(sc.overall_score),1) avg_score
           FROM ai_call_recordings r
           LEFT JOIN ai_call_analysis an ON an.recording_id=r.id
           LEFT JOIN ai_script_compliance sc ON sc.analysis_id=an.id ${where}`, p),
      q(`SELECT an.sentiment, COUNT(*)::int cnt FROM ai_call_recordings r
           JOIN ai_call_analysis an ON an.recording_id=r.id ${where} GROUP BY an.sentiment`, p),
      q(`SELECT obj, COUNT(*)::int cnt FROM ai_call_recordings r
           JOIN ai_call_analysis an ON an.recording_id=r.id
           CROSS JOIN LATERAL unnest(an.objections) obj ${where} GROUP BY obj ORDER BY cnt DESC LIMIT 8`, p),
      q(`SELECT r.operator_name, COUNT(*)::int calls, ROUND(AVG(sc.overall_score),1) avg_score
           FROM ai_call_recordings r
           JOIN ai_call_analysis an ON an.recording_id=r.id
           LEFT JOIN ai_script_compliance sc ON sc.analysis_id=an.id ${where}
          GROUP BY r.operator_name ORDER BY calls DESC LIMIT 20`, p),
    ]);
    const t = tot[0] || {};
    const sd = { positive: 0, neutral: 0, negative: 0 };
    sent.forEach(s => { if (s.sentiment) sd[s.sentiment] = s.cnt; });
    const totDecl = decline.reduce((x, y) => x + y.cnt, 0);
    res.json({
      total_calls: t.total_calls || 0,
      conversion_rate: t.conversion_rate,
      avg_score: t.avg_score,
      sentiment_distribution: sd,
      top_decline_reasons: decline.map(d => ({ reason: d.obj, pct: totDecl ? Math.round(100 * d.cnt / totDecl) : null })),
      by_operator: byOp,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
