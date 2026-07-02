/* lib/cash-ledger.js — единая точка записи онлайн-денег в кассу (аудит 22.06, Critical).
 *
 * Проблема: Mono-оплаты визита/предоплаты, продажа сертификатов и абонементов НЕ
 * попадали в cash_operations → касса/P&L/ДДС не сходились с реально полученными
 * деньгами. Ручные продажи (schedule.js) требуют ОТКРЫТОЙ смены, но онлайн-платёж
 * приходит 24/7 без смены — поэтому пишем с shift_id = NULL (деньги не в денежном
 * ящике, а на счёте/карте; в Z-отчёт смены не входят, но в выручку/ДДС — да).
 *
 * Идемпотентность (#13): ext_ref уникален (ux_cash_operations_ext_ref). Повторная
 * доставка вебхука или ретрай не создаёт дубль — ON CONFLICT DO NOTHING.
 * tenant_id проставляется автоматически (DEFAULT current_tenant_id()).
 */
const { getPool } = require('../db-pg');

// Идемпотентная запись прихода. Возвращает id новой операции или null, если такая
// уже была (ext_ref совпал). amount<=0 / нечисло — молча пропускаем (null).
async function recordCashIn({ category, amount, method = 'mono', ref_type = null, ref_id = null, master_id = null, description = null, ext_ref, db }) {
  if (!ext_ref) throw new Error('cash-ledger: ext_ref обязателен для идемпотентности');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const q = db || getPool();
  const r = await q.query(
    `INSERT INTO cash_operations
       (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, ext_ref)
     VALUES (NULL, 'in', $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [category, amt, method, ref_type, ref_id, master_id, description, ext_ref]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

// Идемпотентная запись расхода (сторно/возврат) — симметрична recordCashIn.
// Используется для компенсирующих операций: анулирование сертификата и т.п.
async function recordCashOut({ category, amount, method = 'cash', ref_type = null, ref_id = null, master_id = null, description = null, ext_ref, db }) {
  if (!ext_ref) throw new Error('cash-ledger: ext_ref обязателен для идемпотентности');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return null;
  const q = db || getPool();
  const r = await q.query(
    `INSERT INTO cash_operations
       (shift_id, type, category, amount, method, ref_type, ref_id, master_id, description, ext_ref)
     VALUES (NULL, 'out', $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (ext_ref) WHERE ext_ref IS NOT NULL DO NOTHING
     RETURNING id`,
    [category, amt, method, ref_type, ref_id, master_id, description, ext_ref]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

module.exports = { recordCashIn, recordCashOut };
