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
        // #109: qty_used у грамах/мл — списуємо ТОЧНЕ дробове значення (stock_qty NUMERIC з міграції 199)
        const qty = Number(m.qty_used);
        if (!Number.isFinite(qty) || qty <= 0) continue; // від'ємне/нульове списання заборонено
        // кламп нулем (уніфіковано з гілкою нижче): склад не йде в мінус,
        // а фактичну нестачу фіксуємо приміткою в stock_movements — правда про розхід не губиться
        const upd = await client.query(
          `UPDATE product_variants pv
              SET stock_qty = GREATEST(COALESCE(pv.stock_qty,0) - $1, 0)
             FROM (SELECT id, COALESCE(stock_qty,0) AS before_qty
                     FROM product_variants WHERE id=$2 FOR UPDATE) old
            WHERE pv.id = old.id
            RETURNING old.before_qty`,
          [qty, m.variant_id]
        );
        const before = Number(upd.rows[0]?.before_qty ?? 0);
        const shortage = qty > before ? +(qty - before).toFixed(3) : 0;
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
           VALUES ($1, $2, $3, $4, $5)`,
          [m.variant_id, -qty, 'service:' + apptId, apptId,
           'списання матеріалів візиту (#105/#109)' + (shortage ? `; нестача ${shortage}: факт розходу перевищив залишок` : '')]
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
      // #109: qty_per_use — дробові грами/мл, списуємо точно без округлення
      const qty = Number(c.qty_per_use);
      if (!Number.isFinite(qty) || qty <= 0) continue; // від'ємне/нульове списання заборонено
      const upd = await client.query(
        `UPDATE product_variants pv
            SET stock_qty = GREATEST(COALESCE(pv.stock_qty,0) - $1, 0)
           FROM (SELECT id, COALESCE(stock_qty,0) AS before_qty
                   FROM product_variants WHERE id=$2 FOR UPDATE) old
          WHERE pv.id = old.id
          RETURNING old.before_qty`,
        [qty, c.variant_id]
      );
      const before = Number(upd.rows[0]?.before_qty ?? 0);
      const shortage = qty > before ? +(qty - before).toFixed(3) : 0;
      await client.query(
        `INSERT INTO stock_movements (variant_id, delta, reason, ref_id, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [c.variant_id, -qty, 'service:' + apptId, apptId,
         'списание расходника по услуге' + (shortage ? `; нестача ${shortage}: факт розходу перевищив залишок` : '')]
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
