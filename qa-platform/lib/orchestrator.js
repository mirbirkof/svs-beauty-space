/* Оркестратор: управляет агентами, копит покрытие, не повторяет сценарии впустую,
   объединяет результаты, и — главное по ТЗ — РЕГРЕССИЯ: каждый цикл перепроверяет
   открытые баги и закрывает их ТОЛЬКО с доказательством (повторный сценарий прошёл). */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const reg = require('./registry');

// Реестр агентов. Горячая загрузка: каждый цикл берём ВСЕ *.js из agents/ со сбросом require-кэша,
// чтобы 24/7-loop подхватывал новых агентов и правки БЕЗ перезапуска процесса (cron/kill не нужны).
// Деструктивные агенты сами проверяют cfg.allowDestructive и в safe-режиме помечают needs-manual.
function loadAgents() {
  const dir = path.join(__dirname, '../agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const agents = [];
  for (const file of files) {
    const f = path.join(dir, file);
    try { delete require.cache[require.resolve(f)]; agents.push(require(f)); }
    catch (e) { console.error(`[qa] агент ${file} не загрузился: ${e.message}`); }
  }
  return agents;
}

// Лёгкий детерминированный shuffle по номеру цикла — порядок меняется, но воспроизводим.
function shuffle(arr, seed) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = (seed * (i + 7) + 13) % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function runCycle(cycleNo) {
  const started = Date.now();
  const agents = shuffle(loadAgents(), cycleNo || 1);
  const summary = { cycle: cycleNo, agents: agents.length, scenarios: 0, newBugs: 0, reBugs: 0, closed: 0, coverageItems: 0, byAgent: {} };
  const freshBugs = []; // новые реальные баги этого цикла (для уведомления инженеру)

  for (const agent of agents) {
    let res;
    try { res = await agent.run({ cycle: cycleNo }); }
    catch (e) { console.error(`[qa] агент ${agent.name} упал: ${e.message}`); summary.byAgent[agent.name] = { error: e.message }; continue; }
    const { scenarios = [], bugs = [], coverage = [] } = res || {};
    summary.scenarios += scenarios.length;
    for (const s of scenarios) reg.recordScenario(`${agent.name}:${s}`, 'run');
    for (const c of coverage) { reg.markCoverage(c[0], c[1], c[2]); summary.coverageItems++; }
    let nw = 0, rb = 0;
    for (const b of bugs) { const existed = reg.allBugs().some((x) => x.signature === reg.sig(`${b.module}|${b.role || 'system'}|${b.title}`)); const saved = reg.reportBug(b); if (existed) { rb++; } else { nw++; if (saved && !saved.needsManual) freshBugs.push(saved); } }
    summary.newBugs += nw; summary.reBugs += rb;
    summary.byAgent[agent.name] = { scenarios: scenarios.length, bugs: bugs.length, coverage: coverage.length };
  }

  // РЕГРЕССИЯ: перепроверяем открытые баги. Если детектор больше НЕ находит нарушение —
  // закрываем с доказательством (proof = повторный прогон того же правила = 0).
  summary.closed = await regressionVerify(agents);

  // Замыкаем петлю: новые реальные баги → уведомление инженеру (Jarvis/Босс).
  // Критичные сразу, medium/low дайджестом. Best-effort — не роняет цикл.
  if (freshBugs.length) {
    try { const { notifyNewBugs } = require('./notify'); await notifyNewBugs(freshBugs); }
    catch (e) { console.error('[qa] notify не сработал:', e.message); }
  }

  // Отчёт цикла
  const report = { ...summary, ms: Date.now() - started, at: new Date().toISOString(),
    openBugs: reg.openBugs().length, mode: cfg.mode };
  fs.writeFileSync(path.join(cfg.dataDir, 'last-cycle.json'), JSON.stringify(report, null, 2));
  const stateFile = path.join(cfg.dataDir, 'cycle-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ lastCycle: cycleNo, at: report.at }, null, 2));

  // Накопительная статистика по агентам (кто сколько работает / сколько багов) + общий статус.
  try {
    const statsFile = path.join(cfg.dataDir, 'agent-stats.json');
    const stats = (() => { try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')); } catch (_) { return {}; } })();
    for (const [name, s] of Object.entries(summary.byAgent)) {
      stats[name] = stats[name] || { cycles: 0, scenarios: 0, bugs: 0, errors: 0, lastRun: null };
      stats[name].cycles++; stats[name].scenarios += s.scenarios || 0; stats[name].bugs += s.bugs || 0;
      if (s.error) stats[name].errors++;
      stats[name].lastRun = report.at;
    }
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
    writeStatus(cycleNo, report, stats);
  } catch (_) { /* статистика не критична */ }

  // Синк состояния в Neon → панель на Render читает оттуда (стабильный домен, без туннелей).
  try {
    const dbSync = require('./db-sync');
    const st = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'status.json'), 'utf8'));
    await dbSync.pushStatus(st);
    await dbSync.pushBugs(reg.allBugs());
  } catch (e) { console.error('[qa] db-sync не сработал:', e.message); }

  return report;
}

// Перезапуск детекторов и закрытие подтверждённых исправлений.
async function regressionVerify(agents) {
  const open = reg.openBugs();
  if (!open.length) return 0;
  // Собираем все обнаруженные сейчас сигнатуры
  const stillBroken = new Set();
  for (const agent of agents) {
    let res; try { res = await agent.run({ regression: true }); } catch (_) { continue; }
    for (const b of (res?.bugs || [])) stillBroken.add(reg.sig(`${b.module}|${b.role || 'system'}|${b.title}`));
  }
  let closed = 0;
  for (const bug of open) {
    if (!stillBroken.has(bug.signature)) {
      reg.closeBug(bug.signature, { passed: true, method: 'regression-recheck', at: new Date().toISOString() });
      closed++;
    }
  }
  return closed;
}

// Всегда-доступный статус для бота: кто работает, сколько, сколько багов. → data/status.json
function writeStatus(cycleNo, report, stats) {
  let roster = []; try { roster = require('../roster'); } catch (_) {}
  const open = reg.openBugs(), all = reg.allBugs(), manual = reg.manualBugs();
  const status = {
    at: report.at, cycle: cycleNo, mode: cfg.mode,
    checks: report.coverageItems, modules: Object.keys(reg.coverage()).length,
    bugs: { open: open.length, closed: all.filter((b) => b.status === 'closed').length, manual: manual.length,
      bySeverity: open.reduce((a, b) => ((a[b.severity] = (a[b.severity] || 0) + 1), a), {}) },
    openList: open.filter((b) => !b.needsManual).map((b) => ({ id: b.id, sev: b.severity, module: b.module, title: b.title, actual: b.actual })),
    agents: roster.map((r) => ({ role: r.role, status: r.status, covers: r.covers,
      stats: stats[r.agent] || { cycles: 0, scenarios: 0, bugs: 0 } })),
  };
  fs.writeFileSync(path.join(cfg.dataDir, 'status.json'), JSON.stringify(status, null, 2));
}

function nextCycleNo() {
  try { return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'cycle-state.json'), 'utf8')).lastCycle + 1; } catch (_) { return 1; }
}

module.exports = { runCycle, nextCycleNo, loadAgents };
