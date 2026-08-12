'use strict';
/**
 * Приёмка поставки на склад МАГАЗИНА — единая точка.
 *
 * Зачем отдельный модуль (12.08): приход на склад магазина заводится двумя путями —
 * руками (форма «Приймання поставки») и накладной файлом/фото (импорт документов).
 * Если бы логика жила только в роуте, второй путь пришлось бы копировать — и она бы
 * разъехалась: доставка в себестоимости, средневзвешенная цена, движения склада.
 * Поэтому расчёт один, вызывают его оба входа.
 *
 * Доставка размазывается по позициям пропорционально их стоимости (landed cost) —
 * решение Босса: «у магазина есть расход на доставку при каждой поставке».
 */

/**
 * @param {object} client — подключение pg В ОТКРЫТОЙ ТРАНЗАКЦИИ (BEGIN делает вызывающий)
 * @param {object} p
 * @param {string} [p.supplier_name]
 * @param {string} p.doc_date        YYYY-MM-DD
 * @param {number} [p.delivery_cost] стоимость доставки всей поставки
 * @param {string} [p.notes]
 * @param {string} [p.created_by]
 * @param {Array}  p.items           [{variant_id, qty, unit_cost}]
 * @returns {Promise<{receipt_id:number, goods_total:number, delivery_cost:number, lines:number}>}
 */
async function createStoreReceipt(client, p) {
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) throw Object.assign(new Error('порожній список позицій'), { user: true });
  if (!p.doc_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.doc_date)))
    throw Object.assign(new Error('doc_date обовʼязкова (YYYY-MM-DD)'), { user: true });

  const dc = Number(p.delivery_cost) || 0;
  if (dc < 0) throw Object.assign(new Error('delivery_cost не може бути відʼємною'), { user: true });

  for (const it of items) {
    if (!it.variant_id || !(Number(it.qty) > 0) || !(Number(it.unit_cost) >= 0))
      throw Object.assign(new Error('позиція: потрібні variant_id, qty>0, unit_cost>=0'), { user: true });
  }

  const goodsTotal = items.reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
  const rec = (await client.query(
    `INSERT INTO store_receipts (supplier_name, doc_date, goods_total, delivery_cost, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.supplier_name || null, p.doc_date, goodsTotal, dc, p.notes || null, p.created_by || null]
  )).rows[0];

  for (const it of items) {
    const qty = Number(it.qty), cost = Number(it.unit_cost);
    // landed cost: доля доставки пропорционально стоимости позиции
    const landed = goodsTotal > 0 ? cost * (1 + dc / goodsTotal) : cost;
    await client.query(
      `INSERT INTO store_receipt_items (receipt_id, variant_id, qty, unit_cost, landed_unit_cost)
       VALUES ($1,$2,$3,$4,$5)`,
      [rec.id, it.variant_id, qty, cost, landed]);
    // средневзвешенная себестоимость остатка (SET считаются от старой строки — порядок безопасен)
    await client.query(
      `INSERT INTO warehouse_stock (variant_id, warehouse_id, qty, avg_cost)
       VALUES ($1,'store',$2,$3)
       ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET
         avg_cost = CASE WHEN warehouse_stock.qty + EXCLUDED.qty > 0
           THEN (warehouse_stock.qty * warehouse_stock.avg_cost + EXCLUDED.qty * EXCLUDED.avg_cost)
                / (warehouse_stock.qty + EXCLUDED.qty)
           ELSE EXCLUDED.avg_cost END,
         qty = warehouse_stock.qty + EXCLUDED.qty,
         updated_at = NOW()`,
      [it.variant_id, qty, landed]);
    await client.query(
      `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes, warehouse_id)
       VALUES ($1,$2,'store:receipt',$3,$4,'store')`,
      [it.variant_id, qty, rec.id,
       `Поставка ${p.doc_date}${p.supplier_name ? ' — ' + String(p.supplier_name).slice(0, 80) : ''}`]);
  }

  return {
    receipt_id: rec.id,
    goods_total: Math.round(goodsTotal * 100) / 100,
    delivery_cost: dc,
    lines: items.length,
  };
}

module.exports = { createStoreReceipt };
