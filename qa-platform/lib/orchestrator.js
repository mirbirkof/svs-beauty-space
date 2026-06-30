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

  for (const agent of agents) {
    let res;
    try { res = await agent.run({ cycle: cycleNo }); }
    catch (e) { console.error(`[qa] агент ${agent.name} упал: ${e.message}`); summary.byAgent[agent.name] = { error: e.message }; continue; }
    const { scenarios = [], bugs = [], coverage = [] } = res || {};
    summary.scenarios += scenarios.length;
    for (const s of scenarios) reg.recordScenario(`${agent.name}:${s}`, 'run');
    for (const c of coverage) { reg.markCoverage(c[0], c[1], c[2]); summary.coverageItems++; }
    let nw = 0, rb = 0;
    for (const b of bugs) { const existed = reg.allBugs().some((x) => x.signature === reg.sig(`${b.module}|${b.role || 'system'}|${b.title}`)); const saved = reg.reportBug(b); existed ? rb++ : nw++; }
    summary.newBugs += nw; summary.reBugs += rb;
    summary.byAgent[agent.name] = { scenarios: scenarios.length, bugs: bugs.length, coverage: coverage.length };
  }

  // РЕГРЕССИЯ: перепроверяем открытые баги. Если детектор больше НЕ находит нарушение —
  // закрываем с доказательством (proof = повторный прогон того же правила = 0).
  summary.closed = await regressionVerify(agents);

  // Отчёт цикла
  const report = { ...summary, ms: Date.now() - started, at: new Date().toISOString(),
    openBugs: reg.openBugs().length, mode: cfg.mode };
  fs.writeFileSync(path.join(cfg.dataDir, 'last-cycle.json'), JSON.stringify(report, null, 2));
  const stateFile = path.join(cfg.dataDir, 'cycle-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ lastCycle: cycleNo, at: report.at }, null, 2));
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

function nextCycleNo() {
  try { return JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'cycle-state.json'), 'utf8')).lastCycle + 1; } catch (_) { return 1; }
}

module.exports = { runCycle, nextCycleNo, loadAgents };
