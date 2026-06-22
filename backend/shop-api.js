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
  contentSecurityPolicy: false,   // админка-SPA: inline scripts + onclick handlers повсюду, строгий CSP ломает всё
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    /\.github\.io$/,
    /\.vercel\.app$/,
    /\.lhr\.life$/,
    /\.pinggy\.link$/,
    /svs-shop-api\.onrender\.com$/,
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
// М'який анти-брутфорс: НЕ блокуємо за звичайні помилки вводу.
// Спрацьовує лише на шквал — 10 невдалих спроб за 1 хв з одного IP (бот/скрипт),
// блок автоматично спадає за хвилину. Людина з парою опечаток не зачіпається.
const credentialLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  skipSuccessfulRequests: true,             // успішний логін не зараховується — рахуємо лише невдалі спроби
  message: { error: 'too-many-auth-attempts' },
});
app.use('/api', globalLimiter);
app.use('/api/cabinet', authLimiter);
// Анти-брутфорс на конкретні точки входу/скидання пароля (лише невдалі спроби).
// Точково, щоб не throttle-ити /me, /refresh-token, /logout (їх викликають часто).
app.use('/api/auth/login', credentialLimiter);
app.use('/api/auth/staff/login-password', credentialLimiter);
app.use('/api/auth/forgot-password', credentialLimiter);
app.use('/api/auth/reset-password', credentialLimiter);
app.use('/api/files/upload', uploadLimiter);

