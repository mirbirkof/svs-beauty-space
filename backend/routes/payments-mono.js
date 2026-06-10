/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Mono Acquiring (M29 Payment Gateway)

   POST /api/pay/mono/invoice          {order_id} → создать/вернуть инвойс
   POST /api/pay/mono/webhook          ← Mono (X-Sign verified)
   GET  /api/pay/mono/status/:orderId  → статус оплаты (с live-поллингом)
   GET  /api/pay/mono/health           → конфиг/мерчант

   Страховка от ротации туннеля: вебхук может не дойти →
   cron каждые 3 мин поллит pending-инвойсы напрямую у Mono.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const mono = require('../lib/mono');

const FINAL = ['success', 'failure', 'reversed', 'expired'];

// ── применить статус инвойса (вебхук И поллинг идут сюда — один путь) ──
async function applyInvoiceStatus(data) {
  const pool = getPool();
  const invoiceId = data.invoiceId;
  if (!invoiceId) return { ok: false, reason: 'no-invoice-id' };

  const cur = await pool.query(
    `SELECT id, order_id, status FROM payments WHERE provider = 'mono' AND invoice_id = $1`,
    [invoiceId]
  );
  if (!cur.rowCount) return { ok: false, reason: 'unknown-invoice' };
  const p = cur.rows[0];

  // финальный статус уже зафиксирован — идемпотентность (вебхук может прийти повторно)
  if (FINAL.includes(p.status)) return { ok: true, status: p.status, dedup: true };
  if (p.status === data.status) return { ok: true, status: p.status, unchanged: true };

  await pool.query(
    `UPDATE payments SET status = $1, failure_reason = $2, raw = $3, updated_at = NOW() WHERE id = $4`,
    [data.status, data.failureReason || null, JSON.stringify(data), p.id]
  );

  if (data.status === 'success') {
    const upd = await pool.query(
      `UPDATE orders SET status = 'paid', updated_at = NOW()
       WHERE id = $1 AND status = 'new' RETURNING id`,
      [p.order_id]
    );
    if (upd.rowCount) {
      // уведомления fire-and-forget
      try {
        const { notifyOrderStatus, tgSend } = require('./telegram-notify');
        notifyOrderStatus(p.order_id, 'paid').catch(e => console.error('[mono:notify-client]', e.message));
        if (process.env.ADMIN_TG_CHAT) {
          tgSend(process.env.ADMIN_TG_CHAT,
            `💳 <b>Оплачено замовлення №${p.order_id}</b>\nMono: ${(data.amount / 100).toFixed(2)} грн`)
            .catch(e => console.error('[mono:notify-admin]', e.message));
        }
      } catch (e) { console.error('[mono:notify:load]', e.message); }
    }
  } else if (['failure', 'expired', 'reversed'].includes(data.status)) {
    console.log(`[mono] invoice ${invoiceId} → ${data.status} (order ${p.order_id})`);
  }
  return { ok: true, status: data.status };
}

