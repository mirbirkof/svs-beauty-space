// Финансовые тесты — сеть безопасности ПЕРЕД унификацией расчётов.
// Фиксируют контракт эталона lib/live-finance.js + защиту денег (идемпотентность кассы).
// Идемпотентность пишет в БД ТОЛЬКО внутри транзакции с ROLLBACK — данные не остаются.
// Запуск: node --test -r dotenv/config test/finance.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const { liveFinance } = require('../lib/live-finance');

let db;
before(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

const monthFrom = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const monthTo = () => new Date().toISOString().slice(0, 10);

test('live-finance: выручка = услуги + товары (нет рассинхрона внутри эталона)', async () => {
  const f = await liveFinance(db, monthFrom(), monthTo());
  assert.ok(Number.isFinite(f.revenue.total), 'revenue.total конечно');
  assert.strictEqual(
    Math.round(f.revenue.total),
    Math.round(f.revenue.services + f.revenue.products),
    'итог выручки должен равняться услуги+товары'
  );
});

test('live-finance: прибыль = выручка − расходы (инвариант)', async () => {
  const f = await liveFinance(db, monthFrom(), monthTo());
  assert.strictEqual(
    Math.round(f.profit.net),
    Math.round(f.revenue.total - f.expenses.total),
    'profit.net = revenue.total - expenses.total'
  );
});

test('live-finance: все числа валидны и неотрицательная выручка', async () => {
  const f = await liveFinance(db, monthFrom(), monthTo());
  for (const v of [f.revenue.total, f.expenses.total, f.profit.net, f.tx_count, f.avg_check]) {
    assert.ok(Number.isFinite(v), `число валидно: ${v}`);
  }
  assert.ok(f.revenue.total >= 0, 'выручка не отрицательна');
});

test('касса: защита от двойного зачисления (UNIQUE ext_ref) реально в БД', async () => {
  const idx = await db.query(
    `SELECT 1 FROM pg_indexes WHERE tablename='cash_operations' AND indexdef ILIKE '%ext_ref%' AND indexdef ILIKE '%UNIQUE%'`
  );
  assert.ok(idx.rowCount > 0, 'должен существовать UNIQUE-индекс на ext_ref — иначе двойное зачисление платежа');
});

test('касса: повторный ext_ref не создаёт дубль (идемпотентность, в ROLLBACK)', async () => {
  const ref = 'test:jarvis:idempotency:DO_NOT_KEEP';
  await db.query('BEGIN');
  try {
    const ins = `INSERT INTO cash_operations (type, category, amount, method, ext_ref)
                 VALUES ('in','sale_service',100,'cash',$1)
                 ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING`;
    await db.query(ins, [ref]);
    await db.query(ins, [ref]); // повтор (как вебхук + поллинг)
    const cnt = await db.query(`SELECT count(*)::int n FROM cash_operations WHERE ext_ref=$1`, [ref]);
    assert.strictEqual(cnt.rows[0].n, 1, 'один платёж = одна запись, дубля нет');
  } finally {
    await db.query('ROLLBACK'); // тестовые данные НЕ остаются в проде
  }
});

test('безопасность: RLS включён на ключевых таблицах', async () => {
  const r = await db.query(
    `SELECT relname, relrowsecurity FROM pg_class
      WHERE relname IN ('appointments','clients','cash_operations') AND relkind='r'`
  );
  for (const row of r.rows) {
    assert.strictEqual(row.relrowsecurity, true, `RLS должен быть включён на ${row.relname}`);
  }
});
