/* API QA-панели (Render). Читает служебные таблицы qa_* из Neon (общая база с QA-loop).
   Отдаёт состояние и принимает действия владельца: игнор бага, запрос на фикс, пауза/запуск.
   Свой owner-пул (qa_* вне tenant-RLS). Авторизация — как во всей админке (requirePerm). */
const express = require('express');
const { Pool } = require('pg');
const { requirePerm } = require('../lib/rbac');

const router = express.Router();
let _pool = null;
const pool = () => (_pool ||= new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 }));

const norm = (b) => ({
  id: b.id, sig: b.signature, sev: b.severity, module: b.module, role: b.role, title: b.title,
  scenario: b.scenario, expected: b.expected, actual: b.actual, cause: b.cause, fix: b.fix, steps: b.steps || [],
  status: b.status, needsManual: b.needs_manual, manualReason: b.manual_reason, seenCount: b.seen_count,
  firstSeen: b.first_seen, lastSeen: b.last_seen, fixRequested: b.fix_requested,
  fixStage: b.fix_stage, fixLog: b.fix_log, fixBranch: b.fix_branch, fixUpdatedAt: b.fix_updated_at,
  fixType: b.fix_type, fixSql: b.fix_sql, fixHuman: b.fix_human,
});
// Активные стадии пайплайна фикса (для отдельной вкладки «В работе»).
const PIPE_STAGES = ['fixing', 'sandbox_testing', 'awaiting_approval', 'approved', 'promoting'];

// Всё состояние для панели одним запросом.
router.get('/state', requirePerm(), async (req, res) => {
  try {
    const c = pool();
    const [stR, bugsR, ctrlR] = await Promise.all([
      c.query('SELECT * FROM qa_status WHERE id=1'),
      c.query('SELECT * FROM qa_bugs ORDER BY last_seen DESC NULLS LAST'),
      c.query('SELECT paused FROM qa_control WHERE id=1'),
    ]);
    const st = stR.rows[0] || {};
    const status = { at: st.at, cycle: st.cycle, mode: st.mode, checks: st.checks, modules: st.modules,
      bugs: st.bugs || {}, agents: st.agents || [] };
    const all = bugsR.rows.map(norm);
    res.json({
      status,
      paused: !!(ctrlR.rows[0] && ctrlR.rows[0].paused),
      open: all.filter((b) => ['open', 'reopened'].includes(b.status) && !PIPE_STAGES.includes(b.fixStage)),
      manual: all.filter((b) => b.status === 'manual' && !PIPE_STAGES.includes(b.fixStage)),
      inProgress: all.filter((b) => PIPE_STAGES.includes(b.fixStage)),
      closed: all.filter((b) => b.status === 'closed'),
      ignored: all.filter((b) => b.status === 'ignored'),
    });
  } catch (e) { console.error('[qa-api] state', e.message); res.status(500).json({ error: 'internal' }); }
});

// Действие над багом: ignore | fix.
router.post('/bug/:sig/:action', requirePerm(), async (req, res) => {
  try {
    const { sig, action } = req.params;
    if (action === 'ignore') {
      await pool().query(`UPDATE qa_bugs SET status='ignored', ignored_at=now(), updated_at=now() WHERE signature=$1`, [sig]);
    } else if (action === 'fix') {
      await pool().query(`UPDATE qa_bugs SET fix_requested=true, fix_requested_at=now(), fix_stage='queued', fix_attempts=0, updated_at=now() WHERE signature=$1`, [sig]);
    } else if (action === 'promote') {
      // Босс подтвердил деплой: только из стадии «ждёт подтверждения»
      await pool().query(`UPDATE qa_bugs SET fix_stage='approved', fix_updated_at=now() WHERE signature=$1 AND fix_stage='awaiting_approval'`, [sig]);
    } else if (action === 'reject') {
      // Отклонить фикс: снять из пайплайна, вернуть в открытые
      await pool().query(`UPDATE qa_bugs SET fix_requested=false, fix_stage=NULL, fix_updated_at=now() WHERE signature=$1`, [sig]);
    } else return res.status(400).json({ error: 'bad-action' });
    res.json({ ok: true });
  } catch (e) { console.error('[qa-api] action', e.message); res.status(500).json({ error: 'internal' }); }
});

// Пауза / запуск платформы.
router.post('/:cmd(pause|resume)', requirePerm(), async (req, res) => {
  try {
    const paused = req.params.cmd === 'pause';
    await pool().query(`INSERT INTO qa_control (id,paused,updated_at) VALUES (1,$1,now())
                        ON CONFLICT (id) DO UPDATE SET paused=$1, updated_at=now()`, [paused]);
    res.json({ ok: true, paused });
  } catch (e) { console.error('[qa-api] ctrl', e.message); res.status(500).json({ error: 'internal' }); }
});

// Прогнать тесты немедленно (будит loop из cooldown).
router.post('/run-now', requirePerm(), async (req, res) => {
  try {
    await pool().query(`INSERT INTO qa_control (id,run_requested,run_requested_at) VALUES (1,true,now())
                        ON CONFLICT (id) DO UPDATE SET run_requested=true, run_requested_at=now()`);
    res.json({ ok: true });
  } catch (e) { console.error('[qa-api] run-now', e.message); res.status(500).json({ error: 'internal' }); }
});

// Отправить в работу ВСЕ открытые баги (массовый фикс).
router.post('/fix-all', requirePerm(), async (req, res) => {
  try {
    const r = await pool().query(
      `UPDATE qa_bugs SET fix_requested=true, fix_requested_at=now(), fix_stage='queued', updated_at=now()
        WHERE status IN ('open','reopened') AND fix_requested=false RETURNING signature`);
    res.json({ ok: true, queued: r.rowCount });
  } catch (e) { console.error('[qa-api] fix-all', e.message); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
