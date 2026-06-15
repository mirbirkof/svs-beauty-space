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
const scheduleRoutes = require('./routes/schedule');
const remindersRoutes = require('./routes/reminders');
const repeatVisitsRoutes = require('./routes/repeat-visits');

const app = express();
const PORT = process.env.SHOP_API_PORT || process.env.PORT || 3011;

// ── Security headers (helmet) ───────────────────────────
// Базовые HTTP-заголовки безопасности: nosniff, frameguard, HSTS, referrer-policy,
// hidePoweredBy. CSP отключён — админка-SPA использует inline-скрипты/стили и внешние
// CDN (иконки/шрифты), строгий CSP их заблокирует. CORP=cross-origin — чтобы фото,
// отдаваемые этим API, грузились на витрине (github.io/onrender). COOP отключён,
// чтобы не ломать popup-вход в кабинет.
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    /\.github\.io$/,
    /\.lhr\.life$/,
    /\.pinggy\.link$/,
    /\.onrender\.com$/,
    'https://svsbeautyworld.com',
    'https://www.svsbeautyworld.com',
  ],
  credentials: true,
}));

// rawBody нужен для верификации X-Sign вебхука Mono (подпись считается от байтов как есть)
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// ── Rate limiting ───────────────────────────────────────
// За туннелем/Render реальный IP приходит в X-Forwarded-For (1 hop)
app.set('trust proxy', 1);
const rateLimit = require('express-rate-limit');
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,            // 300 req/мин с IP
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/health' || req.path === '/' || req.path.startsWith('/p/') || req.path.startsWith('/admin'),
  message: { error: 'too-many-requests' },
});
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 15,         // 15 попыток за 5 мин (OTP/login)
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too-many-auth-attempts' },
});
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 30,         // 30 загрузок за 5 мин
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'too-many-uploads' },
});
app.use('/api', globalLimiter);
app.use('/api/cabinet', authLimiter);
app.use('/api/files/upload', uploadLimiter);

// статика админки — HTML без кэша, чтобы обновления панели сразу были видны (не залипал старый index.html)
app.use('/admin', express.static(__dirname + '/public/admin', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
// статика клиентских страниц (promotions, loyalty, my, cabinet, shop)
app.use('/p', express.static(__dirname + '/public'));

// Render health check (root + /health)
app.get('/', (req, res) => res.json({ ok: true, service: 'svs-shop-api', time: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({
  ok: true, service: 'svs-shop-api', time: new Date().toISOString(),
  rev: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),  // какой код реально задеплоен
}));

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
      cabinet_auth: 'ready (telegram-otp, dev-code disabled in prod)',
      admin_panel: 'ready',
      stock_management: 'ready',
      loyalty_3pct: 'ready',
      promos: 'ready',
      csv_export: 'ready',
      notifications: 'ready (needs telegram_id on client)',
      beautypro_sync: 'ready (fields param OK, awaiting BEAUTYPRO env keys)',
      nova_poshta: 'ready (awaiting api key)',
      mono_pay: 'ready (invoice + webhook + poller)',
    },
  });
});

// Tenant context (SAS-01): резолв тенанта до всех роутов; текущий трафик → дефолтный тенант
const { tenantMiddleware } = require('./lib/tenant');
app.use(tenantMiddleware());

// Mono Acquiring (M29) — ДО роутеров на общем /api (payroll/loyalty вешают
// requirePerm на всё что до них дошло — вебхук Mono был бы заблокирован)
const monoPayRoutes = require('./routes/payments-mono');
app.use('/api/pay/mono', monoPayRoutes);

