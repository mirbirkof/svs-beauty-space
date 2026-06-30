#!/usr/bin/env node
/* Точка входа QA-платформы.
   node run.js            — один цикл (для крона/loop-skill)
   node run.js --loop     — непрерывно (24/7), пауза = QA_COOLDOWN_MS
   node run.js --report   — сводка по багам и покрытию */
const cfg = require('./config');
const { runCycle, nextCycleNo } = require('./lib/orchestrator');
const reg = require('./lib/registry');
const { pool } = require('./lib/crm');

function printReport() {
  const open = reg.openBugs(), all = reg.allBugs(), cov = reg.coverage();
  const bySev = open.reduce((a, b) => ((a[b.severity] = (a[b.severity] || 0) + 1), a), {});
  const manual = all.filter((b) => b.needsManual && b.status !== 'closed').length;
  console.log('=== QA PLATFORM — СВОДКА ===');
  console.log(`Режим: ${cfg.mode} (деструктив: ${cfg.allowDestructive ? 'разрешён' : 'ЗАПРЕЩЁН — нет изолированного таргета'})`);
  console.log(`Багов открыто: ${open.length} | critical:${bySev.critical || 0} high:${bySev.high || 0} medium:${bySev.medium || 0} low:${bySev.low || 0}`);
  console.log(`Закрыто всего: ${all.filter((b) => b.status === 'closed').length} | требует ручной проверки: ${manual}`);
  const modules = Object.keys(cov).length;
  const items = Object.values(cov).reduce((a, m) => a + Object.keys(m.items || {}).length, 0);
  console.log(`Покрытие: ${modules} модулей, ${items} проверок`);
  const real = open.filter((b) => !b.needsManual);
  if (real.length) { console.log('\nРеальные открытые баги:'); real.slice(0, 15).forEach((b) => console.log(`  [${b.severity}] ${b.module}/${b.role}: ${b.title} (${b.actual || ''})`)); }
  // Ростер 13 AI-агентов из ТЗ и их статус
  try {
    const roster = require('./roster');
    const ic = { ready: '✅', partial: '🟡', gated: '🔒', meta: '🧠' };
    console.log('\n=== РОСТЕР 13 AI-АГЕНТОВ (ТЗ) ===');
    roster.forEach((r) => console.log(`  ${ic[r.status] || '·'} ${r.role} — ${r.status} · ${r.covers}`));
    console.log('Легенда: ✅ работает · 🟡 частично (HTTP/активное ждёт staging) · 🔒 ждёт изолированный staging · 🧠 мета');
  } catch (_) {}
}

async function main() {
  const arg = process.argv[2];
  if (arg === '--report') { printReport(); await pool.end(); return; }

  if (arg === '--loop') {
    console.log('[qa] LOOP MODE — Ctrl+C для остановки');
    const reloadFlag = require('path').join(cfg.dataDir, 'reload.flag');
    const fs = require('fs');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const n = nextCycleNo();
      const r = await runCycle(n);
      console.log(`[qa] цикл #${n}: ${r.scenarios} сценариев, +${r.newBugs} новых, ${r.closed} закрыто, открыто ${r.openBugs} (${r.ms}мс)`);
      // Само-перезапуск без kill: если кто-то положил reload.flag — выходим, keepalive поднимет свежий код.
      if (fs.existsSync(reloadFlag)) { fs.unlinkSync(reloadFlag); console.log('[qa] reload.flag → перезапуск на свежий код'); await pool.end(); process.exit(0); }
      if (cfg.cycleCooldownMs > 0) await new Promise((res) => setTimeout(res, cfg.cycleCooldownMs));
    }
  }

  // один цикл
  const n = nextCycleNo();
  const r = await runCycle(n);
  console.log(`[qa] цикл #${n} завершён: ${r.scenarios} сценариев, +${r.newBugs} новых багов, ${r.reBugs} повторных, ${r.closed} закрыто. Открыто: ${r.openBugs}. Режим: ${r.mode}.`);
  printReport();
  await pool.end();
}

main().catch((e) => { console.error('[qa] фатальная ошибка:', e.message); process.exit(1); });
