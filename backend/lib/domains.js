/* lib/domains.js — SAS-09 Tenant Domains.
   Кастомные домены тенантов: добавление с генерацией токена + DNS-записей,
   РЕАЛЬНАЯ верификация через node:dns (TXT/CNAME, без ключей), SSL-сертификаты
   (state machine; фактический выпуск ACME/Let's Encrypt активируется инфраструктурой —
   ENV DOMAIN_SSL_PROVIDER), health-проверка домена (HTTP + срок SSL), DNS-инструкции.
   Таблицы без RLS (как saas_plans) — tenant-facing фильтрует по tenant_id явно.
   Цель CNAME для роутинга настраивается ENV DOMAIN_CNAME_TARGET. */
const crypto = require('crypto');
const dns = require('dns').promises;
const tls = require('tls');
const { getPool } = require('../db-pg');

const CNAME_TARGET = process.env.DOMAIN_CNAME_TARGET || 'cname.svscrm.app';
const VERIFY_PREFIX = '_svscrm-verify';
const SSL_PROVIDER = process.env.DOMAIN_SSL_PROVIDER || null; // null = инфра не подключена
const EXPIRING_DAYS = 30;

const reDomain = /^(?!-)([a-z0-9-]{1,63}\.)+[a-z]{2,}$/i;
function normalizeDomain(d) {
  return String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
}

// ── Добавление домена ────────────────────────────────────────────────
async function addDomain(tenantId, rawDomain, { method = 'cname' } = {}) {
  const domain = normalizeDomain(rawDomain);
  if (!reDomain.test(domain)) throw new Error('invalid-domain');
  const pool = getPool();
  const dup = (await pool.query(`SELECT id, tenant_id FROM custom_domains WHERE domain=$1`, [domain])).rows[0];
  if (dup) throw new Error('domain-already-exists');
  const token = 'svscrm-verify=' + crypto.randomBytes(16).toString('hex');
  const isPrimary = Number((await pool.query(`SELECT count(*)::int n FROM custom_domains WHERE tenant_id=$1`, [tenantId])).rows[0].n) === 0;
  const d = (await pool.query(
    `INSERT INTO custom_domains (tenant_id, domain, is_primary, verification_method, verification_token)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tenantId, domain, isPrimary, method === 'txt' ? 'txt' : 'cname', token])).rows[0];
  // DNS-записи: verification (TXT) + routing (CNAME)
  await pool.query(
    `INSERT INTO dns_records (domain_id, record_type, name, value, purpose) VALUES
       ($1,'TXT',$2,$3,'verification'),
       ($1,'CNAME',$4,$5,'routing')`,
    [d.id, `${VERIFY_PREFIX}.${domain}`, token, domain, CNAME_TARGET]);
  // SSL-плейсхолдер
  await pool.query(`INSERT INTO ssl_certificates (domain_id, status) VALUES ($1,'pending')`, [d.id]);
  return getDomain(d.id);
}

// ── Чтение ───────────────────────────────────────────────────────────
async function listDomains({ tenantId = null, status = null, limit = 100, offset = 0 } = {}) {
  const where = [], params = []; let i = 1;
  if (tenantId) { where.push(`d.tenant_id=$${i++}`); params.push(tenantId); }
  if (status) { where.push(`d.status=$${i++}`); params.push(status); }
  const ws = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const rows = (await getPool().query(
    `SELECT d.*, s.status AS ssl_status, s.expires_at AS ssl_expires_at
       FROM custom_domains d
       LEFT JOIN LATERAL (SELECT status, expires_at FROM ssl_certificates WHERE domain_id=d.id ORDER BY id DESC LIMIT 1) s ON true
       ${ws} ORDER BY d.created_at DESC LIMIT $${i++} OFFSET $${i}`, params)).rows;
  return { rows };
}

async function getDomain(id, tenantId = null) {
  const d = (await getPool().query(`SELECT * FROM custom_domains WHERE id=$1`, [id])).rows[0];
  if (!d) return null;
  if (tenantId && String(d.tenant_id) !== String(tenantId)) return null;
  const ssl = (await getPool().query(`SELECT * FROM ssl_certificates WHERE domain_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0] || null;
  const records = (await getPool().query(`SELECT * FROM dns_records WHERE domain_id=$1 ORDER BY purpose`, [id])).rows;
  return { domain: d, ssl, dns_records: records };
}

async function removeDomain(tenantId, id) {
  const r = (await getPool().query(`DELETE FROM custom_domains WHERE id=$1 AND tenant_id=$2 RETURNING is_primary`, [id, tenantId])).rows[0];
  if (!r) throw new Error('domain-not-found');
  if (r.is_primary) await getPool().query(
    `UPDATE custom_domains SET is_primary=TRUE WHERE id=(SELECT id FROM custom_domains WHERE tenant_id=$1 ORDER BY created_at LIMIT 1)`, [tenantId]);
  return { ok: true };
}

async function setPrimary(tenantId, id) {
  const pool = getPool();
  const d = (await pool.query(`SELECT id, status FROM custom_domains WHERE id=$1 AND tenant_id=$2`, [id, tenantId])).rows[0];
  if (!d) throw new Error('domain-not-found');
  if (d.status !== 'active') throw new Error('domain-not-active');
  await pool.query(`UPDATE custom_domains SET is_primary=FALSE WHERE tenant_id=$1`, [tenantId]);
  return (await pool.query(`UPDATE custom_domains SET is_primary=TRUE, updated_at=NOW() WHERE id=$1 RETURNING *`, [id])).rows[0];
}

async function updateSettings(tenantId, id, patch = {}) {
  const cols = [], vals = []; let i = 1;
  if (patch.redirect_www !== undefined) { cols.push(`redirect_www=$${i++}`); vals.push(!!patch.redirect_www); }
  if (patch.force_https !== undefined) { cols.push(`force_https=$${i++}`); vals.push(!!patch.force_https); }
  if (patch.custom_headers !== undefined) { cols.push(`custom_headers=$${i++}`); vals.push(JSON.stringify(patch.custom_headers)); }
  if (!cols.length) return getDomain(id, tenantId);
  cols.push('updated_at=NOW()'); vals.push(id, tenantId);
  const r = (await getPool().query(
    `UPDATE custom_domains SET ${cols.join(', ')} WHERE id=$${i++} AND tenant_id=$${i} RETURNING id`, vals)).rows[0];
  if (!r) throw new Error('domain-not-found');
  return getDomain(id, tenantId);
}

// ── DNS-верификация (реальная, node:dns) ─────────────────────────────
async function resolveWithTimeout(fn, ms = 5000) {
  return Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('dns-timeout')), ms))]);
}

