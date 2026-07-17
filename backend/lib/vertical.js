/* lib/vertical.js — изоляция вертикалей платформы (beauty / fitness / dental).
   Приказ Босса 18.07.2026: модули вертикалей НЕ должны пересекаться и смешиваться.
   requireVertical('fitness') на роутере → тенант другой вертикали получает 404:
   для салона красоты фитнес-модуля «не существует» (не 403 — нечего апгрейдить).
   ВАЖНО: гейт вертикали fail-CLOSED (при ошибке БД чужой модуль НЕ открывается) —
   в отличие от feature-gate, где fail-open оправдан для не-ломания рабочего салона. */
const { getPool } = require('../db-pg');
const { getTenantId } = require('./tenant');

const _cache = new Map(); // tenant_id → { bt, exp }
const TTL = 60 * 1000;

async function getVertical() {
  const tid = getTenantId();
  if (!tid) return 'beauty'; // нет контекста тенанта = платформа/легаси = beauty
  const hit = _cache.get(tid);
  if (hit && hit.exp > Date.now()) return hit.bt;
  const r = await getPool().query(`SELECT business_type FROM tenants WHERE id=$1`, [tid]);
  const bt = r.rows[0]?.business_type || 'beauty';
  _cache.set(tid, { bt, exp: Date.now() + TTL });
  return bt;
}

function requireVertical(vertical) {
  return async (_req, res, next) => {
    try {
      if ((await getVertical()) === vertical) return next();
      return res.status(404).json({ error: 'not-found' });
    } catch (e) {
      console.error('[vertical-gate]', vertical, e.message);
      return res.status(404).json({ error: 'not-found' }); // fail-closed
    }
  };
}

function invalidateVerticalCache(tenantId) {
  if (tenantId) _cache.delete(tenantId);
  else _cache.clear();
}

module.exports = { getVertical, requireVertical, invalidateVerticalCache };
