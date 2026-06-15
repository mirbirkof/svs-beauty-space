/* routes/ai-marketing.js — AI-03 AI Marketing (генерация маркетингового контента).
   Генерирует тексты рассылок/постов/SMS, ответы на отзывы, A/B варианты, контент-план.
   Brand voice (тон, словарь, эмодзи) применяется ко всем генерациям. LLM — lib/llm.js.
   Модель не пишет SQL и не видит сырых данных клиентов → инъекций нет; промо берёт из каталога услуг/акций.
   Эндпоинты под /api/ai/marketing:
     POST /generate                  — сгенерировать контент (+A/B варианты)
     GET/PUT /generations[/:id]      — список/редактирование/утверждение
     POST /generate-reply            — ответ на отзыв
     GET/POST/PUT /templates[/:id]   — шаблоны промптов
     GET/POST/PUT /brand-voice[/:id] — настройки тона бренда
     POST /content-plan/generate     — AI контент-план
     GET/PUT /content-plan[/:id]     — планы
     GET /analytics                  — аналитика генераций
   Доступ: генерация/план/шаблоны — marketing.write; чтение/аналитика — marketing.read (с фолбэком reports.read). */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');

const router = express.Router();
const pool = getPool();
const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);

// Право: пробуем marketing.*, при отсутствии у роли — RBAC сам решит (wildcard/owner). reports.* как совместимый фолбэк.
const canWrite = requirePerm('marketing.write');
const canRead = requirePerm('marketing.read');

const CHANNEL_LIMITS = {
  sms: 'до 160 символів (1 SMS) або максимум 300; без емодзі, лаконічно',
  telegram: 'до 300 символів, можна 1-3 емодзі, без markdown',
  instagram: 'caption до 500 символів + 3-7 релевантних хештегів наприкінці',
  email: 'розгорнутий текст: тема (subject) + тіло; звертання, абзаци, заклик до дії (CTA)',
  subject_line: 'лише тема листа, до 60 символів, чіпляюча',
  review_reply: 'коротка ввічлива відповідь на відгук',
};

const PURPOSE_HINT = {
  promo: 'рекламний текст про акцію/послугу зі знижкою чи вигодою',
  info: 'інформаційне повідомлення (новина, зміни в роботі)',
  greeting: 'привітання (свято, день народження)',
  reminder: 'нагадування про запис чи повторний візит',
  winback: 'повернення клієнта, який давно не приходив, з мотивацією',
  review_reply: 'відповідь на відгук клієнта',
};

/** Снимок каталога для промо-текстов (услуги+цены, активные акции). Кеш 5 мин. */
let _cat = null, _catTs = 0;
async function catalog() {
  if (_cat && Date.now() - _catTs < 5 * 60 * 1000) return _cat;
  const [services, promotions, codes] = await Promise.all([
    q(`SELECT name, category, price FROM services
        WHERE COALESCE(active,true)=true AND deleted_at IS NULL
        ORDER BY category NULLS LAST, name LIMIT 120`).catch(() => []),
    q(`SELECT title, description, discount_pct, discount_uah
        FROM promotions WHERE COALESCE(is_active,true)=true
          AND (ends_at IS NULL OR ends_at > NOW())
        ORDER BY created_at DESC NULLS LAST LIMIT 30`).catch(() => []),
    q(`SELECT code, type, value, min_total, valid_until FROM promos
        WHERE active=true AND (valid_until IS NULL OR valid_until > NOW()) LIMIT 30`).catch(() => []),
  ]);
  _cat = {
    services: services.map(s => ({ назва: s.name, ціна: Number(s.price) || null })),
    promos: promotions.map(p => ({
      назва: p.title, опис: p.description,
      знижка: p.discount_pct ? `${p.discount_pct}%` : (p.discount_uah ? `${p.discount_uah} грн` : null),
    })),
    promo_codes: codes.map(c => ({
      код: c.code, тип: c.type, значення: c.value, мін_сума: c.min_total,
    })),
  };
  _catTs = Date.now();
  return _cat;
}

