/* Списание расходников со склада при выполнении услуги (SAL-08).
   Идемпотентно: appointments.stock_written_off защищает от двойного списания. */
const { getPool, applyTenant } = require('../db-pg');
const pool = getPool();

/**
 * Списать расходники для выполненной записи.
 * @param {number} apptId
 * @returns {Promise<{written:boolean, items:number, reason?:string}>}
 */
async function writeOffForAppointment(apptId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyTenant(client); // изоляция тенанта в ручной транзакции
    // блокируем запись, читаем услугу и флаг
    const a = await client.query(
      `SELECT id, service_id, stock_written_off FROM appointments WHERE id=$1 FOR UPDATE`,
      [apptId]
    );
    if (!a.rows[0]) { await client.query('ROLLBACK'); return { written: false, items: 0, reason: 'not-found' }; }
    if (a.rows[0].stock_written_off) { await client.query('ROLLBACK'); return { written: false, items: 0, reason: 'already' }; }

    // Заметка #105: фактичні матеріали візиту (appointment_materials) мають
    // пріоритет над нормами service_consumables — списуємо саме їх.
    const mats = await client.query(
      `SELECT variant_id, qty_used FROM appointment_materials WHERE appointment_id=$1`,
      [apptId]
    );
    if (mats.rows.length) {
      let written = 0;
      for (const m of mats.rows) {
        const qty = Math.ceil(Number(m.qty_used)); // stock_qty/delta — цілі числа, округляємо вгору
        if (qty <= 0) continue;
        // мінус БЕЗ обмеження нулем: склад може відставати від факту,
        // відʼємний залишок сигналізує про недооблік, а не блокує списання
        await client.query(
          `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) - $1 WHERE id=$2`,
          [qty, m.variant_id]
        );
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [m.variant_id, -qty, 'service:' + apptId, apptId, 'списання матеріалів візиту (#105)']
        );
        written++;
      }
      await client.query(`UPDATE appointments SET stock_written_off=TRUE WHERE id=$1`, [apptId]);
      await client.query('COMMIT');
      return { written: true, items: written, source: 'materials' };
    }

    const serviceId = a.rows[0].service_id;
    if (!serviceId) { await client.query('ROLLBACK'); return { written: false, items: 0, reason: 'no-service' }; }

    const cons = await client.query(
      `SELECT variant_id, qty_per_use FROM service_consumables WHERE service_id=$1`,
      [serviceId]
    );
    let written = 0;
    for (const c of cons.rows) {
      const qty = Math.ceil(Number(c.qty_per_use)); // склад в штуках — округляем вверх
      if (qty <= 0) continue;
      await client.query(
        `UPDATE product_variants SET stock_qty = GREATEST(stock_qty - $1, 0) WHERE id=$2`,
        [qty, c.variant_id]
      );
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [c.variant_id, -qty, 'service:' + apptId, apptId, 'списание расходника по услуге']
      );
      written++;
    }
    await client.query(`UPDATE appointments SET stock_written_off=TRUE WHERE id=$1`, [apptId]);
    await client.query('COMMIT');
    return { written: true, items: written };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { writeOffForAppointment };
