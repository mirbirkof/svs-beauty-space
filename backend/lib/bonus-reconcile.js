/* lib/bonus-reconcile.js — звірка нарахованого кешбеку з реальністю візитів.
 *
 * Аудит 25.07: кешбек відкликався ТІЛЬКИ в ручному /cancel-payment. Якщо візит скасували
 * будь-яким іншим шляхом (синхронізація з BeautyPro, зміна статусу в журналі, видалення),
 * нарахування лишалось живим і доступним до списання: 31 нарахування = 1 735 бонусів
 * (17% усього зобовʼязання салону) висіли на скасованих візитах. Плюс 6 нарахувань (273)
 * посилались на записи, яких уже нема в базі.
 *
 * Підхід — не «не забути відкликати в кожній точці коду» (так і зʼявилась діра), а звірка:
 * будь-яке нарахування, чий візит більше не виконаний, компенсується сторно-транзакцією.
 * Ідемпотентно: сторно позначається у description, повторний запуск його не задвоює.
 * Списані клієнтом бонуси не забираємо в мінус — гасимо лише те, що ще лишилось (remaining).
 */
const { getPool } = require('../db-pg');

// Нарахування, чий візит скасовано / зник, і які ще не сторновані
const ORPHAN_SQL = `
  SELECT bt.id, bt.client_id, bt.amount, bt.remaining, bt.source_id,
         COALESCE(a.status, '(видалено)') AS appt_status
    FROM bonus_transactions bt
    LEFT JOIN appointments a ON a.id = bt.source_id
   WHERE bt.type = 'accrual'
     AND bt.source_type = 'appointment'
     AND COALESCE(bt.description, '') NOT LIKE '%[сторновано звіркою]%'
     AND (a.id IS NULL OR a.status IN ('cancelled', 'noshow'))`;

/**
 * Відкликати кешбек по скасованих/зниклих візитах.
 * @param {boolean} dryRun — тільки порахувати, нічого не змінювати
 */
async function reconcileBonusAccruals({ dryRun = false } = {}) {
  const pool = getPool();
  const rows = (await pool.query(ORPHAN_SQL)).rows;
  if (!rows.length) return { checked: 0, revoked: 0, bonuses: 0 };
  if (dryRun) {
    return {
      checked: rows.length, revoked: 0,
      bonuses: Math.round(rows.reduce((s, r) => s + Number(r.remaining || 0), 0)),
      preview: rows.slice(0, 10),
    };
  }

  let revoked = 0, bonuses = 0;
  for (const r of rows) {
    // гасимо лише невитрачений залишок — клієнта в мінус не заганяємо
    const left = Math.max(0, Number(r.remaining || 0));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (left > 0) {
        await client.query(
          `INSERT INTO bonus_transactions (client_id, type, amount, remaining, source_type, source_id, description)
           VALUES ($1, 'adjust', $2, 0, 'reconcile', $3, $4)`,
          [r.client_id, -left, r.source_id,
           `Зняття кешбеку: візит #${r.source_id} ${r.appt_status} (звірка)`]);
        await client.query(
          `UPDATE bonus_balances SET balance = GREATEST(COALESCE(balance,0) - $2, 0), updated_at = NOW()
            WHERE client_id = $1`, [r.client_id, left]);
        await client.query(`UPDATE bonus_transactions SET remaining = 0 WHERE id = $1`, [r.id]);
        bonuses += left;
      }
      // мітка: більше цю транзакцію звірка не чіпає (і source_id відвʼязуємо, щоб
      // dup-guard не віддав старе нарахування при повторній оплаті того ж візиту)
      await client.query(
        `UPDATE bonus_transactions
            SET description = COALESCE(description,'') || ' [сторновано звіркою]', source_id = NULL
          WHERE id = $1`, [r.id]);
      await client.query('COMMIT');
      revoked++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn('[bonus-reconcile] пропущено tx', r.id, e.message);
    } finally { client.release(); }
  }
  return { checked: rows.length, revoked, bonuses: Math.round(bonuses) };
}

module.exports = { reconcileBonusAccruals };
