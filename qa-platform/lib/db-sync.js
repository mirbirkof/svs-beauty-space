/* Синхронизация состояния QA в Neon (мост к панели на Render).
   Пишем служебные таблицы qa_bugs/qa_status/qa_control напрямую (owner-подключение),
   мимо RLS app-роли. Best-effort: ошибки не роняют цикл. Пользовательские поля
   (status='ignored', fix_requested) при апсерте НЕ затираются автосинком. */
const path = require('path');
const { Pool } = require(require.resolve('pg', { paths: [path.join(__dirname, '../../backend/node_modules')] }));
require('dotenv').config({ path: path.join(__dirname, '../../backend/.env') });

let _pool = null;
function pool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
  return _pool;
}

async function pushStatus(st) {
  try {
    await pool().query(
      `INSERT INTO qa_status (id, cycle, mode, checks, modules, bugs, agents, at)
       VALUES (1,$1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (id) DO UPDATE SET cycle=$1, mode=$2, checks=$3, modules=$4, bugs=$5, agents=$6, at=now()`,
      [st.cycle || null, st.mode || null, st.checks || 0, st.modules || 0,
       JSON.stringify(st.bugs || {}), JSON.stringify(st.agents || [])]);
  } catch (e) { console.error('[qa-sync] status:', e.message); }
}

async function pushBugs(bugs) {
  if (!Array.isArray(bugs) || !bugs.length) return;
  const c = pool();
  for (const b of bugs) {
    try {
      await c.query(
        `INSERT INTO qa_bugs (signature,id,severity,module,role,title,scenario,expected,actual,cause,fix,steps,
                              status,needs_manual,manual_reason,seen_count,first_seen,last_seen,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
         ON CONFLICT (signature) DO UPDATE SET
           severity=EXCLUDED.severity, module=EXCLUDED.module, role=EXCLUDED.role, title=EXCLUDED.title,
           scenario=EXCLUDED.scenario, expected=EXCLUDED.expected, actual=EXCLUDED.actual, cause=EXCLUDED.cause,
           fix=EXCLUDED.fix, steps=EXCLUDED.steps, needs_manual=EXCLUDED.needs_manual, manual_reason=EXCLUDED.manual_reason,
           seen_count=EXCLUDED.seen_count, last_seen=EXCLUDED.last_seen, updated_at=now(),
           -- пользовательский игнор не перетираем автосинком; остальные статусы обновляем
           status = CASE WHEN qa_bugs.status='ignored' THEN 'ignored' ELSE EXCLUDED.status END`,
        [b.signature, b.id, b.severity, b.module, b.role || 'system', b.title, b.scenario || '', b.expected || '',
         b.actual || '', b.cause || null, b.fix || null, JSON.stringify(b.steps || []),
         b.status || 'open', !!b.needsManual, b.manualReason || null, b.seenCount || 1,
         b.firstSeen || null, b.lastSeen || null]);
    } catch (e) { console.error('[qa-sync] bug', b.signature, e.message); }
  }
}

async function isPaused() {
  try { const r = await pool().query('SELECT paused FROM qa_control WHERE id=1'); return !!(r.rows[0] && r.rows[0].paused); }
  catch (_) { return false; }
}

module.exports = { pushStatus, pushBugs, isPaused };
