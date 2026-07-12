/* ═══════════════════════════════════════════════════════
   INT-07 — Mobile App API
   Префикс: /api/mobile  (монтируется в shop-api.js)

   Модули по спеке:
   07.01 Auth & Security     — login, biometric, refresh, logout, device reg
   07.02 Schedule & Appts    — расписание, CRUD записей, смена статуса
   07.03 Client Card         — поиск, карточка, заметки
   07.04 Cashbox & Payments  — приём оплаты
   07.05 Offline & Sync      — push/pull синхронизация

   Дополнительно:
   - Загрузка фото before/after (делегируем /api/files/upload)
   - Регистрация push-токена
   - Проверка версии приложения
   - Управление устройствами (admin)

   Всё работает через существующий пул (getPool) и requirePerm/logAction
   из rbac, не дублируя бизнес-логику других роутов.
   ═══════════════════════════════════════════════════════ */
'use strict';

const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');

// РАУНД3-m1: часовой пояс салона БЕЗ хардкода +03:00 (зимой Киев = +02, был сдвиг на час).
// Интерпретирует "YYYY-MM-DD" + "HH:mm" как локальное время Europe/Kyiv в любой сезон.
function kyivToUtcIso(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' })
    .formatToParts(guess).find(p => p.type === 'timeZoneName').value; // напр. "GMT+02:00"
  const m = tzName.match(/([+-])(\d{2}):?(\d{2})/);
  const offMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 180;
  return new Date(guess.getTime() - offMin * 60000).toISOString();
}
const { requirePerm, logAction } = require('../lib/rbac');
const {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  refreshTtlMs,
  verifyPassword,
  sha256,
  deviceLabelFromUA,
  clientIp,
} = require('../lib/auth-core');

// ── helpers ──────────────────────────────────────────────

function err500(res, e) {
  console.error('[mobile]', e);
  return res.status(500).json({
    error: process.env.NODE_ENV === 'production' ? 'internal' : e.message,
  });
}

// Middleware: проверяет JWT access-токен из Authorization: Bearer <token>
// Ставит req.user = { id, role, permissions, branch_id, ... }
async function mobileAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'no-token' });
    const payload = verifyAccessToken(m[1]);
    if (!payload) return res.status(401).json({ error: 'invalid-token' });

    const pool = getPool();
    const r = await pool.query(
      `SELECT u.id, u.display_name, u.email, u.branch_id, u.master_id, u.is_active,
              r.code AS role, r.permissions, r.level AS role_level
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.is_active = TRUE LIMIT 1`,
      [payload.sub]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'user-not-found' });

    // Проверяем что сессия не отозвана
    if (payload.sid) {
      const s = await pool.query(
        `SELECT id FROM user_sessions
          WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at > NOW()`,
        [payload.sid, r.rows[0].id]
      );
      if (!s.rows[0]) return res.status(401).json({ error: 'session-revoked' });
    }

    req.user = r.rows[0];
    req.sessionId = payload.sid || null;
    next();
  } catch (e) {
    return err500(res, e);
  }
}

// Проверка конкретного права (после mobileAuth)
function needPerm(perm) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (perms.includes('*') || perms.includes(perm)) return next();
    const area = perm.split('.')[0];
    if (perms.includes(`${area}.*`)) return next();
    return res.status(403).json({ error: 'forbidden', need: perm });
  };
}

// Логирование действия в mobile_activity_log (fire-and-forget)
async function mobileLog(pool, { employeeId, deviceId, action, details, ip }) {
  try {
    await pool.query(
      `INSERT INTO mobile_activity_log (employee_id, device_id, action, details, ip_address)
       VALUES ($1, $2, $3, $4, $5::inet)`,
      [employeeId, deviceId || null, action, details ? JSON.stringify(details) : null, ip || null]
    );
  } catch (_) { /* non-critical */ }
}

// Регистрация / обновление записи об устройстве
async function upsertDevice(pool, { userId, deviceId, deviceName, platform, osVersion, appVersion }) {
  const r = await pool.query(
    `INSERT INTO mobile_devices (employee_id, device_id, device_name, platform, os_version, app_version, last_active_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (tenant_id, employee_id, device_id) DO UPDATE
       SET device_name=EXCLUDED.device_name,
           os_version=EXCLUDED.os_version,
           app_version=EXCLUDED.app_version,
           last_active_at=NOW(),
           updated_at=NOW()
     RETURNING id`,
    [userId, deviceId, deviceName || null, platform, osVersion || null, appVersion]
  );
  return r.rows[0]?.id || null;
}

// ════════════════════════════════════════════════════════════
// 07.01 — AUTH
// ════════════════════════════════════════════════════════════

