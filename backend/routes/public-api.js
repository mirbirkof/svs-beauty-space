/* ═══════════════════════════════════════════════════════
   INT-02 — Публичный API (Public API)
   Подключается как /api/v1 — аутентификация ТОЛЬКО по API-ключу.

   Что закрывает:
   - стабильный внешний контракт для интеграций (сайт, мобайл, партнёры);
   - read-доступ к каталогу: услуги, категории, мастера online-booking;
   - проверка scope + rate limit (INT-01 lib/api-auth);
   - запись лида/заявки (scope write) — POST /v1/leads.

   Каждый эндпоинт защищён apiKeyAuth(<scope>).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { apiKeyAuth } = require('../lib/api-auth');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

// GET /api/v1/ping — проверка ключа
router.get('/ping', apiKeyAuth('read'), (req, res) => {
  res.json({ ok: true, key: req.apiKey.name, scopes: req.apiKey.scopes, ts: new Date().toISOString() });
});

// GET /api/v1/services — активные услуги
router.get('/services', apiKeyAuth('services.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, name, category, price, duration_min, description, is_new, is_hit
       FROM services
       WHERE tenant_id=current_tenant_id() AND deleted_at IS NULL AND coalesce(active,true)=true
       ORDER BY sort_order NULLS LAST, name`);
    res.json({ data: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/v1/services/categories — категории услуг
router.get('/services/categories', apiKeyAuth('services.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT category AS name, count(*)::int services
       FROM services WHERE tenant_id=current_tenant_id() AND deleted_at IS NULL AND category IS NOT NULL
       GROUP BY category ORDER BY category`);
    res.json({ data: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/v1/masters — мастера с включённой онлайн-записью
router.get('/masters', apiKeyAuth('masters.read'), async (req, res) => {
  try {
    const rows = await q(
      `SELECT id, name, surname, specialty, online_title, online_description, avatar
       FROM masters
       WHERE tenant_id=current_tenant_id() AND coalesce(active,true)=true
         AND coalesce(online_booking_enabled,true)=true
       ORDER BY online_rank NULLS LAST, name`);
    res.json({ data: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/v1/leads — внешняя заявка (создаёт запись в form_submissions как лид)
router.post('/leads', apiKeyAuth('write'), async (req, res) => {
  try {
    const { name, phone, message, source } = req.body || {};
    if (!name && !phone) return res.status(400).json({ error: 'name_or_phone_required' });
    const data = { name, phone, message, source: source || 'public_api' };
    // лид кладём в form_submissions с form_id=NULL? form_id NOT NULL → используем спец-форму "API Leads"
    let form = (await q(`SELECT id FROM forms WHERE slug='_api_leads' AND tenant_id=current_tenant_id() LIMIT 1`))[0];
    if (!form) {
      form = (await q(
        `INSERT INTO forms (title, slug, description, fields, status, is_public)
         VALUES ('API Leads','_api_leads','Заявки через публічний API','[]'::jsonb,'published',false)
         RETURNING id`))[0];
    }
    const sub = (await q(
      `INSERT INTO form_submissions (form_id, data, ip) VALUES ($1,$2,$3) RETURNING id, created_at`,
      [form.id, JSON.stringify(data), req.ip || null]))[0];
    res.json({ ok: true, lead_id: sub.id, created_at: sub.created_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