// ── создать инвойс для заказа (вызывается и из orders.js) ──
async function createInvoiceForOrder(orderId) {
  const pool = getPool();
  const r = await pool.query(`SELECT id, total, status FROM orders WHERE id = $1`, [orderId]);
  if (!r.rowCount) { const e = new Error('order-not-found'); e.code = 404; throw e; }
  const order = r.rows[0];
  if (order.status !== 'new') { const e = new Error(`order-status-${order.status}`); e.code = 409; throw e; }

  // идемпотентность: живой pending-инвойс возвращаем повторно
  const existing = await pool.query(
    `SELECT invoice_id, page_url, status FROM payments
     WHERE order_id = $1 AND provider = 'mono'
       AND status IN ('created','processing','hold')
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  if (existing.rowCount && existing.rows[0].page_url) {
    return { invoiceId: existing.rows[0].invoice_id, pageUrl: existing.rows[0].page_url, reused: true };
  }

  const items = await pool.query(
    `SELECT product_name AS name, qty, unit_price, line_total FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  const inv = await mono.createInvoice({
    amountUah: order.total,
    orderId,
    basket: items.rows,
  });
  await pool.query(
    `INSERT INTO payments (order_id, provider, invoice_id, page_url, amount, status)
     VALUES ($1, 'mono', $2, $3, $4, 'created')`,
    [orderId, inv.invoiceId, inv.pageUrl, order.total]
  );
  return { invoiceId: inv.invoiceId, pageUrl: inv.pageUrl };
}

// ── отправить клиенту ссылку на оплату в TG (если привязан) ──
async function sendPayLinkToClient(orderId, pageUrl) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT c.telegram_id, o.total FROM orders o LEFT JOIN clients c ON c.id = o.client_id WHERE o.id = $1`,
    [orderId]
  );
  if (!r.rowCount || !r.rows[0].telegram_id) return { ok: false, reason: 'no-telegram-id' };
  const { tgSend } = require('./telegram-notify');
  await tgSend(r.rows[0].telegram_id,
    `<b>Замовлення №${orderId}</b>\nСума: ${Math.round(r.rows[0].total)} грн\n\nОплатіть онлайн через Mono:`,
    { reply_markup: { inline_keyboard: [[{ text: '💳 Оплатити', url: pageUrl }]] } });
  return { ok: true };
}

// ── HTTP: создать инвойс ──
router.post('/invoice', async (req, res) => {
  try {
    const orderId = parseInt(req.body?.order_id, 10);
    if (!orderId) return res.status(400).json({ error: 'order-id-required' });
    const inv = await createInvoiceForOrder(orderId);
    sendPayLinkToClient(orderId, inv.pageUrl).catch(() => {});
    res.json({ ok: true, order_id: orderId, invoice_id: inv.invoiceId, pay_url: inv.pageUrl, reused: !!inv.reused });
  } catch (e) {
    console.error('[mono:invoice]', e.message);
    res.status(e.code || 502).json({ error: e.message });
  }
});

// ── HTTP: вебхук от Mono (требует req.rawBody — см. shop-api.js) ──
router.post('/webhook', async (req, res) => {
  try {
    const ok = await mono.verifyWebhook(req.rawBody, req.get('X-Sign'));
    if (!ok) {
      console.error('[mono:webhook] bad signature, ip=', req.ip);
      return res.status(403).json({ error: 'bad-signature' });
    }
    const result = await applyInvoiceStatus(req.body || {});
    res.json(result); // 200 всегда при валидной подписи — иначе Mono ретраит
  } catch (e) {
    console.error('[mono:webhook]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── HTTP: статус оплаты заказа (+ live-поллинг если pending) ──
router.get('/status/:orderId', async (req, res) => {
  try {
    const pool = getPool();
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'bad-id' });
    const r = await pool.query(
      `SELECT invoice_id, page_url, status, amount, updated_at FROM payments
       WHERE order_id = $1 AND provider = 'mono' ORDER BY id DESC LIMIT 1`,
      [orderId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'no-payment' });
    let p = r.rows[0];
    // вебхук мог потеряться (ротация туннеля) — спрашиваем Mono напрямую
    if (!FINAL.includes(p.status)) {
      try {
        const live = await mono.getInvoiceStatus(p.invoice_id);
        if (live.status && live.status !== p.status) {
          await applyInvoiceStatus(live);
          p = { ...p, status: live.status };
        }
      } catch (e) { console.error('[mono:status:poll]', e.message); }
    }
    res.json({ ok: true, order_id: orderId, payment: p });
  } catch (e) {
    console.error('[mono:status]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/health', async (req, res) => {
  try {
    const merchant = await mono.getMerchantDetails();
    res.json({ ok: true, configured: true, merchant: merchant.merchantName, public_base: mono.getPublicBase() });
  } catch (e) {
    res.status(503).json({ ok: false, configured: !!process.env.MONO_TOKEN, error: e.message });
  }
});

// ── cron: поллинг pending-инвойсов (страховка от потерянных вебхуков) ──
let _cronTimer = null;
function startCron() {
  if (_cronTimer) return;
  _cronTimer = setInterval(async () => {
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT invoice_id FROM payments
         WHERE provider = 'mono' AND status IN ('created','processing','hold')
           AND created_at > NOW() - INTERVAL '25 hours'
         LIMIT 50`
      );
      for (const row of r.rows) {
        try {
          const live = await mono.getInvoiceStatus(row.invoice_id);
          await applyInvoiceStatus(live);
        } catch (e) { console.error('[mono:cron]', row.invoice_id, e.message); }
      }
    } catch (e) { console.error('[mono:cron]', e.message); }
  }, 3 * 60 * 1000);
  _cronTimer.unref();
  console.log('[mono] pending-invoice poller started (3 min)');
}

module.exports = router;
module.exports.createInvoiceForOrder = createInvoiceForOrder;
module.exports.sendPayLinkToClient = sendPayLinkToClient;
module.exports.applyInvoiceStatus = applyInvoiceStatus;
module.exports.startCron = startCron;
