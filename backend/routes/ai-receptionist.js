/* routes/ai-receptionist.js — AI-01 AI Receptionist (виртуальный администратор 24/7).
   Распознаёт намерение, отвечает на FAQ (цены/услуги/часы/адрес), помогает с записью,
   передаёт оператору (handoff) при жалобе / 2 непонятых подряд / явном запросе.
   LLM рассуждает над компактным снимком салона (никакого SQL от модели → ноль инъекций).
   Эндпоинты под /api/ai/receptionist:
     POST /message                      — обработать входящее (webhook каналов)
     GET  /conversations                — список диалогов
     GET  /conversations/:id            — диалог с сообщениями
     POST /conversations/:id/handoff    — передать оператору
     POST /conversations/:id/close      — закрыть
     GET  /config / PUT /config         — настройки
     GET  /analytics                    — аналитика
     POST /feedback                     — обратная связь оператора
   Доступ: чтение/аналитика reports.read; настройка/handoff reports.finance. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();
const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

const INTENTS = ['book_appointment','cancel','reschedule','price_inquiry','hours','address','services_list','speak_to_human','complaint','review','greeting','other'];
const HANDOFF_INTENTS = new Set(['speak_to_human','complaint']);

const SYSTEM = `Ти — AI-адміністратор салону краси. Спілкуєшся з клієнтами тепло, коротко й по-діловому.
Відповідай мовою клієнта (українська/російська/англійська — автовизначення).
Ніколи не вигадуй ціни, послуги чи години — бери ТІЛЬКИ з наданих даних салону. Якщо даних бракує — чесно скажи й запропонуй з'єднати з адміністратором.
Не використовуй markdown (без зірочок, решіток, списків з дефісами).`;

/** Компактний снімок салону для LLM: послуги+ціни, філія (адреса/телефон/години), майстри. Кеш 5 хв. */
let _snapCache = null, _snapTs = 0;
async function buildSalonSnapshot() {
  if (_snapCache && Date.now() - _snapTs < 5 * 60 * 1000) return _snapCache;
  const [services, branch, masters, cfg] = await Promise.all([
    q(`SELECT name, category, duration_min, price FROM services
        WHERE COALESCE(active,true)=true AND deleted_at IS NULL
        ORDER BY category NULLS LAST, sort_order NULLS LAST, name LIMIT 200`).catch(() => []),
    q(`SELECT name, address, phone, city, working_hours FROM branches
        WHERE COALESCE(is_active,true)=true ORDER BY is_default DESC NULLS LAST LIMIT 1`).catch(() => []),
    q(`SELECT name, surname, specialty, category, online_title FROM masters
        WHERE active=true AND COALESCE(online_booking_enabled,true)=true AND COALESCE(provides_services,true)=true
        ORDER BY online_rank NULLS LAST, name LIMIT 60`).catch(() => []),
    q(`SELECT greeting_message, tone, custom_faq, working_hours FROM ai_receptionist_config
        WHERE branch_id IS NULL ORDER BY id LIMIT 1`).catch(() => []),
  ]);
  const b = branch[0] || {};
  const snap = {
    salon: b.name || 'Салон краси',
    address: b.address || null,
    phone: b.phone || null,
    city: b.city || null,
    working_hours: (cfg[0] && cfg[0].working_hours) || b.working_hours || '24/7 — уточнюйте',
    tone: (cfg[0] && cfg[0].tone) || 'friendly',
    services: services.map(s => ({ назва: s.name, категорія: s.category, хвилин: s.duration_min, ціна: Number(s.price) || null })),
    masters: masters.map(m => ({ імʼя: [m.name, m.surname].filter(Boolean).join(' '), напрям: m.online_title || m.specialty || m.category })),
    custom_faq: (cfg[0] && cfg[0].custom_faq) || [],
  };
  _snapCache = snap; _snapTs = Date.now();
  return snap;
}

