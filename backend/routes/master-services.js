/* routes/master-services.js — ручна курація звʼязки майстер↔послуга (наша CRM = джерело правди).
   Засіяно з BeautyPro лише для активних майстрів; далі редагується тут.
   Читання: masters.read. Редагування: Власник (права "*") завжди; Адмін —
   ЛИШЕ якщо у Бізнес-налаштуваннях увімкнено admin_edit_master_services (Босс 19.07).
   Дефолт вимкнено: власник свідомо відкриває цю можливість адмінам. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction, hasPermission } = require('../lib/rbac');
const { getSetting } = require('../lib/settings');

const router = express.Router();
const pool = getPool();

const err = (res, e) => { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : e.message }); };

// Чи може юзер РЕДАГУВАТИ послуги майстрів: власник ("*") завжди; інші — лише
// коли увімкнено бізнес-тумблер admin_edit_master_services + мають masters.write.
const isOwner = (u) => hasPermission((u && u.permissions) || [], '*');
async function canEditMasterServices(req) {
  const u = req.user;
  if (!u) return false;
  if (isOwner(u)) return true;
  if (!hasPermission(u.permissions || [], 'masters.write')) return false;
  return (await getSetting('admin_edit_master_services', false)) === true;
}
function requireEdit() {
  return async (req, res, next) => {
    try { if (await canEditMasterServices(req)) return next(); }
    catch (e) { return err(res, e); }
    return res.status(403).json({ error: 'master-services-edit-disabled',
      message: 'Керування послугами майстрів вимкнено для адміністраторів. Увімкніть у Бізнес-налаштуваннях (доступно власнику).' });
  };
}

// послуги конкретного майстра (з базовою/персональною ціною)
router.get('/by-master/:masterId', requirePerm('masters.read'), async (req, res) => {
  try {
    // майстер бачить лише ВЛАСНІ звʼязки (чужі персональні ціни закриті)
    if (req.user && req.user.role === 'master' && Number(req.user.master_id) !== Number(req.params.masterId)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const r = await pool.query(
      `SELECT ms.id, ms.service_id, ms.price, ms.duration_min, ms.active, ms.source,
              s.name AS service_name, s.category,
              s.price::float AS base_price, s.duration_min AS base_duration
         FROM master_services ms
         JOIN services s ON s.id = ms.service_id AND s.deleted_at IS NULL
        WHERE ms.master_id = $1
        ORDER BY s.category NULLS LAST, s.name`,
      [Number(req.params.masterId)]
    );
    res.json({ items: r.rows, count: r.rows.length, can_edit: await canEditMasterServices(req) });
  } catch (e) { err(res, e); }
});

// майстри, що надають конкретну послугу
router.get('/by-service/:serviceId', requirePerm('masters.read'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ms.id, ms.master_id, ms.price, ms.duration_min, ms.active, ms.source,
              m.name AS master_name, m.active AS master_active
         FROM master_services ms
         JOIN masters m ON m.id = ms.master_id
        WHERE ms.service_id = $1
        ORDER BY m.active DESC, m.name`,
      [Number(req.params.serviceId)]
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (e) { err(res, e); }
});

// додати звʼязку
router.post('/', requirePerm('masters.read'), requireEdit(), async (req, res) => {
  try {
    const { master_id, service_id, price, duration_min } = req.body || {};
    if (!master_id || !service_id) return res.status(400).json({ error: 'master_id and service_id required' });
    const r = await pool.query(
      `INSERT INTO master_services (master_id, service_id, price, duration_min, source, active)
       VALUES ($1,$2,$3,$4,'manual',true)
       ON CONFLICT (tenant_id, master_id, service_id)
       DO UPDATE SET active=true, price=COALESCE(EXCLUDED.price, master_services.price),
                     duration_min=COALESCE(EXCLUDED.duration_min, master_services.duration_min),
                     updated_at=NOW()
       RETURNING *`,
      [Number(master_id), Number(service_id), price ?? null, duration_min ?? null]
    );
    await logAction(req, 'master_services.add', { master_id, service_id });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err(res, e); }
});

// оновити ціну/тривалість/активність
router.patch('/:id', requirePerm('masters.read'), requireEdit(), async (req, res) => {
  try {
    const body = req.body || {};
    const fields = [], vals = [];
    // price/duration_min — число >= 0 або null (скидання на базове), active — boolean
    for (const k of ['price', 'duration_min']) {
      if (!(k in body)) continue;
      let v = body[k];
      if (v === null || v === '') v = null;
      else {
        v = Number(v);
        if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: `${k} must be a number >= 0 or null` });
      }
      vals.push(v); fields.push(`${k}=$${vals.length}`);
    }
    if ('active' in body) {
      if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'active must be boolean' });
      vals.push(body.active); fields.push(`active=$${vals.length}`);
    }
    if (!fields.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(Number(req.params.id));
    const r = await pool.query(
      `UPDATE master_services SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    await logAction(req, 'master_services.update', { id: req.params.id });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { err(res, e); }
});

// прибрати звʼязку
router.delete('/:id', requirePerm('masters.read'), requireEdit(), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM master_services WHERE id=$1 RETURNING id', [Number(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    await logAction(req, 'master_services.delete', { id: req.params.id });
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
