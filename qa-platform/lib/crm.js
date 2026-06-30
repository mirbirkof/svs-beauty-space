/* Клиент к CRM: HTTP (admin-токен) + прямой доступ к БД для верификации.
   Все агенты ходят сюда — единая точка, единый способ собирать доказательства (логи запросов). */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const cfg = require('../config');
const { getPool } = require('../../backend/db-pg');
// pg резолвим из backend/node_modules (в qa-platform своего node_modules нет).
const { Pool } = require(require.resolve('pg', { paths: [require('path').join(__dirname, '../../backend/node_modules')] }));

const pool = getPool(); // ПРОД — только чтение (read-only сверки)

// Изолированная QA-ветка для деструктивных тестов (запись/нагрузка/мутации). Создаётся лениво.
let _qaPool = null;
function qaPool() {
  if (!cfg.qaDbUrl) return null;
  if (!_qaPool) _qaPool = new Pool({ connectionString: cfg.qaDbUrl, ssl: { rejectUnauthorized: false }, max: 4 });
  return _qaPool;
}
// qaQ — запросы ТОЛЬКО к QA-ветке. Если ветки нет — бросаем (деструктив запрещён без изоляции).
const qaQ = (sql, params = []) => {
  const p = qaPool();
  if (!p) throw new Error('QA branch not configured — деструктив запрещён');
  return p.query(sql, params).then((r) => r.rows);
};

// HTTP-запрос к CRM API. Возвращает {status, json, ms, raw} — всё для доказательства бага.
function apiRaw(method, path, { body, token, base } = {}) {
  const url = new URL((base || cfg.apiBase) + path);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Accept: 'application/json' };
  if (payload) headers['Content-Type'] = 'application/json';
  const t = token === null ? null : (token || cfg.adminToken);
  if (t) headers['X-Admin-Token'] = t;
  const started = Date.now();
  return new Promise((resolve) => {
    const req = lib.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 20000 }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json, ms: Date.now() - started, raw: buf.slice(0, 2000), method, path });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, ms: Date.now() - started, error: e.message, method, path }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, ms: Date.now() - started, error: 'timeout', method, path }); });
    if (payload) req.write(payload);
    req.end();
  });
}

const api = (m, p, o) => apiRaw(m, p, o);
const q = (sql, params = []) => pool.query(sql, params).then((r) => r.rows);

module.exports = { api, apiRaw, q, pool, qaQ, qaPool };
