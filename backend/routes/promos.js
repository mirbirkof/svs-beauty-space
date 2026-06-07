/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Promo Codes
   POST /api/promo/validate { code, cart_total } → { discount, type }
   GET  /api/admin/promos                (admin) — список
   POST /api/admin/promos                (admin) — создать
   PATCH /api/admin/promos/:code         (admin) — изменить
   DELETE /api/admin/promos/:code        (admin) — деактивировать
   ─────────────────────────────────────────────────────────
   Использует таблицу promos. Создаст её при первом старте.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');

let bootstrapped = false;
async function bootstrap() {
  if (bootstrapped) return;
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS promos (
      code         TEXT PRIMARY KEY,
      type         TEXT NOT NULL CHECK (type IN ('percent','fixed')),
      value        NUMERIC NOT NULL,
      min_total    NUMERIC DEFAULT 0,
      max_uses     INT,
      uses         INT DEFAULT 0,
      valid_until  TIMESTAMPTZ,
      active       BOOLEAN DEFAULT TRUE,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  bootstrapped = true;
}

function adminOnly(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// клиентский: проверить промокод и получить скидку
router.post('/validate', async (req, res) => {
  try {
    await bootstrap();
    const { code, cart_total } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code-required' });
    const pool = getPool();
    const r = await pool.query(
      `SELECT * FROM promos WHERE code = $1 AND active = TRUE`,
      [String(code).toUpperCase().trim()]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'invalid-code' });
    const p = r.rows[0];
    if (p.valid_until && new Date(p.valid_until) < new Date()) {
      return res.status(410).json({ error: 'expired' });
    }
    if (p.max_uses != null && p.uses >= p.max_uses) {
      return res.status(410).json({ error: 'used-up' });
    }
    const total = Number(cart_total || 0);
    if (total < Number(p.min_total || 0)) {
      return res.status(400).json({ error: 'min-total-not-met', required: Number(p.min_total) });
    }
    const discount = p.type === 'percent'
      ? Math.round(total * Number(p.value) / 100)
      : Math.min(Number(p.value), total);
    res.json({ ok: true, code: p.code, type: p.type, discount });
  } catch (e) {
    console.error('[promo:validate]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ═══════════════════════════════════════════════════════
//   ADMIN
// ═══════════════════════════════════════════════════════
router.get('/admin/list', adminOnly, async (req, res) => {
  try {
    await bootstrap();
    const pool = getPool();
    const r = await pool.query(`SELECT * FROM promos ORDER BY created_at DESC`);
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/admin/create', adminOnly, async (req, res) => {
  try {
    await bootstrap();
    const { code, type, value, min_total, max_uses, valid_until } = req.body || {};
    if (!code || !type || value == null) return res.status(400).json({ error: 'code-type-value-required' });
    if (!['percent','fixed'].includes(type)) return res.status(400).json({ error: 'bad-type' });
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO promos (code, type, value, min_total, max_uses, valid_until, active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
      [String(code).toUpperCase().trim(), type, value, min_total || 0, max_uses || null, valid_until || null]
    );
    res.status(201).json({ ok: true, promo: r.rows[0] });
  } catch (e) {
    console.error('[promo:create]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  }
});

router.delete('/admin/:code', adminOnly, async (req, res) => {
  try {
    await bootstrap();
    const pool = getPool();
    const r = await pool.query(
      `UPDATE promos SET active = FALSE WHERE code = $1 RETURNING code`,
      [String(req.params.code).toUpperCase().trim()]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, deactivated: r.rows[0].code });
  } catch (e) {
    res.status(500).json({ error: 'internal' });
  }
});

module.exports = router;
