/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Orders API (Postgres)
   POST   /api/orders                — создать заказ (резерв остатков)
   GET    /api/orders/:id            — получить заказ + позиции
   GET    /api/orders                — список заказов клиента (по сессии)
   PATCH  /api/orders/:id/status     — смена статуса (admin)
   POST   /api/orders/:id/cancel     — отмена + возврат остатков
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool, applyTenant } = require('../db-pg');
const { authClient } = require('./cabinet-auth');
const { requirePerm } = require('../lib/rbac');

const STATUSES = ['new', 'paid', 'packing', 'shipped', 'delivered', 'cancelled', 'refunded'];

// ── создать заказ ───────────────────────────────────────
router.post('/', authClient({ optional: true }), async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { items, delivery, notes, contact, promo_code } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'no-items' });
    }

    await client.query('BEGIN'); await applyTenant(client);

    // клиент: либо из сессии, либо guest по телефону
    let clientId = req.client?.id || null;
    if (!clientId) {
      if (!contact?.phone) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'phone-required' });
      }
      // нормализация телефона: единый формат +380XXXXXXXXX (как в waitlist/booking)
      const digits = String(contact.phone).replace(/\D/g, '');
      let phone;
      if (digits.length === 12 && digits.startsWith('380')) phone = '+' + digits;
      else if (digits.length === 10 && digits.startsWith('0')) phone = '+38' + digits;
      else if (digits.length === 9) phone = '+380' + digits;
      else phone = '+' + digits;
      const upd = await client.query(
        `INSERT INTO clients (phone, name, source)
         VALUES ($1, $2, 'shop-guest')
         ON CONFLICT (tenant_id, phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, clients.name)
         RETURNING id`,
        [phone, contact.name || null]
      );
      clientId = upd.rows[0].id;
    }

    // расчёт суммы сервер-сайд (никогда не доверяем клиенту)
    let total = 0;
    let wholesaleTotal = 0;
    const lines = [];
    for (const it of items) {
      const v = await client.query(
        `SELECT pv.id, pv.price, pv.wholesale, pv.volume, pv.stock_qty, pv.reserved_qty,
                p.name AS product_name
         FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
         WHERE pv.id = $1 AND pv.active = true
         FOR UPDATE OF pv`,
        [it.variant_id]
      );
      if (v.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'variant-not-found', variant_id: it.variant_id });
      }
      const row = v.rows[0];
      const qty = Math.max(1, parseInt(it.qty || 1, 10));
      const available = (row.stock_qty || 0) - (row.reserved_qty || 0);
      // мягкая проверка: разрешаем preorder если stock_qty не задан (NULL/0)
      if (row.stock_qty != null && row.stock_qty > 0 && qty > available) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'insufficient-stock',
          variant_id: row.id,
          available,
        });
      }
      const unit = Number(row.price);
      total += unit * qty;
      wholesaleTotal += Number(row.wholesale || 0) * qty;
      lines.push({
        variant_id: row.id,
        product_name: row.product_name,
        volume: row.volume,
        qty,
        unit_price: unit,
        line_total: unit * qty,
      });

      // резерв
      await client.query(
        `UPDATE product_variants SET reserved_qty = COALESCE(reserved_qty,0) + $1 WHERE id = $2`,
        [qty, row.id]
      );
    }

    // промокод: применяется ЗДЕСЬ, сервер-сайд, атомарно (uses++ и проверка лимита одним UPDATE)
    let discount = 0;
    let appliedPromo = null;
    if (promo_code) {
      const claim = await client.query(
        `UPDATE promos SET uses = COALESCE(uses, 0) + 1
         WHERE code = $1 AND active = TRUE
           AND (valid_until IS NULL OR valid_until > NOW())
           AND (max_uses IS NULL OR COALESCE(uses, 0) < max_uses)
           AND COALESCE(min_total, 0) <= $2
         RETURNING code, type, value`,
        [String(promo_code).toUpperCase().trim(), total]
      );
      if (!claim.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid-promo' });
      }
      const pr = claim.rows[0];
      discount = pr.type === 'percent'
        ? Math.round(total * Number(pr.value)) / 100
        : Math.min(Number(pr.value), total);
      discount = Math.round(discount * 100) / 100;
      total = Math.round((total - discount) * 100) / 100;
      appliedPromo = pr.code;
    }

    // создаём заказ (branch_id: из body или дефолтный)
    const ord = await client.query(
      `INSERT INTO orders (client_id, total, wholesale_total, status, payment_method,
                           delivery_type, delivery_json, notes, branch_id, promo_code, discount)
       VALUES ($1,$2,$3,'new','mono',$4,$5,$6,
               COALESCE($7, (SELECT id FROM branches WHERE is_default = true LIMIT 1)),
               $8, $9)
       RETURNING id, created_at, status, branch_id`,
      [
        clientId,
        total,
        wholesaleTotal,
        delivery?.type || 'pickup',
        delivery ? JSON.stringify(delivery) : null,
        notes || null,
        req.body?.branch_id || null,
        appliedPromo,
        discount,
      ]
    );
    const orderId = ord.rows[0].id;

    for (const ln of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, variant_id, product_name, volume, qty, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [orderId, ln.variant_id, ln.product_name, ln.volume, ln.qty, ln.unit_price, ln.line_total]
      );
    }

    await client.query('COMMIT');
    // алерт Боссу в Telegram (fire-and-forget — не блокируем ответ клиенту)
    try {
      const { notifyAdminNewOrder } = require('./telegram-notify');
      notifyAdminNewOrder(orderId).catch(e => console.error('[notify-admin]', e.message));
    } catch (e) { console.error('[notify-admin:load]', e.message); }

    // Mono: сразу создаём инвойс и шлём ссылку клиенту в TG (заказ создан даже если Mono упал)
    let payUrl = null;
    if (process.env.MONO_TOKEN) {
      try {
        const monoPay = require('./payments-mono');
        const inv = await monoPay.createInvoiceForOrder(orderId);
        payUrl = inv.pageUrl;
        monoPay.sendPayLinkToClient(orderId, payUrl).catch(() => {});
      } catch (e) { console.error('[orders:mono-invoice]', e.message); }
    }

    res.status(201).json({
      ok: true,
      order: {
        id: orderId,
        client_id: clientId,
        total,
        status: 'new',
        items: lines,
        created_at: ord.rows[0].created_at,
        pay_url: payUrl,
        next: payUrl ? 'pay-with-mono' : 'mono-unavailable-retry-via-/api/pay/mono/invoice',
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[orders:create]', e);
    res.status(500).json({ error: 'internal', detail: e.message });
  } finally {
    client.release();
  }
});

