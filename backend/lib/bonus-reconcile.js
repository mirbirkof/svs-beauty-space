/* lib/bonus-reconcile.js — звірка нарахованого кешбеку з реальністю візитів.
 *
 * Аудит 25.07: кешбек відкликався ТІЛЬКИ в ручному /cancel-payment. Якщо візит скасували
 * будь-яким іншим шляхом (синхронізація з стара CRM, зміна статусу в журналі, видалення),
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
        // Аудит 13.08: раніше тут мінявся ЛИШЕ balance → лічильник total_redeemed
        // залишався старим і зведення «нараховано / списано за весь час» брехало
        // (знайдено 46 клієнтів з розбіжністю). Тепер сторно теж потрапляє в лічильник,
        // тож формула balance = нараховано − списано − згоріло сходиться завжди.
        await client.query(
          `UPDATE bonus_balances
              SET balance = GREATEST(COALESCE(balance,0) - $2, 0),
                  total_redeemed = COALESCE(total_redeemed,0) + $2,
                  updated_at = NOW()
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

/**
 * Аудит 13.08: лічильники bonus_balances (total_accrued/total_redeemed/total_expired)
 * інкрементуються окремими UPDATE-ами і можуть розійтися з журналом bonus_transactions
 * (знайдено клієнта #365: баланс 124.23 при total_accrued 105.59 — «нараховано менше,
 * ніж на балансі»). Гроші від цього не течуть — реальне зобовʼязання салону це balance,
 * і воно збігалося з журналом до копійки, — але зведення в кабінеті («нараховано за
 * весь час») показувало неправду.
 *
 * Лікуємо перерахунком лічильників ІЗ ЖУРНАЛУ. balance НЕ чіпаємо навмисно: він —
 * єдине джерело правди по грошах, і його правильність перевірена звіркою з журналом.
 * Ідемпотентно, безпечно запускати скільки завгодно разів.
 */
async function reconcileBonusCounters({ dryRun = false } = {}) {
  const pool = getPool();
  const DRIFT_SQL = `
    SELECT b.tenant_id, b.client_id, b.total_accrued, b.total_redeemed, b.total_expired,
           COALESCE(t.accrued, 0)  AS real_accrued,
           COALESCE(t.redeemed, 0) AS real_redeemed,
           COALESCE(t.expired, 0)  AS real_expired
      FROM bonus_balances b
      LEFT JOIN (
        SELECT client_id,
               SUM(amount) FILTER (WHERE amount > 0)                  AS accrued,
               -- Аудит 13.08 (регрес!): фільтр type='redemption' не існує в даних —
               -- реальні списання лежать під типами 'manual_deduct' та відʼємний 'adjust'.
               -- Перша версія цього перерахунку через це обнулила total_redeemed у 20 клієнтів.
               -- Правильно: списане = будь-яка відʼємна сума, крім згорання.
               -SUM(amount) FILTER (WHERE amount < 0 AND type <> 'expire') AS redeemed,
               -SUM(amount) FILTER (WHERE type = 'expire')            AS expired
          FROM bonus_transactions GROUP BY client_id
      ) t ON t.client_id = b.client_id
     WHERE ABS(b.total_accrued  - COALESCE(t.accrued, 0))  > 0.01
        OR ABS(b.total_redeemed - COALESCE(t.redeemed, 0)) > 0.01
        OR ABS(b.total_expired  - COALESCE(t.expired, 0))  > 0.01`;
  const rows = (await pool.query(DRIFT_SQL)).rows;
  if (dryRun || !rows.length) return { checked: rows.length, fixed: 0, preview: rows.slice(0, 10) };
  let fixed = 0;
  for (const r of rows) {
    await pool.query(
      `UPDATE bonus_balances
          SET total_accrued=$3, total_redeemed=$4, total_expired=$5, updated_at=NOW()
        WHERE tenant_id=$1 AND client_id=$2`,
      [r.tenant_id, r.client_id, r.real_accrued, r.real_redeemed, r.real_expired]);
    fixed++;
  }
  return { checked: rows.length, fixed };
}

module.exports = { reconcileBonusAccruals, reconcileBonusCounters };