/** Простой rule-based детектор интента как fallback, если LLM недоступен/невалиден. */
function ruleIntent(text) {
  const t = (text || '').toLowerCase();
  if (/живою людиною|оператор|адміністратор|человек|менеджер|speak.*human|operator/.test(t)) return 'speak_to_human';
  if (/скарг|жаліюсь|жалоб|обурен|поверн.*грош|refund|complaint|погано|жахливо/.test(t)) return 'complaint';
  if (/скасув|відмін|отмен|cancel/.test(t)) return 'cancel';
  if (/перенес|перенест|reschedul/.test(t)) return 'reschedule';
  if (/запис|book|appointment|хочу.*на|можна.*на/.test(t)) return 'book_appointment';
  if (/цін|вартіст|скільки кошт|price|стоит|почём/.test(t)) return 'price_inquiry';
  if (/годин|працює|режим|hours|время работ|відкрит/.test(t)) return 'hours';
  if (/адрес|де ви|где вы|address|як дістат/.test(t)) return 'address';
  if (/послуг|перелік|що ви робите|services|какие услуги/.test(t)) return 'services_list';
  if (/відгук|review|залишити.*враж/.test(t)) return 'review';
  if (/привіт|вітаю|доброго|здравств|hello|hi |добрий день/.test(t)) return 'greeting';
  return 'other';
}

