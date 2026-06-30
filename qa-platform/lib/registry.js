/* Реестр: баги + покрытие + история сценариев. JSON-файлы (самодостаточно, переживает рестарт).
   Дедуп багов по сигнатуре (модуль+сценарий+суть), чтобы один баг не плодился каждый цикл.
   Баг закрывается ТОЛЬКО при наличии доказательства (см. requireProof в orchestrator). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('../config');

const BUGS = path.join(cfg.dataDir, 'bugs.json');
const COVERAGE = path.join(cfg.dataDir, 'coverage.json');
const SCENARIOS = path.join(cfg.dataDir, 'scenarios-history.json');

function load(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return def; } }
function save(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
const sig = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

// Зафиксировать баг. Обязательные поля по ТЗ. Дедуп по (module|scenario|title).
function reportBug(b) {
  const bugs = load(BUGS, []);
  const signature = sig(`${b.module}|${b.role}|${b.title}`);
  const now = new Date().toISOString();
  const existing = bugs.find((x) => x.signature === signature);
  if (existing) {
    existing.lastSeen = now; existing.seenCount = (existing.seenCount || 1) + 1;
    if (b.evidence) existing.evidence = b.evidence;
    if (existing.status === 'closed' && b.stillBroken) { existing.status = 'reopened'; existing.reopenedAt = now; }
    save(BUGS, bugs); return existing;
  }
  const bug = {
    id: 'QA-' + signature,
    severity: b.severity || 'medium',          // critical|high|medium|low
    module: b.module, role: b.role || 'system',
    title: b.title,
    scenario: b.scenario || '', steps: b.steps || [],
    expected: b.expected || '', actual: b.actual || '',
    logs: b.logs || [], errorStack: b.errorStack || null,
    sql: b.sql || null, evidence: b.evidence || null,
    cause: b.cause || null, fix: b.fix || null,
    status: b.needsManual ? 'manual' : 'open', signature, seenCount: 1,
    firstSeen: now, lastSeen: now,
    needsManual: !!b.needsManual, manualReason: b.manualReason || null,
  };
  bugs.push(bug); save(BUGS, bugs);
  return bug;
}

// Подтвердить, что баг исправлен — ТОЛЬКО с доказательством (proof = результат повторного сценария).
function closeBug(signature, proof) {
  const bugs = load(BUGS, []);
  const bug = bugs.find((x) => x.signature === signature || x.id === signature);
  if (!bug) return null;
  if (!proof || !proof.passed) return bug; // нет доказательства — не закрываем
  bug.status = 'closed'; bug.closedAt = new Date().toISOString(); bug.closeProof = proof;
  save(BUGS, bugs); return bug;
}

function openBugs() { return load(BUGS, []).filter((b) => ['open', 'reopened'].includes(b.status)); }
function manualBugs() { return load(BUGS, []).filter((b) => b.status === 'manual'); }
function allBugs() { return load(BUGS, []); }

// Покрытие: модуль → {checks, lastRun, pass, fail}
function markCoverage(module, item, ok) {
  const cov = load(COVERAGE, {});
  cov[module] = cov[module] || { items: {}, lastRun: null };
  cov[module].items[item] = { ok, at: new Date().toISOString() };
  cov[module].lastRun = new Date().toISOString();
  save(COVERAGE, cov);
}
function coverage() { return load(COVERAGE, {}); }

// История сценариев — чтобы не повторять идентичный сценарий слишком часто (anti-repeat).
function scenarioRecentlyRun(key) {
  const h = load(SCENARIOS, {});
  const rec = h[key];
  if (!rec) return false;
  const ageH = (Date.now() - new Date(rec.at).getTime()) / 3600e3;
  return ageH < cfg.scenarioDedupWindowH;
}
function recordScenario(key, result) {
  const h = load(SCENARIOS, {});
  h[key] = { at: new Date().toISOString(), result };
  save(SCENARIOS, h);
}

module.exports = { reportBug, closeBug, openBugs, manualBugs, allBugs, markCoverage, coverage, scenarioRecentlyRun, recordScenario, sig };