// POST /api/mobile/auth/login
// Body: { email, password, device_id, device_name, platform, os_version, app_version }
router.post('/auth/login', async (req, res) => {
  try {
    const pool = getPool();
    const { email, password, device_id, device_name, platform, os_version, app_version } = req.body || {};

    if (!email || !password) return res.status(400).json({ error: 'email+password required' });
    if (!device_id || !platform) return res.status(400).json({ error: 'device_id+platform required' });
    if (!['ios', 'android'].includes(platform)) return res.status(400).json({ error: 'platform must be ios|android' });

    // Поиск пользователя по email
    const r = await pool.query(
      `SELECT u.id, u.display_name, u.email, u.password_hash, u.branch_id, u.master_id,
              u.is_active, r.code AS role, r.permissions, r.level AS role_level
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE LOWER(u.email) = LOWER($1) LIMIT 1`,
      [String(email).trim()]
    );
    const user = r.rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'invalid-credentials' });

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid-credentials' });

    // Регистрация/обновление устройства
    const appVer = String(app_version || '0.0.0');
    const mdevId = await upsertDevice(pool, {
      userId: user.id, deviceId: device_id, deviceName: device_name,
      platform, osVersion: os_version, appVersion: appVer,
    });

    // Выдача сессии (refresh token → user_sessions)
    const refreshToken = generateRefreshToken();
    const refreshHash = sha256(refreshToken);
    const ttlMs = refreshTtlMs(true); // mobile = remember me
    const expiresAt = new Date(Date.now() + ttlMs);
    const ua = deviceLabelFromUA(req.headers['user-agent'] || `${platform} mobile`);
    const sess = await pool.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, device_label, ip, remember_me, expires_at)
       VALUES ($1,$2,$3,$4,TRUE,$5) RETURNING id`,
      [user.id, refreshHash, ua, clientIp(req), expiresAt]
    );
    const accessToken = signAccessToken({ sub: user.id, role: user.role, sid: sess.rows[0].id });

    await mobileLog(pool, { employeeId: user.id, deviceId: mdevId, action: 'login', ip: clientIp(req) });
    logAction({ user, action: 'mobile.login', entity: 'users', entity_id: user.id, ip: clientIp(req), meta: { platform } });

    return res.json({
      ok: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      device_id: mdevId,
      employee: {
        id: user.id,
        name: user.display_name,
        email: user.email,
        role: user.role,
        branch_id: user.branch_id,
        master_id: user.master_id,
        permissions: user.permissions,
      },
    });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/auth/biometric
// Body: { device_id, biometric_token }
// Упрощённая реализация: biometric_token = хэш сессии устройства (верифицируется по device record)
router.post('/auth/biometric', async (req, res) => {
  try {
    const pool = getPool();
    const { device_id, biometric_token } = req.body || {};
    if (!device_id || !biometric_token) return res.status(400).json({ error: 'device_id+biometric_token required' });

    // Находим устройство
    const d = await pool.query(
      `SELECT md.*, u.id AS uid, u.display_name, u.email, u.branch_id, u.is_active,
              r.code AS role, r.permissions
         FROM mobile_devices md
         JOIN users u ON u.id::text = md.employee_id::text
         JOIN roles r ON r.id = u.role_id
        WHERE md.device_id = $1 AND md.status = 'active' AND md.biometric_enabled = true LIMIT 1`,
      [device_id]
    );
    const dev = d.rows[0];
    if (!dev) return res.status(401).json({ error: 'device-not-found-or-biometric-disabled' });
    if (!dev.is_active) return res.status(401).json({ error: 'user-inactive' });

    // В продакшене здесь должна быть верификация biometric_token через Keychain/Keystore challenge
    // Упрощённо: biometric_token = SHA256(device_id + employee_id), статическая проверка устройства
    const expected = sha256(`${device_id}:${dev.employee_id}`);
    if (biometric_token !== expected) return res.status(401).json({ error: 'biometric-invalid' });

    const refreshToken = generateRefreshToken();
    const refreshHash = sha256(refreshToken);
    const ttlMs = refreshTtlMs(true);
    const expiresAt = new Date(Date.now() + ttlMs);
    const sess = await pool.query(
      `INSERT INTO user_sessions (user_id, refresh_token_hash, device_label, ip, remember_me, expires_at)
       VALUES ($1,$2,'biometric',$3,TRUE,$4) RETURNING id`,
      [dev.uid, refreshHash, clientIp(req), expiresAt]
    );
    const accessToken = signAccessToken({ sub: dev.uid, role: dev.role, sid: sess.rows[0].id });

    await pool.query(`UPDATE mobile_devices SET last_active_at=NOW(), updated_at=NOW() WHERE id=$1`, [dev.id]);
    await mobileLog(pool, { employeeId: dev.uid, deviceId: dev.id, action: 'biometric_unlock', ip: clientIp(req) });

    return res.json({ ok: true, access_token: accessToken, refresh_token: refreshToken });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/auth/refresh
// Body: { refresh_token }
router.post('/auth/refresh', async (req, res) => {
  try {
    const pool = getPool();
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

    const hash = sha256(refresh_token);
    const s = await pool.query(
      `SELECT s.id, s.user_id, u.is_active, r.code AS role, r.permissions
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.refresh_token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at > NOW() LIMIT 1`,
      [hash]
    );
    const sess = s.rows[0];
    if (!sess || !sess.is_active) return res.status(401).json({ error: 'invalid-refresh-token' });

    // Rotate refresh token
    const newRefresh = generateRefreshToken();
    const newHash = sha256(newRefresh);
    const ttlMs = refreshTtlMs(true);
    const expiresAt = new Date(Date.now() + ttlMs);
    await pool.query(
      `UPDATE user_sessions SET refresh_token_hash=$1, expires_at=$2, last_used=NOW() WHERE id=$3`,
      [newHash, expiresAt, sess.id]
    );
    const accessToken = signAccessToken({ sub: sess.user_id, role: sess.role, sid: sess.id });

    return res.json({ ok: true, access_token: accessToken, refresh_token: newRefresh });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/auth/logout
router.post('/auth/logout', mobileAuth, async (req, res) => {
  try {
    const pool = getPool();
    if (req.sessionId) {
      await pool.query(`UPDATE user_sessions SET revoked_at=NOW() WHERE id=$1`, [req.sessionId]);
    }
    logAction({ user: req.user, action: 'mobile.logout', entity: 'users', entity_id: req.user.id, ip: clientIp(req) });
    return res.json({ ok: true });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// 07.02 — SCHEDULE & APPOINTMENTS
// ════════════════════════════════════════════════════════════

// GET /api/mobile/schedule
// Query: ?date=2026-06-15&view=day|week&employee_id=&branch_id=
router.get('/schedule', mobileAuth, needPerm('mobile.schedule.read'), async (req, res) => {
  try {
    const pool = getPool();
    const { date, view = 'day', employee_id, branch_id } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    const params = [];
    const conditions = [];

    if (view === 'week') {
      // Неделя: от Monday до Sunday включительно
      conditions.push(`(a.starts_at AT TIME ZONE 'Europe/Kyiv')::date
        BETWEEN $${params.length + 1}::date AND $${params.length + 1}::date + interval '6 days'`);
      params.push(targetDate);
    } else {
      conditions.push(`(a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = $${params.length + 1}::date`);
      params.push(targetDate);
    }

    // Мастер видит только своё расписание
    if (req.user.role === 'master' && req.user.master_id) {
      conditions.push(`a.master_id = $${params.length + 1}`);
      params.push(req.user.master_id);
    } else if (employee_id) {
      conditions.push(`a.master_id = $${params.length + 1}`);
      params.push(parseInt(employee_id, 10));
    }
    if (branch_id) {
      conditions.push(`a.branch_id = $${params.length + 1}`);
      params.push(parseInt(branch_id, 10));
    }
    // Исключаем удалённые
    conditions.push(`COALESCE(a.status,'') != 'deleted'`);

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(
      `SELECT a.id,
              to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv', 'HH24:MI') AS time,
              (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date AS date,
              COALESCE(a.duration_min, 60) AS duration,
              a.status,
              a.price,
              a.services_text,
              a.notes,
              COALESCE(a.client_name, c.name) AS client_name,
              c.phone AS client_phone,
              c.id AS client_id,
              m.name AS master_name,
              m.id AS master_id,
              m.avatar AS master_avatar
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN masters m ON m.id = a.master_id
         ${where}
         ORDER BY a.starts_at`,
      params
    );

    return res.json({ ok: true, date: targetDate, view, appointments: r.rows });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/appointments
// Body: { client_id, service_id, employee_id, date, time, notes? }
router.post('/appointments', mobileAuth, needPerm('mobile.appointments.create'), async (req, res) => {
  try {
    const pool = getPool();
    const { client_id, service_id, employee_id, date, time, notes } = req.body || {};
    if (!date || !time) return res.status(400).json({ error: 'date+time required' });

    // Собираем информацию об услуге и клиенте
    let serviceText = null;
    let price = null;
    let durationMin = 60;
    if (service_id) {
      const sv = await pool.query(
        `SELECT name, price, duration_min FROM services WHERE id=$1 LIMIT 1`,
        [service_id]
      );
      if (sv.rows[0]) {
        serviceText = sv.rows[0].name;
        price = sv.rows[0].price;
        durationMin = sv.rows[0].duration_min || 60;
      }
    }

    let clientName = null;
    if (client_id) {
      const cl = await pool.query(`SELECT name FROM clients WHERE id=$1 LIMIT 1`, [client_id]);
      clientName = cl.rows[0]?.name || null;
    }

    const startsAt = kyivToUtcIso(date, time);
    const endsAt = new Date(new Date(startsAt).getTime() + durationMin * 60000).toISOString();

    const r = await pool.query(
      `INSERT INTO appointments
         (client_id, client_name, master_id, service_id, services_text, starts_at, ends_at,
          duration_min, price, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING id, status`,
      [client_id || null, clientName, employee_id || null, service_id || null,
       serviceText, startsAt, endsAt, durationMin, price, notes || null]
    );
    const appt = r.rows[0];

    logAction({ user: req.user, action: 'mobile.appointment.create', entity: 'appointments',
      entity_id: appt.id, ip: clientIp(req), meta: { client_id, service_id, date, time } });

    return res.status(201).json({ ok: true, id: appt.id, status: appt.status });
  } catch (e) { return err500(res, e); }
});

// PUT /api/mobile/appointments/:id
// Body: { date?, time?, service_id?, employee_id?, status?, notes? }
router.put('/appointments/:id', mobileAuth, needPerm('mobile.appointments.update'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });

    const existing = await pool.query(`SELECT * FROM appointments WHERE id=$1`, [id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'not-found' });

    const { date, time, service_id, employee_id, status, notes } = req.body || {};
    const sets = [], vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

    if (date && time) {
      const startsAt = kyivToUtcIso(date, time);
      push('starts_at', startsAt);
    } else if (date) {
      // Только дата, время берём из существующей записи
      const existingTime = new Date(existing.rows[0].starts_at).toTimeString().slice(0, 5);
      const startsAt = kyivToUtcIso(date, existingTime);
      push('starts_at', startsAt);
    }
    if (time && !date) {
      const existingDate = new Date(existing.rows[0].starts_at).toISOString().slice(0, 10);
      const startsAt = kyivToUtcIso(existingDate, time);
      push('starts_at', startsAt);
    }
    if (service_id !== undefined) push('service_id', service_id);
    if (employee_id !== undefined) push('master_id', employee_id);
    if (status !== undefined) push('status', status);
    if (notes !== undefined) push('notes', notes);

    if (!sets.length) return res.status(400).json({ error: 'no fields to update' });

    vals.push(id);
    const r = await pool.query(
      `UPDATE appointments SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    logAction({ user: req.user, action: 'mobile.appointment.update', entity: 'appointments',
      entity_id: id, ip: clientIp(req), meta: req.body });

    return res.json({ ok: true, appointment: r.rows[0] });
  } catch (e) { return err500(res, e); }
});

