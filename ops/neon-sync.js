#!/usr/bin/env node
/**
 * Neon data sync: PRIMARY -> BACKUP (full snapshot, dependency-free).
 *
 * Why this design:
 *  - We only have the connection STRING for primary (no Neon API key for it),
 *    and primary has wal_level=replica → logical/streaming replication is NOT
 *    available. So we keep the backup current with frequent full snapshots.
 *  - DB is small (~63 MB). A full snapshot copies in seconds.
 *  - No pg_dump / pg-copy-streams in this environment, so we copy via SQL:
 *      * every value is read with ::text cast on primary  (exact canonical form)
 *      * re-inserted with $n::<type> casts on backup       (exact round-trip)
 *    This round-trips jsonb, arrays, bytea, timestamptz, numeric, etc.
 *  - FK ordering is irrelevant: all FK constraints on backup are made
 *    DEFERRABLE and the whole load runs in ONE transaction with
 *    SET CONSTRAINTS ALL DEFERRED (handles self-refs and cycles too).
 *
 * Usage:
 *   node ops/neon-sync.js            # one snapshot
 *   node ops/neon-sync.js --quiet    # less log noise (for cron)
 *
 * Reads NEON primary from DATABASE_URL (backend/.env) and backup from
 * NEON_BACKUP_URL (own-engine/.env / workspace/.env).
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
// Пресейл-блокер #2: после пересборки схемы на backup надо ЗАНОВО навесить RLS —
// createMissingTables создаёт «голые» таблицы без политик, иначе фейловер оставляет
// backup без изоляции тенантов. Переиспользуем тот же ассерт, что и boot-time.
const { ENSURE_SQL: ENSURE_RLS_SQL } = require('../backend/lib/ensure-rls');

// ---- load env without extra deps ----
for (const p of [
  path.join(__dirname, '../backend/.env'),
  path.join(process.env.HOME, 'workspace/own-engine/.env'),
  path.join(process.env.HOME, 'workspace/.env'),
]) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch (_) {}
}

const PRIMARY_URL = process.env.DATABASE_URL;
const BACKUP_URL = process.env.NEON_BACKUP_URL;
const QUIET = process.argv.includes('--quiet');
const LOG_FILE = '/tmp/neon-sync.log';
const STATE_FILE = '/tmp/neon-sync-state.json';
const BATCH = 500;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  if (!QUIET) console.log(line);
}

// Ротация лога: держим последние 2000 строк чтобы файл не рос бесконечно
function rotateLog() {
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n');
    if (lines.length > 2500) {
      fs.writeFileSync(LOG_FILE, lines.slice(-2000).join('\n') + '\n');
    }
  } catch (_) {}
}

function newClient(url) {
  return new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, statement_timeout: 0 });
}

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

async function getBaseTables(c) {
  const r = await c.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name`);
  return r.rows.map(x => x.table_name).filter(t => t !== '_migrations');
}

async function getColumns(c, table) {
  // exact type via format_type, ordered by attnum, skip dropped/system cols.
  // Skip GENERATED-stored columns (attgenerated<>'') — they are computed by the DB.
  // Flag GENERATED-ALWAYS-AS-IDENTITY columns (attidentity='a') — need OVERRIDING SYSTEM VALUE.
  const r = await c.query(`
    SELECT a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attidentity AS identity,
           a.attnotnull AS notnull,
           pg_get_expr(ad.adbin, ad.adrelid) AS "default"
    FROM pg_attribute a
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE a.attrelid = $1::regclass
      AND a.attnum > 0 AND NOT a.attisdropped
      AND a.attgenerated = ''
    ORDER BY a.attnum`, [ '"' + table.replace(/"/g, '""') + '"' ]);
  return r.rows;
}

// Витягти імʼя послідовності з nextval('schema.seq'::regclass) → створити її на backup,
// щоб DEFAULT автонумерації працював (інакше нова таблиця = колонки без автоінкремента,
// вставка падає. Інцидент 09.07: 11 таблиць без sequence після фейловера).
async function ensureSeqForDefault(backup, def) {
  if (!def) return null;
  const m = def.match(/nextval\('([^']+)'/);
  if (!m) return null;
  let seq = m[1].replace(/::regclass$/i, '').replace(/"/g, '');
  const bare = seq.includes('.') ? seq.split('.').pop() : seq;
  try { await backup.query(`CREATE SEQUENCE IF NOT EXISTS ${ident(bare)}`); } catch (_) {}
  return bare;
}

// Build a minimal CREATE TABLE for tables present on primary but missing on backup
async function createMissingTables(primary, backup, missing) {
  for (const t of missing) {
    const cols = await getColumns(primary, t);
    // primary key columns
    const pk = await primary.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid=$1::regclass AND i.indisprimary
      ORDER BY a.attnum`, [ '"' + t.replace(/"/g, '""') + '"' ]);
    // Повний DDL: тип + DEFAULT (з автостворенням послідовності) + NOT NULL.
    // Раніше створювались "голі" колонки без defaults/автонумерації → вставка падала.
    const ownedSeqs = [];
    const colDefs = [];
    for (const c of cols) {
      let d = `${ident(c.name)} ${c.type}`;
      if (c.default) {
        const seq = await ensureSeqForDefault(backup, c.default);
        if (seq) ownedSeqs.push([seq, c.name]);
        d += ` DEFAULT ${c.default}`;
      }
      if (c.notnull) d += ' NOT NULL';
      colDefs.push(d);
    }
    if (pk.rows.length) colDefs.push(`PRIMARY KEY (${pk.rows.map(r => ident(r.attname)).join(', ')})`);
    const ddl = `CREATE TABLE IF NOT EXISTS ${ident(t)} (\n  ${colDefs.join(',\n  ')}\n)`;
    await backup.query(ddl);
    for (const [seq, col] of ownedSeqs) {
      await backup.query(`ALTER SEQUENCE ${ident(seq)} OWNED BY ${ident(t)}.${ident(col)}`).catch(() => {});
    }
    log(`created missing table on backup: ${t}`);
  }
}

// Ensure every (non-generated) column that exists on PRIMARY also exists on
// BACKUP. Prod sometimes gains columns outside migrations (runtime ALTER TABLE),
// so the migration-built backup can lag. Added as nullable — data fills them.
async function ensureColumns(primary, backup, tables) {
  let added = 0, retyped = 0;
  const bcols = async (t) => {
    const m = new Map();
    const r = await backup.query(
      `SELECT attname, format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated=''`,
      ['"' + t.replace(/"/g, '""') + '"']);
    for (const row of r.rows) m.set(row.attname, row.type);
    return m;
  };
  for (const t of tables) {
    const pCols = await getColumns(primary, t); // already skips generated cols
    const have = await bcols(t);
    for (const c of pCols) {
      if (!have.has(c.name)) {
        try {
          let add = `ALTER TABLE ${ident(t)} ADD COLUMN ${ident(c.name)} ${c.type}`;
          if (c.default) { await ensureSeqForDefault(backup, c.default); add += ` DEFAULT ${c.default}`; }
          await backup.query(add);
          log(`added missing column ${t}.${c.name} ${c.type}${c.default ? ' (with default)' : ''}`);
          added++;
        } catch (e) { log(`add col ${t}.${c.name} skip: ${e.message}`); }
      } else if (have.get(c.name) !== c.type) {
        // align backup column type to primary (tables are reloaded fully anyway)
        try {
          await backup.query(`ALTER TABLE ${ident(t)} ALTER COLUMN ${ident(c.name)} TYPE ${c.type} USING ${ident(c.name)}::${c.type}`);
          log(`retyped ${t}.${c.name} -> ${c.type}`);
          retyped++;
        } catch (e) { log(`retype ${t}.${c.name} skip: ${e.message}`); }
      }
    }
  }
  if (added) log(`added ${added} missing columns on backup`);
  if (retyped) log(`retyped ${retyped} columns on backup`);
}

// Make FK / unique / exclusion constraints deferrable so a full reload in one
// transaction is order-independent and tolerates primary's deferred state.
// (idempotent; only alters constraints not yet deferrable)
async function makeFKsDeferrable(backup) {
  const r = await backup.query(`
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
    WHERE contype IN ('f','u','x') AND NOT condeferrable AND conrelid <> 0`);
  for (const row of r.rows) {
    try {
      await backup.query(`ALTER TABLE ${row.tbl} ALTER CONSTRAINT ${ident(row.conname)} DEFERRABLE INITIALLY IMMEDIATE`);
    } catch (e) { log(`defer ${row.tbl}.${row.conname} skip: ${e.message}`); }
  }
  if (r.rows.length) log(`made ${r.rows.length} constraints deferrable`);
}

// Drop non-FK constraints (exclusion/unique/check) that exist on BACKUP but not
// on PRIMARY. Primary is the source of truth; if prod never created/validated a
// constraint, its data can violate the migration-created one on backup and block
// the reload. FKs are not dropped — they are deferred instead.
// Also reconciles PRIMARY KEY definitions — if migration changed PK columns (e.g.
// categories from (id) to (tenant_id,id)), backup's old PK must be rebuilt.
async function reconcileConstraints(primary, backup) {
  const grab = async (c) => (await c.query(
    `SELECT conrelid::regclass::text tbl, conname, contype
       FROM pg_constraint
      WHERE connamespace='public'::regnamespace AND contype IN ('x','u','c')`)).rows;
  const [P, B] = await Promise.all([grab(primary), grab(backup)]);
  const pk = new Set(P.map(x => x.tbl + '.' + x.conname));
  const drop = B.filter(x => !pk.has(x.tbl + '.' + x.conname));
  for (const d of drop) {
    try {
      await backup.query(`ALTER TABLE ${d.tbl} DROP CONSTRAINT ${ident(d.conname)}`);
      log(`dropped backup-only constraint ${d.tbl}.${d.conname} (absent on primary)`);
    } catch (e) { log(`drop ${d.tbl}.${d.conname} skip: ${e.message}`); }
  }

  // Reconcile PRIMARY KEY column sets: if primary changed PK (e.g. added tenant_id),
  // rebuild backup PK to match. FKs referencing old PK are dropped first (cascade).
  const grabPK = async (c) => (await c.query(`
    SELECT conrelid::regclass::text AS tbl, conname,
           array_agg(a.attname ORDER BY array_position(conkey, a.attnum)) AS cols
      FROM pg_constraint c2
      JOIN pg_attribute a ON a.attrelid = c2.conrelid AND a.attnum = ANY(c2.conkey)
     WHERE c2.connamespace='public'::regnamespace AND c2.contype='p'
     GROUP BY conrelid, conname`)).rows;
  const [ppk, bpk] = await Promise.all([grabPK(primary), grabPK(backup)]);
  // pg driver may return array_agg as a JS array OR as a pg literal string {a,b,c}
  const pgArr = v => Array.isArray(v) ? v : String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  const ppkMap = new Map(ppk.map(r => [r.tbl, { name: r.conname, cols: pgArr(r.cols) }]));
  for (const br of bpk) {
    const pr = ppkMap.get(br.tbl);
    if (!pr) continue; // table only on backup — skip
    const brCols = pgArr(br.cols);
    const same = pr.cols.join(',') === brCols.join(',');
    if (same) continue;
    log(`PK mismatch on ${br.tbl}: backup=(${brCols}) primary=(${pr.cols}) — rebuilding`);
    try {
      // DROP CASCADE removes dependent FKs on backup (they'll be re-synced next time)
      await backup.query(`ALTER TABLE ${br.tbl} DROP CONSTRAINT ${ident(br.conname)} CASCADE`);
      await backup.query(`ALTER TABLE ${br.tbl} ADD CONSTRAINT ${ident(pr.name)} PRIMARY KEY (${pr.cols.map(ident).join(', ')})`);
      log(`rebuilt PK ${br.tbl}.${pr.name} (${pr.cols})`);
    } catch (e) { log(`rebuild PK ${br.tbl} skip: ${e.message}`); }
  }
}

async function copyTable(primary, backup, table) {
  const cols = await getColumns(primary, table);
  if (!cols.length) return 0;
  const colNames = cols.map(c => ident(c.name));
  const selectList = cols.map(c => `${ident(c.name)}::text`).join(', ');
  const res = await primary.query(`SELECT ${selectList} FROM ${ident(table)}`);
  const rows = res.rows;
  if (!rows.length) return 0;

  const hasIdentityAlways = cols.some(c => c.identity === 'a');
  const overriding = hasIdentityAlways ? ' OVERRIDING SYSTEM VALUE' : '';
  const typeCasts = cols.map(c => c.type); // cast text->original type on insert
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map(row => {
      const ph = cols.map((c, j) => {
        params.push(row[c.name]); // text or null
        return `$${params.length}::${typeCasts[j]}`;
      });
      return `(${ph.join(',')})`;
    });
    const sql = `INSERT INTO ${ident(table)} (${colNames.join(',')})${overriding} VALUES ${tuples.join(',')}`;
    await backup.query(sql, params);
  }
  return rows.length;
}

async function fixSequences(primary, backup) {
  const seqs = await primary.query(`SELECT schemaname, sequencename, last_value FROM pg_sequences WHERE schemaname='public'`);
  let n = 0;
  for (const s of seqs.rows) {
    if (s.last_value == null) continue;
    try {
      await backup.query(`SELECT setval($1, $2, true)`, [`${s.schemaname}.${s.sequencename}`, s.last_value]);
      n++;
    } catch (e) {
      // Suppress "does not exist" — sequence on primary not yet created on backup (migration pending)
      if (!e.message.includes('does not exist')) log(`setval ${s.sequencename} skip: ${e.message}`);
    }
  }
  return n;
}

async function main() {
  rotateLog();
  if (!PRIMARY_URL || !BACKUP_URL) { log('FATAL: DATABASE_URL or NEON_BACKUP_URL missing'); process.exit(1); }
  const t0 = Date.now();
  const primary = newClient(PRIMARY_URL);
  const backup = newClient(BACKUP_URL);
  await primary.connect();
  await backup.connect();
  await primary.query(`SET extra_float_digits = 3`); // exact float text

  try {
    const [pTables, bTables] = await Promise.all([getBaseTables(primary), getBaseTables(backup)]);
    const bSet = new Set(bTables);
    const missing = pTables.filter(t => !bSet.has(t));
    if (missing.length) await createMissingTables(primary, backup, missing);

    await ensureColumns(primary, backup, pTables);
    await makeFKsDeferrable(backup);
    await reconcileConstraints(primary, backup);
    // Восстановить RLS/политики на backup (createMissingTables их не переносит).
    // Идемпотентно; без этого второй салон читал бы чужие данные после фейловера.
    try { await backup.query(ENSURE_RLS_SQL); log('RLS ensured on backup'); }
    catch (e) { log(`RLS ensure WARN: ${e.message}`); }

    const tables = pTables; // primary is source of truth
    await backup.query('BEGIN');
    await backup.query('SET CONSTRAINTS ALL DEFERRED');
    // wipe everything first (single CASCADE statement, order-independent)
    const truncList = tables.map(ident).join(', ');
    await backup.query(`TRUNCATE TABLE ${truncList} RESTART IDENTITY CASCADE`);

    let total = 0, tcount = 0;
    for (const t of tables) {
      const n = await copyTable(primary, backup, t);
      total += n; tcount++;
    }
    await backup.query('COMMIT');

    const seqN = await fixSequences(primary, backup);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(`SYNC OK: ${tcount} tables, ${total} rows, ${seqN} sequences in ${secs}s`);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ok: true, tables: tcount, rows: total, sequences: seqN, seconds: +secs, at: new Date().toISOString() }, null, 2)); } catch (_) {}
  } catch (e) {
    try { await backup.query('ROLLBACK'); } catch (_) {}
    log(`SYNC FAILED: ${e.message}`);
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ ok: false, error: e.message, at: new Date().toISOString() }, null, 2)); } catch (_) {}
    process.exitCode = 1;
  } finally {
    await primary.end().catch(() => {});
    await backup.end().catch(() => {});
  }
}

main();
