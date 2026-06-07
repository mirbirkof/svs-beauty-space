/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Backend Server
   Auth: SMS/Twilio (masters) + Google/Facebook/Apple OAuth
   Payments: Stripe (Google Pay, Apple Pay, Card)
   Sessions: JWT, 30 days
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const bookingRoutes = require('./routes/booking');
const catalogRoutes = require('./routes/catalog');

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ───────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    /\.github\.io$/,
  ],
  credentials: true,
}));

// ── Body parsing (raw for Stripe webhooks) ────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ──────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Забагато спроб. Спробуйте через 15 хвилин.' },
});
const smsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 3,
  message: { error: 'Забагато SMS. Зачекайте хвилину.' },
});

// ── Routes ─────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/auth/sms', smsLimiter);
app.use('/api/payments', paymentRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/catalog', catalogRoutes);

// ── Health check ───────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ── Error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[SVS-Shop]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log('[SVS-Shop] Backend running on port', PORT);
});

module.exports = app;
