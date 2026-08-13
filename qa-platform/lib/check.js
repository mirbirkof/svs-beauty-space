/* lib/check.js — ЧЕСТНОСТЬ ПРОВЕРОК.
 *
 * ПРИЧИНА (13.08, разнос Босса). По всем тестерам был один узор:
 *   const n = await q(SQL).catch(() => [{ n: 0 }]);
 *   coverage.push(['finance', 'no-orphan-payments', n[0].n === 0]);
 * Запрос падает (нет таблицы, таймаут, разрыв пула) → подставляется 0 → отчёт пишет
 * «сирот нет, проверено». То есть чем ХУЖЕ состояние системы, тем ЗЕЛЕНЕЕ отчёт.
 * Полгода такие проверки могли не выполняться ни разу, и никто бы не узнал.
 *
 * ЗАКОН: проверка, которая не выполнилась, НЕ считается пройденной. Она попадает в отчёт
 * как «не проверено» + находка, требующая ручного разбора. Тишина запрещена.
 *
 * Использование:
 *   const { counted, record } = require('../lib/check');
 *   const r = await counted(q(`SELECT COUNT(*)::int n FROM ...`));
 *   if (record(coverage, bugs, 'finance', 'no-orphan-payments', r) && r.n > 0) bugs.push({...});
 */

/** Выполнить запрос-счётчик. Никогда не выдумывает 0 при сбое. */
async function counted(promise) {
  try {
    const rows = await promise;
    const n = Number((rows && rows[0] && rows[0].n) || 0);
    return { ok: true, n };
  } catch (e) {
    return { ok: false, n: null, err: e && e.message ? e.message : String(e) };
  }
}

/** Выполнить произвольную проверку, вернуть {ok,value} без подмены результата при сбое. */
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; }
  catch (e) { return { ok: false, value: null, err: e && e.message ? e.message : String(e) }; }
}

/**
 * Записать итог проверки. Возвращает true, только если проверка РЕАЛЬНО отработала.
 * res: результат counted()/attempt(). passed: чем считать успех (по умолчанию n === 0).
 */
function record(coverage, bugs, module, key, res, opts = {}) {
  if (!res || res.ok !== true) {
    coverage.push([module, `${key}:не-проверено`, false]);
    bugs.push({
      severity: opts.severity || 'low', module, role: opts.role || 'system',
      title: `Проверка «${key}» НЕ выполнена — результат неизвестен`,
      scenario: opts.scenario || key,
      expected: 'проверка отрабатывает и даёт ответ',
      actual: `сбой: ${(res && res.err) || 'неизвестная причина'}`,
      needsManual: true,
      manualReason: 'Проверка не выполнилась. Раньше такой сбой молча превращался в «ок».',
    });
    return false;
  }
  const passed = typeof opts.passed === 'boolean' ? opts.passed : res.n === 0;
  coverage.push([module, key, passed]);
  return true;
}

/** Явная отметка «проверка пропущена» — для блоков за условием (нет staging, regression и т.п.). */
function skipped(coverage, bugs, module, key, reason, opts = {}) {
  coverage.push([module, `${key}:пропущено`, false]);
  bugs.push({
    severity: opts.severity || 'low', module, role: opts.role || 'system',
    title: `Проверка «${key}» пропущена`, scenario: key,
    expected: 'проверка выполняется', actual: reason,
    needsManual: true, manualReason: reason,
  });
}

module.exports = { counted, attempt, record, skipped };