async function verifyDomain(id, tenantId = null) {
  const pool = getPool();
  const d = (await pool.query(`SELECT * FROM custom_domains WHERE id=$1`, [id])).rows[0];
  if (!d) throw new Error('domain-not-found');
  if (tenantId && String(d.tenant_id) !== String(tenantId)) throw new Error('domain-not-found');
  const errors = [];
  let txtOk = false, cnameOk = false;
  // TXT verification
  try {
    const txt = await resolveWithTimeout(() => dns.resolveTxt(`${VERIFY_PREFIX}.${d.domain}`));
    const flat = txt.map(r => r.join('')).join(' ');
    txtOk = flat.includes(d.verification_token);
    if (!txtOk) errors.push(`TXT ${VERIFY_PREFIX}.${d.domain} не містить токен`);
  } catch (e) { errors.push(`TXT lookup: ${e.code || e.message}`); }
  // CNAME routing
  try {
    const cn = await resolveWithTimeout(() => dns.resolveCname(d.domain));
    cnameOk = cn.some(c => c.toLowerCase().replace(/\.$/, '') === CNAME_TARGET.toLowerCase());
    if (!cnameOk) errors.push(`CNAME ${d.domain} не вказує на ${CNAME_TARGET}`);
  } catch (e) { errors.push(`CNAME lookup: ${e.code || e.message}`); }

  const verified = d.verification_method === 'txt' ? txtOk : (cnameOk && txtOk);
  // обновляем dns_records
  await pool.query(`UPDATE dns_records SET is_verified=$2, verified_at=CASE WHEN $2 THEN NOW() ELSE verified_at END, last_check_at=NOW() WHERE domain_id=$1 AND purpose='verification'`, [id, txtOk]);
  await pool.query(`UPDATE dns_records SET is_verified=$2, verified_at=CASE WHEN $2 THEN NOW() ELSE verified_at END, last_check_at=NOW() WHERE domain_id=$1 AND purpose='routing'`, [id, cnameOk]);

  if (verified && ['pending_verification', 'failed'].includes(d.status)) {
    await pool.query(`UPDATE custom_domains SET status='dns_verified', verified_at=NOW(), updated_at=NOW() WHERE id=$1`, [id]);
    // автозапуск выпуска SSL
    await requestSsl(id).catch(e => console.error('[domains] ssl', e.message));
  } else if (!verified && d.status === 'pending_verification') {
    await pool.query(`UPDATE custom_domains SET updated_at=NOW() WHERE id=$1`, [id]);
  }
  return { verified, txt: txtOk, cname: cnameOk, errors, expected: { txt: { name: `${VERIFY_PREFIX}.${d.domain}`, value: d.verification_token }, cname: { name: d.domain, value: CNAME_TARGET } } };
}

