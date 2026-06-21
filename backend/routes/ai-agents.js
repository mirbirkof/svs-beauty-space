/* routes/ai-agents.js — AI-06 AI Agents (платформа автономных агентов).
   Runtime: ReAct-цикл на lib/llm.js — модель отвечает строгим JSON {action:tool|final,...},
   рантайл исполняет реальные tools (lib/agent-tools.js), логирует каждый шаг (аудит),
   уважает guardrails (whitelist tools, блокировки, подтверждение деструктивных, лимит шагов),
   подгружает память клиента. Деструктивные действия (запись/заметка) без confirm_destructive
   → эскалация на человека (session escalated), реального изменения не происходит.
   Эндпоинты под /api/ai/agents:
     GET/POST/GET:id/PUT:id/DELETE:id     — реестр агентов (+activate/pause)
     POST :id/run                         — запуск (реальный)
     POST :id/test                        — dry-run (tools = мок)
     GET  :id/sessions, GET sessions/:sid — история/детали сессий
     GET  tools                           — каталог инструментов
     GET  :id/memory                      — память агента
     GET  metrics                         — сводные метрики
   Доступ: чтение — ai.agents.read (фолбэк reports.read); управление/запуск — ai.agents.manage (фолбэк reports.finance). */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const llm = require('../lib/llm');
const { TOOLS, seedCatalog, catalogFor } = require('../lib/agent-tools');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

const canRead = requirePerm('reports.read');
const canManage = requirePerm('reports.finance');

// Наполнить каталог инструментов один раз при старте (best-effort).
seedCatalog().catch(() => {});

// ── Runtime ────────────────────────────────────────────────
function runtimeSystem(agent, catalog) {
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  return `${agent.system_prompt}

Поточна дата й час (Київ): ${now}. Використовуй це для відносних дат ("завтра", "наступний тиждень").

Ти — автономний агент салону краси. У тебе є інструменти (tools). Працюй покроково (ReAct):
думай → за потреби виклич інструмент → отримай результат → продовжуй, поки не зможеш дати фінальну відповідь.

Доступні інструменти:
${catalog.map(t => `- ${t.name}: ${t.description}${t.destructive ? ' [деструктивний]' : ''}`).join('\n') || '(немає інструментів)'}

ВІДПОВІДАЙ ЗАВЖДИ СУВОРО одним JSON-обʼєктом, без markdown:
- щоб викликати інструмент: {"action":"tool","tool":"<назва>","args":{...},"reasoning":"чому","confidence":0.0-1.0}
- щоб дати фінальну відповідь: {"action":"final","response":"текст для користувача","confidence":0.0-1.0}
Не вигадуй даних — отримуй їх через інструменти. Якщо інструментів бракує — чесно скажи у final.`;
}

async function loadClientMemory(agentId, clientId) {
  if (!clientId) return [];
  return q(`SELECT key, value FROM ai_agent_memory WHERE agent_id=$1 AND scope='client' AND scope_id=$2 ORDER BY relevance_score DESC LIMIT 20`,
    [agentId, String(clientId)]).catch(() => []);
}

