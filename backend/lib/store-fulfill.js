/* SLS-11 этап 4: онлайн-заказ витрины обслуживает склад МАГАЗИНА (если владелец включил режим).
 *
 * Принцип безопасности: fail-safe. Если режим выключен, товара не хватает или что-то пошло
 * не так — возвращаем false, и вызывающий код списывает со склада салона как исторически.
 * Заказ клиента НИКОГДА не падает из-за этого модуля.
 *
 * Обе функции работают ВНУТРИ уже открытой транзакции вызывающего роута (client), поэтому
 * при откате заказа откатывается и продажа магазина — половинчатых состояний не бывает.
 */
const ONLINE_KEY = 'store_fulfills_online';

async function isOnlineMode() {
  try {
    const v = await require('./settings').getSetting(ONLINE_KEY, false);
    return v === true || v === 'true';
  } catch (e) { console.error('[store-fulfill] не вдалося перевірити режим магазину (вважаю вимкненим):', e.message); return false; }
}

/** Пытается выдать заказ со склада магазина. true — выдал (салон не трогать), false — пусть выдаёт салон. */
async function fulfillFromStore(client, orderId, items) {
  try {
    if (!(await isOnlineMode())) return false;
    const rows = [];
    for (const it of items) {
      if (it.variant_id == null) return false;
      const st = (await client.query(
        `SELECT ws.qty, ws.avg_cost, v.price
           FROM warehouse_stock ws JOIN product_variants v ON v.id = ws.variant_id
          WHERE ws.variant_id=$1 AND ws.warehouse_id='store' FOR UPDATE OF ws`, [it.variant_id])).rows[0];
      if (!st || Number(st.qty) < Number(it.qty)) return false;  // не хватает — отдаёт салон
      rows.push({ variant_id: it.variant_id, qty: Number(it.qty), cost: Number(st.avg_cost) || 0, price: Number(st.price) || 0 });
    }
    const sale = (await client.query(
      `INSERT INTO store_sales (sale_type, channel, order_id, notes, created_by)
       VALUES ('retail','online',$1,$2,'online') RETURNING id`,
      [orderId, `Онлайн-замовлення #${orderId}`])).rows[0];
    let total = 0, cost = 0;
    for (const r of rows) {
      total += r.qty * r.price; cost += r.qty * r.cost;
      await client.query(
        `INSERT INTO store_sale_items (sale_id, variant_id, qty, unit_price, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
        [sale.id, r.variant_id, r.qty, r.price, r.cost]);
      await client.query(
        `UPDATE warehouse_stock SET qty = qty - $2, updated_at = NOW()
          WHERE variant_id=$1 AND warehouse_id='store'`, [r.variant_id, r.qty]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:sale_online',$3,$4,'store')`,
        [r.variant_id, -r.qty, orderId, `Онлайн-замовлення #${orderId}`]);
    }
    // онлайн оплачен сразу → долга нет
    await client.query(
      `UPDATE store_sales SET total_amount=$2, total_cost=$3, paid_amount=$2 WHERE id=$1`,
      [sale.id, total, cost]);
    return true;
  } catch (e) {
    console.error('[store-fulfill] выдача со склада магазина не удалась, отдаёт салон:', e.message);
    return false;
  }
}

/** Возврат отменённого онлайн-заказа НА СКЛАД МАГАЗИНА. true — вернули (салон не трогать). */
async function revertToStore(client, orderId) {
  try {
    const sale = (await client.query(
      `SELECT id FROM store_sales WHERE order_id=$1 AND status='active' FOR UPDATE`, [orderId])).rows[0];
    if (!sale) return false;
    const items = (await client.query(
      `SELECT variant_id, qty FROM store_sale_items WHERE sale_id=$1`, [sale.id])).rows;
    for (const it of items) {
      await client.query(
        `UPDATE warehouse_stock SET qty = qty + $2, updated_at = NOW()
          WHERE variant_id=$1 AND warehouse_id='store'`, [it.variant_id, it.qty]);
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
         VALUES ($1,$2,'store:sale_online_cancel',$3,$4,'store')`,
        [it.variant_id, it.qty, orderId, `Скасування замовлення #${orderId}`]);
    }
    await client.query(`UPDATE store_sales SET status='cancelled' WHERE id=$1`, [sale.id]);
    return true;
  } catch (e) {
    console.error('[store-fulfill] возврат на склад магазина не удался:', e.message);
    return false;
  }
}

module.exports = { isOnlineMode, fulfillFromStore, revertToStore };
