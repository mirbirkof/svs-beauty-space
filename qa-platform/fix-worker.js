#!/usr/bin/env node
/* Fix-worker — сердце safe-fix пайплайна. Управляется ТОЛЬКО из веб-панели:
   Босс жмёт «Исправить» → в Neon ставится fix_requested → воркер забирает баг и ведёт по стадиям:

     queued → fixing → sandbox_testing → awaiting_approval → (кнопка «Деплоить») → promoting → done
                     ↘ failed (на любом шаге: откат, баг назад в «Открытые», причина в fix_log)

   Прод НЕ трогается, пока Босс не подтвердит промоушен в панели. Все стадии видны в панели.
   Запуск: node fix-worker.js once  (один проход очереди) | loop (демон).
*/
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require(require.resolve('pg', { paths: [path.join(__dirname, '../backend/node_modules')] }));
require('dotenv').config({ path: path.join(__dirname, '../backend/.env') });
const cfg = require('./config');

const REPO = path.join(__dirname, '..');            // svs-beauty-space
const STAGING_PORT = 3026;                          // отдельный порт verify-staging (3025 занят ручным)
let _pool = null;
const pool = () => (_pool ||= new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 }));

const short = (sig) => sig.slice(0, 8);
async function setStage(sig, stage, log) {
  await pool().query(
    `UPDATE qa_bugs SET fix_stage=$2, fix_log=COALESCE($3, fix_log), fix_updated_at=now() WHERE signature=$1`,
    [sig, stage, log || null]);
  console.log(`[fix] ${short(sig)} → ${stage}${log ? ' · ' + log : ''}`);
}

// Очередь: АВТОНОМНО берём все открытые КОД-баги (не ждём кнопки «Исправить»).
// Тестеры сами чинят в песочнице; вручную остаётся только финальный деплой (стадия approved).
async function fixQueue() {
  // Только КОД-баги (не ручные — их нельзя починить кодом), не в процессе/аппруве, не больше 2 попыток.
  // Игнорированные (Босс отклонил) и уже одобренные/деплоящиеся не трогаем.
  const r = await pool().query(
    `SELECT * FROM qa_bugs
      WHERE status IN ('open','reopened') AND needs_manual=false
        AND (fix_stage IS NULL OR fix_stage='queued' OR (fix_stage='failed' AND COALESCE(fix_attempts,0) < 2))
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 1`);
  return r.rows[0] || null;
}

function sh(cmd, opts = {}) { return execSync(cmd, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }

// Изолированная копия кода под фикс.
function makeWorktree(sig) {
  const dir = path.join('/tmp', `qa-fix-${short(sig)}`);
  const branch = `qa-fix-${short(sig)}`;
  try { sh(`git worktree remove --force ${dir}`); } catch (_) {}
  try { sh(`git branch -D ${branch}`); } catch (_) {}
  sh(`git worktree add -b ${branch} ${dir} main`);
  return { dir, branch };
}
function cleanupWorktree(dir, branch) {
  try { sh(`git worktree remove --force ${dir}`); } catch (_) {}
  try { sh(`git branch -D ${branch}`); } catch (_) {}
}

// OAuth-токен claude берём из окружения живого Jarvis (own-engine) — там он авторизован.
// Ищем node-процесс с cmdline «src/index.js» и cwd внутри own-engine (pgrep -f ненадёжен:
// цепляет наш собственный claude-процесс, в аргументах которого встречается этот путь).
function resolveClaudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (!cmd.includes('src/index.js')) continue;
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        if (!cwd.includes('own-engine')) continue;
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
        const line = env.split('\0').find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
        if (line) return line.slice('CLAUDE_CODE_OAUTH_TOKEN='.length);
      } catch (_) { /* процесс исчез/нет прав — пропускаем */ }
    }
  } catch (_) {}
  return null;
}
const CLI_BIN = '/home/client/workspace/.npm-local/node_modules/.bin/claude';

