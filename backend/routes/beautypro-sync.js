/* ═══════════════════════════════════════════════════════
   SVS Beauty World — BeautyPro Sync
   Цель: единый клиент салон+магазин.
   Логика: при регистрации/заказе в магазине ищем клиента
   в BeautyPro по телефону. Если есть — связываем (beautypro_id).
   Если нет — создаём в BeautyPro и пишем id.

   POST /api/sync/client      — синхро одного клиента по телефону
   POST /api/sync/all-clients — массовая синхро (admin)
   GET  /api/sync/status      — счётчики
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const bp = require('../beautyproClient');

function adminOnly(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── один клиент по телефону ─────────────────────────────
async function syncOneClient(phone, fallbackName) {
  const pool = getPool();
  const normalized = String(phone).replace(/\D/g, '');

  // 1. найти / создать в нашей БД
  const localR = await pool.query(`SELECT * FROM clients WHERE phone = $1`, [normalized]);
  let local = localR.rows[0];
  if (!local) {
    const ins = await pool.query(
      `INSERT INTO clients (phone, name, source) VALUES ($1,$2,'sync')
       RETURNING *`,
      [normalized, fallbackName || null]
    );
    local = ins.rows[0];
  }

  // если уже связан — ничего не делаем
  if (local.beautypro_id) {
    return { ok: true, action: 'already-linked', local_id: local.id, beautypro_id: local.beautypro_id };
  }

  // 2. поискать в BeautyPro
  let bpClient = null;
  try {
    bpClient = await bp.findClientByPhone(normalized);
  } catch (e) {
    return { ok: false, action: 'bp-search-failed', error: e.message };
  }

  // 3. если нет — создать
  if (!bpClient) {
    try {
      const created = await bp.createClient({
        phone: normalized,
        name: local.name || fallbackName || 'Клієнт магазину',
      });
      bpClient = created;
    } catch (e) {
      return { ok: false, action: 'bp-create-failed', error: e.message };
    }
  }

  // 4. связать
  const bpId = bpClient.id || bpClient.client_id || bpClient.uuid;
  if (!bpId) {
    return { ok: false, action: 'bp-no-id', bpClient };
  }
  await pool.query(
    `UPDATE clients SET beautypro_id = $1, updated_at = NOW() WHERE id = $2`,
    [bpId, local.id]
  );
  return {
    ok: true,
    action: bpClient._wasCreated ? 'created-in-bp' : 'linked-existing',
    local_id: local.id,
    beautypro_id: bpId,
  };
}

router.post('/client', async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone-required' });
    const result = await syncOneClient(phone, name);
    res.json(result);
  } catch (e) {
    console.error('[sync:client]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

router.post('/all-clients', adminOnly, async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, phone, name FROM clients WHERE beautypro_id IS NULL AND phone IS NOT NULL LIMIT 100`
    );
    const results = [];
    for (const c of r.rows) {
      const out = await syncOneClient(c.phone, c.name);
      results.push({ phone: c.phone, ...out });
      // лёгкая пауза чтобы не задолбить BeautyPro
      await new Promise(r => setTimeout(r, 200));
    }
    const ok = results.filter(x => x.ok).length;
    res.json({ ok: true, processed: results.length, success: ok, failed: results.length - ok, details: results });
  } catch (e) {
    console.error('[sync:all]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

router.get('/status', adminOnly, async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE beautypro_id IS NOT NULL)::int AS linked,
         COUNT(*) FILTER (WHERE beautypro_id IS NULL)::int AS unlinked,
         COUNT(*)::int AS total
       FROM clients WHERE phone IS NOT NULL`
    );
    res.json({ ok: true, sync: r.rows[0] });
  } catch (e) {
    console.error('[sync:status]', e);
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
module.exports.syncOneClient = syncOneClient;