app.use('/api/catalog', catalogRoutes);
app.use('/api/cabinet', cabinetRoutes);
app.use('/api/cabinet', require('./routes/cabinet')); // M20: visits/orders/loyalty/summary
app.use('/api/orders', ordersRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/sync', syncRoutes);
try { app.use('/api/sync', require('./routes/beautypro-sync-v2')); } catch(e) { /* v2 optional */ }
try { app.use('/api/sync', require('./routes/beautypro-appointments-sync')); } catch(e) { console.error('[bp-appt-sync] mount failed:', e.message); }
try { app.use('/api/files', require('./routes/files')); } catch(e) { console.error('[files] mount failed:', e.message); }
app.use('/api/np', npRoutes);
app.use('/api/catalog/legacy', legacyRoutes);
app.use('/api/notify', notifyRoutes);
app.use('/api/promo', promoRoutes);
app.use('/api/export', exportRoutes);
app.use('/api', waitlistRoutes);
app.use('/api', dikidiRoutes);
app.use('/api', payrollRoutes);
app.use('/api', loyaltyRoutes);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth/staff', require('./routes/auth-staff'));
app.use('/api/cashbox', require('./routes/cashbox'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/schedule', scheduleRoutes);
app.use('/api/reminders', remindersRoutes);
app.use('/api/repeat-visits', repeatVisitsRoutes);
app.use('/api/branches', require('./routes/branches'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/services', require('./routes/services'));
app.use('/api/service-categories', require('./routes/categories'));
app.use('/api/client-tags', require('./routes/client-tags'));
app.use('/api/consumables', require('./routes/consumables'));
app.use('/api/notes', require('./routes/notes'));
try { app.use('/api/events', require('./routes/events')); } catch(e) { console.error('[events] mount failed:', e.message); }
const notificationsRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationsRoutes);
app.use('/api/segments', require('./routes/segments'));
app.use('/api/campaigns', require('./routes/campaigns'));
const triggersRoutes = require('./routes/marketing-triggers');
app.use('/api/triggers', triggersRoutes);
try { app.use('/api/reputation', require('./routes/reputation')); } catch(e) { console.error('[reputation] mount failed:', e.message); }
try { app.use('/api/ai', require('./routes/ai')); } catch(e) { console.error('[ai] mount failed:', e.message); }
try { app.use('/api/pipeline', require('./routes/pipeline')); } catch(e) { console.error('[pipeline] mount failed:', e.message); }
try { app.use('/api/shifts', require('./routes/shifts')); } catch(e) { console.error('[shifts] mount failed:', e.message); }
try { app.use('/api/financial', require('./routes/financial')); } catch(e) { console.error('[financial] mount failed:', e.message); }
try { app.use('/api/gift-certificates', require('./routes/gift-certificates')); } catch(e) { console.error('[gift-certificates] mount failed:', e.message); }
try { app.use('/api/subscriptions', require('./routes/subscriptions')); } catch(e) { console.error('[subscriptions] mount failed:', e.message); }
try { app.use('/api/budgets', require('./routes/budgets')); } catch(e) { console.error('[budgets] mount failed:', e.message); }
try { app.use('/api/cash-flow', require('./routes/cash-flow')); } catch(e) { console.error('[cash-flow] mount failed:', e.message); }

// (Mono routes смонтированы выше — до catch-all /api роутеров)

app.use((err, req, res, next) => {
  console.error('[shop-api]', err);
  res.status(500).json({ error: err.message || 'internal' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[shop-api] listening on http://0.0.0.0:${PORT}`);
  console.log(`[shop-api] DB: ${process.env.DATABASE_URL ? 'connected' : 'MISSING'}`);
  // Запуск cron напоминаний
  if (process.env.DATABASE_URL) {
    remindersRoutes.startCron();
    notificationsRoutes.startCron(); // COM-01 Notification Hub воркер очереди
    triggersRoutes.startCron();      // MKT-02 авто-триггеры маркетинга
    // страховка вебхуков Mono: поллинг pending-инвойсов
    if (process.env.MONO_TOKEN) monoPayRoutes.startCron();
  }
});

// ── Авто-миграции при старте: БД, в которую смотрит ЭТОТ процесс, всегда догоняет код ──
// Причина: 12.06 verify падал 42P10 — на Render-базе не было clients_tenant_phone_key
// (миграция 016 была применена только к локальной базе). Не блокирует и не роняет сервис.
if (process.env.DATABASE_URL) {
  const { execFile } = require('child_process');
  const path = require('path');
  execFile(process.execPath, [path.join(__dirname, 'scripts', 'apply-migrations.js')],
    { env: process.env, timeout: 120000 },
    (err, stdout, stderr) => {
      if (stdout) console.log('[migrate]', stdout.trim());
      if (err) console.error('[migrate] FAILED (сервис продолжает работать):', (stderr || err.message).trim());
      else console.log('[migrate] схема БД актуальна');
    });
}

// ── Render keep-alive: free tier засыпает после 15 мин простоя ──
// Пингуем себя и booking-сервис каждые 10 мин. Пока жив хоть один — не спят оба.
if (process.env.RENDER_EXTERNAL_URL) {
  const KEEPALIVE_URLS = [
    process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/health',
    'https://svs-booking-api.onrender.com/api/health',
  ];
  setInterval(() => {
    for (const url of KEEPALIVE_URLS) {
      fetch(url, { signal: AbortSignal.timeout(60000) })
        .then((r) => { if (!r.ok) console.warn('[keepalive]', url, '->', r.status); })
        .catch((e) => console.warn('[keepalive]', url, 'failed:', e.message));
    }
  }, 10 * 60 * 1000).unref();
  console.log('[shop-api] keep-alive enabled:', KEEPALIVE_URLS.join(', '));
}