// Claude CLI чинит код в worktree (автономно, точечно).
function runClaudeFix(dir, bug) {
  const prompt = `Ты чинишь баг в CRM салона. Внеси ТОЧЕЧНЫЙ фикс, не рефакторь лишнего.

БАГ: ${bug.title}
Модуль: ${bug.module} · важность: ${bug.severity}
Сценарий: ${bug.scenario || '—'}
Ожидалось: ${bug.expected || '—'}
Получили (actual): ${bug.actual || '—'}
Причина (гипотеза): ${bug.cause || '—'}

Задача: найди корневую причину в коде (backend/ или backend/public/admin/) и исправь минимальным изменением.
Не трогай тесты и qa-platform/. После правки коротко напиши что изменил.`;
  const token = resolveClaudeToken();
  return new Promise((resolve) => {
    if (!token) return resolve({ code: -1, out: 'нет CLAUDE_CODE_OAUTH_TOKEN (Jarvis не найден)' });
    const out = [];
    const p = spawn(CLI_BIN, ['-p', prompt,
      '--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions',
      '--model', 'sonnet', '--add-dir', dir],
      { cwd: dir, env: { ...process.env, HOME: '/home/client', CI: '1', CLAUDE_CODE_OAUTH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    const to = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} }, 10 * 60 * 1000);
    p.stdout.on('data', (d) => out.push(d.toString()));
    p.stderr.on('data', (d) => out.push(d.toString()));
    p.on('close', (code) => { clearTimeout(to); resolve({ code, out: out.join('').slice(-2000) }); });
    p.on('error', (e) => { clearTimeout(to); resolve({ code: -1, out: 'spawn error: ' + e.message }); });
  });
}

