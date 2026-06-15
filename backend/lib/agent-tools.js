/* lib/agent-tools.js — реестр инструментов для AI-06 AI Agents.
   Каждый tool — это in-process функция над реальными данными CRM (без самовызовов по HTTP):
   чтение услуг/клиентов/истории/выручки, поиск по базе знаний, генерация контента.
   Деструктивные tools (book_appointment, add_client_note) помечены is_destructive →
   рантайм требует подтверждения (human-in-the-loop) перед реальным выполнением.
   Импорт в роут и в seed каталога ai_agent_tools. */
const { getPool } = require('../db-pg');
const llm = require('./llm');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

/** Описание инструментов + реализация. impl(args) → объект-результат (JSON-сериализуемый). */
const TOOLS = {
  search_kb: {
    category: 'knowledge',
    description: 'Знайти інформацію в базі знань салону (послуги, ціни, акції, FAQ) за текстовим запитом. Параметри: {query: string}.',
    parameters_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    is_destructive: false,
    async impl(args) {
      const question = String(args.query || '').trim();
      if (!question) return { error: 'query порожній' };
      const tokens = (question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).slice(0, 12);
      if (!tokens.length) return { results: [] };
      const orQuery = tokens.join(' | ');
      const rows = await q(
        `SELECT c.content, d.title, d.source_type,
                GREATEST(ts_rank(c.tsv, to_tsquery('simple',$1))*4, ws.score)::float AS score
           FROM ai_kb_chunks c JOIN ai_kb_documents d ON d.id=c.document_id
           CROSS JOIN LATERAL (SELECT COALESCE(MAX(word_similarity(tok,c.content)),0) score FROM unnest($2::text[]) tok) ws
          WHERE c.tsv @@ to_tsquery('simple',$1) OR ws.score > 0.3
          ORDER BY score DESC LIMIT 5`, [orQuery, tokens]).catch(() => []);
      return { results: rows.map(r => ({ title: r.title, source: r.source_type, text: r.content.slice(0, 500) })) };
    },
  },

  get_services: {
    category: 'crm',
    description: 'Отримати список послуг салону з цінами. Параметри: {query?: string (фільтр за назвою/категорією)}.',
    parameters_schema: { type: 'object', properties: { query: { type: 'string' } } },
    is_destructive: false,
    async impl(args) {
      const f = args.query ? `%${String(args.query).toLowerCase()}%` : null;
      const rows = await q(
        `SELECT name, category, duration_min, price FROM services
          WHERE COALESCE(active,true)=true AND deleted_at IS NULL
          ${f ? `AND (lower(name) LIKE $1 OR lower(COALESCE(category,'')) LIKE $1)` : ''}
          ORDER BY category NULLS LAST, name LIMIT ${f ? '40' : '120'}`, f ? [f] : []).catch(() => []);
      return { services: rows.map(s => ({ name: s.name, category: s.category, minutes: s.duration_min, price: Number(s.price) || null })) };
    },
  },

  get_client: {
    category: 'crm',
    description: 'Знайти клієнта за номером телефону або імʼям. Параметри: {phone?: string, name?: string}.',
    parameters_schema: { type: 'object', properties: { phone: { type: 'string' }, name: { type: 'string' } } },
    is_destructive: false,
    async impl(args) {
      let rows = [];
      if (args.phone) rows = await q(`SELECT id, name, phone, email, total_spent, last_visit_at, notes FROM clients WHERE phone ILIKE $1 LIMIT 5`, [`%${args.phone}%`]).catch(() => []);
      if (!rows.length && args.name) rows = await q(`SELECT id, name, phone, email, total_spent, last_visit_at, notes FROM clients WHERE name ILIKE $1 LIMIT 5`, [`%${args.name}%`]).catch(() => []);
      return { clients: rows.map(c => ({ id: c.id, name: c.name, phone: c.phone, total_spent: Number(c.total_spent) || 0, last_visit_at: c.last_visit_at, notes: c.notes })) };
    },
  },

  get_client_history: {
    category: 'crm',
    description: 'Історія візитів клієнта (останні записи). Параметри: {client_id: number}.',
    parameters_schema: { type: 'object', properties: { client_id: { type: 'number' } }, required: ['client_id'] },
    is_destructive: false,
    async impl(args) {
      const id = parseInt(args.client_id, 10);
      if (!id) return { error: 'client_id обовʼязковий' };
      const rows = await q(
        `SELECT a.starts_at, a.status, a.price, s.name AS service, m.name AS master
           FROM appointments a
           LEFT JOIN services s ON s.id=a.service_id
           LEFT JOIN masters m ON m.id=a.master_id
          WHERE a.client_id=$1 ORDER BY a.starts_at DESC LIMIT 15`, [id]).catch(() => []);
      return { visits: rows.map(v => ({ date: v.starts_at, service: v.service, master: v.master, status: v.status, price: Number(v.price) || null })) };
    },
  },

  get_revenue: {
    category: 'finance',
    description: 'Виручка салону за період (завершені візити). Параметри: {from?: "YYYY-MM-DD", to?: "YYYY-MM-DD"}.',
    parameters_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    is_destructive: false,
    async impl(args) {
      const w = [`status='done'`], p = [];
      if (args.from) { p.push(args.from); w.push(`starts_at >= $${p.length}`); }
      if (args.to) { p.push(args.to); w.push(`starts_at <= $${p.length}`); }
      const r = await q(
        `SELECT COUNT(*)::int visits, COALESCE(SUM(price),0)::float revenue, COALESCE(AVG(price),0)::float avg_check
           FROM appointments WHERE ${w.join(' AND ')}`, p).catch(() => [{}]);
      return { visits: r[0]?.visits || 0, revenue: Math.round(r[0]?.revenue || 0), avg_check: Math.round(r[0]?.avg_check || 0) };
    },
  },

  get_top_services: {
    category: 'analytics',
    description: 'Топ послуг за кількістю/виручкою за період. Параметри: {from?: string, to?: string, limit?: number}.',
    parameters_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number' } } },
    is_destructive: false,
    async impl(args) {
      const w = [`a.status='done'`], p = [];
      if (args.from) { p.push(args.from); w.push(`a.starts_at >= $${p.length}`); }
      if (args.to) { p.push(args.to); w.push(`a.starts_at <= $${p.length}`); }
      const lim = Math.min(parseInt(args.limit, 10) || 10, 30);
      const rows = await q(
        `SELECT s.name, COUNT(*)::int cnt, COALESCE(SUM(a.price),0)::float revenue
           FROM appointments a JOIN services s ON s.id=a.service_id
          WHERE ${w.join(' AND ')} GROUP BY s.name ORDER BY revenue DESC LIMIT ${lim}`, p).catch(() => []);
      return { top: rows.map(r => ({ service: r.name, count: r.cnt, revenue: Math.round(r.revenue) })) };
    },
  },

  generate_content: {
    category: 'communication',
    description: 'Згенерувати маркетинговий текст (пост/смс/розсилку). Параметри: {channel: "telegram"|"sms"|"email", prompt: string}.',
    parameters_schema: { type: 'object', properties: { channel: { type: 'string' }, prompt: { type: 'string' } }, required: ['prompt'] },
    is_destructive: false,
    async impl(args) {
      if (!llm.available()) return { error: 'LLM недоступний' };
      const ch = args.channel || 'telegram';
      const text = await llm.ask(
        `Напиши короткий маркетинговий текст для каналу ${ch}. Завдання: ${args.prompt}. Без markdown, готовий до публікації.`,
        { system: 'Ти маркетолог салону краси. Пишеш живо й продаюче українською.', maxTokens: 400 }
      ).catch(e => null);
      return text ? { text: text.trim() } : { error: 'генерація не вдалась' };
    },
  },

  // ── Деструктивні (потребують підтвердження) ──
  add_client_note: {
    category: 'crm',
    description: 'Додати замітку в картку клієнта. Параметри: {client_id: number, note: string}. ПОТРЕБУЄ підтвердження.',
    parameters_schema: { type: 'object', properties: { client_id: { type: 'number' }, note: { type: 'string' } }, required: ['client_id', 'note'] },
    is_destructive: true,
    async impl(args) {
      const id = parseInt(args.client_id, 10);
      if (!id || !args.note) return { error: 'client_id і note обовʼязкові' };
      const r = await q(
        `UPDATE clients SET notes = COALESCE(notes,'') || $2 WHERE id=$1 RETURNING id`,
        [id, `\n[AI ${new Date().toISOString().slice(0, 10)}] ${args.note}`]).catch(() => []);
      return r.length ? { ok: true, client_id: id } : { error: 'клієнта не знайдено' };
    },
  },

  book_appointment: {
    category: 'booking',
    description: 'Створити запис клієнта. Параметри: {client_id: number, service_id: number, master_id?: number, starts_at: "ISO datetime"}. ПОТРЕБУЄ підтвердження.',
    parameters_schema: { type: 'object', properties: { client_id: { type: 'number' }, service_id: { type: 'number' }, master_id: { type: 'number' }, starts_at: { type: 'string' } }, required: ['client_id', 'service_id', 'starts_at'] },
    is_destructive: true,
    async impl(args) {
      const cid = parseInt(args.client_id, 10), sid = parseInt(args.service_id, 10);
      if (!cid || !sid || !args.starts_at) return { error: 'client_id, service_id, starts_at обовʼязкові' };
      const price = await q(`SELECT price FROM services WHERE id=$1`, [sid]).then(r => r[0]?.price).catch(() => null);
      const r = await q(
        `INSERT INTO appointments (client_id, service_id, master_id, starts_at, status, price)
         VALUES ($1,$2,$3,$4,'booked',$5) RETURNING id`,
        [cid, sid, args.master_id ? parseInt(args.master_id, 10) : null, args.starts_at, price]).catch(e => ({ error: e.message }));
      if (Array.isArray(r) && r[0]) return { ok: true, appointment_id: r[0].id };
      return { error: (r && r.error) || 'не вдалось створити запис' };
    },
  },
};

/** Upsert каталога инструментов в ai_agent_tools (вызывается при старте). */
async function seedCatalog() {
  for (const [name, t] of Object.entries(TOOLS)) {
    await q(
      `INSERT INTO ai_agent_tools (name, category, description, parameters_schema, is_destructive)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE SET category=EXCLUDED.category, description=EXCLUDED.description,
         parameters_schema=EXCLUDED.parameters_schema, is_destructive=EXCLUDED.is_destructive, updated_at=NOW()`,
      [name, t.category, t.description, JSON.stringify(t.parameters_schema), t.is_destructive]
    ).catch(() => {});
  }
}

/** Каталог для system-промпта агента (только разрешённые имена). */
function catalogFor(toolNames) {
  return Object.entries(TOOLS)
    .filter(([n]) => toolNames.includes(n))
    .map(([n, t]) => ({ name: n, description: t.description, destructive: t.is_destructive }));
}

module.exports = { TOOLS, seedCatalog, catalogFor };