/** Основной цикл агента. dryRun → деструктивные tools возвращают мок, остальные исполняются. */
async function runAgent(agent, { message, client_id, user_id, triggered_by = 'user', confirm_destructive = false, dryRun = false }) {
  const started = Date.now();
  const catalog = catalogFor(agent.tool_names || []);
  const guard = agent.guardrails || {};
  const blocked = new Set(guard.blocked_tools || []);
  const needConfirm = new Set(guard.confirmation_required || []);
  const maxSteps = Math.min(agent.max_tool_calls || 12, 20);

  const mem = await loadClientMemory(agent.id, client_id);
  const memNote = mem.length ? `\nВідома памʼять про клієнта: ${mem.map(m => `${m.key}=${m.value}`).join('; ')}` : '';

  const messages = [
    { role: 'system', content: runtimeSystem(agent, catalog) },
    { role: 'user', content: String(message || '').trim() + memNote },
  ];

  // создаём сессию
  const sess = (await q(
    `INSERT INTO ai_agent_sessions (agent_id, branch_id, triggered_by, trigger_data, user_id, client_id, status, messages)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7) RETURNING id`,
    [agent.id, agent.branch_id || null, triggered_by, JSON.stringify({ dryRun }), user_id || null, client_id || null, JSON.stringify(messages)]
  ))[0];
  const sessionId = sess.id;

  let step = 0, toolCalls = 0, finalText = null, status = 'completed', errMsg = null;
  const actions = [];

  try {
    while (step < maxSteps + 2) {
      const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') +
        `\n\nASSISTANT (тільки JSON):`;
      const decision = await llm.askJSON(prompt, { system: messages[0].content, maxTokens: agent.max_tokens || 1500 });
      if (!decision || !decision.action) {
        finalText = 'Не вдалося обробити запит (некоректна відповідь моделі).';
        status = 'failed'; errMsg = 'invalid LLM decision';
        break;
      }

      if (decision.action === 'final') {
        finalText = decision.response || '';
        await logAction(sessionId, step, 'reasoning', null, null, { response: finalText }, decision.reasoning, decision.confidence, 'executed', null);
        break;
      }

      if (decision.action === 'tool') {
        const tname = decision.tool;
        const tool = TOOLS[tname];
        const aStart = Date.now();

        // guardrails
        if (!tname || !tool || !(agent.tool_names || []).includes(tname)) {
          messages.push({ role: 'assistant', content: JSON.stringify(decision) });
          messages.push({ role: 'user', content: `OBSERVATION: інструмент "${tname}" недоступний цьому агенту.` });
          await logAction(sessionId, step, 'tool_call', tname, decision.args, { error: 'tool not allowed' }, decision.reasoning, decision.confidence, 'rejected', 'not allowed');
          step++; continue;
        }
        if (blocked.has(tname)) {
          messages.push({ role: 'assistant', content: JSON.stringify(decision) });
          messages.push({ role: 'user', content: `OBSERVATION: інструмент "${tname}" заблокований guardrails.` });
          await logAction(sessionId, step, 'tool_call', tname, decision.args, { error: 'blocked' }, decision.reasoning, decision.confidence, 'rejected', 'blocked');
          step++; continue;
        }

        const requiresConfirm = tool.is_destructive || needConfirm.has(tname);
        if (requiresConfirm && !confirm_destructive && !dryRun) {
          // эскалация — стоп без выполнения
          await logAction(sessionId, step, 'confirmation_request', tname, decision.args, null, decision.reasoning, decision.confidence, 'pending', null);
          status = 'escalated';
          finalText = `Потрібне підтвердження менеджера для дії "${tname}" з параметрами ${JSON.stringify(decision.args)}.`;
          actions.push({ tool_name: tname, input: decision.args, reasoning: decision.reasoning, status: 'pending' });
          break;
        }

        // выполнение (или мок в dryRun для деструктивных)
        let output;
        if (dryRun && tool.is_destructive) {
          output = { dry_run: true, would_execute: tname, args: decision.args };
        } else {
          try { output = await tool.impl(decision.args || {}); }
          catch (e) { output = { error: e.message }; }
        }
        toolCalls++;
        await logAction(sessionId, step, 'tool_call', tname, decision.args, output, decision.reasoning, decision.confidence, output && output.error ? 'failed' : 'executed', output && output.error || null);
        actions.push({ tool_name: tname, input: decision.args, mock_output: output, reasoning: decision.reasoning });

        messages.push({ role: 'assistant', content: JSON.stringify(decision) });
        messages.push({ role: 'user', content: `OBSERVATION (${tname}): ${JSON.stringify(output).slice(0, 1500)}` });
        step++;
        if (toolCalls >= maxSteps) {
          // принудительный финал
          const fp = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n') + `\n\nДай фінальну відповідь користувачу одним JSON {"action":"final","response":"..."}:`;
          const fin = await llm.askJSON(fp, { system: messages[0].content, maxTokens: agent.max_tokens || 1500 });
          finalText = (fin && fin.response) || 'Досягнуто ліміт кроків.';
          break;
        }
        continue;
      }

      // неизвестное действие
      messages.push({ role: 'user', content: 'OBSERVATION: невідома дія, поверни {"action":"final",...} або {"action":"tool",...}.' });
      step++;
    }
  } catch (e) {
    status = 'failed'; errMsg = e.message; finalText = finalText || 'Помилка виконання агента.';
  }

  const duration = Date.now() - started;
  await q(
    `UPDATE ai_agent_sessions SET status=$2, messages=$3, tool_calls_count=$4, final_response=$5, error_message=$6, duration_ms=$7, finished_at=NOW()
       WHERE id=$1`,
    [sessionId, status, JSON.stringify(messages), toolCalls, finalText, errMsg, duration]
  ).catch(() => {});
  if (!dryRun) await q(`UPDATE ai_agents SET total_runs=total_runs+1, updated_at=NOW() WHERE id=$1`, [agent.id]).catch(() => {});

  return { session_id: sessionId, status, final_response: finalText, tool_calls: toolCalls, duration_ms: duration, actions };
}