/** Загрузить brand voice по id (или default). Возвращает объект или null. */
async function loadBrandVoice(id) {
  let rows;
  if (id) rows = await q(`SELECT * FROM ai_brand_voice WHERE id=$1 LIMIT 1`, [id]).catch(() => []);
  else rows = await q(`SELECT * FROM ai_brand_voice WHERE is_default=true ORDER BY id LIMIT 1`).catch(() => []);
  return rows[0] || null;
}

/** Системный промпт с учётом brand voice. */
function systemPrompt(bv) {
  let s = `Ти — досвідчений маркетолог салону краси. Пишеш живі, продаючі тексти українською (або мовою запиту).
Не вигадуй цін і послуг — використовуй ТІЛЬКИ надані дані каталогу. Без markdown-розмітки (без зірочок і решіток).`;
  if (bv) {
    const toneMap = { friendly: 'дружній, теплий', professional: 'професійний, діловий', premium: 'преміальний, вишуканий', casual: 'легкий, невимушений' };
    const emojiMap = { none: 'не використовуй емодзі', minimal: 'максимум 1 емодзі', moderate: 'помірно емодзі (1-3)', heavy: 'багато емодзі' };
    s += `\nТон бренду: ${toneMap[bv.tone] || bv.tone}.`;
    if (bv.description) s += ` ${bv.description}`;
    if (bv.preferred_words?.length) s += `\nБажані слова: ${bv.preferred_words.join(', ')}.`;
    if (bv.banned_words?.length) s += `\nЗаборонені слова (НЕ вживай): ${bv.banned_words.join(', ')}.`;
    s += `\nЕмодзі: ${emojiMap[bv.emoji_usage] || 'помірно'}.`;
    if (bv.example_texts?.length) s += `\nЕталонні тексти (наслідуй стиль):\n- ${bv.example_texts.slice(0, 3).join('\n- ')}`;
  }
  return s;
}

/** Сгенерировать один текст. */
async function generateOne({ type, purpose, prompt, variables, language, bv }) {
  const cat = await catalog();
  const limit = CHANNEL_LIMITS[type] || CHANNEL_LIMITS.telegram;
  const hint = PURPOSE_HINT[purpose] || PURPOSE_HINT.promo;
  const vars = variables && Object.keys(variables).length
    ? `\nЗмінні для підстановки (вживай як плейсхолдери {ключ} або реальні значення): ${JSON.stringify(variables)}` : '';
  const userPrompt = `Завдання: ${prompt || hint}.
Канал: ${type} (${limit}).
Тип контенту: ${hint}.
Мова відповіді: ${language || 'uk'}.${vars}
Дані салону (послуги й ціни, актуальні акції) — бери звідси факти:
${JSON.stringify(cat).slice(0, 4000)}
Поверни ЛИШЕ готовий текст без пояснень, без лапок навколо, без markdown.`;
  const text = await llm.ask(userPrompt, { system: systemPrompt(bv), maxTokens: 700 });
  return (text || '').trim();
}

