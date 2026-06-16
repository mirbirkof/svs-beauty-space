/* Standalone server для DikiDi-like фич (отзывы, избранное, чёрный список, акции)
   Порт 3012. Подключается клиентом напрямую через свой туннель или общий nginx. */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    /\.github\.io$/,
    /svs-shop-api\.onrender\.com$/,
    'https://svsbeautyworld.com',
    'https://www.svsbeautyworld.com',
  ],
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
}));
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'dikidi-features', ts: new Date().toISOString() }));

app.use('/api', require('./routes/dikidi-features'));
app.use('/api', require('./routes/payroll-stock'));
app.use('/api', require('./routes/loyalty'));

// статика — публичные страницы (promotions.html, my.html, ...)
app.use(express.static(__dirname + '/public'));

const PORT = process.env.DIKIDI_PORT || 3012;
app.listen(PORT, '0.0.0.0', () => console.log(`[dikidi-server] :${PORT}`));