async function logAction(sessionId, step, type, toolName, input, output, reasoning, confidence, status, err) {
  await q(
    `INSERT INTO ai_agent_actions (session_id, step_index, action_type, tool_name, input, output, reasoning, confidence, status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [sessionId, step, type, toolName || null, input ? JSON.stringify(input) : null, output ? JSON.stringify(output) : null,
     reasoning || null, confidence != null ? confidence : null, status, err || null]
  ).catch(() => {});
}

// ── Agents CRUD ────────────────────────────────────────────
router.get('/', canRead, async (req, res) => {
  try {
    const { status, role } = req.query;
    const w = [], p = [];
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (role) { p.push(role); w.push(`role=$${p.length}`); }
    const rows = await q(
      `SELECT id, name, role, status, total_runs, branch_id, updated_at,
              (SELECT MAX(started_at) FROM ai_agent_sessions s WHERE s.agent_id=a.id) AS last_run_at
         FROM ai_agents a ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT 200`, p);
    res.json({ items: rows, total: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/', canManage, async (req, res) => {
  try {
    const { name, role = 'custom', description, system_prompt, model = 'auto', tool_names = [],
            guardrails = {}, schedule, event_triggers = [], temperature = 0.3, max_tokens = 1500, max_tool_calls = 12, branch_id } = req.body || {};
    if (!name || !system_prompt) return res.status(400).json({ error: 'name і system_prompt обовʼязкові' });
    const bad = (tool_names || []).filter(t => !TOOLS[t]);
    if (bad.length) return res.status(400).json({ error: 'невідомі інструменти: ' + bad.join(', ') });
    const row = (await q(
      `INSERT INTO ai_agents (branch_id, name, role, description, system_prompt, model, temperature, max_tokens, max_tool_calls, tool_names, guardrails, schedule, event_triggers, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, name, status, version`,
      [branch_id || null, name, role, description || null, system_prompt, model, temperature, max_tokens, max_tool_calls,
       tool_names, JSON.stringify(guardrails), schedule ? JSON.stringify(schedule) : null, event_triggers, req.user?.id || null]
    ))[0];
    res.json({ agent: row });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/metrics', canRead, async (req, res) => {
  try {
    const { from, to } = req.query;
    const w = [], p = [];
    if (from) { p.push(from); w.push(`started_at >= $${p.length}`); }
    if (to) { p.push(to); w.push(`started_at <= $${p.length}`); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const [tot, byAgent, byTrigger, errs] = await Promise.all([
      q(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='completed')::int ok,
                AVG(duration_ms)::int avg_ms FROM ai_agent_sessions ${where}`, p),
      q(`SELECT a.name, COUNT(*)::int runs FROM ai_agent_sessions s JOIN ai_agents a ON a.id=s.agent_id ${where} GROUP BY a.name ORDER BY runs DESC LIMIT 20`, p),
      q(`SELECT triggered_by, COUNT(*)::int cnt FROM ai_agent_sessions ${where} GROUP BY triggered_by`, p),
      q(`SELECT error_message, COUNT(*)::int cnt FROM ai_agent_sessions ${where ? where + ' AND' : 'WHERE'} error_message IS NOT NULL GROUP BY error_message ORDER BY cnt DESC LIMIT 5`, p),
    ]);
    const t = tot[0] || {};
    res.json({
      total_sessions: t.total || 0,
      success_rate: t.total ? Number((t.ok / t.total).toFixed(2)) : null,
      avg_duration_ms: t.avg_ms || 0,
      sessions_by_agent: byAgent,
      sessions_by_trigger: byTrigger,
      top_errors: errs,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/tools', canRead, async (req, res) => {
  try {
    const { category } = req.query;
    const rows = await q(
      `SELECT name, category, description, is_destructive, is_enabled FROM ai_agent_tools
        ${category ? 'WHERE category=$1' : ''} ORDER BY category, name`, category ? [category] : []);
    res.json({ tools: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/sessions/:sid', canRead, async (req, res) => {
  try {
    const s = (await q(`SELECT * FROM ai_agent_sessions WHERE id=$1`, [req.params.sid]))[0];
    if (!s) return res.status(404).json({ error: 'сесію не знайдено' });
    const acts = await q(`SELECT step_index, action_type, tool_name, input, output, reasoning, confidence, status, error_message, created_at FROM ai_agent_actions WHERE session_id=$1 ORDER BY step_index`, [req.params.sid]);
    res.json({ session: s, actions: acts });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/:id', canRead, async (req, res) => {
  try {
    const a = (await q(`SELECT * FROM ai_agents WHERE id=$1`, [req.params.id]))[0];
    if (!a) return res.status(404).json({ error: 'агента не знайдено' });
    const metrics = (await q(
      `SELECT COUNT(*)::int total_runs, COUNT(*) FILTER (WHERE status='completed')::int ok, AVG(duration_ms)::int avg_ms
         FROM ai_agent_sessions WHERE agent_id=$1`, [a.id]))[0] || {};
    a.tools = catalogFor(a.tool_names || []);
    a.metrics = { total_runs: metrics.total_runs || 0, success_rate: metrics.total_runs ? Number((metrics.ok / metrics.total_runs).toFixed(2)) : null, avg_duration_ms: metrics.avg_ms || 0 };
    res.json({ agent: a });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/:id', canManage, async (req, res) => {
  try {
    if (req.body.tool_names) {
      const bad = req.body.tool_names.filter(t => !TOOLS[t]);
      if (bad.length) return res.status(400).json({ error: 'невідомі інструменти: ' + bad.join(', ') });
    }
    const cols = { name: 1, role: 1, description: 1, system_prompt: 1, model: 1, temperature: 1, max_tokens: 1, max_tool_calls: 1, tool_names: 1, event_triggers: 1, status: 1 };
    const sets = ['updated_at=NOW()', 'version=version+1'], p = [];
    for (const k of Object.keys(cols)) if (req.body[k] !== undefined) { p.push(req.body[k]); sets.push(`${k}=$${p.length}`); }
    if (req.body.guardrails !== undefined) { p.push(JSON.stringify(req.body.guardrails)); sets.push(`guardrails=$${p.length}::jsonb`); }
    if (req.body.schedule !== undefined) { p.push(req.body.schedule ? JSON.stringify(req.body.schedule) : null); sets.push(`schedule=$${p.length}`); }
    if (p.length === 0) return res.status(400).json({ error: 'нема що оновлювати' });
    p.push(req.params.id);
    const rows = await q(`UPDATE ai_agents SET ${sets.join(', ')} WHERE id=$${p.length} RETURNING id, version, status`, p);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ agent: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/:id', canManage, async (req, res) => {
  try {
    const rows = await q(`UPDATE ai_agents SET status='archived', updated_at=NOW() WHERE id=$1 RETURNING id, status`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ agent: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id/activate', canManage, async (req, res) => {
  try {
    const rows = await q(`UPDATE ai_agents SET status='active', updated_at=NOW() WHERE id=$1 RETURNING id, status`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ agent: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id/pause', canManage, async (req, res) => {
  try {
    const rows = await q(`UPDATE ai_agents SET status='paused', updated_at=NOW() WHERE id=$1 RETURNING id, status`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'не знайдено' });
    res.json({ agent: rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Run / Test ─────────────────────────────────────────────
router.post('/:id/run', canManage, async (req, res) => {
  try {
    const agent = (await q(`SELECT * FROM ai_agents WHERE id=$1`, [req.params.id]))[0];
    if (!agent) return res.status(404).json({ error: 'агента не знайдено' });
    if (agent.status === 'archived') return res.status(409).json({ error: 'агент архівований' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний' });
    const { message, client_id, confirm_destructive } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message обовʼязковий' });
    const r = await runAgent(agent, { message, client_id, user_id: req.user?.id, triggered_by: 'user', confirm_destructive: !!confirm_destructive });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/:id/test', canManage, async (req, res) => {
  try {
    const agent = (await q(`SELECT * FROM ai_agents WHERE id=$1`, [req.params.id]))[0];
    if (!agent) return res.status(404).json({ error: 'агента не знайдено' });
    if (!llm.available()) return res.status(503).json({ error: 'LLM недоступний' });
    const { message, client_id } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message обовʼязковий' });
    const r = await runAgent(agent, { message, client_id, user_id: req.user?.id, triggered_by: 'user', dryRun: true });
    res.json(r);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/:id/sessions', canRead, async (req, res) => {
  try {
    const { status, client_id } = req.query;
    const w = ['agent_id=$1'], p = [req.params.id];
    if (status) { p.push(status); w.push(`status=$${p.length}`); }
    if (client_id) { p.push(client_id); w.push(`client_id=$${p.length}`); }
    const rows = await q(
      `SELECT id, triggered_by, status, tool_calls_count, cost_usd, duration_ms, final_response, started_at
         FROM ai_agent_sessions WHERE ${w.join(' AND ')} ORDER BY started_at DESC LIMIT 100`, p);
    res.json({ items: rows, total: rows.length });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/:id/memory', canRead, async (req, res) => {
  try {
    const { scope, scope_id } = req.query;
    const w = ['agent_id=$1'], p = [req.params.id];
    if (scope) { p.push(scope); w.push(`scope=$${p.length}`); }
    if (scope_id) { p.push(scope_id); w.push(`scope_id=$${p.length}`); }
    const rows = await q(`SELECT scope, scope_id, key, value, relevance_score, last_accessed_at FROM ai_agent_memory WHERE ${w.join(' AND ')} ORDER BY relevance_score DESC LIMIT 100`, p);
    res.json({ items: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
// экспорт ядра для серверных вызовов (Instagram-вебхук, триггеры): запуск агента вне HTTP
module.exports.runAgent = runAgent;
