/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Shop API (Postgres only)
   Минимальный сервер для каталога магазина.
   Не зависит от sqlite/auth/payments — работает отдельно
   от booking-server.js. Mono routes будут добавлены когда
   придут API ключи.
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const catalogRoutes = require('./routes/catalog');
const cabinetRoutes = require('./routes/cabinet-auth');
const ordersRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const syncRoutes = require('./routes/beautypro-sync');
const npRoutes = require('./routes/novaposhta');
const legacyRoutes = require('./routes/catalog-legacy');
const notifyRoutes = require('./routes/telegram-notify');
const promoRoutes = require('./routes/promos');
const exportRoutes = require('./routes/export');
const waitlistRoutes = require('./routes/waitlist');
const dikidiRoutes = require('./routes/dikidi-features');
const payrollRoutes = require('./routes/payroll-stock');
const loyaltyRoutes = require('./routes/loyalty');

const app = express();
const PORT = process.env.SHOP_API_PORT || 3011;

app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    /\.github\.io$/,
    /\.lhr\.life$/,
    /\.pinggy\.link$/,
  ],
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));

// статика админки
app.use('/admin', express.static(__dirname + '/public/admin'));
// статика клиентских страниц (promotions, loyalty, my, cabinet, shop)
app.use('/p', express.static(__dirname + '/public'));

// health + readiness map
app.get('/api/shop/health', (req, res) => {
  res.json({
    ok: true,
    service: 'svs-shop-api',
    db: process.env.DATABASE_URL ? 'configured' : 'missing',
    mono: process.env.MONO_TOKEN ? 'configured' : 'awaiting-key',
    time: new Date().toISOString(),
  });
});

app.get('/api/shop/readiness', (req, res) => {
  const ready = (v) => v ? 'ready' : 'awaiting';
  res.json({
    ok: true,
    components: {
      database: ready(!!process.env.DATABASE_URL),
      admin_token: ready(!!process.env.ADMIN_TOKEN),
      mono_acquiring: ready(!!process.env.MONO_TOKEN),
      nova_poshta: ready(!!process.env.NOVAPOSHTA_API_KEY),
      sms_provider: ready(!!process.env.SMS_PROVIDER),
      telegram_bot: ready(!!(process.env.TELEGRAM_NOTIFY_TOKEN || process.env.TELEGRAM_BOT_TOKEN)),
      beautypro_crm: ready(!!(process.env.BEAUTYPRO_ID_KEY && process.env.BEAUTYPRO_SECRET_KEY)),
    },
    code_status: {
      catalog: 'ready',
      orders: 'ready',
      cabinet_auth: 'ready (dev-mode 0000)',
      admin_panel: 'ready',
      stock_management: 'ready',
      loyalty_3pct: 'ready',
      promos: 'ready',
      csv_export: 'ready',
      notifications: 'ready (needs telegram_id on client)',
      beautypro_sync: 'ready (needs fields param fix)',
      nova_poshta: 'ready (awaiting api key)',
      mono_pay: 'stub (awaiting api key)',
    },
  });
});

app.use('/api/catalog', catalogRoutes);
app.use('/api/cabinet', cabinetRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/np', npRoutes);
app.use('/api/catalog/legacy', legacyRoutes);
app.use('/api/notify', notifyRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/export', exportRoutes);
app.use('/api', waitlistRoutes);
app.use('/api', dikidiRoutes);
app.use('/api', payrollRoutes);
app.use('/api', loyaltyRoutes);

// Mono Pay placeholder — активируется когда MONO_TOKEN задан
app.post('/api/pay/mono/invoice', (req, res) => {
  if (!process.env.MONO_TOKEN) {
    return res.status(503).json({
      error: 'mono-not-configured',
      message: 'Ожидаются API ключи Mono Acquiring',
    });
  }
  // TODO: создать инвойс через Mono API когда придут ключи
  res.status(501).json({ error: 'not-implemented-yet' });
});

app.use((err, req, res, next) => {
  console.error('[shop-api]', err);
  res.status(500).json({ error: err.message || 'internal' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[shop-api] listening on http://0.0.0.0:${PORT}`);
  console.log(`[shop-api] DB: ${process.env.DATABASE_URL ? 'connected' : 'MISSING'}`);
});
