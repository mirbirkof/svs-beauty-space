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

const ALLOWED_PLANS = ['solo', 'free', 'pro', 'enterprise'];

router.post('/signup', signupLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const salonName = String(b.salon_name || b.name || '').trim();
    const ownerName = String(b.owner_name || '').trim() || 'Власник';
    const phone = String(b.phone || '').replace(/\D/g, '');
    const password = b.password ? String(b.password) : '';
    const email = b.email ? String(b.email).trim() : null;
    // account_type='solo' → майстер-одиночка: безкоштовний план solo
    const accountType = b.account_type === 'solo' ? 'solo' : 'salon';
    let planCode = ALLOWED_PLANS.includes(b.plan_code) ? b.plan_code : 'pro';
    if (accountType === 'solo') planCode = 'solo';
    const cycle = b.cycle === 'yearly' ? 'yearly' : 'monthly';
    // solo та free — безкоштовні назавжди, trial не потрібен
    const needTrial = !['solo', 'free'].includes(planCode);

    // Валідація на межі системи
    if (!salonName) return res.status(400).json({ error: 'salon-name-required' });
    if (salonName.length > 120) return res.status(400).json({ error: 'salon-name-too-long' });
    if (!phone || phone.length < 10) return res.status(400).json({ error: 'valid-phone-required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'password-min-6' });

    // Дедуп не потрібен: телефон унікальний ПЕР-САЛОН (migration 016),
    // один власник може мати кілька салонів. Від спаму захищає rate-limit вище.
    // Створення салону + власника. Платні плани → 14-денний trial.
    // solo/free → trial:false: одразу постійна безкоштовна active-підписка без рахунку.
    const r = await tm.createTenant(salonName, {
      phone, password, owner_name: ownerName, email,
      plan_code: planCode, cycle, trial: needTrial,
    }, { id: null, source: 'public-signup' });

    res.status(201).json({
      ok: true,
      slug: r.slug,
      salon_name: r.tenant.name,
      login: { phone, tenant_slug: r.slug, header: 'X-Tenant-Slug: ' + r.slug },
      login_url: '/admin/?tenant=' + encodeURIComponent(r.slug),
      subscription: r.subscription,
      trial_ends_at: r.subscription ? r.subscription.trial_ends_at : null,
    });
  } catch (e) {
    console.error('[public-signup]', e.message);
    const msg = e.message || '';
    const code = /required|invalid|min|too-long/.test(msg) ? 400 : 500;
    res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : msg });
  }
});

module.exports = router;