/** Достать N последних сообщений диалога для контекста LLM. */
async function convHistory(convId, limit = 8) {
  const rows = await q(
    `SELECT role, content FROM ai_messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [convId, limit]
  ).catch(() => []);
  return rows.reverse();
}

// ── POST /message — главный движок: принять входящее, ответить, при необходимости handoff ──
router.post('/message', requirePerm('reports.read'), async (req, res) => {
  try {
    const channel = String(req.body?.channel || 'website').slice(0, 20);
    const chatId = req.body?.chat_id != null ? String(req.body.chat_id).slice(0, 100) : null;
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    const clientId = req.body?.client_id != null ? parseInt(req.body.client_id, 10) || null : null;
    if (!text) return res.status(400).json({ error: 'no_text' });

    // 1) найти/создать активный диалог
    let conv = (await q(
      `SELECT * FROM ai_conversations WHERE channel=$1 AND channel_chat_id IS NOT DISTINCT FROM $2 AND status='active' ORDER BY id DESC LIMIT 1`,
      [channel, chatId]
    ))[0];
    if (!conv) {
      conv = (await q(
        `INSERT INTO ai_conversations (client_id, channel, channel_chat_id) VALUES ($1,$2,$3) RETURNING *`,
        [clientId, channel, chatId]
      ))[0];
    } else if (clientId && !conv.client_id) {
      await q(`UPDATE ai_conversations SET client_id=$1 WHERE id=$2`, [clientId, conv.id]);
    }

    // 2) сохранить сообщение пользователя
    const userMsg = (await q(
      `INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1,'user',$2) RETURNING id`,
      [conv.id, text]
    ))[0];

    // 3) если диалог уже передан оператору — AI молчит
    if (conv.status === 'handed_off') {
      await q(`UPDATE ai_conversations SET messages_count=messages_count+1, updated_at=NOW() WHERE id=$1`, [conv.id]);
      return res.json({ conversation_id: conv.id, reply: null, intent: 'handed_off', action: 'await_operator', handed_off: true });
    }

    // 4) понять интент + сформировать ответ через LLM (fallback — правила)
    const snapshot = await buildSalonSnapshot();
    const history = await convHistory(conv.id);
    let intent = ruleIntent(text), confidence = 0.5, entities = {}, reply = null, lowConfidence = false;

    if (llm.available()) {
      const prompt = `Дані салону (JSON):
${JSON.stringify(snapshot)}

Останні повідомлення діалогу:
${history.map(h => `${h.role === 'user' ? 'Клієнт' : 'Адмін'}: ${h.content}`).join('\n') || '(порожньо)'}

Нове повідомлення клієнта: "${text}"

Поверни СУВОРО валідний JSON без пояснень:
{"intent":"<один з: ${INTENTS.join('|')}>","confidence":0.0-1.0,"entities":{"service":null,"date":null,"time":null,"master":null,"name":null,"phone":null},"reply":"<твоя відповідь клієнту його мовою, тепло й коротко>"}
Правила: ціни/послуги/години бери лише зі снімку. Для book_appointment — уточни послугу, бажаного майстра, дату й час, поясни що передаси запит адміністратору на підтвердження. Для скарги (complaint) або прохання людини (speak_to_human) — співчутливо повідом, що зараз зʼєднаєш з адміністратором.`;
      try {
        const j = await llm.askJSON(prompt, { system: SYSTEM, maxTokens: snapshot.max_tokens || 600 });
        if (j && typeof j === 'object') {
          if (INTENTS.includes(j.intent)) intent = j.intent;
          if (typeof j.confidence === 'number') confidence = Math.max(0, Math.min(1, j.confidence));
          if (j.entities && typeof j.entities === 'object') entities = j.entities;
          if (j.reply) reply = String(j.reply).slice(0, 2000);
        }
      } catch (e) { console.error('[ai-recept] llm fail', e.message); }
    }
    if (!reply) {
      // деградация без LLM — короткие шаблоны из снимка
      lowConfidence = true;
      if (intent === 'hours') reply = `Графік роботи: ${typeof snapshot.working_hours === 'string' ? snapshot.working_hours : JSON.stringify(snapshot.working_hours)}.`;
      else if (intent === 'address') reply = snapshot.address ? `Ми за адресою: ${snapshot.address}${snapshot.phone ? `, тел. ${snapshot.phone}` : ''}.` : 'Уточню адресу й передам вам.';
      else if (intent === 'price_inquiry' || intent === 'services_list') reply = `Наші послуги: ${snapshot.services.slice(0, 12).map(s => `${s.назва}${s.ціна ? ` — ${s.ціна} грн` : ''}`).join('; ')}.`;
      else if (intent === 'greeting') reply = snapshot.salon ? `Вітаю! Це ${snapshot.salon}. Чим можу допомогти — запис, ціни чи послуги?` : 'Вітаю! Чим можу допомогти?';
      else reply = 'Зрозумів вас. Передаю запит адміністратору, він уточнить деталі.';
    }

    // 5) логика handoff
    const cfg = (await q(`SELECT handoff_after_misses FROM ai_receptionist_config WHERE branch_id IS NULL LIMIT 1`).catch(() => []))[0];
    const maxMiss = (cfg && cfg.handoff_after_misses) || 2;
    let missStreak = conv.miss_streak || 0;
    const understood = intent !== 'other' && confidence >= 0.45;
    missStreak = understood ? 0 : missStreak + 1;

    let action = 'faq_answered', handoff = false, handoffReason = null;
    if (HANDOFF_INTENTS.has(intent)) { handoff = true; handoffReason = intent === 'complaint' ? 'complaint' : 'explicit_request'; }
    else if (missStreak >= maxMiss) { handoff = true; handoffReason = 'misunderstanding'; }
    else if (intent === 'book_appointment') action = 'suggested_booking';
    else if (!understood) action = 'clarify';

    if (handoff) {
      action = 'handoff';
      reply = reply || 'Зараз зʼєднаю вас з адміністратором, зачекайте хвилинку.';
      await q(`UPDATE ai_conversations SET status='handed_off', ai_handled=false, handed_off_at=NOW(), handed_off_reason=$2, updated_at=NOW() WHERE id=$1`, [conv.id, handoffReason]);
    }

    // 6) сохранить ответ AI + обновить счётчики диалога
    const aiMsg = (await q(
      `INSERT INTO ai_messages (conversation_id, role, content, intent, intent_confidence, entities, action_taken, action_result)
       VALUES ($1,'assistant',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [conv.id, reply, intent, confidence, JSON.stringify(entities), action, JSON.stringify({ handoff_reason: handoffReason })]
    ))[0];
    await q(
      `UPDATE ai_conversations SET messages_count=messages_count+2, last_intent=$2, miss_streak=$3, updated_at=NOW() WHERE id=$1`,
      [conv.id, intent, missStreak]
    );

    res.json({
      conversation_id: conv.id, message_id: aiMsg.id, user_message_id: userMsg.id,
      reply, intent, confidence, entities, action, handoff, handoff_reason: handoffReason,
    });
  } catch (e) {
    console.error('[ai-recept:message]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── GET /conversations — список ──
router.get('/conversations', requirePerm('reports.read'), async (req, res) => {
  try {
    const { status, channel, client_id, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const where = [], params = [];
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    if (channel) { params.push(channel); where.push(`channel=$${params.length}`); }
    if (client_id) { params.push(parseInt(client_id, 10)); where.push(`client_id=$${params.length}`); }
    if (from) { params.push(from); where.push(`started_at >= $${params.length}`); }
    if (to) { params.push(to); where.push(`started_at <= $${params.length}`); }
    params.push(limit);
    const rows = await q(
      `SELECT c.*, cl.name AS client_name, cl.phone AS client_phone,
              (SELECT content FROM ai_messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message
         FROM ai_conversations c
         LEFT JOIN clients cl ON cl.id=c.client_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY c.updated_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ conversations: rows });
  } catch (e) { console.error('[ai-recept:list]', e); res.status(500).json({ error: 'internal' }); }
});

// ── GET /conversations/:id — диалог с сообщениями ──
router.get('/conversations/:id', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const conv = (await q(
      `SELECT c.*, cl.name AS client_name, cl.phone AS client_phone
         FROM ai_conversations c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.id=$1`, [id]
    ))[0];
    if (!conv) return res.status(404).json({ error: 'not_found' });
    const messages = await q(`SELECT * FROM ai_messages WHERE conversation_id=$1 ORDER BY created_at`, [id]);
    res.json({ conversation: conv, messages });
  } catch (e) { console.error('[ai-recept:get]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /conversations/:id/handoff — ручная передача оператору ──
router.post('/conversations/:id/handoff', requirePerm('reports.finance'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const operatorId = req.body?.operator_id != null ? parseInt(req.body.operator_id, 10) : null;
    const reason = String(req.body?.reason || 'manual').slice(0, 50);
    const r = await q(
      `UPDATE ai_conversations SET status='handed_off', ai_handled=false, handed_off_to=$2, handed_off_at=NOW(), handed_off_reason=$3, updated_at=NOW()
        WHERE id=$1 AND status<>'closed' RETURNING *`, [id, operatorId, reason]
    );
    if (!r[0]) return res.status(404).json({ error: 'not_found_or_closed' });
    res.json({ ok: true, conversation: r[0] });
  } catch (e) { console.error('[ai-recept:handoff]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /conversations/:id/close ──
router.post('/conversations/:id/close', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const r = await q(`UPDATE ai_conversations SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *`, [id]);
    if (!r[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, conversation: r[0] });
  } catch (e) { console.error('[ai-recept:close]', e); res.status(500).json({ error: 'internal' }); }
});

// ── GET /config ──
router.get('/config', requirePerm('reports.read'), async (req, res) => {
  try {
    let cfg = (await q(`SELECT * FROM ai_receptionist_config WHERE branch_id IS NULL ORDER BY id LIMIT 1`))[0];
    if (!cfg) cfg = (await q(`INSERT INTO ai_receptionist_config (branch_id) VALUES (NULL) RETURNING *`))[0];
    res.json({ config: cfg, llm_available: llm.available() });
  } catch (e) { console.error('[ai-recept:cfg-get]', e); res.status(500).json({ error: 'internal' }); }
});

// ── PUT /config ──
router.put('/config', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    let cfg = (await q(`SELECT id FROM ai_receptionist_config WHERE branch_id IS NULL ORDER BY id LIMIT 1`))[0];
    if (!cfg) cfg = (await q(`INSERT INTO ai_receptionist_config (branch_id) VALUES (NULL) RETURNING id`))[0];
    const fields = [], params = [];
    const set = (col, val) => { params.push(val); fields.push(`${col}=$${params.length}`); };
    if (b.greeting_message !== undefined) set('greeting_message', b.greeting_message);
    if (b.tone !== undefined && ['friendly', 'professional', 'casual'].includes(b.tone)) set('tone', b.tone);
    if (b.language !== undefined) set('language', String(b.language).slice(0, 5));
    if (b.handoff_after_misses !== undefined) set('handoff_after_misses', Math.max(1, parseInt(b.handoff_after_misses, 10) || 2));
    if (b.working_hours !== undefined) set('working_hours', b.working_hours == null ? null : JSON.stringify(b.working_hours));
    if (b.custom_faq !== undefined) set('custom_faq', JSON.stringify(Array.isArray(b.custom_faq) ? b.custom_faq : []));
    if (b.enabled_channels !== undefined && Array.isArray(b.enabled_channels)) set('enabled_channels', b.enabled_channels);
    if (b.model !== undefined) set('model', b.model);
    if (b.max_tokens !== undefined) set('max_tokens', Math.max(100, Math.min(2000, parseInt(b.max_tokens, 10) || 600)));
    if (b.enabled !== undefined) set('enabled', !!b.enabled);
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });
    params.push(cfg.id);
    const r = await q(`UPDATE ai_receptionist_config SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING *`, params);
    _snapCache = null; // сбросить кеш снимка (мог измениться tone/working_hours/faq)
    res.json({ ok: true, config: r[0] });
  } catch (e) { console.error('[ai-recept:cfg-put]', e); res.status(500).json({ error: 'internal' }); }
});

// ── GET /analytics ──
router.get('/analytics', requirePerm('reports.read'), async (req, res) => {
  try {
    const from = req.query.from || null, to = req.query.to || null;
    // фильтр по датам: собираем дважды — для ai_conversations (без префикса) и для JOIN (с префиксом c.)
    const params = [];
    const condPlain = [], condC = [];
    if (from) { params.push(from); condPlain.push(`started_at >= $${params.length}`); condC.push(`c.started_at >= $${params.length}`); }
    if (to) { params.push(to); condPlain.push(`started_at <= $${params.length}`); condC.push(`c.started_at <= $${params.length}`); }
    const whereC = condPlain.length ? 'WHERE ' + condPlain.join(' AND ') : '';
    const totals = (await q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ai_handled)::int AS ai_handled,
              COUNT(*) FILTER (WHERE status='handed_off')::int AS handed_off,
              COUNT(*) FILTER (WHERE status='active')::int AS active,
              COALESCE(AVG(messages_count),0)::numeric(10,1) AS avg_messages
         FROM ai_conversations ${whereC}`, params
    ))[0] || {};
    const intents = await q(
      `SELECT m.intent, COUNT(*)::int AS n FROM ai_messages m
         JOIN ai_conversations c ON c.id=m.conversation_id
        WHERE m.role='assistant' AND m.intent IS NOT NULL ${condC.length ? 'AND ' + condC.join(' AND ') : ''}
        GROUP BY m.intent ORDER BY n DESC LIMIT 12`, params
    ).catch(() => []);
    const fb = (await q(
      `SELECT COUNT(*) FILTER (WHERE feedback_type='good_response')::int AS good,
              COUNT(*) FILTER (WHERE feedback_type IN ('wrong_intent','bad_response'))::int AS bad,
              COUNT(*)::int AS total FROM ai_feedback`
    ).catch(() => [{}]))[0] || {};
    const total = totals.total || 0;
    res.json({
      total_conversations: total,
      ai_handled_percent: total ? Math.round((totals.ai_handled / total) * 100) : 0,
      handoff_rate: total ? Math.round((totals.handed_off / total) * 100) : 0,
      active_conversations: totals.active || 0,
      avg_messages_per_conv: Number(totals.avg_messages) || 0,
      top_intents: intents,
      satisfaction: fb.total ? Math.round((fb.good / fb.total) * 100) : null,
      feedback: fb,
    });
  } catch (e) { console.error('[ai-recept:analytics]', e); res.status(500).json({ error: 'internal' }); }
});

// ── POST /feedback ──
router.post('/feedback', requirePerm('reports.read'), async (req, res) => {
  try {
    const messageId = parseInt(req.body?.message_id, 10);
    const type = String(req.body?.feedback_type || '');
    if (!messageId || !['wrong_intent', 'bad_response', 'good_response'].includes(type))
      return res.status(400).json({ error: 'bad_input' });
    const givenBy = req.user && req.user.id ? req.user.id : null;
    const r = await q(
      `INSERT INTO ai_feedback (message_id, feedback_type, correct_intent, comment, given_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [messageId, type, req.body?.correct_intent || null, req.body?.comment || null, givenBy]
    );
    res.json({ ok: true, feedback: r[0] });
  } catch (e) { console.error('[ai-recept:feedback]', e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
