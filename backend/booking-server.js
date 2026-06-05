/* ═══════════════════════════════════════════════════════
   SVS Booking — Standalone MVP server
   Минимальные зависимости: только express
   Запуск: node booking-server.js
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();
const express = require('express');
const bookingRoutes = require('./routes/booking');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — открытый для теста
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.json({ ok: true, service: 'svs-booking', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api/booking', bookingRoutes);

app.use((err, req, res, next) => {
  console.error('[svs-booking]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('[svs-booking] running on http://0.0.0.0:' + PORT);
});