// PUT /api/mobile/appointments/:id/status
// Body: { status: 'confirmed'|'in_progress'|'completed'|'cancelled' }
router.put('/appointments/:id/status', mobileAuth, needPerm('mobile.appointments.update'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });

    const ALLOWED_STATUSES = ['confirmed', 'in_progress', 'completed', 'cancelled', 'pending', 'noshow'];
    const { status } = req.body || {};
    if (!status || !ALLOWED_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status required', allowed: ALLOWED_STATUSES });
    }

    const r = await pool.query(
      `UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id, status`,
      [status, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: `mobile.appointment.${status}`, entity: 'appointments',
      entity_id: id, ip: clientIp(req) });

    return res.json({ ok: true, id: r.rows[0].id, status: r.rows[0].status });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// 07.03 — CLIENT CARD
// ════════════════════════════════════════════════════════════

// GET /api/mobile/clients/search
// Query: ?q=search&limit=20
router.get('/clients/search', mobileAuth, needPerm('mobile.clients.read'), async (req, res) => {
  try {
    const pool = getPool();
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const r = await pool.query(
      `SELECT id, name, phone, email,
              last_visit_at,
              (SELECT url FROM files WHERE entity_type='client_avatar' AND entity_id=clients.id::text
                AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS avatar
         FROM clients
        WHERE deleted_at IS NULL
          AND (
            name ILIKE $1
            OR regexp_replace(phone, '\\D', '', 'g') LIKE '%' || regexp_replace($2, '\\D', '', 'g') || '%'
            OR email ILIKE $1
          )
        ORDER BY last_visit_at DESC NULLS LAST, name
        LIMIT $3`,
      [`%${q}%`, q, limit]
    );
    return res.json({ ok: true, items: r.rows });
  } catch (e) { return err500(res, e); }
});

