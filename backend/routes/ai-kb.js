/* routes/ai-kb.js — AI-05 AI Knowledge Base (RAG).
   Единый источник знаний для AI-модулей. Индексирует CRM-данные (услуги/цены, мастера/расписание,
   акции, FAQ) и загруженные тексты в чанки с эмбеддингами (Gemini 768-dim, pgvector).
   RAG: вопрос → embedding → top-K cosine (fallback full-text tsvector+trgm) → LLM → ответ с цитатами.
   Эндпоинты /api/ai/kb: ask, test, documents(+:id), sync, sync/status, stats, analytics, sources(+:id), feedback.
   Доступ: ask/analytics reports.read; sync/документы/источники reports.finance. */
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');
const embed = require('../lib/kb-embed');

const router = express.Router();
const pool = getPool();
const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const SYSTEM = `Ти — база знань салону краси. Відповідай ТІЛЬКИ на основі наданих фрагментів знань.
Якщо у фрагментах немає відповіді — чесно скажи "Не знайшов точної інформації". Не вигадуй.
Відповідай мовою запитання, коротко й конкретно, з цифрами. Без markdown-розмітки.`;

const CRM_SOURCES = ['crm_service', 'crm_schedule', 'crm_promo', 'crm_faq'];

// ── Чанкинг: короткие CRM-сущности = 1 чанк; длинный текст — по ~1800 симв с overlap 200 ──
function chunkText(text, size = 1800, overlap = 200) {
  const t = String(text || '').trim();
  if (t.length <= size) return [t];
  const chunks = [];
  for (let i = 0; i < t.length; i += (size - overlap)) chunks.push(t.slice(i, i + size));
  return chunks;
}
const approxTokens = (s) => Math.ceil((s || '').length / 4);

