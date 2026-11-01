// Постійні витрати по нарахуванню (01.11.2026). Ничего не меняют в базе: чистые функции + чтение исходников.
//  • оренда/CRM в аналитике = сума × днів періоду в місяці / днів місяця; каса не змінюється;
//  • маржа «—» (null), якщо виручка < 1% витрат;
//  • межі періоду liveFinance — справжній київський зсув (взимку +02:00), не жорсткі +03:00.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { marginPct, fmtMargin, mergeByCategory, ACCRUAL_SQL, CASH_ONLY } = require('../lib/recurring-accrual');

test('маржа: null при виручці < 1% витрат або нулі, інакше округлений %', () => {
  assert.strictEqual(marginPct(-61530, 900, 62430), -6837); // 900 ≥ 1% від 62 430 → число; лікує саме нарахування
  assert.strictEqual(marginPct(-500, 900, 140000), null);    // 900 < 1 400 → «—»
});

test('маржа: межа 1%', () => {
  assert.strictEqual(marginPct(-100, 0, 100), null);
  assert.strictEqual(marginPct(-9999, 99, 10000), null);       // 99 < 100 (1%)
  assert.strictEqual(marginPct(-9900, 100, 10000), -9900);     // рівно 1% — показуємо
  assert.strictEqual(marginPct(103276, 316001, 212725), 33);
  assert.strictEqual(fmtMargin(null), '—');
  assert.strictEqual(fmtMargin(33), '33%');
});

test('злиття касових і нарахованих статей по категорії', () => {
  const m = mergeByCategory([{ category: 'refund', sum: 1700 }, { category: 'rent', sum: 0 }],
    [{ category: 'rent', sum: 1666.67 }, { category: 'срм', sum: 368.5 }]);
  const o = Object.fromEntries(m.map(x => [x.category, x.sum]));
  assert.deepStrictEqual(o, { refund: 1700, rent: 1666.67, 'срм': 368.5 });
});

test('SQL нарахування: частка днів місяця, без зарплат; касова частина відсікає позначені', () => {
  assert.match(ACCRUAL_SQL, /accrual_month IS NOT NULL/);
  assert.match(ACCRUAL_SQL, /EXTRACT\(DAY FROM/);
  assert.match(ACCRUAL_SQL, /NOT IN \('salary','payroll'\)/);
  assert.strictEqual(CASH_ONLY, 'accrual_month IS NULL');
});

test('аналітика бере постійні по нарахуванню, а не цілою сумою з каси', () => {
  const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(rd('lib/live-finance.js'), /AND accrual_month IS NULL/);
  assert.match(rd('lib/live-finance.js'), /q\(ACCRUAL_SQL/);
  assert.match(rd('routes/zones.js'), /accruedByCategory\(pool, from, to\)/);
  assert.match(rd('routes/financial.js'), /accruedOps\(pool/);
  assert.match(rd('routes/pnl.js'), /co\.accrual_month IS NULL/);
  // нові проводки шаблонів одразу позначені
  assert.match(rd('routes/recurring-expenses.js'), /recurring_expense_id/);
  assert.match(rd('routes/expense-confirm.js'), /accrual_month/);
});

test('liveFinance: без жорсткого +03:00 (взимку Київ UTC+2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/live-finance.js'), 'utf8');
  assert.ok(!/'\+03:00'|T00:00:00\+03:00/.test(src), 'знову зашито +03:00');
  const m = src.match(/const kyivWall = [\s\S]*?\n  };\n/);
  assert.ok(m, 'kyivWall не знайдено');
  const kyivWall = new Function(m[0] + '; return kyivWall;')();
  assert.strictEqual(new Date(kyivWall('2026-11-01')).toISOString(), '2026-10-31T22:00:00.000Z');
  assert.strictEqual(new Date(kyivWall('2026-07-15')).toISOString(), '2026-07-14T21:00:00.000Z');
  assert.strictEqual(new Date(kyivWall('2026-10-31', '23:59:59')).toISOString(), '2026-10-31T21:59:59.000Z');
});
