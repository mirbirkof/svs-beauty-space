/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Shop API (Postgres only)
   Минимальный сервер для каталога магазина.
   Не зависит от sqlite/auth/payments — работает отдельно
   от booking-server.js. Mono routes будут добавлены когда
   придут API ключи.
   ═══════════════════════════════════════════════════════ */
require('dotenv').config();

// STAGING-режим (QA safe-fix пайплайн): backend поднят на песочнице-ветке Neon для тестов.
// Глушим фоновые планировщики (кроны/синки/уведомления) — у них интервалы/задержки >=20с,
// тогда как короткие служебные таймеры (<20с) остаются. Прод не затрагивается: там QA_STAGING не задан.
if (process.env.QA_STAGING === '1') {
  const realSI = global.setInterval, realST = global.setTimeout;
  global.setInterval = (fn, ms, ...a) => (ms >= 20000 ? { unref() {}, close() {} } : realSI(fn, ms, ...a));
  global.setTimeout = (fn, ms, ...a) => (ms >= 20000 ? { unref() {}, close() {} } : realST(fn, ms, ...a));
  console.log('[staging] QA_STAGING=1 — фоновые планировщики (>=20с) заглушены, только HTTP');
}

// Sentry — мониторинг ошибок прода. No-op без SENTRY_DSN. Инициализируем до express.
const sentry = require('./lib/sentry');
sentry.init();

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
    /\.onrender\.com$/,
    'https://svsbeautyworld.com',
    'https://www.svsbeautyworld.com',
  ],
  credentials: true,
}));

// Майстер міграції приймає Excel .xlsx у base64 → тіло може бути важким.
// Ставимо ДО глобального 1mb-парсера: після розбору express виставляє
// прапор _body і глобальний парсер нижче цей запит пропустить.
app.use('/api/migrate', express.json({ limit: '12mb' }));

// rawBody нужен для верификации X-Sign вебхука Mono (подпись считается от байтов как есть)
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Ловим SyntaxError от express.json (невалидный JSON в теле) → 400 вместо 500
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'invalid-json', message: 'Request body is not valid JSON' });
  }
  next(err);
});

// ── Rate limiting ───────────────────────────────────────
// За туннелем/Render реальный IP приходит в X-Forwarded-For (1 hop)
app.set('trust proxy', 1);
const rateLimit = require('express-rate-limit');
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300,            // 300 req/мин с IP
  standardHeaders: true, legacyHeaders: false,
  // ВАЖЛИВО: лимітер змонтований на '/api', тож req.path тут БЕЗ префікса '/api'.
  // Старий skip('/admin') ненавмисно звільняв від ліміту ВСІ /api/admin/* (req.path='/admin/...').
  // Статика адмінки віддається окремим app.use('/admin', static) і під цим лимітером не проходить.
  skip: (req) => req.path === '/health' || req.path === '/',
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
// Аудит v6: query (?tenant=slug) НАДО сохранить при редиректе — иначе клиент арендатора
// теряет привязку к салону и бронирует в дефолтный (салон Босса).
app.get('/book', (req, res) => {
  const qs = req.url.indexOf('?');
  res.redirect(302, '/p/book.html' + (qs >= 0 ? req.url.slice(qs) : ''));
});
app.get('/signup', (req, res) => res.redirect(302, '/p/signup.html'));
app.get('/pricing', (req, res) => res.redirect(302, '/p/pricing.html')); // публічна вітрина тарифів
app.get('/register', (req, res) => res.redirect(302, '/p/signup.html'));

// Render health check (root + /health)
app.get('/', (req, res) => res.json({ ok: true, service: 'svs-shop-api', time: new Date().toISOString() }));
app.get('/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*'); // ворота zvetlacrm.onrender.com пингуют /health с другого origin
  res.json({
    ok: true, service: 'svs-shop-api', time: new Date().toISOString(),
    rev: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),  // какой код реально задеплоен
  });
});

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