// GET /api/mobile/clients/:id
// Карточка клиента: контакты, история визитов, бонусы, заметки, абонементы
router.get('/clients/:id', mobileAuth, needPerm('mobile.clients.read'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });

    const c = await pool.query(`SELECT * FROM clients WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not-found' });
    const client = c.rows[0];

    // История визитов
    const visits = await pool.query(
      `SELECT a.id, a.starts_at, a.status, a.price, a.services_text, a.payment_method, a.notes,
              m.name AS master_name
         FROM appointments a
         LEFT JOIN masters m ON m.id = a.master_id
        WHERE a.client_id = $1
        ORDER BY a.starts_at DESC NULLS LAST
        LIMIT 50`,
      [id]
    );

    // Бонусный баланс
    let bonusBalance = 0;
    let bonusHistory = [];
    try {
      const bb = await pool.query(
        `SELECT balance, total_accrued, total_spent FROM bonus_balances WHERE client_id=$1 LIMIT 1`,
        [id]
      );
      bonusBalance = parseFloat(bb.rows[0]?.balance || 0);
      const bh = await pool.query(
        `SELECT type, amount, description, created_at
           FROM bonus_transactions WHERE client_id=$1
           ORDER BY created_at DESC LIMIT 20`,
        [id]
      );
      bonusHistory = bh.rows;
    } catch (_) { /* таблица ещё не создана */ }

    // Заметки клиента из notes поля + crm_notes не связаны с клиентом напрямую
    // Основные заметки — поле notes в таблице clients

    // Фото before/after
    let photos = [];
    try {
      const ph = await pool.query(
        `SELECT f.id, f.url, f.original_name, f.entity_type, f.created_at
           FROM files f
          WHERE f.entity_type IN ('before_photo','after_photo')
            AND f.entity_id IN (
              SELECT id::text FROM appointments WHERE client_id=$1
            )
            AND f.deleted_at IS NULL
          ORDER BY f.created_at DESC LIMIT 50`,
        [id]
      );
      photos = ph.rows;
    } catch (_) { /* файлы ещё не проиндексированы */ }

    // Абонементы
    let subscriptions = [];
    try {
      const subs = await pool.query(
        `SELECT s.id, s.subscription_number, s.status, s.visits_remaining,
                s.minutes_remaining, s.expires_at, p.name AS plan_name
           FROM subscriptions s
           LEFT JOIN subscription_plans p ON p.id = s.plan_id
          WHERE s.client_id=$1 AND s.status IN ('active','frozen')
          ORDER BY s.created_at DESC`,
        [id]
      );
      subscriptions = subs.rows;
    } catch (_) { /* subscriptions ещё не создана */ }

    return res.json({
      ok: true,
      client: {
        id: client.id,
        name: client.name,
        phone: client.phone,
        email: client.email,
        birthday: client.birthday,
        notes: client.notes,
        last_visit_at: client.last_visit_at,
        bonus_balance: bonusBalance,
        bonus_history: bonusHistory,
        visits: visits.rows,
        photos,
        subscriptions,
      },
    });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/clients/:id/notes
// Body: { text }
router.post('/clients/:id/notes', mobileAuth, needPerm('mobile.clients.write'), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad id' });

    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    if (text.length > 4000) return res.status(400).json({ error: 'text too long (max 4000)' });

    // Добавляем заметку к полю notes (append) + crm_notes если есть entity_type поддержка
    // Паттерн: обновляем notes поле клиента с датой и автором
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const author = req.user.display_name || 'staff';
    const newNote = `[${stamp} ${author}] ${text}`;

    const r = await pool.query(
      `UPDATE clients
          SET notes = CASE
            WHEN notes IS NULL OR notes = '' THEN $1
            ELSE notes || E'\\n' || $1
          END,
          updated_at = NOW()
        WHERE id=$2 AND deleted_at IS NULL
        RETURNING id, notes`,
      [newNote, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });

    logAction({ user: req.user, action: 'mobile.client.note.add', entity: 'clients',
      entity_id: id, ip: clientIp(req), meta: { text: text.slice(0, 100) } });

    return res.json({ ok: true, note: newNote });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// 07.04 — CASHBOX & PAYMENTS
// ════════════════════════════════════════════════════════════

// POST /api/mobile/payments
// Body: { appointment_id, amount_cents, payment_method, bonus_amount?, discount_percent? }
router.post('/payments', mobileAuth, needPerm('mobile.payments.create'), async (req, res) => {
  try {
    const pool = getPool();
    const { appointment_id, amount_cents, payment_method, bonus_amount, discount_percent } = req.body || {};

    if (!appointment_id || !amount_cents || !payment_method) {
      return res.status(400).json({ error: 'appointment_id, amount_cents, payment_method required' });
    }
    const ALLOWED_METHODS = ['cash', 'card', 'bonus', 'mixed'];
    if (!ALLOWED_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: 'payment_method must be cash|card|bonus|mixed' });
    }

    const appt = await pool.query(
      `SELECT * FROM appointments WHERE id=$1 LIMIT 1`,
      [parseInt(appointment_id, 10)]
    );
    if (!appt.rows[0]) return res.status(404).json({ error: 'appointment-not-found' });

    // Идемпотентность МЕЖДУ методами: повторная отправка с другим method (обрыв сети,
    // ретрай приложения) не должна создать вторую оплату — уникальный индекс ловит
    // только тот же method+category (аудит 06.07).
    const dup = await pool.query(
      `SELECT id FROM cash_operations WHERE type='in' AND ref_type='appointment' AND ref_id=$1 LIMIT 1`,
      [parseInt(appointment_id, 10)]);
    if (dup.rows[0]) return res.status(200).json({ ok: true, already_paid: true, payment_id: dup.rows[0].id });

    const bonusModule = require('../lib/bonus');
    const amountNum = Number(amount_cents) / 100;
    const discountPct = discount_percent ? Number(discount_percent) : 0;
    const checkAfterDiscount = amountNum * (1 - discountPct / 100);
    let bonusNum = bonus_amount ? Number(bonus_amount) / 100 : 0;

    // Валідація балансу бонусів ДО проведення каси.
    if (bonusNum > 0 && appt.rows[0].client_id) {
      const bb = await pool.query('SELECT balance FROM bonus_balances WHERE client_id=$1 LIMIT 1', [appt.rows[0].client_id]);
      const bal = parseFloat(bb.rows[0]?.balance || 0);
      if (bal < bonusNum) {
        return res.status(400).json({ error: 'insufficient-bonus-balance', balance: bal, requested: bonusNum,
          message: `На бонусному рахунку ${bal}, а списати треба ${bonusNum}. Оплату не проведено.` });
      }
      // КРИТ (аудит 07.07): redeem обрізає бонус до max_pay_percent% чека. Якщо каса відніме
      // ПОВНИЙ bonusNum, а спишеться менше — грошова діра. Рахуємо ЕФЕКТИВНИЙ бонус (те, що
      // реально спишеться) і використовуємо його І в касі, І в redeem — суми збігаються.
      bonusNum = await bonusModule.previewRedeem({
        clientId: appt.rows[0].client_id, amount: bonusNum, checkAmount: checkAfterDiscount });
    }
    // finalAmount не може бути відʼємним (bonusNum вже обмежений лімітом і балансом).
    const finalAmount = Math.max(0, checkAfterDiscount - bonusNum);

    // Находим текущую открытую смену
    const shiftRes = await pool.query(
      `SELECT id FROM cash_shifts WHERE status='open' ORDER BY opened_at DESC LIMIT 1`
    );
    const shiftId = shiftRes.rows[0]?.id || null;

    // Записываем операцию в кассу. Колонок appointment_id/client_id в cash_operations НЕТ —
    // привязка к визиту через ref_type/ref_id (как в /appointments/:id/pay).
    // ON CONFLICT по ux_cash_ops_appt_payment = идемпотентность: повторная оплата не дублирует приход.
    const op = await pool.query(
      `INSERT INTO cash_operations
         (shift_id, type, amount, method, category, description, ref_type, ref_id, master_id)
       VALUES ($1,'in',$2,$3,'sale_service',$4,'appointment',$5,$6)
       ON CONFLICT (tenant_id, ref_type, ref_id, method, category) WHERE type='in' AND ref_type='appointment' DO NOTHING
       RETURNING id`,
      [shiftId, finalAmount, payment_method === 'mixed' ? 'cash' : payment_method,
       appt.rows[0].services_text || 'Услуга',
       parseInt(appointment_id, 10), appt.rows[0].master_id || null]
    );
    if (!op.rows[0]) return res.status(200).json({ ok: true, already_paid: true });

    // Обновляем статус записи
    await pool.query(
      `UPDATE appointments SET status='completed', payment_method=$1, updated_at=NOW() WHERE id=$2`,
      [payment_method, appointment_id]
    );

    // Списание бонусов если mixed/bonus.
    // ФІКС: bonus.redeem приймає ОБ'ЄКТ {clientId, amount, ...}, а не позиційні аргументи —
    // старий виклик redeem(client_id, bonusNum, text) завжди кидав 'clientId-and-amount-required',
    // помилка глушилась → бонуси НЕ списувались, а каса вже зменшена (грошова діра).
    // Ідемпотентність по source_id: повторна оплата візиту не спише бонуси двічі.
    if (bonusNum > 0 && appt.rows[0].client_id) {
      const bonus = require('../lib/bonus');
      const dup = await pool.query(
        `SELECT 1 FROM bonus_transactions WHERE type='redemption' AND source_type='mobile-pay' AND source_id=$1 LIMIT 1`,
        [parseInt(appointment_id, 10)]);
      if (!dup.rows[0]) {
        try {
          await bonus.redeem({
            clientId: appt.rows[0].client_id,
            amount: bonusNum,
            checkAmount: amountNum * (1 - discountPct / 100),
            sourceType: 'mobile-pay',
            sourceId: parseInt(appointment_id, 10),
            description: `Оплата записи #${appointment_id}`,
          });
        } catch (e) {
          console.error('[mobile:bonus-redeem]', e.message); // не глушим молча — видно в логах
        }
      }
    }

    logAction({ user: req.user, action: 'mobile.payment.create', entity: 'cash_operations',
      entity_id: op.rows[0].id, ip: clientIp(req),
      meta: { appointment_id, amount_cents, payment_method, discount_percent } });

    return res.status(201).json({
      ok: true,
      payment_id: op.rows[0].id,
      receipt_url: null,          // фискализация — отдельный модуль INT-09
      fiscal_receipt_id: null,
    });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// ФОТО BEFORE/AFTER