// ── POST /generate — генерация (+ A/B) ─────────────────────
router.post('/generate', canWrite, async (req, res) => {
  try {
    const { type, purpose = 'promo', prompt, variables = {}, language = 'uk', brand_voice_id } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type обовʼязковий (email|sms|telegram|instagram|subject_line)' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний (немає API-ключів)' });
    const abCount = Math.min(Math.max(parseInt(req.body.ab_count, 10) || 1, 1), 5);
    const bv = await loadBrandVoice(brand_voice_id);
    const abGroup = abCount > 1 ? crypto.randomUUID() : null;
    const uid = req.user?.id || null;
    const out = [];
    for (let i = 0; i < abCount; i++) {
      let text;
      try { text = await generateOne({ type, purpose, prompt, variables, language, bv }); }
      catch (e) { return res.status(502).json({ error: 'генерація не вдалась: ' + e.message }); }
      if (!text) return res.status(502).json({ error: 'LLM повернув порожній текст' });
      const variant = abCount > 1 ? String.fromCharCode(65 + i) : null;
      const row = (await q(
        `INSERT INTO ai_content_generations (branch_id, type, purpose, prompt, generated_text, variables, language, brand_voice_id, ab_variant, ab_group_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, generated_text, ab_variant, status`,
        [req.body.branch_id || null, type, purpose, prompt || null, text, variables, language, brand_voice_id || null, variant, abGroup, uid]
      ))[0];
      out.push({ id: row.id, text: row.generated_text, ab_variant: row.ab_variant, status: row.status });
    }
    res.json({ generations: out, ab_group_id: abGroup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /generations — список ──────────────────────────────
router.get('/generations', canRead, async (req, res) => {
  try {
    const { type, status, branch_id, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const w = [], p = [];
    if (type) { p.push(type); w.push(`type=$${p.length}`); }
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (branch_id) { p.push(branch_id); w.push(`branch_id=$${p.length}`); }
    if (from) { p.push(from); w.push(`created_at >= $${p.length}`); }
    if (to) { p.push(to); w.push(`created_at <= $${p.length}`); }
    p.push(limit);
    const rows = await q(
      `SELECT id, branch_id, type, purpose, prompt, generated_text, language, ab_variant, ab_group_id, status, performance, created_at
         FROM ai_content_generations ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT $${p.length}`, p);
    res.json({ generations: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /generations/:id — редактировать/утвердить/метрики ──
router.put('/generations/:id', canWrite, async (req, res) => {
  try {
    const { text, status, performance } = req.body || {};
    const sets = ['updated_at=NOW()'], p = [];
    if (text !== undefined) { p.push(text); sets.push(`generated_text=$${p.length}`); }
    if (status !== undefined) {
      if (!['draft', 'approved', 'sent', 'archived'].includes(status)) return res.status(400).json({ error: 'невірний status' });
      p.push(status); sets.push(`status=$${p.length}`);
    }
    if (performance !== undefined) { p.push(JSON.stringify(performance)); sets.push(`performance=$${p.length}::jsonb`); }
    if (p.length === 0) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_content_generations SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING id, generated_text, status, performance`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ generation: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /generate-reply — ответ на отзыв ──────────────────
router.post('/generate-reply', canWrite, async (req, res) => {
  try {
    const { review_text, reviewer_name, rating, service, brand_voice_id } = req.body || {};
    if (!review_text) return res.status(400).json({ error: 'review_text обовʼязковий' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний' });
    const bv = await loadBrandVoice(brand_voice_id);
    const r = parseInt(rating, 10);
    const sentiment = !isNaN(r) ? (r >= 4 ? 'позитивний' : r <= 2 ? 'негативний' : 'нейтральний') : 'невідомий';
    const guide = sentiment === 'негативний'
      ? 'Вибачся, прояви емпатію, запропонуй вирішення проблеми й контакт для звʼязку. Не виправдовуйся надмірно.'
      : sentiment === 'позитивний'
        ? 'Подякуй щиро, згадай послугу/майстра, запроси завітати знову.'
        : 'Подякуй за відгук, ввічливо й по-діловому.';
    const userPrompt = `Згенеруй відповідь салону на відгук клієнта.
Відгук: "${review_text}"
${reviewer_name ? `Імʼя клієнта: ${reviewer_name} (звернись по імені).` : ''}
${service ? `Послуга: ${service}.` : ''}
Тональність відгуку: ${sentiment}. ${guide}
Відповідь коротка (2-4 речення), щира, без шаблонності, без markdown. Поверни лише текст відповіді.`;
    let text;
    try { text = (await llm.ask(userPrompt, { system: systemPrompt(bv), maxTokens: 400 })).trim(); }
    catch (e) { return res.status(502).json({ error: 'генерація не вдалась: ' + e.message }); }
    const row = (await q(
      `INSERT INTO ai_content_generations (branch_id, type, purpose, prompt, generated_text, variables, brand_voice_id, created_by)
       VALUES ($1,'review_reply','review_reply',$2,$3,$4,$5,$6) RETURNING id, generated_text`,
      [req.body.branch_id || null, review_text, text, JSON.stringify({ reviewer_name, rating, service, sentiment }), brand_voice_id || null, req.user?.id || null]
    ))[0];
    res.json({ reply_text: text, id: row.id, sentiment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Templates ──────────────────────────────────────────────
router.get('/templates', canRead, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM ai_content_templates WHERE active=true ORDER BY usage_count DESC, name LIMIT 200`);
    res.json({ templates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/templates', canWrite, async (req, res) => {
  try {
    const { name, type, purpose = 'promo', prompt_template, variables_schema = [], brand_voice_id, example_output } = req.body || {};
    if (!name || !type || !prompt_template) return res.status(400).json({ error: 'name, type, prompt_template обовʼязкові' });
    const row = (await q(
      `INSERT INTO ai_content_templates (branch_id, name, type, purpose, prompt_template, variables_schema, brand_voice_id, example_output)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.body.branch_id || null, name, type, purpose, prompt_template, JSON.stringify(variables_schema), brand_voice_id || null, example_output || null]
    ))[0];
    res.json({ template: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/templates/:id', canWrite, async (req, res) => {
  try {
    const allowed = ['name', 'type', 'purpose', 'prompt_template', 'example_output', 'active', 'brand_voice_id'];
    const sets = ['updated_at=NOW()'], p = [];
    for (const k of allowed) if (req.body[k] !== undefined) { p.push(req.body[k]); sets.push(`${k}=$${p.length}`); }
    if (req.body.variables_schema !== undefined) { p.push(JSON.stringify(req.body.variables_schema)); sets.push(`variables_schema=$${p.length}::jsonb`); }
    if (p.length === 0) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_content_templates SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ template: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Brand voice ────────────────────────────────────────────
router.get('/brand-voice', canRead, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM ai_brand_voice ORDER BY is_default DESC, name`);
    res.json({ brand_voices: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/brand-voice', canWrite, async (req, res) => {
  try {
    const { name, tone = 'friendly', description, preferred_words = [], banned_words = [], example_texts = [],
            emoji_usage = 'moderate', formality = 'neutral', is_default = false } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name обовʼязковий' });
    if (is_default) await q(`UPDATE ai_brand_voice SET is_default=false WHERE is_default=true`).catch(() => {});
    const row = (await q(
      `INSERT INTO ai_brand_voice (branch_id, name, tone, description, preferred_words, banned_words, example_texts, emoji_usage, formality, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.body.branch_id || null, name, tone, description || null, preferred_words, banned_words, example_texts, emoji_usage, formality, !!is_default]
    ))[0];
    res.json({ brand_voice: row });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'brand voice з такою назвою вже існує' });
    res.status(500).json({ error: e.message });
  }
});
router.put('/brand-voice/:id', canWrite, async (req, res) => {
  try {
    if (req.body.is_default === true) await q(`UPDATE ai_brand_voice SET is_default=false WHERE is_default=true`).catch(() => {});
    const allowed = ['name', 'tone', 'description', 'preferred_words', 'banned_words', 'example_texts', 'emoji_usage', 'formality', 'is_default'];
    const sets = ['updated_at=NOW()'], p = [];
    for (const k of allowed) if (req.body[k] !== undefined) { p.push(req.body[k]); sets.push(`${k}=$${p.length}`); }
    if (p.length === 1) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_brand_voice SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ brand_voice: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Content plan ───────────────────────────────────────────
router.post('/content-plan/generate', canWrite, async (req, res) => {
  try {
    const { period_start, period_end, branch_id } = req.body || {};
    if (!period_start || !period_end) return res.status(400).json({ error: 'period_start, period_end обовʼязкові' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний' });
    const cat = await catalog();
    const userPrompt = `Склади контент-план для салону краси на період ${period_start} — ${period_end}.
Канали: telegram, email, instagram. Типи контенту: promo, info, greeting, education, review.
Враховуй сезонність і свята у цьому періоді (Україна). Розподіли публікації рівномірно (3-5 на тиждень).
Дані салону (послуги, акції): ${JSON.stringify(cat).slice(0, 2500)}
Поверни СУВОРО JSON: {"items":[{"date":"YYYY-MM-DD","type":"promo","channel":"telegram","topic":"короткий опис теми"}]}`;
    let parsed;
    try { parsed = await llm.askJSON(userPrompt, { system: 'Ти контент-маркетолог. Повертаєш лише валідний JSON.', maxTokens: 2000 }); }
    catch (e) { return res.status(502).json({ error: 'генерація плану не вдалась: ' + e.message }); }
    const items = (parsed && Array.isArray(parsed.items)) ? parsed.items.map(it => ({ ...it, status: 'draft', generation_id: null })) : [];
    if (!items.length) return res.status(502).json({ error: 'LLM не повернув валідний план' });
    const row = (await q(
      `INSERT INTO ai_content_plans (branch_id, period_start, period_end, items, generated_by)
       VALUES ($1,$2,$3,$4,'ai') RETURNING *`,
      [branch_id || null, period_start, period_end, JSON.stringify(items)]
    ))[0];
    res.json({ plan: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/content-plan', canRead, async (req, res) => {
  try {
    const rows = await q(`SELECT * FROM ai_content_plans ORDER BY period_start DESC LIMIT 100`);
    res.json({ plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/content-plan/:id', canWrite, async (req, res) => {
  try {
    const sets = ['updated_at=NOW()'], p = [];
    if (req.body.items !== undefined) { p.push(JSON.stringify(req.body.items)); sets.push(`items=$${p.length}::jsonb`); }
    if (req.body.status !== undefined) {
      if (!['draft', 'approved', 'active', 'completed'].includes(req.body.status)) return res.status(400).json({ error: 'невірний status' });
      p.push(req.body.status); sets.push(`status=$${p.length}`);
      if (req.body.status === 'approved') { p.push(req.user?.id || null); sets.push(`approved_by=$${p.length}`, `approved_at=NOW()`); }
    }
    if (p.length === 1) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_content_plans SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING *`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ plan: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ──────────────────────────────────────────────
router.get('/analytics', canRead, async (req, res) => {
  try {
    const { from, to, type } = req.query;
    const w = [], p = [];
    if (from) { p.push(from); w.push(`created_at >= $${p.length}`); }
    if (to) { p.push(to); w.push(`created_at <= $${p.length}`); }
    if (type) { p.push(type); w.push(`type=$${p.length}`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [totals, byType, abGroups] = await Promise.all([
      q(`SELECT COUNT(*)::int total,
                COUNT(*) FILTER (WHERE status='approved')::int approved,
                COUNT(*) FILTER (WHERE status='sent')::int sent,
                AVG(NULLIF((performance->>'open_rate')::float,0)) avg_open_rate
           FROM ai_content_generations ${where}`, p),
      q(`SELECT type, COUNT(*)::int cnt, AVG(NULLIF((performance->>'open_rate')::float,0)) avg_open
           FROM ai_content_generations ${where} GROUP BY type ORDER BY cnt DESC`, p),
      q(`SELECT COUNT(DISTINCT ab_group_id)::int ab_groups FROM ai_content_generations
          WHERE ab_group_id IS NOT NULL ${w.length ? 'AND ' + w.join(' AND ') : ''}`, p),
    ]);
    const t = totals[0] || {};
    const best = byType.filter(r => r.avg_open != null).sort((a, b) => b.avg_open - a.avg_open)[0];
    res.json({
      total_generations: t.total || 0,
      approved: t.approved || 0,
      sent: t.sent || 0,
      avg_open_rate: t.avg_open_rate != null ? Number(t.avg_open_rate.toFixed(3)) : null,
      best_performing_type: best ? best.type : null,
      ab_groups: (abGroups[0] || {}).ab_groups || 0,
      by_type: byType.map(r => ({ type: r.type, count: r.cnt, avg_open_rate: r.avg_open != null ? Number(r.avg_open.toFixed(3)) : null })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
