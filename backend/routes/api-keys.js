/* ═══════════════════════════════════════════════════════
   INT-01 — Управление API-ключами (админка)
   Подключается как /api/api-keys

   Что закрывает:
   - выпуск ключа (полный ключ показывается ОДИН раз при создании);
   - список ключей (только префикс + метаданные, без секрета);
   - ротация (revoke + reissue), деактивация, удаление;
   - настройка scopes и rate_limit_per_min.

   Права: apikeys.read / apikeys.write (миграция 092).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { generateKey } = require('../lib/api-auth');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'apikeys.read' : 'apikeys.write';
  return requirePerm(perm)(req, res, next);
});

// GET /api/api-keys — список (без секретов)
router.get('/', async (req, res) => {
  try {
    const rows = await q(`SELECT id,name,key_prefix,scopes,rate_limit_per_min,active,request_count,last_used_at,expires_at,created_at
                          FROM api_keys WHERE tenant_id=current_tenant_id() ORDER BY created_at DESC`);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/api-keys — выпустить ключ (раскрывается один раз)
router.post('/', async (req, res) => {
  try {
    const { name, scopes, rate_limit_per_min, expires_at } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const k = generateKey();
    const sc = Array.isArray(scopes) && scopes.length ? scopes.map(String) : ['read'];
    const row = (await q(
      `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, rate_limit_per_min, expires_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,name,key_prefix,scopes,rate_limit_per_min,active,created_at`,
      [name, k.prefix, k.hash, JSON.stringify(sc),
       parseInt(rate_limit_per_min, 10) || 120, expires_at || null, req.user?.id || null]))[0];
    await logAction({ user: req.user, action: 'apikey.create', entity: 'api_keys', entity_id: row.id, ip: req.ip });
    // полный ключ возвращается ТОЛЬКО сейчас
    res.json({ ...row, api_key: k.raw, warning: 'Збережіть ключ — він більше не буде показаний.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/api-keys/:id — изменить scopes/limit/active
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['name', 'scopes', 'rate_limit_per_min', 'active', 'expires_at'];
    const sets = [], params = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        params.push(key === 'scopes' ? JSON.stringify((req.body[key] || []).map(String)) : req.body[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.params.id);
    const row = (await q(`UPDATE api_keys SET ${sets.join(', ')}
                          WHERE id=$${params.length} AND tenant_id=current_tenant_id()
                          RETURNING id,name,key_prefix,scopes,rate_limit_per_min,active`, params))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/api-keys/:id/rotate — выпустить новый секрет для существующего ключа
router.post('/:id/rotate', async (req, res) => {
  try {
    const k = generateKey();
    const row = (await q(`UPDATE api_keys SET key_prefix=$1, key_hash=$2, active=true
                          WHERE id=$3 AND tenant_id=current_tenant_id()
                          RETURNING id,name,key_prefix,scopes`, [k.prefix, k.hash, req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'apikey.rotate', entity: 'api_keys', entity_id: row.id, ip: req.ip });
    res.json({ ...row, api_key: k.raw, warning: 'Старий ключ більше не діє.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/api-keys/:id
router.delete('/:id', async (req, res) => {
  try {
    const row = (await q(`DELETE FROM api_keys WHERE id=$1 AND tenant_id=current_tenant_id() RETURNING id`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    await logAction({ user: req.user, action: 'apikey.delete', entity: 'api_keys', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