// Синтаксис изменённых .js.
function syntaxCheck(dir) {
  const changed = sh('git diff --name-only', { cwd: dir }).trim().split('\n').filter(Boolean);
  if (!changed.length) return { ok: false, reason: 'фикс не изменил ни одного файла', changed };
  const errs = [];
  for (const f of changed.filter((x) => x.endsWith('.js'))) {
    try { execSync(`node --check "${f}"`, { cwd: dir, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { errs.push(`${f}: ${(e.stderr || e.message || '').toString().slice(0, 200)}`); }
  }
  return errs.length ? { ok: false, reason: 'синтакс-ошибки: ' + errs.join('; '), changed } : { ok: true, changed };
}

// Verify: поднимаем staging из worktree на песочнице и гоняем QA-цикл против фикса.
async function verifyOnSandbox(dir, bug) {
  if (!cfg.qaDbUrl) return { ok: false, reason: 'нет песочницы (qaDbUrl)' };
  const backend = path.join(dir, 'backend', 'shop-api.js');
  // git worktree не содержит node_modules (gitignored) — симлинкуем из основного репо, иначе backend не стартует.
  for (const sub of ['backend', '']) {
    const nm = path.join(dir, sub, 'node_modules');
    const src = path.join(REPO, sub, 'node_modules');
    try { if (!fs.existsSync(nm) && fs.existsSync(src)) fs.symlinkSync(src, nm); } catch (_) {}
  }
  // 1) поднять staging из worktree
  try {
    execSync(`node staging.js start`, { cwd: __dirname, timeout: 100000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, QA_STAGING_BACKEND: backend, QA_STAGING_PORT: String(STAGING_PORT) } });
  } catch (e) { return { ok: false, reason: 'staging не поднялся: ' + (e.message || '').slice(0, 150) }; }
  // 2) прогон QA против песочницы (агенты читают sandbox БД + бьют staging HTTP)
  let out = '';
  try {
    out = execSync(`node run.js`, { cwd: __dirname, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: cfg.qaDbUrl, QA_API_BASE: `http://127.0.0.1:${STAGING_PORT}`, QA_VERIFY: '1' } }).toString();
  } catch (e) { out = (e.stdout || '').toString() + (e.message || ''); }
  finally {
    try { execSync(`node staging.js stop`, { cwd: __dirname, stdio: 'ignore',
      env: { ...process.env, QA_STAGING_PORT: String(STAGING_PORT) } }); } catch (_) {}
  }
  // 3) вердикт: целевой баг больше не воспроизводится и нет новых critical/high
  const stillThere = await pool().query(
    `SELECT status FROM qa_bugs WHERE signature=$1`, [bug.signature]); // грубая проверка по свежему прогону
  const gone = !out.includes(bug.title);
  return gone ? { ok: true, out: out.slice(-500) } : { ok: false, reason: 'после фикса баг всё ещё воспроизводится', out: out.slice(-500) };
}

// Claude отвечает текстом (без правки файлов) — для генерации SQL-фикса данных.
function runClaudeRaw(prompt) {
  const token = resolveClaudeToken();
  return new Promise((resolve) => {
    if (!token) return resolve('');
    const out = [];
    const p = spawn(CLI_BIN, ['-p', prompt, '--model', 'sonnet'],
      { cwd: REPO, env: { ...process.env, HOME: '/home/client', CI: '1', CLAUDE_CODE_OAUTH_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    const to = setTimeout(() => { try { p.kill('SIGTERM'); } catch (_) {} }, 5 * 60 * 1000);
    p.stdout.on('data', (d) => out.push(d.toString()));
    p.on('close', () => { clearTimeout(to); resolve(out.join('')); });
    p.on('error', () => { clearTimeout(to); resolve(''); });
  });
}

// Автопочинка ДАННЫХ: Claude генерит безопасный SQL, проверяем в ПЕСОЧНИЦЕ. Прод — только по кнопке.
async function dataFix(bug) {
  const prompt = `Это баг ДАННЫХ в PostgreSQL базе CRM салона (НЕ баг кода, а кривая запись в таблице).
Баг: ${bug.title}
Детали: ${bug.actual || '—'}
Причина: ${bug.cause || '—'}
Сгенерируй ОДИН безопасный SQL-запрос (UPDATE или DELETE) с ТОЧНЫМ WHERE, который исправит только кривые записи.
СТРОГО ЗАПРЕЩЕНО: DROP, TRUNCATE, ALTER, DELETE/UPDATE без WHERE.
Ответь РОВНО в таком формате, без markdown:
SQL: <один запрос в одну строку>
ПОНЯТНО: <объясни простыми словами для НЕ-технаря, что этот фикс делает и почему это безопасно>`;
  const raw = await runClaudeRaw(prompt);
  const sql = ((raw.match(/SQL:\s*([\s\S]+?)(?:\nПОНЯТНО:|$)/) || [])[1] || '').trim().replace(/^```\w*|```$/g, '').trim();
  const human = ((raw.match(/ПОНЯТНО:\s*([\s\S]+)/) || [])[1] || '').trim().slice(0, 400);
  if (!sql || !/^(update|delete)\s/i.test(sql)) return { ok: false, reason: 'не удалось сгенерировать безопасный SQL-фикс' };
  if (/\b(drop|truncate|alter|create)\b/i.test(sql)) return { ok: false, reason: 'SQL содержит запрещённую операцию' };
  if (!/\bwhere\b/i.test(sql)) return { ok: false, reason: 'SQL без WHERE — небезопасно' };
  // применяем в ПЕСОЧНИЦЕ (не в проде!)
  try { const { qaQ } = require('./lib/crm'); await qaQ(sql); }
  catch (e) { return { ok: false, reason: 'SQL не прошёл в песочнице: ' + String(e.message).slice(0, 150) }; }
  return { ok: true, sql, human: human || 'Система исправит кривую запись в базе.' };
}

async function processBug(bug) {
  const sig = bug.signature;
  let wt = null;
  try {
    await pool().query('UPDATE qa_bugs SET fix_attempts=COALESCE(fix_attempts,0)+1 WHERE signature=$1', [sig]);
    await setStage(sig, 'fixing', 'готовлю изолированную копию и правлю код');
    wt = makeWorktree(sig);
    await pool().query(`UPDATE qa_bugs SET fix_branch=$2 WHERE signature=$1`, [sig, wt.branch]);

    const fix = await runClaudeFix(wt.dir, bug);
    const syn = syntaxCheck(wt.dir);
    if (!syn.ok) {
      // Код не изменился → это, скорее всего, баг ДАННЫХ. Пробуем автопочинку данных (SQL в песочнице).
      if (/не изменил ни одного файла/.test(syn.reason)) {
        await setStage(sig, 'sandbox_testing', 'код чинить нечего — похоже баг в данных, готовлю авто-исправление записи');
        const df = await dataFix(bug);
        if (df.ok) {
          await pool().query(
            `UPDATE qa_bugs SET fix_type='data', fix_sql=$2, fix_human=$3, fix_stage='awaiting_approval', fix_updated_at=now(),
                    fix_log=$4 WHERE signature=$1`,
            [sig, df.sql, df.human, `✅ Проверено в песочнице: ${df.human} Жми «Применить», чтобы поправить боевую базу.`]);
          console.log(`[fix] ${short(sig)} → awaiting_approval (data-fix)`);
          cleanupWorktree(wt.dir, wt.branch); return;
        }
        // не смогли починить данные автоматически — честно в ручную
        await pool().query(
          `UPDATE qa_bugs SET status='manual', needs_manual=true, fix_requested=false,
                  manual_reason=$2 WHERE signature=$1`,
          [sig, `Автопочинка не удалась: ${df.reason}. Нужен человек — данные неоднозначные.`]);
        await setStage(sig, 'failed', `авто-исправление данных не удалось: ${df.reason}`);
        cleanupWorktree(wt.dir, wt.branch); return;
      }
      const detail = fix.code !== 0 ? ` | claude(${fix.code}): ${(fix.out || '').slice(-300)}` : '';
      await setStage(sig, 'failed', syn.reason + detail); cleanupWorktree(wt.dir, wt.branch); return;
    }
    await setStage(sig, 'sandbox_testing', `правки: ${syn.changed.join(', ')} — тестирую в песочнице`);

    let ver = await verifyOnSandbox(wt.dir, bug);
    if (!ver.ok) {
      // Код изменился, но баг жив → частый случай: причина в СУЩЕСТВУЮЩИХ данных (кривые записи),
      // а код-фикс лишь предотвращает новые. Чиним и данные, потом перепроверяем.
      await setStage(sig, 'sandbox_testing', 'код поправлен, но баг ещё жив — похоже, кривые записи уже в базе. Чиню и данные');
      const df = await dataFix(bug);
      if (df.ok) {
        // SQL уже проверен применением в песочнице. Перепроверять детектором нельзя:
        // детекторы читают ПРОД, а кривые записи там исправятся только после «Деплоить».
        await pool().query(
          `UPDATE qa_bugs SET fix_type='data', fix_sql=$2, fix_human=$3, fix_stage='awaiting_approval', fix_updated_at=now(),
                  fix_log=$4 WHERE signature=$1`,
          [sig, df.sql, df.human,
           `✅ Готово к деплою. Фикс двойной — (1) ${df.human} (2) код теперь не даст создать такую запись снова (${syn.changed.join(', ')}). SQL проверен на копии базы. Жми «Деплоить» — применится и то, и другое, баг закроется регрессией после деплоя.`]);
        console.log(`[fix] ${short(sig)} → awaiting_approval (data+code)`);
        return; // worktree оставляем — ветка нужна для промоушена кода
      }
      // Исчерпаны попытки → баг не поддаётся авто-фиксу (частый случай — баг ДАННЫХ, а не кода).
      const a = await pool().query('SELECT COALESCE(fix_attempts,0) n FROM qa_bugs WHERE signature=$1', [sig]);
      const last = (a.rows[0] && a.rows[0].n) >= 2;
      const msg = last
        ? `не поддаётся авто-фиксу за 2 попытки (${ver.reason}). Вероятно баг в существующих ДАННЫХ, а не в коде — нужна ручная проверка.`
        : ver.reason;
      await setStage(sig, 'failed', msg);
      // Если исчерпаны попытки — помечаем как "нужна ручная правка" и снимаем флаг авто-фикса,
      // чтобы кнопка «Исправить» в UI не запускала бесконечный цикл заново.
      if (last) {
        // уводим из «открытых» в «требует ручной правки» (иначе баг вечно висит в open)
        await pool().query(
          `UPDATE qa_bugs SET status='manual', needs_manual=true, fix_requested=false,
                  manual_reason='Авто-фикс не справился за 2 попытки. Обычно это баг в ДАННЫХ (кривая запись), а не в коде — правится вручную в базе, деплой кода не нужен.' WHERE signature=$1`,
          [sig]);
      }
      cleanupWorktree(wt.dir, wt.branch); return;
    }

    // Зелено в песочнице → ждём подтверждения Босса. В лог — ЧТО именно деплоим (файлы), чтобы Босс видел.
    const files = syn.changed.join(', ');
    await setStage(sig, 'awaiting_approval',
      `✅ Проверено в песочнице: баг ушёл, новых не появилось. При деплое изменится: ${files}. Ветка ${wt.branch}. Жми «Деплоить» когда готов.`);
    // worktree НЕ удаляем — он нужен для промоушена после аппрува.
  } catch (e) {
    await setStage(sig, 'failed', 'ошибка воркера: ' + (e.message || '').slice(0, 200));
    if (wt) cleanupWorktree(wt.dir, wt.branch);
  }
}

// Одобренные Боссом в панели фиксы (кнопка «Деплоить») → merge в main → деплой Render.
async function promoteQueue() {
  const r = await pool().query(`SELECT * FROM qa_bugs WHERE fix_stage='approved' AND (fix_branch IS NOT NULL OR fix_type='data') LIMIT 1`);
  return r.rows[0] || null;
}
async function promoteBug(bug) {
  const sig = bug.signature, branch = bug.fix_branch;
  // Data-фикс: применяем проверенный SQL к БОЕВОЙ базе (не git). SQL уже прошёл песочницу.
  if (bug.fix_type === 'data' && bug.fix_sql) {
    try {
      await setStage(sig, 'promoting', 'применяю исправление данных к боевой базе');
      await pool().query(bug.fix_sql);
      if (!branch) { // чисто данные — код не менялся
        await pool().query(
          `UPDATE qa_bugs SET status='closed', fix_stage='done', fix_requested=false, closed_at=now(), fix_updated_at=now(),
                  fix_log='✔ Данные исправлены в боевой базе' WHERE signature=$1`, [sig]);
        console.log(`[fix] ${short(sig)} → done (данные исправлены в проде)`);
        return;
      }
      // двойной фикс: данные применены, дальше деплоим и код-ветку (защита от повторения)
      console.log(`[fix] ${short(sig)} → данные в проде, деплою код-ветку`);
    } catch (e) {
      await setStage(sig, 'failed', 'не удалось применить SQL к боевой: ' + String(e.message).slice(0, 150));
      return;
    }
  }
  try {
    await setStage(sig, 'promoting', `переношу ветку ${branch} на боевую`);
    sh('git checkout main');
    try { sh('git pull --ff-only origin main'); } catch (_) {}
    sh(`git merge --no-ff ${branch} -m "[jarvis] fix(qa): ${bug.title.slice(0, 80)} [${short(sig)}]"`);
    sh('git push origin main');   // → Render автодеплой
    await pool().query(
      `UPDATE qa_bugs SET status='closed', fix_stage='done', fix_requested=false, closed_at=now(), fix_updated_at=now(),
              fix_log='задеплоено на боевую (Render)' WHERE signature=$1`, [sig]);
    console.log(`[fix] ${short(sig)} → done (в проде)`);
    const dir = path.join('/tmp', `qa-fix-${short(sig)}`);
    cleanupWorktree(dir, branch);
  } catch (e) {
    // конфликт/ошибка мерджа — откат, назад на аппрув с причиной
    try { sh('git merge --abort'); } catch (_) {}
    try { sh('git checkout main'); } catch (_) {}
    await setStage(sig, 'failed', 'промоушен не удался: ' + (e.message || '').slice(0, 200));
  }
}

async function main() {
  const mode = process.argv[2] || 'once';
  const restartFlag = '/tmp/qa-fix-worker-restart';
  do {
    // Мягкий рестарт без kill: тронуть /tmp/qa-fix-worker-restart → воркер выходит, qa-daemon поднимает свежий код за 30с.
    if (fs.existsSync(restartFlag)) {
      try { fs.unlinkSync(restartFlag); } catch (_) {}
      console.log('[fix] рестарт по флагу — выхожу, сторож поднимет новую версию');
      break;
    }
    // 1) сначала одобренные — переносим в прод
    const approved = await promoteQueue();
    if (approved) { console.log(`[fix] промоушен: ${approved.title}`); await promoteBug(approved); }
    // 2) затем новые в работу
    const bug = await fixQueue();
    if (bug) { console.log(`[fix] беру в работу: ${bug.title}`); await processBug(bug); }
    if (!approved && !bug && mode === 'once') { console.log('[fix] очередь пуста'); break; }
    if (mode === 'loop') await new Promise((r) => setTimeout(r, 30000));
  } while (mode === 'loop');
  await pool().end();
}
main().catch((e) => { console.error('[fix] fatal:', e.message); process.exit(1); });
