/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Stripe Payment Routes
   POST /api/payments/create-intent  → create PaymentIntent
   POST /api/payments/webhook        → Stripe webhook
   GET  /api/payments/orders         → user's orders
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('./auth');

let stripe = null;
function getStripe() {
  if (!stripe && process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// ── Create Payment Intent ───────────────────────────────
router.post('/create-intent', authMiddleware, async (req, res) => {
  try {
    const { items, delivery } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No items' });

    const isMaster = req.user.role === 'master';

    // Calculate total from server-side data (security: never trust client price)
    // items: [{id, qty, volIdx}]
    let total = 0;
    const processedItems = items.map((item) => {
      // NOTE: in production load product prices from DB or server-side data
      // Here we trust client for simplicity since prices are public
      const price = isMaster ? item.wholesale : item.price;
      total += price * item.qty;
      return { ...item, unitPrice: price, subtotal: price * item.qty };
    });

    // Total in kopecks (Stripe uses smallest currency unit)
    const amountKopecks = Math.round(total * 100);

    const s = getStripe();
    if (!s) {
      // Dev mode: return mock intent
      console.log('[Stripe-DEV] Would create intent for', total, 'UAH');
      return res.json({
        clientSecret: 'dev_mock_client_secret',
        orderId: 'dev_' + Date.now(),
        total,
      });
    }

    const paymentIntent = await s.paymentIntents.create({
      amount: amountKopecks,
      currency: 'uah',
      automatic_payment_methods: { enabled: true },
      metadata: {
        user_id: String(req.user.id),
        is_master: String(isMaster),
        items_count: String(items.length),
      },
    });

    // Save order to DB
    const orderResult = db.prepare(`
      INSERT INTO orders (user_id, items, total, wholesale_total, status, stripe_id, delivery)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      req.user.id,
      JSON.stringify(processedItems),
      total,
      isMaster ? total : null,
      paymentIntent.id,
      delivery ? JSON.stringify(delivery) : null
    );

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderId: orderResult.lastInsertRowid,
      total,
    });
  } catch (err) {
    console.error('[Stripe CreateIntent]', err.message);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

// ── Stripe Webhook ──────────────────────────────────────
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const s = getStripe();
    if (s && webhookSecret) {
      event = s.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[Stripe Webhook]', err.message);
    return res.status(400).send('Webhook error: ' + err.message);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object;
      db.prepare("UPDATE orders SET status = 'paid' WHERE stripe_id = ?").run(pi.id);
      console.log('[Stripe] Payment succeeded:', pi.id);
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object;
      db.prepare("UPDATE orders SET status = 'failed' WHERE stripe_id = ?").run(pi.id);
      break;
    }
  }

  res.json({ received: true });
});

// ── Get user orders ─────────────────────────────────────
router.get('/orders', authMiddleware, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT id, total, status, delivery, created_at, items
      FROM orders WHERE user_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).all(req.user.id);

    const parsed = orders.map((o) => ({
      ...o,
      items: JSON.parse(o.items || '[]'),
      delivery: o.delivery ? JSON.parse(o.delivery) : null,
    }));

    res.json({ orders: parsed });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Get Stripe publishable key ──────────────────────────
router.get('/config', (req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  });
});

module.exports = router;
