// Живой тест изоляции салонов (RLS) — не чтение кода, а реальная проверка базы:
// два тенанта, по клиенту каждому, под ролью app_tenant каждый видит ТОЛЬКО своего.
// Всё в транзакции с ROLLBACK — тестовые данные в базе НЕ остаются.
// Запуск: node --test -r dotenv/config test/rls-isolation.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

let db;
before(async () => { db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }); await db.connect(); });
after(async () => { if (db) await db.end(); });

test('RLS: два салона видят только своих клиентов (живой тест под app_tenant)', async () => {
  await db.query('BEGIN');
  try {
    const ts = Date.now();
    const A = (await db.query(`INSERT INTO tenants(name,slug,status,plan) VALUES('QA-A','qa-a-${ts}','active','free') RETURNING id`)).rows[0].id;
    const B = (await db.query(`INSERT INTO tenants(name,slug,status,plan) VALUES('QA-B','qa-b-${ts}','active','free') RETURNING id`)).rows[0].id;
    await db.query(`SELECT set_config('app.tenant_id',$1,true)`, [A]);
    await db.query(`INSERT INTO clients(name,phone,tenant_id) VALUES('CA','380001110001',$1)`, [A]);
    await db.query(`SELECT set_config('app.tenant_id',$1,true)`, [B]);
    await db.query(`INSERT INTO clients(name,phone,tenant_id) VALUES('CB','380002220002',$1)`, [B]);

    // под реальной ролью приложения (не суперюзер) RLS должна отфильтровать
    await db.query('SET LOCAL ROLE app_tenant');
    await db.query(`SELECT set_config('app.tenant_id',$1,true)`, [A]);
    const fromA = await db.query(`SELECT name FROM clients WHERE phone IN ('380001110001','380002220002')`);
    await db.query(`SELECT set_config('app.tenant_id',$1,true)`, [B]);
    const fromB = await db.query(`SELECT name FROM clients WHERE phone IN ('380001110001','380002220002')`);
    await db.query('RESET ROLE');

    assert.strictEqual(fromA.rows.length, 1, 'салон A видит ровно 1 клиента');
    assert.strictEqual(fromA.rows[0].name, 'CA', 'салон A видит ТОЛЬКО своего клиента');
    assert.strictEqual(fromB.rows.length, 1, 'салон B видит ровно 1 клиента');
    assert.strictEqual(fromB.rows[0].name, 'CB', 'салон B видит ТОЛЬКО своего клиента');
  } finally {
    await db.query('ROLLBACK'); // тестовые данные не остаются
  }
});