/** Пересобрать чанки+эмбеддинги документа (вызывается после upsert контента). */
async function reindexDocument(docId, language = 'uk') {
  await q(`UPDATE ai_kb_documents SET status='processing', error_message=NULL WHERE id=$1`, [docId]);
  try {
    const doc = (await q(`SELECT content, source_type, source_id FROM ai_kb_documents WHERE id=$1`, [docId]))[0];
    if (!doc) return;
    await q(`DELETE FROM ai_kb_chunks WHERE document_id=$1`, [docId]);
    const parts = chunkText(doc.content);
    const vectors = embed.available() ? await embed.embedBatch(parts, 'RETRIEVAL_DOCUMENT') : parts.map(() => null);
    let embedded = 0;
    for (let i = 0; i < parts.length; i++) {
      const vlit = embed.toVectorLiteral(vectors[i]);
      if (vlit) embedded++;
      await q(
        `INSERT INTO ai_kb_chunks (document_id, chunk_index, content, token_count, char_count, metadata, embedding, embed_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)`,
        [docId, i, parts[i], approxTokens(parts[i]), parts[i].length,
         JSON.stringify({ entity_type: doc.source_type, entity_id: doc.source_id, language }),
         vlit, vlit ? embed.MODEL : null]
      );
    }
    await q(
      `UPDATE ai_kb_documents SET status='indexed', chunks_count=$2, indexed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [docId, parts.length]
    );
    return { chunks: parts.length, embedded };
  } catch (e) {
    await q(`UPDATE ai_kb_documents SET status='error', error_message=$2 WHERE id=$1`, [docId, e.message]).catch(() => {});
    throw e;
  }
}

/** Upsert документа из CRM-сущности по (source_type, source_id). Реиндексирует только при смене hash. */
async function upsertCrmDoc(sourceType, sourceId, title, content, language = 'uk') {
  const hash = sha256(content);
  const existing = (await q(
    `SELECT id, content_hash FROM ai_kb_documents WHERE source_type=$1 AND source_id=$2`, [sourceType, sourceId]
  ))[0];
  if (existing) {
    if (existing.content_hash === hash) return { id: existing.id, changed: false };
    await q(`UPDATE ai_kb_documents SET title=$2, content=$3, content_hash=$4, version=version+1, status='pending', updated_at=NOW() WHERE id=$1`,
      [existing.id, title, content, hash]);
    await reindexDocument(existing.id, language);
    return { id: existing.id, changed: true };
  }
  const doc = (await q(
    `INSERT INTO ai_kb_documents (source_type, source_id, title, content, content_hash, language, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
    [sourceType, sourceId, title, content, hash, language]
  ))[0];
  await reindexDocument(doc.id, language);
  return { id: doc.id, changed: true };
}

// ── Синхронизация одного источника. Возвращает {count, kept}. ──
async function syncSource(type) {
  let rows = [];
  if (type === 'crm_service') {
    const svc = await q(`SELECT id, name, category, duration_min, price, description, contraindications
                           FROM services WHERE COALESCE(active,true)=true AND deleted_at IS NULL`).catch(() => []);
    for (const s of svc) {
      const content = `Послуга: ${s.name}. Категорія: ${s.category || '—'}. Ціна: ${s.price != null ? s.price + ' грн' : 'уточнюйте'}. `
        + `Тривалість: ${s.duration_min || '—'} хв.${s.description ? ' Опис: ' + s.description + '.' : ''}`
        + `${s.contraindications ? ' Протипоказання: ' + s.contraindications + '.' : ''}`;
      rows.push({ id: String(s.id), title: `Послуга: ${s.name}`, content });
    }
  } else if (type === 'crm_schedule') {
    const masters = await q(`SELECT id, name, surname, specialty, category, online_title, online_description
                               FROM masters WHERE active=true AND COALESCE(provides_services,true)=true`).catch(() => []);
    for (const m of masters) {
      const fio = [m.name, m.surname].filter(Boolean).join(' ');
      const content = `Майстер: ${fio}. Напрям: ${m.online_title || m.specialty || m.category || '—'}.`
        + `${m.online_description ? ' ' + m.online_description : ''}`;
      rows.push({ id: String(m.id), title: `Майстер: ${fio}`, content });
    }
  } else if (type === 'crm_promo') {
    const promos = await q(`SELECT id, title, description, discount_pct, discount_uah, starts_at, ends_at
                              FROM promotions WHERE COALESCE(is_active,true)=true`).catch(() => []);
    for (const p of promos) {
      const disc = p.discount_pct ? `-${p.discount_pct}%` : (p.discount_uah ? `-${p.discount_uah} грн` : '');
      const content = `Акція: ${p.title}. ${disc}${p.description ? '. ' + p.description : ''}.`
        + `${p.ends_at ? ' Діє до ' + new Date(p.ends_at).toLocaleDateString('uk-UA') + '.' : ''}`;
      rows.push({ id: String(p.id), title: `Акція: ${p.title}`, content });
    }
    const codes = await q(`SELECT code, type, value, min_total, valid_until FROM promos WHERE active=true`).catch(() => []);
    for (const c of codes) {
      const val = c.type === 'percent' ? `${c.value}%` : `${c.value} грн`;
      rows.push({ id: `code_${c.code}`, title: `Промокод ${c.code}`,
        content: `Промокод ${c.code}: знижка ${val}.${c.min_total ? ' Від ' + c.min_total + ' грн.' : ''}${c.valid_until ? ' Діє до ' + new Date(c.valid_until).toLocaleDateString('uk-UA') + '.' : ''}` });
    }
  } else if (type === 'crm_faq') {
    const cfg = (await q(`SELECT custom_faq FROM ai_receptionist_config WHERE branch_id IS NULL LIMIT 1`).catch(() => []))[0];
    const faq = (cfg && Array.isArray(cfg.custom_faq)) ? cfg.custom_faq : [];
    faq.forEach((f, i) => {
      if (f && f.q && f.a) rows.push({ id: `faq_${i}`, title: `FAQ: ${String(f.q).slice(0, 80)}`, content: `Питання: ${f.q}. Відповідь: ${f.a}` });
    });
    const br = (await q(`SELECT name, address, phone, working_hours FROM branches WHERE COALESCE(is_active,true)=true ORDER BY is_default DESC NULLS LAST LIMIT 1`).catch(() => []))[0];
    if (br) rows.push({ id: 'salon_info', title: 'Інформація про салон',
      content: `Салон: ${br.name}.${br.address ? ' Адреса: ' + br.address + '.' : ''}${br.phone ? ' Телефон: ' + br.phone + '.' : ''}${br.working_hours ? ' Графік: ' + JSON.stringify(br.working_hours) + '.' : ''}` });
  }

  // upsert + удаление исчезнувших сущностей этого типа
  let count = 0;
  const seen = new Set();
  for (const r of rows) {
    await upsertCrmDoc(type, r.id, r.title, r.content);
    seen.add(r.id); count++;
  }
  const existing = await q(`SELECT id, source_id FROM ai_kb_documents WHERE source_type=$1`, [type]);
  for (const d of existing) if (d.source_id && !seen.has(d.source_id)) await q(`DELETE FROM ai_kb_documents WHERE id=$1`, [d.id]);
  return { count };
}

// ── Извлечение релевантных чанков: cosine по embedding, fallback full-text+trgm ──
async function retrieve(question, topK = 5) {
  let qvec = null;
  if (embed.available()) qvec = await embed.embedOne(question, 'RETRIEVAL_QUERY');
  const vlit = embed.toVectorLiteral(qvec);
  if (vlit) {
    const rows = await q(
      `SELECT c.id, c.content, c.document_id, d.title, d.source_type,
              1 - (c.embedding <=> $1::vector) AS score
         FROM ai_kb_chunks c JOIN ai_kb_documents d ON d.id=c.document_id
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $1::vector LIMIT $2`, [vlit, topK]
    ).catch(() => []);
    if (rows.length) return { mode: 'vector', chunks: rows };
  }
  // fallback: full-text (websearch) + trgm similarity
  const rows = await q(
    `SELECT c.id, c.content, c.document_id, d.title, d.source_type,
            GREATEST(ts_rank(c.tsv, websearch_to_tsquery('simple', $1)), similarity(c.content, $1)) AS score
       FROM ai_kb_chunks c JOIN ai_kb_documents d ON d.id=c.document_id
      WHERE c.tsv @@ websearch_to_tsquery('simple', $1) OR c.content % $1
      ORDER BY score DESC LIMIT $2`, [question, topK]
  ).catch(() => []);
  return { mode: 'fulltext', chunks: rows };
}

// ── RAG-ядро: retrieve → LLM → ответ с цитатами + лог ──
async function ragAnswer(question, { topK = 5, callerModule = 'admin', userId = null } = {}) {
  const t0 = Date.now();
  const { mode, chunks } = await retrieve(question, topK);
  const maxScore = chunks.length ? Math.max(...chunks.map(c => Number(c.score) || 0)) : 0;
  if (!chunks.length || maxScore < (mode === 'vector' ? 0.35 : 0.05)) {
    const ans = 'Не знайшов точної інформації за цим запитом. Уточніть, будь ласка, питання.';
    await logQuery(question, chunks, ans, 0.2, callerModule, userId, Date.now() - t0);
    return { answer: ans, confidence: 0.2, sources: [], mode, response_time_ms: Date.now() - t0 };
  }
  const context = chunks.map((c, i) => `[${i + 1}] (${c.title}) ${c.content}`).join('\n');
  let answer = null;
  if (llm.available()) {
    const prompt = `Фрагменти знань салону:\n${context}\n\nПитання: "${question}"\n\nДай коротку точну відповідь українською (або мовою питання) ТІЛЬКИ на основі фрагментів. Якщо відповіді немає — скажи що не знайшов.`;
    try { answer = await llm.ask(prompt, { system: SYSTEM, maxTokens: 600 }); } catch (e) { console.error('[kb:rag] llm', e.message); }
  }
  if (!answer) answer = chunks.slice(0, 2).map(c => c.content).join(' ');
  const confidence = Math.min(0.99, mode === 'vector' ? maxScore : Math.min(0.85, 0.4 + maxScore));
  const sources = chunks.map(c => ({ document_id: c.document_id, title: c.title, chunk_text: c.content.slice(0, 240), similarity_score: Number((Number(c.score) || 0).toFixed(3)) }));
  await logQuery(question, chunks, answer, confidence, callerModule, userId, Date.now() - t0);
  return { answer, confidence: Number(confidence.toFixed(2)), sources, mode, response_time_ms: Date.now() - t0 };
}

async function logQuery(question, chunks, answer, confidence, callerModule, userId, ms) {
  await q(
    `INSERT INTO ai_kb_query_log (user_id, caller_module, question, retrieved_chunk_ids, retrieved_scores, answer, confidence, response_time_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, callerModule, question.slice(0, 1000),
     chunks.map(c => c.id), chunks.map(c => Number((Number(c.score) || 0).toFixed(4))),
     String(answer).slice(0, 4000), confidence, ms]
  ).catch(() => {});
}

// ═══════════════════ ЭНДПОИНТЫ ═══════════════════

// POST /ask — RAG-запрос
router.post('/ask', requirePerm('reports.read'), async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim().slice(0, 1000);
    if (!question) return res.status(400).json({ error: 'no_question' });
    const out = await ragAnswer(question, {
      topK: Math.min(parseInt(req.body?.top_k, 10) || 5, 12),
      callerModule: String(req.body?.caller_module || 'admin').slice(0, 30),
      userId: req.user && req.user.id ? req.user.id : null,
    });
    res.json(out);
  } catch (e) { console.error('[kb:ask]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /test — отладочный запрос с найденными чанками и шагами
router.post('/test', requirePerm('reports.finance'), async (req, res) => {
  try {
    const question = String(req.body?.question || '').trim().slice(0, 1000);
    if (!question) return res.status(400).json({ error: 'no_question' });
    const steps = [];
    let t = Date.now();
    const { mode, chunks } = await retrieve(question, Math.min(parseInt(req.body?.top_k, 10) || 5, 12));
    steps.push({ step: `retrieve (${mode})`, duration_ms: Date.now() - t }); t = Date.now();
    const out = await ragAnswer(question, { topK: chunks.length || 5 });
    steps.push({ step: 'rag_answer', duration_ms: Date.now() - t });
    res.json({ answer: out.answer, confidence: out.confidence, mode,
      chunks: chunks.map(c => ({ id: c.id, content: c.content.slice(0, 300), similarity_score: Number((Number(c.score) || 0).toFixed(3)), document_title: c.title })),
      processing_steps: steps });
  } catch (e) { console.error('[kb:test]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /documents
router.get('/documents', requirePerm('reports.read'), async (req, res) => {
  try {
    const { source_type, status, search } = req.query;
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const where = [], params = [];
    if (source_type) { params.push(source_type); where.push(`source_type=$${params.length}`); }
    if (status) { params.push(status); where.push(`status=$${params.length}`); }
    if (search) { params.push('%' + search + '%'); where.push(`(title ILIKE $${params.length} OR content ILIKE $${params.length})`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await q(`SELECT COUNT(*)::int n FROM ai_kb_documents ${w}`, params))[0].n;
    params.push(perPage); params.push((page - 1) * perPage);
    const items = await q(
      `SELECT id, title, source_type, source_id, status, chunks_count, language, version, indexed_at, created_at
         FROM ai_kb_documents ${w} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    res.json({ items, total, page, per_page: perPage });
  } catch (e) { console.error('[kb:docs]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /documents — загрузка текстового документа (JSON: title + content). Бинарные PDF/DOCX — вне v1.
router.post('/documents', requirePerm('reports.finance'), async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim().slice(0, 300);
    const content = String(req.body?.content || '').trim();
    if (!title || !content) return res.status(400).json({ error: 'title_and_content_required' });
    const language = String(req.body?.language || 'uk').slice(0, 5);
    const hash = sha256(content);
    const doc = (await q(
      `INSERT INTO ai_kb_documents (source_type, title, content, content_hash, language, file_type, status, created_by)
       VALUES ('upload',$1,$2,$3,$4,'txt','pending',$5) RETURNING id`,
      [title, content, hash, language, req.user && req.user.id ? req.user.id : null]
    ))[0];
    const r = await reindexDocument(doc.id, language);
    res.json({ id: doc.id, title, status: 'indexed', chunks_count: r.chunks, embedded: r.embedded });
  } catch (e) { console.error('[kb:doc-add]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /documents/:id
router.get('/documents/:id', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const doc = (await q(`SELECT * FROM ai_kb_documents WHERE id=$1`, [id]))[0];
    if (!doc) return res.status(404).json({ error: 'not_found' });
    const chunks = await q(`SELECT id, chunk_index, content, token_count, (embedding IS NOT NULL) AS has_embedding FROM ai_kb_chunks WHERE document_id=$1 ORDER BY chunk_index`, [id]);
    res.json({ document: { ...doc, content_preview: doc.content.slice(0, 500) }, chunks });
  } catch (e) { console.error('[kb:doc-get]', e); res.status(500).json({ error: 'internal' }); }
});

// DELETE /documents/:id
router.delete('/documents/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const cnt = (await q(`SELECT COUNT(*)::int n FROM ai_kb_chunks WHERE document_id=$1`, [id]))[0].n;
    const r = await q(`DELETE FROM ai_kb_documents WHERE id=$1 RETURNING id`, [id]);
    if (!r[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ deleted: true, chunks_removed: cnt });
  } catch (e) { console.error('[kb:doc-del]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /documents/:id/reindex
router.post('/documents/:id/reindex', requirePerm('reports.finance'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const doc = (await q(`SELECT language FROM ai_kb_documents WHERE id=$1`, [id]))[0];
    if (!doc) return res.status(404).json({ error: 'not_found' });
    const r = await reindexDocument(id, doc.language);
    res.json({ id, status: 'indexed', chunks: r.chunks, embedded: r.embedded });
  } catch (e) { console.error('[kb:reindex]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /sync — синхронизация с CRM
router.post('/sync', requirePerm('reports.finance'), async (req, res) => {
  try {
    const types = Array.isArray(req.body?.source_types) && req.body.source_types.length
      ? req.body.source_types.filter(t => CRM_SOURCES.includes(t)) : CRM_SOURCES;
    const result = {};
    for (const type of types) {
      try {
        const r = await syncSource(type);
        result[type] = { status: 'success', count: r.count };
        await q(`INSERT INTO ai_kb_sources (branch_id, source_type, last_sync_at, last_sync_status, last_sync_count)
                 VALUES (NULL,$1,NOW(),'success',$2)
                 ON CONFLICT (tenant_id, COALESCE(branch_id,-1), source_type)
                 DO UPDATE SET last_sync_at=NOW(), last_sync_status='success', last_sync_count=$2, last_error=NULL, updated_at=NOW()`,
                [type, r.count]).catch(() => {});
      } catch (e) {
        result[type] = { status: 'error', error: e.message };
        await q(`INSERT INTO ai_kb_sources (branch_id, source_type, last_sync_at, last_sync_status, last_error)
                 VALUES (NULL,$1,NOW(),'error',$2)
                 ON CONFLICT (tenant_id, COALESCE(branch_id,-1), source_type)
                 DO UPDATE SET last_sync_at=NOW(), last_sync_status='error', last_error=$2, updated_at=NOW()`,
                [type, e.message]).catch(() => {});
      }
    }
    res.json({ status: 'done', sources: result, embeddings: embed.available() ? 'gemini-768' : 'fulltext_only' });
  } catch (e) { console.error('[kb:sync]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /sync/status
router.get('/sync/status', requirePerm('reports.read'), async (req, res) => {
  try {
    const sources = await q(`SELECT source_type AS type, last_sync_at, last_sync_status AS status, last_sync_count AS count,
                                    is_enabled, sync_interval_minutes, last_error FROM ai_kb_sources ORDER BY source_type`);
    res.json({ sources });
  } catch (e) { console.error('[kb:sync-status]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /stats
router.get('/stats', requirePerm('reports.read'), async (req, res) => {
  try {
    const s = (await q(
      `SELECT (SELECT COUNT(*)::int FROM ai_kb_documents) AS total_documents,
              (SELECT COUNT(*)::int FROM ai_kb_chunks) AS total_chunks,
              (SELECT COUNT(*)::int FROM ai_kb_chunks WHERE embedding IS NOT NULL) AS total_embeddings,
              (SELECT MAX(last_sync_at) FROM ai_kb_sources) AS last_sync_at,
              (SELECT COALESCE(AVG(response_time_ms),0)::int FROM ai_kb_query_log) AS avg_query_time_ms,
              (SELECT COALESCE(AVG(confidence),0)::numeric(3,2) FROM ai_kb_query_log) AS avg_confidence`
    ))[0];
    res.json({ ...s, embedding_mode: embed.available() ? 'gemini-embedding-001@768' : 'fulltext' });
  } catch (e) { console.error('[kb:stats]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /analytics
router.get('/analytics', requirePerm('reports.read'), async (req, res) => {
  try {
    const from = req.query.from || null, to = req.query.to || null;
    const cond = [], params = [];
    if (from) { params.push(from); cond.push(`created_at >= $${params.length}`); }
    if (to) { params.push(to); cond.push(`created_at <= $${params.length}`); }
    const w = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const totals = (await q(
      `SELECT COUNT(*)::int total, COALESCE(AVG(confidence),0)::numeric(3,2) avg_confidence,
              COUNT(*) FILTER (WHERE confidence < 0.5)::int unanswered FROM ai_kb_query_log ${w}`, params))[0];
    const top = await q(
      `SELECT lower(trim(question)) AS question, COUNT(*)::int count FROM ai_kb_query_log ${w}
        GROUP BY lower(trim(question)) ORDER BY count DESC LIMIT 20`, params);
    const byModule = await q(
      `SELECT caller_module, COUNT(*)::int n FROM ai_kb_query_log ${w} GROUP BY caller_module`, params);
    const coverage = (await q(`SELECT COUNT(*) FILTER (WHERE status='indexed')::int indexed, COUNT(*)::int total FROM ai_kb_documents`))[0];
    res.json({
      total_queries: totals.total, avg_confidence: Number(totals.avg_confidence) || 0,
      unanswered_count: totals.unanswered, top_questions: top,
      coverage_percent: coverage.total ? Math.round((coverage.indexed / coverage.total) * 100) : 0,
      queries_by_module: Object.fromEntries(byModule.map(r => [r.caller_module, r.n])),
    });
  } catch (e) { console.error('[kb:analytics]', e); res.status(500).json({ error: 'internal' }); }
});

// GET /sources
router.get('/sources', requirePerm('reports.read'), async (req, res) => {
  try {
    let sources = await q(`SELECT id, source_type, is_enabled, sync_interval_minutes, last_sync_at, last_sync_status FROM ai_kb_sources ORDER BY source_type`);
    if (!sources.length) {
      for (const t of CRM_SOURCES) await q(`INSERT INTO ai_kb_sources (branch_id, source_type) VALUES (NULL,$1) ON CONFLICT DO NOTHING`, [t]).catch(() => {});
      sources = await q(`SELECT id, source_type, is_enabled, sync_interval_minutes, last_sync_at, last_sync_status FROM ai_kb_sources ORDER BY source_type`);
    }
    res.json({ sources });
  } catch (e) { console.error('[kb:sources]', e); res.status(500).json({ error: 'internal' }); }
});

// PUT /sources/:id
router.put('/sources/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const fields = [], params = [];
    const set = (c, v) => { params.push(v); fields.push(`${c}=$${params.length}`); };
    if (req.body?.is_enabled !== undefined) set('is_enabled', !!req.body.is_enabled);
    if (req.body?.sync_interval_minutes !== undefined) set('sync_interval_minutes', Math.max(5, parseInt(req.body.sync_interval_minutes, 10) || 60));
    if (req.body?.config !== undefined) set('config', JSON.stringify(req.body.config));
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });
    params.push(id);
    const r = await q(`UPDATE ai_kb_sources SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${params.length} RETURNING id, source_type, is_enabled, sync_interval_minutes, updated_at`, params);
    if (!r[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r[0]);
  } catch (e) { console.error('[kb:source-put]', e); res.status(500).json({ error: 'internal' }); }
});

// POST /feedback — оценка ответа
router.post('/feedback', requirePerm('reports.read'), async (req, res) => {
  try {
    const id = parseInt(req.body?.query_id, 10);
    const fb = String(req.body?.feedback || '');
    if (!id || !['good', 'bad'].includes(fb)) return res.status(400).json({ error: 'bad_input' });
    const r = await q(`UPDATE ai_kb_query_log SET feedback=$2, feedback_comment=$3 WHERE id=$1 RETURNING id`, [id, fb, req.body?.comment || null]);
    if (!r[0]) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { console.error('[kb:feedback]', e); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
