/* routes/public-signup.js — SAS-10 Публічна самореєстрація салонів. /api/public
   Вхідні двері для нових салонів БЕЗ участі суперадміна:
     POST /signup   { salon_name, owner_name, phone, password, email?, plan_code?, cycle? }
       → створює тенант + власника + 14-денний trial (через tm.createTenant)
       → повертає { slug, login_url, trial_ends_at }

   Захист від зловживань:
     - власний rate-limit: 5 реєстрацій / година / IP
     - валідація полів (ім'я, телефон, пароль >=6)
     - дедуп: якщо телефон вже є власником активного салону → 409
   Платіж НЕ потрібен: trial безкоштовний 14 днів. Оплата — після trial,
   через уже наявний модуль /api/billing (subscription/invoices/pay-link). */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const tm = require('../lib/tenant-mgmt');

// Жорсткий ліміт: 5 реєстрацій на годину з одного IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато реєстрацій з цієї адреси. Спробуйте за годину.' },
});

// Канонические слаги saas_plans_v2 + legacy-коды (solo/pro) для обратной совместимости.
// Аудит: раньше здесь не было 'starter'/'professional' → выбор Starter (490) молча
// подменялся на 'pro' (990) — салон платил бы за не тот тариф.
const ALLOWED_PLANS = ['free', 'starter', 'professional', 'enterprise', 'solo', 'pro'];

router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const salonName = String(b.salon_name || b.name || '').trim();
    const ownerName = String(b.owner_name || '').trim() || 'Власник';
    const phone = String(b.phone || '').replace(/\D/g, '');
    const password = b.password ? String(b.password) : '';
    const email = b.email ? String(b.email).trim() : null;
    // Страна (выбор) и язык (автоопределён из браузера) — запрос Босса.
    const country = b.country ? String(b.country).slice(0, 8).toUpperCase() : null;
    const lang = b.lang ? String(b.lang).slice(0, 5).toLowerCase() : 'uk';
    // account_type='solo' → майстер-одиночка: безкоштовний план solo
    const accountType = b.account_type === 'solo' ? 'solo' : 'salon';
    // Вертикаль бізнесу (Phase A, 18.07): обирається на реєстрації і визначає, які модулі
    // «існують» для тенанта (lib/vertical.js, fail-closed). Невідоме значення → beauty.
    const businessType = ['beauty', 'fitness', 'dental', 'wellness'].includes(b.business_type) ? b.business_type : 'beauty';
    let planCode = ALLOWED_PLANS.includes(b.plan_code) ? b.plan_code : 'pro';
    if (accountType === 'solo') planCode = 'solo';
    const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
    // solo та free — безкоштовні назавжди, trial не потрібен
    const needTrial = !['solo', 'free'].includes(planCode);

    // Валідація на межі системи
    if (!salonName) return res.status(400).json({ error: 'salon-name-required' });
    if (salonName.length > 120) return res.status(400).json({ error: 'salon-name-too-long' });
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'valid-phone-required' });
    // SaaS-поріг (Phase A): min 8 символів для НОВИХ реєстрацій (старі паролі не чіпаємо).
    if (!password || password.length < 8) return res.status(400).json({ error: 'password-min-8' });
    // GDPR (блокер G1, ужесточено РАУНД3-m5): згода має бути ЯВНОЮ — сервер не довіряє
    // «мовчазній» згоді. Форма шле consent:true з 11.07 (commit 67aa4ea), API-клієнти зобовʼязані теж.
    if (b.consent !== true && b.consent !== 'true') return res.status(400).json({ error: 'consent-required' });

    // Дедуп не потрібен: телефон унікальний ПЕР-САЛОН (migration 016),
    // один власник може мати кілька салонів. Від спаму захищає rate-limit вище.
    // Створення салону + власника. Платні плани → 14-денний trial.
    // solo/free → trial:false: одразу постійна безкоштовна active-підписка без рахунку.
    // ПІДТВЕРДЖЕННЯ ТЕЛЕФОНУ (Босс 16.07): НЕ створюємо салон одразу — спершу
    // верифікуємо номер через Telegram (безкоштовно, request_contact). Дані заявки
    // живуть у pending_signups, реальне створення — у lib/signup-verify після контакту.
    const { hashPassword } = require('../lib/auth-core');
    const verify = require('../lib/signup-verify');
    const cip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
    const password_hash = await hashPassword(password);
    const { token, deeplink, bot_username } = await verify.createPending({
      phone, salonName, ownerName, email, password_hash, accountType, planCode, cycle,
      businessType, country, lang, refCode: (b.ref || req.query.ref || '').toString().trim() || null,
      consent: true, consentIp: cip,
    });
    res.status(202).json({
      ok: true, needs_verification: true, token, deeplink, bot_username,
      message: 'Підтвердіть номер телефону в Telegram, щоб завершити реєстрацію.',
    });
  } catch (e) {
    console.error('[public-signup]', e.message);
    const msg = e.message || '';
    const code = /required|invalid|min|too-long/.test(msg) ? 400 : 500;
    res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : msg });
  }
});

// Статус заявки: веб поллит після відкриття Telegram-бота.
// { status: pending | verified | expired | not-found, slug?, login_url? }
router.get('/signup-status', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token-required' });
    const st = await require('../lib/signup-verify').getStatus(token);
    res.json(st);
  } catch (e) {
    console.error('[signup-status]', e.message);
    res.status(500).json({ error: 'status-failed' });
  }
});

module.exports = router;