// ── получить заказ ──────────────────────────────────────
router.get('/:id', authClient({ optional: true }), async (req, res) => {
  try {
    const pool = getPool();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'bad-id' });
    const r = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    const order = r.rows[0];
    if (req.client && order.client_id !== req.client.id) {
      return res.status(403).json({ error: 'not-yours' });
    }
    const items = await pool.query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [id]
    );
    res.json({ ok: true, order: { ...order, items: items.rows } });
  } catch (e) {
    console.error('[orders:get]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── список заказов клиента ──────────────────────────────
router.get('/', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, total, status, payment_method, delivery_type, created_at
       FROM orders WHERE client_id = $1 ORDER BY id DESC LIMIT 100`,
      [req.client.id]
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    console.error('[orders:list]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── смена статуса (admin) ───────────────────────────────
router.patch('/:id/status', requirePerm('order.write'), async (req, res) => {
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad-status' });
  try {
    const pool = getPool();
    const r = await pool.query(
      `UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status`,
      [status, parseInt(req.params.id, 10)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, order: r.rows[0] });
  } catch (e) {
    console.error('[orders:status]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── отмена ──────────────────────────────────────────────
router.post('/:id/cancel', authClient({ optional: true }), async (req, res) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await applyTenant(client);
    const id = parseInt(req.params.id, 10);
    const r = await client.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [id]);
    if (r.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not-found' });
    }
    const order = r.rows[0];
    if (req.client && order.client_id !== req.client.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not-yours' });
    }
    if (['cancelled', 'refunded', 'delivered', 'shipped'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'cannot-cancel', status: order.status });
    }
    // возврат остатков: для оплаченного заказа товар уже списан со склада → восстанавливаем stock_qty;
    // для нового (ещё не оплачен) — только снимаем резерв.
    const stockTaken = ['paid', 'packing'].includes(order.status);
    const items = await client.query(`SELECT variant_id, qty FROM order_items WHERE order_id = $1`, [id]);
    for (const it of items.rows) {
      if (it.variant_id == null) continue;
      if (stockTaken) {
        await client.query(
          `UPDATE product_variants SET stock_qty = COALESCE(stock_qty,0) + $1 WHERE id = $2`,
          [it.qty, it.variant_id]
        );
        await client.query(
          `INSERT INTO stock_movements (variant_id, delta, reason, ref_id)
           VALUES ($1, $2, $3, $4)`,
          [it.variant_id, it.qty, `cancel:order:${id}`, id]
        );
      } else {
        await client.query(
          `UPDATE product_variants SET reserved_qty = GREATEST(0, COALESCE(reserved_qty,0) - $1) WHERE id = $2`,
          [it.qty, it.variant_id]
        );
      }
    }
    await client.query(`UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [id]);
    await client.query('COMMIT');
    res.json({ ok: true, status: 'cancelled' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[orders:cancel]', e);
    res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

module.exports = router;
