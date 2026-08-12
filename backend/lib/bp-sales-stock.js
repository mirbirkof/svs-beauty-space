/* lib/bp-sales-stock.js — списання складу за продажами з синхронізацію зі старою CRMу.
 *
 * Аудит 25.07: продажі товарів, що приходили з стара CRM (salon_product_sales),
 * писались у виручку, але НЕ чіпали склад — залишки завищувались із кожним чеком.
 * Причина: імпортований реєстр salon_stock не був звʼязаний із живим product_variants.
 * Після міграції 280 звʼязок є → нові продажі списуються автоматично.
 *
 * СВІДОМЕ рішення: історію (315 продажів до 25.07.2026) НЕ списуємо заднім числом.
 * Склад не має стартової інвентаризації, і мінус 10 718 одиниць зробив би залишки
 * фікцією (правило Боса: «головне не зробити гірше»). Правда відновлюється однією
 * реальною інвентаризацією, далі система тримає її сама.
 *
 * Ідемпотентно: рух позначається reason 'bp-sale:<sps.id>' — повторний синк не задвоїть.
 */
const { getPool } = require('../db-pg');

const CUTOFF = '2026-07-25'; // продажі до цієї дати — історія, не списуємо

async function writeOffBpSales() {
  const pool = getPool();
  const rows = (await pool.query(
    `SELECT sps.id, sps.qty, ss.variant_id
       FROM salon_product_sales sps
       JOIN salon_stock ss ON ss.id = sps.stock_id AND ss.variant_id IS NOT NULL
      WHERE sps.sale_date >= $1::date
        AND NOT EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.reason = 'bp-sale:' || sps.id)`,
    [CUTOFF])).rows;
  let written = 0;
  for (const r of rows) {
    const qty = Number(r.qty || 0);
    if (!(qty > 0)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE product_variants pv
            SET stock_qty = GREATEST(COALESCE(pv.stock_qty,0) - $1, 0)
           FROM (SELECT id, COALESCE(stock_qty,0) AS before_qty
                   FROM product_variants WHERE id = $2 FOR UPDATE) old
          WHERE pv.id = old.id
          RETURNING old.before_qty`, [qty, r.variant_id]);
      const before = Number(upd.rows[0]?.before_qty ?? 0);
      const deducted = Math.min(qty, before); // delta = фактично списане (правило 25.07)
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
         VALUES ($1, $2, 'bp-sale:' || $3, $3, $4)`,
        [r.variant_id, -deducted, r.id,
         `продаж товару (стара CRM чек); заявлено ${qty}` + (qty > before ? `; нестача ${+(qty - before).toFixed(3)}` : '')]);
      await client.query('COMMIT');
      written++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn('[bp-sales-stock] пропущено продаж', r.id, e.message);
    } finally { client.release(); }
  }
  return { candidates: rows.length, written };
}

module.exports = { writeOffBpSales };
