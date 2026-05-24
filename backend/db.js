/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Database (SQLite)
   ═══════════════════════════════════════════════════════ */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'shop.db'));

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ── Create tables ──────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    phone       TEXT UNIQUE,
    email       TEXT UNIQUE,
    name        TEXT,
    role        TEXT DEFAULT 'user',   -- 'user' | 'master'
    provider    TEXT DEFAULT 'phone',  -- 'phone' | 'google' | 'facebook' | 'apple'
    provider_id TEXT,
    avatar      TEXT,
    approved    INTEGER DEFAULT 0,     -- masters need approval
    created_at  TEXT DEFAULT (datetime('now')),
    last_login  TEXT
  );

  CREATE TABLE IF NOT EXISTS sms_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL,
    code       TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used       INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER,
    items          TEXT NOT NULL,  -- JSON
    total          REAL NOT NULL,
    wholesale_total REAL,
    status         TEXT DEFAULT 'pending',
    stripe_id      TEXT,
    delivery       TEXT,           -- JSON: {name, phone, address, city}
    created_at     TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    token      TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

module.exports = db;