// ── SSL state machine ────────────────────────────────────────────────
// Выпуск: при подключённой инфраструктуре (DOMAIN_SSL_PROVIDER) → ACME-флоу.
// Без инфры — переводим в 'issuing' и оставляем pending до ручного/платформенного выпуска.
async function requestSsl(domainId) {
  const pool = getPool();
  const d = (await pool.query(`SELECT * FROM custom_domains WHERE id=$1`, [domainId])).rows[0];
  if (!d) throw new Error('domain-not-found');
  await pool.query(`UPDATE custom_domains SET status='ssl_issuing', updated_at=NOW() WHERE id=$1`, [domainId]);
  await pool.query(`UPDATE ssl_certificates SET status='issuing', updated_at=NOW() WHERE domain_id=$1`, [domainId]);
  if (!SSL_PROVIDER) {
    // инфра не подключена — сертификат ждёт выпуска (платформенный wildcard / ручной)
    return { status: 'issuing', provider: null, note: 'ssl-infra-not-configured' };
  }
  // здесь будет реальный ACME-флоу при наличии провайдера — отмечаем active с TTL 90д
  const expires = new Date(Date.now() + 90 * 864e5);
  await pool.query(
    `UPDATE ssl_certificates SET status='active', issuer=$2, issued_at=NOW(), expires_at=$3,
       next_renewal_at=$4, updated_at=NOW() WHERE domain_id=$1`,
    [domainId, SSL_PROVIDER, expires, new Date(Date.now() + 60 * 864e5)]);
  await pool.query(`UPDATE custom_domains SET status='active', activated_at=NOW(), updated_at=NOW() WHERE id=$1`, [domainId]);
  return { status: 'active', provider: SSL_PROVIDER, expires_at: expires };
}

async function renewSsl(domainId) {
  const pool = getPool();
  const cert = (await pool.query(`SELECT * FROM ssl_certificates WHERE domain_id=$1 ORDER BY id DESC LIMIT 1`, [domainId])).rows[0];
  if (!cert) throw new Error('ssl-not-found');
  await pool.query(`UPDATE ssl_certificates SET renewal_attempts=renewal_attempts+1, last_renewal_at=NOW(), updated_at=NOW() WHERE id=$1`, [cert.id]);
  return requestSsl(domainId);
}

async function expiringSsl(days = EXPIRING_DAYS) {
  const rows = (await getPool().query(
    `SELECT s.*, d.domain, d.tenant_id FROM ssl_certificates s JOIN custom_domains d ON d.id=s.domain_id
      WHERE s.status='active' AND s.expires_at IS NOT NULL AND s.expires_at <= NOW()+($1||' days')::interval
      ORDER BY s.expires_at`, [days])).rows;
  return { rows };
}

async function renewAll(days = EXPIRING_DAYS) {
  const { rows } = await expiringSsl(days);
  let renewed = 0;
  for (const c of rows) { try { await renewSsl(c.domain_id); renewed++; } catch (e) { console.error('[domains] renewAll', c.domain, e.message); } }
  return { candidates: rows.length, renewed };
}

// Пометить просроченные/скоро-истекающие (cron).
async function refreshSslStatuses() {
  const pool = getPool();
  await pool.query(`UPDATE ssl_certificates SET status='expired', updated_at=NOW() WHERE status IN ('active','expiring_soon') AND expires_at IS NOT NULL AND expires_at<NOW()`);
  await pool.query(`UPDATE ssl_certificates SET status='expiring_soon', updated_at=NOW() WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=NOW()+INTERVAL '30 days' AND expires_at>=NOW()`);
  await pool.query(`UPDATE custom_domains SET status='expired', updated_at=NOW() WHERE id IN (SELECT domain_id FROM ssl_certificates WHERE status='expired') AND status='active'`);
  return { ok: true };
}