// статика админки — HTML без кэша, чтобы обновления панели сразу были видны (не залипал старый index.html)
app.use('/admin', express.static(__dirname + '/public/admin', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
// статика клиентских страниц (promotions, loyalty, my, cabinet, shop)
app.use('/p', express.static(__dirname + '/public'));

// Публічна онлайн-запис (INT-08 сайт / INT-06 TG Mini App) — короткий URL
app.get('/book', (req, res) => res.redirect(302, '/p/book.html'));

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
      // Критичні секрети безпеки — лише булевий статус, значення ніколи не віддаються
      jwt_secret: ready(!!(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32)),
      integration_encryption: ready(!!(process.env.INTEGRATION_ENC_KEY || process.env.JWT_SECRET)),
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

// Instagram вебхук (COM-10) — ДО tenantMiddleware: тенант определяется по
// ig_user_id из payload (Meta шлёт все салоны на один URL), не по запросу.
try { app.use('/api/instagram', require('./routes/instagram-webhook')); } catch(e) { console.error('[instagram-webhook] mount failed:', e.message); }

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
try { app.use('/api/bonus', require('./routes/bonus')); } catch(e) { console.error('[bonus] mount failed:', e.message); }
try { app.use('/api/meta-ads', require('./routes/meta-ads')); } catch(e) { console.error('[meta-ads] mount failed:', e.message); }
try { app.use('/api/google-ads', require('./routes/google-ads')); } catch(e) { console.error('[google-ads] mount failed:', e.message); }
try { app.use('/api/security', require('./routes/security')); } catch(e) { console.error('[security] mount failed:', e.message); }
try { app.use('/api/instagram-content', require('./routes/instagram-content')); } catch(e) { console.error('[ig-content] mount failed:', e.message); }
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
try { app.use('/api/master-services', require('./routes/master-services')); } catch(e) { console.error('[master-services] mount failed:', e.message); }
app.use('/api/notes', require('./routes/notes'));
try { app.use('/api/me', require('./routes/master-cabinet')); } catch(e) { console.error('[master-cabinet] mount failed:', e.message); }
try { app.use('/api/events', require('./routes/events')); } catch(e) { console.error('[events] mount failed:', e.message); }
const notificationsRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationsRoutes);
app.use('/api/segments', require('./routes/segments'));
try { app.use('/api/rfm', require('./routes/rfm')); } catch(e) { console.error('[rfm] mount failed:', e.message); }
try { app.use('/api/attribution', require('./routes/attribution')); } catch(e) { console.error('[attribution] mount failed:', e.message); }
app.use('/api/campaigns', require('./routes/campaigns'));
try { app.use('/api/purchasing', require('./routes/purchasing')); } catch(e) { console.error('[purchasing] mount failed:', e.message); }
try { app.use('/api/referral', require('./routes/referral')); } catch(e) { console.error('[referral] mount failed:', e.message); }
try { app.use('/api/marketing-center', require('./routes/marketing-center')); } catch(e) { console.error('[marketing-center] mount failed:', e.message); }
try { app.use('/api/tasks', require('./routes/tasks')); } catch(e) { console.error('[tasks] mount failed:', e.message); }
try { app.use('/api/projects', require('./routes/projects')); } catch(e) { console.error('[projects] mount failed:', e.message); }
try { app.use('/api/kb', require('./routes/kb')); } catch(e) { console.error('[kb] mount failed:', e.message); }
try { app.use('/api/incidents', require('./routes/incidents')); } catch(e) { console.error('[incidents] mount failed:', e.message); }
try { app.use('/api/surveys', require('./routes/surveys')); } catch(e) { console.error('[surveys] mount failed:', e.message); }
try { app.use('/api/qc', require('./routes/qc')); } catch(e) { console.error('[qc] mount failed:', e.message); }
try { app.use('/api/documents', require('./routes/documents')); } catch(e) { console.error('[documents] mount failed:', e.message); }
try { app.use('/api/esign', require('./routes/esign')); } catch(e) { console.error('[esign] mount failed:', e.message); }
const triggersRoutes = require('./routes/marketing-triggers');
app.use('/api/triggers', triggersRoutes);
try { app.use('/api/reputation', require('./routes/reputation')); } catch(e) { console.error('[reputation] mount failed:', e.message); }
try { app.use('/api/ai', require('./routes/ai')); } catch(e) { console.error('[ai] mount failed:', e.message); }
try { app.use('/api/forecast', require('./routes/forecasting')); } catch(e) { console.error('[forecast] mount failed:', e.message); }
try { app.use('/api/recommendations', require('./routes/recommendations')); } catch(e) { console.error('[recommendations] mount failed:', e.message); }
try { app.use('/api/search', require('./routes/search')); } catch(e) { console.error('[search] mount failed:', e.message); }
try { app.use('/api/audit', require('./routes/audit')); } catch(e) { console.error('[audit] mount failed:', e.message); }
try { app.use('/api/forms', require('./routes/forms')); } catch(e) { console.error('[forms] mount failed:', e.message); }
try { app.use('/api/webhooks', require('./routes/webhooks')); } catch(e) { console.error('[webhooks] mount failed:', e.message); }
try { app.use('/api/api-keys', require('./routes/api-keys')); } catch(e) { console.error('[api-keys] mount failed:', e.message); }
try { app.use('/api/v1', require('./routes/public-api')); } catch(e) { console.error('[public-api] mount failed:', e.message); }
try { app.use('/api/portfolio', require('./routes/portfolio')); } catch(e) { console.error('[portfolio] mount failed:', e.message); }
try { app.use('/api/saas/analytics', require('./routes/saas-analytics')); } catch(e) { console.error('[saas-analytics] mount failed:', e.message); }
try { app.use('/api/saas', require('./routes/saas')); } catch(e) { console.error('[saas] mount failed:', e.message); }
try { app.use('/api/white-label', require('./routes/white-label')); } catch(e) { console.error('[white-label] mount failed:', e.message); }
try { app.use('/api/public', require('./routes/public-signup')); } catch(e) { console.error('[public-signup] mount failed:', e.message); }
try { app.use('/api/tenant-mgmt', require('./routes/tenant-mgmt')); } catch(e) { console.error('[tenant-mgmt] mount failed:', e.message); }
try { app.use('/api/billing', require('./routes/billing')); } catch(e) { console.error('[billing] mount failed:', e.message); }
try { app.use('/api/domains', require('./routes/domains')); } catch(e) { console.error('[domains] mount failed:', e.message); }
try { app.use('/api/omni', require('./routes/omnichannel')); } catch(e) { console.error('[omni] mount failed:', e.message); }
try { app.use('/api/reviews-moderation', require('./routes/reviews-moderation')); } catch(e) { console.error('[reviews-moderation] mount failed:', e.message); }
try { app.use('/api/fin-integrations', require('./routes/integrations-fin')); } catch(e) { console.error('[fin-integrations] mount failed:', e.message); }
try { app.use('/api/quality', require('./routes/quality')); } catch(e) { console.error('[quality] mount failed:', e.message); }
try { app.use('/api/ai/sales', require('./routes/ai-sales')); } catch(e) { console.error('[ai-sales] mount failed:', e.message); }
try { app.use('/api/ai/receptionist', require('./routes/ai-receptionist')); } catch(e) { console.error('[ai-receptionist] mount failed:', e.message); }
try { app.use('/api/ai/kb', require('./routes/ai-kb')); } catch(e) { console.error('[ai-kb] mount failed:', e.message); }
try { app.use('/api/ai/marketing', require('./routes/ai-marketing')); } catch(e) { console.error('[ai-marketing] mount failed:', e.message); }
try { app.use('/api/ai/agents', require('./routes/ai-agents')); } catch(e) { console.error('[ai-agents] mount failed:', e.message); }
try { app.use('/api/ai/calls', require('./routes/ai-call-analysis')); } catch(e) { console.error('[ai-call-analysis] mount failed:', e.message); }
try { app.use('/api/ai/video', require('./routes/ai-video')); } catch(e) { console.error('[ai-video] mount failed:', e.message); }
try { app.use('/api/pipeline', require('./routes/pipeline')); } catch(e) { console.error('[pipeline] mount failed:', e.message); }
try { app.use('/api/shifts', require('./routes/shifts')); } catch(e) { console.error('[shifts] mount failed:', e.message); }
try { app.use('/api/financial', require('./routes/financial')); } catch(e) { console.error('[financial] mount failed:', e.message); }
try { app.use('/api/gift-certificates', require('./routes/gift-certificates')); } catch(e) { console.error('[gift-certificates] mount failed:', e.message); }
try { app.use('/api/subscriptions', require('./routes/subscriptions')); } catch(e) { console.error('[subscriptions] mount failed:', e.message); }
try { app.use('/api/budgets', require('./routes/budgets')); } catch(e) { console.error('[budgets] mount failed:', e.message); }
try { app.use('/api/cash-flow', require('./routes/cash-flow')); } catch(e) { console.error('[cash-flow] mount failed:', e.message); }
try { app.use('/api/medical', require('./routes/medical')); } catch(e) { console.error('[medical] mount failed:', e.message); }
try { app.use('/api/booking', require('./routes/booking-catalog')); } catch(e) { console.error('[booking-catalog] mount failed:', e.message); }
try { app.use('/api/monitoring', require('./routes/monitoring')); } catch(e) { console.error('[monitoring] mount failed:', e.message); }
try { app.use('/api/bi', require('./routes/bi')); } catch(e) { console.error('[bi] mount failed:', e.message); }
try { app.use('/api/google-business', require('./routes/google-business')); } catch(e) { console.error('[google-business] mount failed:', e.message); }
try { app.use('/api/kpi-branches', require('./routes/kpi-branches')); } catch(e) { console.error('[kpi-branches] mount failed:', e.message); }
try { app.use('/api/backup', require('./routes/backup')); } catch(e) { console.error('[backup] mount failed:', e.message); }
try { app.use('/api/dwh', require('./routes/data-warehouse')); } catch(e) { console.error('[dwh] mount failed:', e.message); }
try { app.use('/api/marketplace', require('./routes/marketplace')); } catch(e) { console.error('[marketplace] mount failed:', e.message); }
try { app.use('/api/integrations', require('./routes/integrations')); } catch(e) { console.error('[integrations] mount failed:', e.message); }

// (Mono routes смонтированы выше — до catch-all /api роутеров)

app.use((err, req, res, next) => {
  console.error('[shop-api]', err);
  const { safeMessage } = require('./lib/safe-error');
  res.status(500).json({ error: safeMessage(err, 'internal') });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[shop-api] listening on http://0.0.0.0:${PORT}`);
  console.log(`[shop-api] DB: ${process.env.DATABASE_URL ? 'connected' : 'MISSING'}`);
  // Запуск cron напоминаний
  if (process.env.DATABASE_URL) {
    // Підвантажити секрети інтеграцій, задані з UI, у process.env (env Render пріоритетніший)
    try { require('./lib/integration-secrets').loadIntegrationSecrets(); } catch (e) { console.error('[integration-secrets]', e.message); }
    remindersRoutes.startCron();
    notificationsRoutes.startCron(); // COM-01 Notification Hub воркер очереди
    triggersRoutes.startCron();      // MKT-02 авто-триггеры маркетинга
    // INF-04 Monitoring: in-process чекер здоровья сервисов + алерты
    try { require('./lib/monitor-checker').start(60000); } catch (e) { console.error('[monitor] start failed:', e.message); }
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

// ── Планировщик отложенных маркетинговых кампаний (каждую минуту) ──
try {
  const camp = require('./routes/campaigns');
  if (typeof camp.processScheduled === 'function') {
    setInterval(() => {
      camp.processScheduled()
        .then((r) => { if (r && r.launched) console.log('[campaigns] auto-launched', r.launched); })
        .catch((e) => console.error('[campaigns] scheduler:', e.message));
    }, 60 * 1000).unref();
    console.log('[shop-api] campaign scheduler enabled');
  }
} catch (e) { console.error('[campaigns] scheduler init failed:', e.message); }

// ── Биллинг-планировщик (SAS-03): продление подписок + dunning + health ──
// Раз в час: runRecurring (trial/период истёк → продление + счёт), processDunning
// (просроченные попытки оплаты; 4-я неудача → tenant suspended → 403 на входе).
// Раз в сутки: health-чек всех активных тенантов. RLS-free таблицы, явный tenant_id.
if (process.env.DATABASE_URL) {
  try {
    const billing = require('./lib/billing');
    const tm = require('./lib/tenant-mgmt');
    const runBillingCycle = async () => {
      try { const r = await billing.runRecurring(); if (r.renewed || r.cancelled) console.log('[billing] recurring', r); }
      catch (e) { console.error('[billing] recurring:', e.message); }
      try { const d = await billing.processDunning(); if (d.attempted || d.suspended) console.log('[billing] dunning', d); }
      catch (e) { console.error('[billing] dunning:', e.message); }
      try { const b = await require('./lib/bonus').expireBonuses(); if (b.expired) console.log('[bonus] expired', b); }
      catch (e) { console.error('[bonus] expiry:', e.message); }
      try { const m = await require('./lib/meta-ads').syncAllAccounts(); if (m.synced) console.log('[meta-ads] synced', m); }
      catch (e) { console.error('[meta-ads] sync:', e.message); }
      try { const g = await require('./lib/google-ads').syncAllAccounts(); if (g.synced) console.log('[google-ads] synced', g); }
      catch (e) { console.error('[google-ads] sync:', e.message); }
      try { const s = await require('./lib/security-center').detectThreats(); if (s.created) console.log('[security] threats detected', s); }
      catch (e) { console.error('[security] detect:', e.message); }
      try { const ig = await require('./lib/instagram-content').runScheduled(); if (ig.published) console.log('[ig-content] published', ig); }
      catch (e) { console.error('[ig-content] scheduled:', e.message); }
    };
    setInterval(runBillingCycle, 60 * 60 * 1000).unref();
    setTimeout(runBillingCycle, 60 * 1000).unref(); // первый прогон через минуту после старта
    let lastHealth = 0;
    setInterval(() => {
      if (Date.now() - lastHealth < 24 * 60 * 60 * 1000) return;
      lastHealth = Date.now();
      tm.runHealthAll().then((r) => console.log('[tenant-health] checked', r.checked, '/', r.tenants))
        .catch((e) => console.error('[tenant-health]', e.message));
    }, 60 * 60 * 1000).unref();
    console.log('[shop-api] billing scheduler enabled');
  } catch (e) { console.error('[billing] scheduler init failed:', e.message); }
}