// ════════════════════════════════════════════════════════════

// POST /api/mobile/photos/upload
// multipart/form-data: { appointment_id, photo_type: 'before'|'after', file }
// Делегируем в существующий /api/files/upload, здесь только привязка к визиту
router.post('/photos/upload', mobileAuth, needPerm('mobile.photos.upload'), async (req, res) => {
  try {
    const { appointment_id, photo_type } = req.body || {};
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' });
    if (!['before', 'after'].includes(photo_type)) {
      return res.status(400).json({ error: 'photo_type must be before|after' });
    }
    // Перенаправляем на /api/files/upload с entity_type = before_photo/after_photo
    // Клиент должен сделать multipart POST к /api/files/upload с полями:
    //   entity_type = before_photo | after_photo
    //   entity_id   = appointment_id
    //   file        = бинарный файл
    // Этот endpoint отдаёт инструкцию + upload_url для клиента
    return res.json({
      ok: true,
      upload_url: '/api/files/upload',
      fields: {
        entity_type: `${photo_type}_photo`,
        entity_id: String(appointment_id),
      },
      message: 'POST multipart to upload_url with field "file" + provided fields',
    });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// 07.05 — OFFLINE SYNC
// ════════════════════════════════════════════════════════════

// POST /api/mobile/sync
// Body: { actions: [{ id, action_type, payload, queued_at }] }
router.post('/sync', mobileAuth, needPerm('mobile.access'), async (req, res) => {
  try {
    const pool = getPool();
    const actions = Array.isArray(req.body?.actions) ? req.body.actions : [];
    if (!actions.length) return res.json({ ok: true, results: [] });

    // Находим device_id текущего пользователя (последнее активное устройство)
    const devRes = await pool.query(
      `SELECT id FROM mobile_devices WHERE employee_id=$1::uuid AND status='active'
       ORDER BY last_active_at DESC LIMIT 1`,
      [req.user.id]
    );
    const deviceId = devRes.rows[0]?.id || null;

    const results = [];
    for (const action of actions) {
      const { id: clientId, action_type, payload, queued_at } = action;
      let status = 'synced';
      let conflictDetails = null;

      try {
        // Сохраняем в offline_queue для аудита
        if (deviceId) {
          await pool.query(
            `INSERT INTO offline_queue
               (device_id, employee_id, action_type, payload, status, queued_at, synced_at)
             VALUES ($1,$2::uuid,$3,$4,'synced',$5,NOW())
             ON CONFLICT DO NOTHING`,
            [deviceId, req.user.id, action_type, JSON.stringify(payload || {}),
             queued_at ? new Date(queued_at).toISOString() : new Date().toISOString()]
          );
        }

        // Применяем действие
        if (action_type === 'appointment.create') {
          const { client_id, service_id, employee_id, date, time, notes } = payload || {};
          if (date && time) {
            const startsAt = kyivToUtcIso(date, time);
            // РАУНД3-FIX (BLOCKER-R2): ends_at обязателен (NOT NULL + без него триггер
            // защиты от овербукинга пропускал оффлайн-путь). Считаем из длительности услуги.
            let durMin = 60;
            if (service_id) {
              const svc = await pool.query(`SELECT duration_min FROM services WHERE id=$1`, [service_id]);
              if (svc.rowCount && svc.rows[0].duration_min > 0) durMin = svc.rows[0].duration_min;
            }
            const endsAt = new Date(new Date(startsAt).getTime() + durMin * 60000).toISOString();
            await pool.query(
              `INSERT INTO appointments (client_id, master_id, service_id, starts_at, ends_at, notes, status)
               VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
              [client_id || null, employee_id || null, service_id || null, startsAt, endsAt, notes || null]
            );
          }
        } else if (action_type === 'appointment.update' || action_type === 'appointment.cancel') {
          const { appointment_id, status: newStatus } = payload || {};
          if (appointment_id) {
            await pool.query(
              `UPDATE appointments SET status=$1, updated_at=NOW() WHERE id=$2`,
              [newStatus || 'cancelled', appointment_id]
            );
          }
        } else if (action_type === 'note.add') {
          const { client_id, text } = payload || {};
          if (client_id && text) {
            const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
            const note = `[${stamp} sync] ${text}`;
            await pool.query(
              `UPDATE clients SET notes = COALESCE(notes||E'\\n','') || $1, updated_at=NOW() WHERE id=$2`,
              [note, client_id]
            );
          }
        }
      } catch (syncErr) {
        console.error('[mobile/sync] action failed', action_type, syncErr.message);
        status = 'conflict';
        conflictDetails = { error: syncErr.message };
      }

      results.push({ id: clientId, status, conflict_details: conflictDetails });
    }

    await pool.query(
      `UPDATE mobile_devices SET last_sync_at=NOW(), updated_at=NOW()
       WHERE employee_id=$1::uuid AND status='active'`,
      [req.user.id]
    );

    return res.json({ ok: true, results });
  } catch (e) { return err500(res, e); }
});

// GET /api/mobile/sync/pull
// Query: ?since=2026-06-15T10:00:00Z
// Возвращает изменения с сервера после указанного момента
router.get('/sync/pull', mobileAuth, needPerm('mobile.access'), async (req, res) => {
  try {
    const pool = getPool();
    // guard: new Date('мусор').toISOString() кидає RangeError і роняє sync/pull (аудит v8)
    let since = null;
    if (req.query.since) { const d = new Date(req.query.since); if (!isNaN(d.getTime())) since = d.toISOString(); }
    const sinceTs = since || new Date(Date.now() - 3 * 86400000).toISOString(); // по умолчанию 3 дня

    // Фильтр по мастеру для роли master
    const masterFilter = (req.user.role === 'master' && req.user.master_id)
      ? `AND a.master_id = ${parseInt(req.user.master_id, 10)}`
      : '';

    const appts = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.price, a.services_text,
              a.client_id, a.master_id, a.notes, a.updated_at
         FROM appointments a
        WHERE a.updated_at >= $1 ${masterFilter}
        ORDER BY a.updated_at DESC
        LIMIT 500`,
      [sinceTs]
    );

    const clients = await pool.query(
      `SELECT id, name, phone, email, birthday, notes, updated_at
         FROM clients
        WHERE updated_at >= $1 AND deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 500`,
      [sinceTs]
    );

    const services = await pool.query(
      `SELECT id, name, price, duration_min, category_id, active, updated_at
         FROM services
        WHERE updated_at >= $1
        ORDER BY updated_at DESC
        LIMIT 500`,
      [sinceTs]
    );

    return res.json({
      ok: true,
      since: sinceTs,
      last_sync_at: new Date().toISOString(),
      appointments: appts.rows,
      clients: clients.rows,
      services: services.rows,
    });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// PUSH TOKENS
// ════════════════════════════════════════════════════════════

// POST /api/mobile/push/register
// Body: { token, provider: 'fcm'|'apns' }
router.post('/push/register', mobileAuth, needPerm('mobile.access'), async (req, res) => {
  try {
    const pool = getPool();
    const { token, provider } = req.body || {};
    if (!token || !provider) return res.status(400).json({ error: 'token+provider required' });
    if (!['fcm', 'apns'].includes(provider)) return res.status(400).json({ error: 'provider must be fcm|apns' });

    // Находим устройство текущего пользователя
    const devRes = await pool.query(
      `SELECT id FROM mobile_devices WHERE employee_id=$1::uuid AND status='active'
       ORDER BY last_active_at DESC LIMIT 1`,
      [req.user.id]
    );
    const deviceId = devRes.rows[0]?.id || null;

    // Деактивируем старые токены этого устройства для этого провайдера
    if (deviceId) {
      await pool.query(
        `UPDATE push_tokens SET is_active=false, updated_at=NOW()
         WHERE device_id=$1 AND provider=$2`,
        [deviceId, provider]
      );
    }

    // Сохраняем новый токен
    const r = await pool.query(
      `INSERT INTO push_tokens (device_id, employee_id, token, provider, is_active)
       VALUES ($1, $2::uuid, $3, $4, true)
       RETURNING id`,
      [deviceId, req.user.id, token, provider]
    );

    return res.json({ ok: true, push_token_id: r.rows[0].id });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// VERSION CHECK
// ════════════════════════════════════════════════════════════

// GET /api/mobile/version/check
// Query: ?platform=ios&version=1.2.3
router.get('/version/check', async (req, res) => {
  try {
    const pool = getPool();
    const { platform, version: currentVersion } = req.query;
    if (!platform || !currentVersion) {
      return res.status(400).json({ error: 'platform+version required' });
    }
    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'platform must be ios|android' });
    }

    // Последняя доступная версия
    const latest = await pool.query(
      `SELECT * FROM app_versions_mobile
        WHERE platform=$1
        ORDER BY released_at DESC LIMIT 1`,
      [platform]
    );

    if (!latest.rows[0]) {
      return res.json({ ok: true, update_available: false, latest_version: currentVersion });
    }

    const latestVersion = latest.rows[0].version;

    // Простое сравнение semver: разбить по точкам и сравнить цифры
    function semverGt(a, b) {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return true;
        if ((pa[i] || 0) < (pb[i] || 0)) return false;
      }
      return false;
    }

    const updateAvailable = semverGt(latestVersion, currentVersion);

    // Форс-апдейт: текущая версия < min_supported версии
    let forceUpdate = false;
    if (updateAvailable) {
      const minSupported = await pool.query(
        `SELECT version FROM app_versions_mobile
          WHERE platform=$1 AND min_supported=true
          ORDER BY released_at DESC LIMIT 1`,
        [platform]
      );
      if (minSupported.rows[0]) {
        forceUpdate = semverGt(minSupported.rows[0].version, currentVersion);
      }
    }

    return res.json({
      ok: true,
      update_available: updateAvailable,
      force_update: forceUpdate,
      latest_version: latestVersion,
      download_url: latest.rows[0].download_url || null,
      release_notes: latest.rows[0].release_notes || null,
    });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// ADMIN — DEVICE MANAGEMENT
// ════════════════════════════════════════════════════════════

// GET /api/mobile/admin/devices
// Query: ?employee_id=&status=active
router.get('/admin/devices', mobileAuth, needPerm('mobile.devices.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const conditions = [];
    const params = [];
    if (req.query.employee_id) {
      params.push(req.query.employee_id);
      conditions.push(`md.employee_id=$${params.length}::uuid`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      conditions.push(`md.status=$${params.length}`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const r = await pool.query(
      `SELECT md.id, md.employee_id, md.device_id, md.device_name, md.platform,
              md.app_version, md.os_version, md.status, md.biometric_enabled,
              md.last_active_at, md.last_sync_at, md.registered_at,
              u.display_name AS employee_name
         FROM mobile_devices md
         LEFT JOIN users u ON u.id::text = md.employee_id::text
         ${where}
         ORDER BY md.last_active_at DESC NULLS LAST
         LIMIT 500`,
      params
    );
    return res.json({ ok: true, items: r.rows, count: r.rowCount });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/admin/devices/:id/wipe
// Удалённый сброс устройства
router.post('/admin/devices/:id/wipe', mobileAuth, needPerm('mobile.devices.wipe'), async (req, res) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const r = await pool.query(
      `UPDATE mobile_devices
          SET status='wiped', wiped_at=NOW(), updated_at=NOW()
        WHERE id=$1 RETURNING id, employee_id, device_name`,
      [id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'device-not-found' });

    // Деактивируем все push-токены устройства
    await pool.query(
      `UPDATE push_tokens SET is_active=false, updated_at=NOW() WHERE device_id=$1`,
      [id]
    );

    // Отзываем все сессии пользователя (remote wipe = разлогин на устройстве)
    await pool.query(
      `UPDATE user_sessions SET revoked_at=NOW()
        WHERE user_id=$1::uuid AND revoked_at IS NULL`,
      [r.rows[0].employee_id]
    );

    logAction({ user: req.user, action: 'mobile.device.wipe', entity: 'mobile_devices',
      entity_id: id, ip: clientIp(req),
      meta: { device_name: r.rows[0].device_name, employee_id: r.rows[0].employee_id } });

    return res.json({ ok: true, device_id: id, status: 'wiped' });
  } catch (e) { return err500(res, e); }
});

// POST /api/mobile/admin/devices/:id/lock
// Заблокировать устройство (не wipe, только lock)
router.post('/admin/devices/:id/lock', mobileAuth, needPerm('mobile.devices.manage'), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE mobile_devices SET status='locked', updated_at=NOW()
        WHERE id=$1 RETURNING id, device_name`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'device-not-found' });
    logAction({ user: req.user, action: 'mobile.device.lock', entity: 'mobile_devices',
      entity_id: req.params.id, ip: clientIp(req) });
    return res.json({ ok: true, device_id: req.params.id, status: 'locked' });
  } catch (e) { return err500(res, e); }
});

// ════════════════════════════════════════════════════════════
// РАСПИСАНИЕ МАСТЕРА (shortcut для мастер-роли)
// ════════════════════════════════════════════════════════════

// GET /api/mobile/me/schedule
// Расписание текущего мастера на день (удобный алиас)
router.get('/me/schedule', mobileAuth, needPerm('mobile.schedule.read'), async (req, res) => {
  try {
    const pool = getPool();
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const masterId = req.user.master_id;
    if (!masterId) return res.status(400).json({ error: 'no master_id on user' });

    const r = await pool.query(
      `SELECT a.id,
              to_char(a.starts_at AT TIME ZONE 'Europe/Kyiv', 'HH24:MI') AS time,
              COALESCE(a.duration_min, 60) AS duration,
              a.status, a.price, a.services_text, a.notes,
              COALESCE(a.client_name, c.name) AS client_name,
              c.phone AS client_phone,
              c.id AS client_id
         FROM appointments a
         LEFT JOIN clients c ON c.id = a.client_id
        WHERE a.master_id = $1
          AND (a.starts_at AT TIME ZONE 'Europe/Kyiv')::date = $2::date
          AND COALESCE(a.status,'') != 'deleted'
        ORDER BY a.starts_at`,
      [masterId, date]
    );
    return res.json({ ok: true, date, master_id: masterId, appointments: r.rows });
  } catch (e) { return err500(res, e); }
});

// GET /api/mobile/me/stats
// Статистика мастера (за текущий месяц)
router.get('/me/stats', mobileAuth, needPerm('mobile.schedule.read'), async (req, res) => {
  try {
    const pool = getPool();
    const masterId = req.user.master_id;
    if (!masterId) return res.status(400).json({ error: 'no master_id on user' });

    const stats = await pool.query(
      `SELECT
         COUNT(*)::int                                                          AS appointments_total,
         COUNT(CASE WHEN status='completed' THEN 1 END)::int                   AS appointments_done,
         COALESCE(SUM(CASE WHEN status='completed' THEN price END),0)::float   AS revenue,
         COUNT(CASE WHEN (starts_at AT TIME ZONE 'Europe/Kyiv')::date = CURRENT_DATE THEN 1 END)::int AS today_count
         FROM appointments
        WHERE master_id=$1
          AND starts_at >= date_trunc('month', NOW())`,
      [masterId]
    );
    return res.json({ ok: true, master_id: masterId, stats: stats.rows[0] });
  } catch (e) { return err500(res, e); }
});

module.exports = router;