// Жива проба БД (SAS): /health = liveness (процес живий), це — readiness БД.
// Пінгує реальне зʼєднання SELECT 1 з коротким таймаутом. Моніторинг/фейловер
// має дивитись СЮДИ, а не на /health — інакше "здоровий" сервіс з мертвою базою
// (інцидент 08.07: /health віддавав ok при недоступному Neon).
app.get('/api/shop/db-health', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const t0 = Date.now();
  try {
    const pool = require('./db-pg').getPool();
    const q = pool.query('SELECT 1 AS ok');
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('db-timeout')), 4000));
    await Promise.race([q, timeout]);
    res.json({ ok: true, db: 'up', latency_ms: Date.now() - t0 });
  } catch (e) {
    res.status(503).json({ ok: false, db: 'down', error: String(e.message || e).slice(0, 80), latency_ms: Date.now() - t0 });
  }
});

// Instagram вебхук (COM-10) — ДО tenantMiddleware: тенант определяется по
// ig_user_id из payload (Meta шлёт все салоны на один URL), не по запросу.
try { app.use('/api/instagram', require('./routes/instagram-webhook')); } catch(e) { console.error('[instagram-webhook] mount failed:', e.message); }

// Живой дашборд аудита — публичный, ДО tenantMiddleware (не тенантный, эфемерный снимок в памяти)
try { app.use('/api/audit-dash', require('./routes/audit-dash')); } catch(e) { console.error('[audit-dash] mount failed:', e.message); }

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
app.use('/api/import', require('./routes/import'));
app.use('/api/migrate', require('./routes/migrate'));
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
try { app.use('/api/qa', require('./routes/qa')); } catch(e) { console.error('[qa] mount failed:', e.message); }
app.use('/api/reminders', remindersRoutes);
app.use('/api/repeat-visits', repeatVisitsRoutes);
app.use('/api/branches', require('./routes/branches'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/services', require('./routes/services'));
app.use('/api/service-categories', require('./routes/categories'));
app.use('/api/client-tags', require('./routes/client-tags'));
app.use('/api/consumables', require('./routes/consumables'));
app.use('/api/stock-import', require('./routes/stock-import')); // накладні + прайси → склад
try { app.use('/api/master-services', require('./routes/master-services')); } catch(e) { console.error('[master-services] mount failed:', e.message); }
app.use('/api/notes', require('./routes/notes'));
try { app.use('/api/me', require('./routes/master-cabinet')); } catch(e) { console.error('[master-cabinet] mount failed:', e.message); }
try { app.use('/api/events', require('./routes/events')); } catch(e) { console.error('[events] mount failed:', e.message); }
const notificationsRoutes = require('./routes/notifications');
app.use('/api/notifications', notificationsRoutes);
app.use('/api/segments', require('./routes/segments'));
try { app.use('/api/rfm', require('./routes/rfm')); } catch(e) { console.error('[rfm] mount failed:', e.message); }
try { app.use('/api/attribution', require('./routes/attribution')); } catch(e) { console.error('[attribution] mount failed:', e.message); }
app.use('/api/campaigns', require('./lib/feature-gate').requireFeature('mkt.campaigns'), require('./routes/campaigns'));
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
try { app.use('/api/ai/analytics', require('./lib/feature-gate').requireFeature('analytics.advanced'), require('./routes/ai-analytics')); } catch(e) { console.error('[ai-analytics] mount failed:', e.message); }
try { app.use('/api/recommendations', require('./lib/feature-gate').requireFeature('ai.recommendations'), require('./routes/recommendations')); } catch(e) { console.error('[recommendations] mount failed:', e.message); }
try { app.use('/api/search', require('./routes/search')); } catch(e) { console.error('[search] mount failed:', e.message); }
try { app.use('/api/audit', require('./routes/audit')); } catch(e) { console.error('[audit] mount failed:', e.message); }
try { app.use('/api/forms', require('./routes/forms')); } catch(e) { console.error('[forms] mount failed:', e.message); }
try { app.use('/api/webhooks', require('./routes/webhooks')); } catch(e) { console.error('[webhooks] mount failed:', e.message); }
try { app.use('/api/api-keys', require('./routes/api-keys')); } catch(e) { console.error('[api-keys] mount failed:', e.message); }
try { app.use('/api/v1', require('./routes/public-api')); } catch(e) { console.error('[public-api] mount failed:', e.message); }
try { app.use('/api/portfolio', require('./routes/portfolio')); } catch(e) { console.error('[portfolio] mount failed:', e.message); }
try { app.use('/api/saas/analytics', require('./routes/saas-analytics')); } catch(e) { console.error('[saas-analytics] mount failed:', e.message); }
try { app.use('/api/saas', require('./routes/saas')); } catch(e) { console.error('[saas] mount failed:', e.message); }
try { app.use('/api/licenses', require('./routes/licenses')); } catch(e) { console.error('[licenses] mount failed:', e.message); }
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
try { app.use('/api/pnl', require('./routes/pnl')); } catch(e) { console.error('[pnl] mount failed:', e.message); }
try { app.use('/api/payouts', require('./routes/payouts')); } catch(e) { console.error('[payouts] mount failed:', e.message); }
try { app.use('/api/expense-confirm', require('./routes/expense-confirm')); } catch(e) { console.error('[expense-confirm] mount failed:', e.message); }
try { app.use('/api/manager', require('./routes/manager')); } catch(e) { console.error('[manager] mount failed:', e.message); }
try { app.use('/api/onboarding', require('./routes/onboarding')); } catch(e) { console.error('[onboarding] mount failed:', e.message); }
// Нагадування про витрати: 1-го, 15-го і в останній день місяця.
// НЕ проводить автоматично — лише нагадує підтвердити (адмін підтверджує/коригує у CRM).
if (process.env.DATABASE_URL) {
  let _lastExpReminder = null;
  const expenseReminderTick = async () => {
    try {
      const p = {}; for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
      const y = +p.year, m = +p.month, d = +p.day;
      const lastDay = new Date(y, m, 0).getDate();
      const isReminderDay = (d === 1 || d === 15 || d === lastDay);
      const stamp = `${y}-${m}-${d}`;
      if (!isReminderDay || _lastExpReminder === stamp) return;
      _lastExpReminder = stamp;
      const when = d === 1 ? 'початок місяця' : d === 15 ? 'середина місяця' : 'кінець місяця';
      const { tgSend } = require('./routes/telegram-notify');
      const chat = process.env.ADMIN_TG_CHAT;
      if (chat) await tgSend(chat, `🔔 <b>Час підтвердити витрати</b> (${when})\nЗарплата майстрам, оренда та інші витрати нараховані — перевірте суми й проведіть.\n👉 Зарплата → <b>Підтвердження витрат</b>`, { parse_mode: 'HTML' }).catch(()=>{});
      console.log(`[expense-reminder] нагадування надіслано (${when})`);
    } catch (e) { console.error('[expense-reminder] tick:', e.message); }
  };
  setTimeout(expenseReminderTick, 50000);
  setInterval(expenseReminderTick, 6 * 60 * 60 * 1000);
}
try { app.use('/api/ai/quality', require('./routes/ai-quality')); } catch(e) { console.error('[ai-quality] mount failed:', e.message); }
try { app.use('/api/v2', require('./routes/plans')); } catch(e) { console.error('[plans-v2] mount failed:', e.message); }
try { app.use('/api/ai/receptionist', require('./lib/feature-gate').requireFeature('ai.receptionist'), require('./routes/ai-receptionist')); } catch(e) { console.error('[ai-receptionist] mount failed:', e.message); }
try { app.use('/api/ai/kb', require('./routes/ai-kb')); } catch(e) { console.error('[ai-kb] mount failed:', e.message); }
try { app.use('/api/ai/marketing', require('./routes/ai-marketing')); } catch(e) { console.error('[ai-marketing] mount failed:', e.message); }
try { app.use('/api/ai/agents', require('./routes/ai-agents')); } catch(e) { console.error('[ai-agents] mount failed:', e.message); }
try { app.use('/api/ai/calls', require('./routes/ai-call-analysis')); } catch(e) { console.error('[ai-call-analysis] mount failed:', e.message); }
try { app.use('/api/ai/video', require('./routes/ai-video')); } catch(e) { console.error('[ai-video] mount failed:', e.message); }
try { app.use('/api/pipeline', require('./routes/pipeline')); } catch(e) { console.error('[pipeline] mount failed:', e.message); }
try { app.use('/api/shifts', require('./routes/shifts')); } catch(e) { console.error('[shifts] mount failed:', e.message); }
try { app.use('/api/shift-checklist', require('./routes/shift-checklist')); } catch(e) { console.error('[shift-checklist] mount failed:', e.message); }
try { app.use('/api/employees', require('./routes/employees')); } catch(e) { console.error('[employees] mount failed:', e.message); }
try { app.use('/api/clients', require('./routes/crm-card')); } catch(e) { console.error('[crm-card] mount failed:', e.message); }
try { app.use('/api/kpi', require('./routes/kpi')); } catch(e) { console.error('[kpi] mount failed:', e.message); }
try { app.use('/api/ai/recommendations', require('./lib/feature-gate').requireFeature('ai.recommendations'), require('./routes/ai-recommendations')); } catch(e) { console.error('[ai-recommendations] mount failed:', e.message); }
try { app.use('/api/financial', require('./routes/financial')); } catch(e) { console.error('[financial] mount failed:', e.message); }
try { app.use('/api/zones', require('./routes/zones')); } catch(e) { console.error('[zones] mount failed:', e.message); }
try { app.use('/api/gift-certificates', require('./routes/gift-certificates')); } catch(e) { console.error('[gift-certificates] mount failed:', e.message); }
try { app.use('/api/subscriptions', require('./routes/subscriptions')); } catch(e) { console.error('[subscriptions] mount failed:', e.message); }
try { app.use('/api/budgets', require('./routes/budgets')); } catch(e) { console.error('[budgets] mount failed:', e.message); }
try { app.use('/api/cash-flow', require('./routes/cash-flow')); } catch(e) { console.error('[cash-flow] mount failed:', e.message); }
try {
  const recExp = require('./routes/recurring-expenses');
  app.use('/api/recurring-expenses', recExp);
  // Тік авто-проводки постійних витрат: на старті (через 30с) і кожні 12 год. Ідемпотентно по місяцю.
  if (process.env.DATABASE_URL && typeof recExp.postDue === 'function') {
    // Блокер #5: проводим постоянные расходы ПО КАЖДОМУ салону под его RLS-контекстом,
    // иначе расходы всех салонов сваливались в кассу Босса (дефолтный тенант).
    const { forEachTenant } = require('./lib/tenant');
    // Guard от наложения (аудит-контроль): если проход по всем салонам занял >12ч, следующий
    // tick не должен стартовать поверх — иначе постоянные расходы провелись бы дважды за период.
    let _recExpRunning = false;
    const tick = () => {
      if (_recExpRunning) { console.warn('[recurring-exp] попередній тік ще йде — пропуск'); return Promise.resolve(); }
      _recExpRunning = true;
      return forEachTenant(() => recExp.postDue())
        .then(r => { if (r.ok) console.log(`[recurring-exp] тік по ${r.tenants} салонах (ok ${r.ok}, fail ${r.fail})`); })
        .catch(e => console.error('[recurring-exp] tick:', e.message))
        .finally(() => { _recExpRunning = false; });
    };
    setTimeout(tick, 30000);
    setInterval(tick, 12 * 60 * 60 * 1000);
  }
} catch(e) { console.error('[recurring-expenses] mount failed:', e.message); }
// Віртуальний керуючий (шар 2): авто-запит відгуку після візиту + ранковий розклад майстрам.
try {
  const vm = require('./lib/virtual-manager');
  if (process.env.DATABASE_URL) {
    const kyivHour = () => Number(new Date().toLocaleString('en-US', { timeZone: 'Europe/Kiev', hour: '2-digit', hour12: false }).slice(0, 2));
    const tick = async () => {
      try { const n = await vm.autoReviewRequests(); if (n) console.log(`[vm] запитано відгуків: ${n}`); } catch (e) { console.error('[vm] reviews tick:', e.message); sentry.capture(e, { kind: 'cron', job: 'vm.reviews' }); }
      try { const h = kyivHour(); if (h >= 8 && h < 12) { const n = await vm.masterDailySchedules(); if (n) console.log(`[vm] розклад майстрам: ${n}`); } } catch (e) { console.error('[vm] sched tick:', e.message); sentry.capture(e, { kind: 'cron', job: 'vm.schedules' }); }
      try { const h = kyivHour(); if (h >= 8 && h < 12) { const n = await vm.ownerDailyReportAll(); if (n) console.log(`[vm] ранковий фінзвіт власникам надіслано: ${n}`); } } catch (e) { console.error('[vm] owner-report tick:', e.message); sentry.capture(e, { kind: 'cron', job: 'vm.owner-report' }); }
      try { const h = kyivHour(); if (h >= 8 && h < 12) { const n = await vm.adminDayPlan(); if (n) console.log('[vm] план дня адміну надіслано'); } } catch (e) { console.error('[vm] day-plan tick:', e.message); }
      try { const h = kyivHour(); if (h >= 8 && h < 12) { const n = await vm.weeklyMonthlyReminders(); if (n) console.log(`[vm] тижневі/місячні нагадування: ${n}`); } } catch (e) { console.error('[vm] reminders tick:', e.message); }
    };
    setTimeout(tick, 45000);
    setInterval(tick, 30 * 60 * 1000);
  }
} catch(e) { console.error('[virtual-manager] init failed:', e.message); }

// ── Прострочені ліцензії модулів (SaaS-аудит 06.07): trial/підписка не «вічні».
// active + expires_at у минулому → grace_period (7 днів), далі → expired.
// Платформенний крон: runAs(null) → без tenant-фільтра, обробляє ВСІ салони.
if (process.env.DATABASE_URL) {
  const licenseExpiryTick = async () => {
    try {
      const { runAs } = require('./lib/tenant');
      const pool = require('./db-pg').getPool();
      await runAs(null, async () => {
        const g = await pool.query(
          `UPDATE licenses SET status='grace_period',
                  grace_period_ends = COALESCE(expires_at, NOW()) + INTERVAL '7 days'
            WHERE status='active' AND license_type <> 'perpetual'
              AND expires_at IS NOT NULL AND expires_at < NOW()
            RETURNING id, tenant_id`);
        const x = await pool.query(
          `UPDATE licenses SET status='expired'
            WHERE status='grace_period' AND grace_period_ends IS NOT NULL AND grace_period_ends < NOW()
            RETURNING id, tenant_id`);
        if (g.rowCount || x.rowCount) console.log(`[licenses] grace:${g.rowCount} expired:${x.rowCount}`);
        // Неоплата: рахунок (його генерує billing.runRecurring при продовженні) висить
        // відкритим 7+ днів → підписка past_due, фічегейти гаснуть (аудит 06.07;
        // trialing НЕ чіпаємо — runRecurring сам продовжує trial → active + рахунок).
        const t = await pool.query(
          `UPDATE subscriptions_saas s SET status='past_due', updated_at=NOW()
            WHERE s.status='active'
              AND EXISTS (SELECT 1 FROM invoices_saas i
                           WHERE i.subscription_id = s.id AND i.status = 'open'
                             AND i.created_at < NOW() - INTERVAL '7 days')
            RETURNING s.id, s.tenant_id, s.plan_code, s.current_period_end`);
        if (t.rowCount) {
          console.log(`[subscriptions] active→past_due (несплата 7+ днів): ${t.rowCount}`);
          const billing = require('./lib/billing');
          for (const sub of t.rows) {
            await billing.syncLicense(sub.tenant_id, sub.plan_code, 'past_due', sub.current_period_end).catch(() => {});
            // Аудит v6: past_due був ТУПИКОМ — dunning заводився лише при продовженні
            // (runRecurring), а сюди підписки потрапляли через upgrade/ручний рахунок і
            // висіли past_due вічно: ні нагадувань, ні suspend. Тепер заводимо дожим.
            try {
              const inv = (await pool.query(
                `SELECT id FROM invoices_saas WHERE subscription_id=$1 AND status='open'
                  ORDER BY created_at LIMIT 1`, [sub.id])).rows[0];
              if (inv) await billing.scheduleDunning(sub.id, inv.id);
            } catch (e) { console.error('[subscriptions] dunning schedule:', e.message); }
          }
        }
        // Страховка від вічного past_due: 14+ днів без живого dunning → suspend
        // (нормальний шлях — 4-та невдала спроба дожиму в processDunning).
        const susp = await pool.query(
          `UPDATE subscriptions_saas s SET status='suspended', updated_at=NOW()
            WHERE s.status='past_due' AND s.updated_at < NOW() - INTERVAL '14 days'
              AND NOT EXISTS (SELECT 1 FROM dunning_attempts d
                               WHERE d.subscription_id = s.id AND d.status = 'pending')
            RETURNING s.tenant_id, s.plan_code, s.current_period_end`);
        if (susp.rowCount) {
          console.log(`[subscriptions] past_due→suspended (страховка 14 днів): ${susp.rowCount}`);
          const billing = require('./lib/billing');
          for (const sub of susp.rows) {
            await pool.query(`UPDATE tenants SET status='suspended', updated_at=NOW() WHERE id=$1`, [sub.tenant_id]).catch(() => {});
            await billing.syncLicense(sub.tenant_id, sub.plan_code, 'suspended', sub.current_period_end).catch(() => {});
          }
        }
        // повідомлення оператору платформи: хто перейшов у grace/past_due (щоб подзвонити/виставити рахунок)
        if ((g.rowCount || t.rowCount) && process.env.ADMIN_TG_CHAT) {
          try {
            const { tgSend } = require('./routes/telegram-notify');
            const names = await pool.query(
              `SELECT t2.name, t2.slug FROM tenants t2 WHERE t2.id = ANY($1::uuid[])`,
              [[...new Set([...(g.rows||[]).map(r=>r.tenant_id).filter(Boolean), ...(t.rows||[]).map(r=>r.tenant_id).filter(Boolean)])]]).catch(()=>({rows:[]}));
            if (names.rows.length) await tgSend(process.env.ADMIN_TG_CHAT,
              '<b>⏳ SaaS: прострочені підписки</b>\n' + names.rows.map(x=>`• ${x.name} (${x.slug})`).join('\n') +
              '\nМодулі перейшли в grace/past_due — виставте рахунок або звʼяжіться.');
          } catch (e) { console.error('[licenses] notify:', e.message); }
        }
      });
    } catch (e) { console.error('[licenses] expiry tick:', e.message); sentry.capture(e, { kind: 'cron', job: 'licenses.expiry' }); }
  };
  setInterval(licenseExpiryTick, 60 * 60 * 1000);
  setTimeout(licenseExpiryTick, 90 * 1000);
}
try { app.use('/api/medical', require('./routes/medical')); } catch(e) { console.error('[medical] mount failed:', e.message); }
try { app.use('/api/booking', require('./routes/booking-catalog')); } catch(e) { console.error('[booking-catalog] mount failed:', e.message); }
// Повний booking-роутер: telegram-вебхук бота @Svs_beautybot + розмовна запис + нагадування.
// З 03.07 вебхук вказує СЮДИ (svs-shop-api) — окремий сервіс svs-booking-api деплоївся
// з іншого репо і застряг на червневому коді. /catalog перехоплює booking-catalog вище.
try { app.use('/api/booking', require('./routes/booking')); } catch(e) { console.error('[booking] mount failed:', e.message); }
// SAS этап 1: самостоятельное подключение ТГ-бота салона (BotFather token → всё само)
try { app.use('/api/bot-connect', require('./routes/bot-connect')); } catch(e) { console.error('[bot-connect] mount failed:', e.message); }
try { app.use('/api/monitoring', require('./routes/monitoring')); } catch(e) { console.error('[monitoring] mount failed:', e.message); }
try { app.use('/api/bi', require('./routes/bi')); } catch(e) { console.error('[bi] mount failed:', e.message); }
try { app.use('/api/google-business', require('./routes/google-business')); } catch(e) { console.error('[google-business] mount failed:', e.message); }
try { app.use('/api/kpi-branches', require('./routes/kpi-branches')); } catch(e) { console.error('[kpi-branches] mount failed:', e.message); }
try { app.use('/api/backup', require('./routes/backup')); } catch(e) { console.error('[backup] mount failed:', e.message); }
try { app.use('/api/dwh', require('./routes/data-warehouse')); } catch(e) { console.error('[dwh] mount failed:', e.message); }
try { app.use('/api/marketplace', require('./routes/marketplace')); } catch(e) { console.error('[marketplace] mount failed:', e.message); }
try { app.use('/api/integrations', require('./routes/integrations')); } catch(e) { console.error('[integrations] mount failed:', e.message); }
try { app.use('/api/suppliers', require('./routes/suppliers')); } catch(e) { console.error('[suppliers] mount failed:', e.message); }
try { app.use('/api/viber', require('./routes/viber')); } catch(e) { console.error('[viber] mount failed:', e.message); }
try { app.use('/api/branding', require('./routes/branding')); } catch(e) { console.error('[branding] mount failed:', e.message); }
try { app.use('/api/call-center', require('./routes/call-center')); } catch(e) { console.error('[call-center] mount failed:', e.message); }
try { app.use('/api/mobile', require('./routes/mobile')); } catch(e) { console.error('[mobile] mount failed:', e.message); }
try { app.use('/api/quality-control', require('./routes/quality-control')); } catch(e) { console.error('[quality-control] mount failed:', e.message); }
try { app.use('/api/referral-marketing', require('./routes/referral-marketing')); } catch(e) { console.error('[referral-marketing] mount failed:', e.message); }
try { app.use('/api/material-norms', require('./routes/material-norms')); } catch(e) { console.error('[material-norms] mount failed:', e.message); }
try { app.use('/api/v2', require('./routes/feature-flags')); } catch(e) { console.error('[feature-flags-v2] mount failed:', e.message); }

// (Mono routes смонтированы выше — до catch-all /api роутеров)

app.use((err, req, res, next) => {
  console.error('[shop-api]', err);
  sentry.capture(err, { path: req.path, method: req.method });
  const { safeMessage } = require('./lib/safe-error');
  res.status(500).json({ error: safeMessage(err, 'internal') });
});

const server = app.listen(PORT, '0.0.0.0', () => {
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
    // INF: суточный offsite-бэкап БД (выгрузка в S3/Spaces, если заданы BACKUP_S3_*)
    try { require('./lib/backup-core').startCron(); } catch (e) { console.error('[backup] cron start failed:', e.message); }
    // INF: суточная очистка растущих таблиц (outbox, логи, коды) — данные не растут бесконтрольно
    try { require('./lib/retention').startRetentionCron(); } catch (e) { console.error('[retention] cron start failed:', e.message); }
    // Бизнес-автоматизации: неявка→задача, отток 60д→задача, ДР клиента→задача администратору
    try { require('./lib/automations').startAutomations(); } catch (e) { console.error('[automations] start failed:', e.message); }
    // GDPR: фоновая дошифровка ПД новых клиентов (phone_enc/phone_bidx). No-op без PII_KEY.
    try { require('./lib/pii-backfill-cron').startCron(); } catch (e) { console.error('[pii] cron start failed:', e.message); }
  }
});

// ── Graceful shutdown (audit #32) ──────────────────────────────────────────
// Render шлёт SIGTERM при деплое и даёт ~30с до SIGKILL. Без дренажа активные
// транзакции кассы/оплат обрывались на середине. Порядок: перестать принимать
// новые соединения → дать текущим запросам завершиться → закрыть пул БД → выход.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shop-api] ${signal} received → graceful shutdown`);
  // принудительный выход-страховка, если дренаж завис (раньше SIGKILL от Render)
  const hardKill = setTimeout(() => {
    console.error('[shop-api] drain timeout → forced exit');
    process.exit(1);
  }, 25000);
  hardKill.unref();
  server.close(async () => {
    try {
      const { getPool } = require('./db-pg');
      const pool = getPool();
      if (pool && typeof pool.end === 'function') await pool.end(); // ждёт активные запросы
      console.log('[shop-api] db pool closed, exit 0');
    } catch (e) {
      console.error('[shop-api] shutdown cleanup error:', e.message);
    } finally {
      clearTimeout(hardKill);
      process.exit(0);
    }
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Необработанные ошибки — главная причина падений прода. Логируем + шлём в Sentry (если включён).
process.on('unhandledRejection', (reason) => {
  console.error('[shop-api] unhandledRejection:', reason);
  sentry.capture(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('[shop-api] uncaughtException:', err);
  sentry.capture(err, { kind: 'uncaughtException' });
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
      // Пресейл-блокер #2: после миграций — self-healing RLS. Независимо от _migrations
      // (которая копируется при фейловере и скрывает пропущенные политики) на каждом
      // старте гарантируем tenant_isolation на всех таблицах с tenant_id.
      try {
        require('./lib/ensure-rls').ensureTenantRls().catch((e) =>
          console.error('[ensure-rls] boot check failed:', e.message));
      } catch (e) { console.error('[ensure-rls] boot init failed:', e.message); }
    });
}

// ── DWH: нічний авто-ETL о 04:00 за Києвом (раз на добу) ──
// dwh_etl_jobs.cron_expression існує, але шедулера не було — сховище наповнювалось
// лише кнопкою. Тепер факти/виміри оновлюються самі щоночі.
if (process.env.DATABASE_URL) {
  let _lastEtlDay = null;
  setInterval(async () => {
    try {
      const now = new Date();
      const kyivHour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Kyiv' }).format(now));
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
      if (kyivHour === 4 && _lastEtlDay !== day) {
        _lastEtlDay = day;
        const dwh = require('./routes/data-warehouse');
        if (typeof dwh.runAllActive === 'function') {
          const r = await dwh.runAllActive('cron');
          console.log('[dwh-cron] нічний ETL виконано:', r.length, 'джобів');
        }
      }
    } catch (e) { console.error('[dwh-cron]', e.message); sentry.capture(e, { kind: 'cron', job: 'dwh' }); }
  }, 20 * 60 * 1000).unref();
}

// ── Render keep-alive: free tier засыпает после 15 мин простоя ──
// Пингуем себя каждые 10 мин (svs-booking-api погашено 03.07 — бот тепер тут).
if (process.env.RENDER_EXTERNAL_URL) {
  const KEEPALIVE_URLS = [
    process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/health',
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
      catch (e) { console.error('[billing] recurring:', e.message); sentry.capture(e, { kind: 'cron', job: 'billing.recurring' }); }
      try { const d = await billing.processDunning(); if (d.attempted || d.suspended) console.log('[billing] dunning', d); }
      catch (e) { console.error('[billing] dunning:', e.message); sentry.capture(e, { kind: 'cron', job: 'billing.dunning' }); }
      try { const b = await require('./lib/bonus').expireBonuses(); if (b.expired) console.log('[bonus] expired', b); }
      catch (e) { console.error('[bonus] expiry:', e.message); sentry.capture(e, { kind: 'cron', job: 'bonus.expiry' }); }
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