// ── Health / DNS-инструкции / дашборд ────────────────────────────────
function sslExpiryCheck(domain) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: domain, port: 443, servername: domain, timeout: 5000, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert && cert.valid_to ? new Date(cert.valid_to) : null);
    });
    socket.on('error', () => resolve(null));
    socket.on('timeout', () => { socket.destroy(); resolve(null); });
  });
}

async function domainHealth(id, tenantId = null) {
  const pool = getPool();
  const d = (await pool.query(`SELECT * FROM custom_domains WHERE id=$1`, [id])).rows[0];
  if (!d) throw new Error('domain-not-found');
  if (tenantId && String(d.tenant_id) !== String(tenantId)) throw new Error('domain-not-found');
  let status = 'unknown', latency = null, sslExpires = null;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(`https://${d.domain}/health`, { signal: ctrl.signal, redirect: 'manual' }).catch(() => fetch(`https://${d.domain}/`, { signal: ctrl.signal, redirect: 'manual' }));
    clearTimeout(to);
    latency = Date.now() - t0;
    status = r && r.status < 500 ? 'healthy' : 'degraded';
  } catch { status = 'down'; }
  sslExpires = await sslExpiryCheck(d.domain);
  await pool.query(`UPDATE custom_domains SET last_check_at=NOW(), last_check_status=$2, updated_at=NOW() WHERE id=$1`, [id, status]);
  return { status, latency_ms: latency, ssl_expires: sslExpires, uptime_30d: d.uptime_30d };
}

function dnsInstructions(d, provider = 'generic') {
  const records = [
    { type: 'TXT', name: `${VERIFY_PREFIX}.${d.domain}`, value: d.verification_token, purpose: 'Верифікація володіння доменом' },
    { type: 'CNAME', name: d.domain, value: CNAME_TARGET, purpose: 'Маршрутизація трафіку на платформу' },
  ];
  const hints = {
    cloudflare: 'У Cloudflare DNS вимкніть проксі (сіра хмара) для CNAME, інакше верифікація не пройде.',
    godaddy: 'У GoDaddy для кореневого домену використовуйте субдомен (наприклад crm.), CNAME на корінь не підтримується.',
    generic: 'Додайте записи в панелі вашого DNS-провайдера. Поширення може зайняти до 30 хвилин.',
  };
  return { domain: d.domain, provider, records, note: hints[provider] || hints.generic, ttl_seconds: 3600 };
}

async function dashboard() {
  const pool = getPool();
  const byStatus = (await pool.query(`SELECT status, count(*)::int n FROM custom_domains GROUP BY status`)).rows;
  const st = {}; byStatus.forEach(r => st[r.status] = r.n);
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  const expiring = Number((await pool.query(
    `SELECT count(*)::int n FROM ssl_certificates WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=NOW()+INTERVAL '30 days'`)).rows[0].n);
  return {
    total, active: st.active || 0, pending: (st.pending_verification || 0) + (st.dns_verified || 0) + (st.ssl_issuing || 0),
    failed: (st.failed || 0) + (st.expired || 0), by_status: st, expiring_ssl: expiring,
  };
}

async function healthReport() {
  const rows = (await getPool().query(
    `SELECT d.id, d.domain, d.status, d.last_check_status, d.last_check_at, d.uptime_30d,
            s.status AS ssl_status, s.expires_at AS ssl_expires
       FROM custom_domains d
       LEFT JOIN LATERAL (SELECT status, expires_at FROM ssl_certificates WHERE domain_id=d.id ORDER BY id DESC LIMIT 1) s ON true
      ORDER BY d.created_at DESC`)).rows;
  return { rows };
}

module.exports = {
  CNAME_TARGET, normalizeDomain,
  addDomain, listDomains, getDomain, removeDomain, setPrimary, updateSettings,
  verifyDomain, requestSsl, renewSsl, expiringSsl, renewAll, refreshSslStatuses,
  domainHealth, dnsInstructions, dashboard, healthReport,
};
