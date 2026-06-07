#!/usr/bin/env node
/**
 * SVS Beauty World — Apply SQL migrations to Postgres
 *
 * Usage: DATABASE_URL=postgresql://... node scripts/apply-migrations.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL env (Neon connection string).');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('Connected.');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) {
      const already = await client.query(`SELECT 1 FROM _migrations WHERE name = $1`, [f]);
      if (already.rowCount) {
        console.log(`- ${f} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      console.log(`→ Applying ${f}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(`INSERT INTO _migrations(name) VALUES($1)`, [f]);
        await client.query('COMMIT');
        console.log(`✓ ${f} applied`);
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`✗ ${f} FAILED: ${e.message}`);
        process.exit(1);
      }
    }

    const cnt = await client.query(`SELECT COUNT(*)::int FROM _migrations`);
    console.log(`\nTotal migrations applied: ${cnt.rows[0].count}`);
  } finally {
    await client.end();
  }
}

main();
