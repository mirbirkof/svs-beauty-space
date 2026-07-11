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
    // GDPR (блокер G1): згода на обробку ПД обов'язкова. Явне false = відмова → блок.
    // Відсутність поля трактуємо як згоду (форма має чекбокс), але факт фіксуємо нижче.
    if (b.consent === false || b.consent === 'false') return res.status(400).json({ error: 'consent-required' });

    // Дедуп не потрібен: телефон унікальний ПЕР-САЛОН (migration 016),
    // один власник може мати кілька салонів. Від спаму захищає rate-limit вище.
    // Створення салону + власника. Платні плани → 14-денний trial.
    // solo/free → trial:false: одразу постійна безкоштовна active-підписка без рахунку.
    const r = await tm.createTenant(salonName, {
      phone, password, owner_name: ownerName, email,
      plan_code: planCode, cycle, trial: needTrial,
    }, { id: null, source: 'public-signup' });

    // GDPR (блокер G1): зберігаємо доказ згоди власника — timestamp, джерело, IP, версія.
    try {
      const { getPool } = require('../db-pg');
      const cip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
      await getPool().query(
        `UPDATE tenants SET consent_given_at = NOW(), consent_source = $2, consent_ip = $3, consent_version = $4 WHERE id = $1`,
        [r.tenant.id, 'public-signup', cip, 'offer+dpa-2026-07']);
    } catch (consErr) { console.error('[public-signup/consent]', consErr.message); }

    // SAS этап 2: онлайн-запис доступний одразу — ліцензія модуля online_booking.
    // Платні плани → trial на trial_days; solo/free → безстрокова підписка (це
    // ключовий сценарій майстра-одиночки: CRM + запис + свій ТГ-бот безкоштовно).
    try {
      const { getPool } = require('../db-pg');
      const mod = await getPool().query(`SELECT id, trial_days FROM module_catalog WHERE code = 'online_booking'`);
      if (mod.rowCount) {
        await getPool().query(
          `INSERT INTO licenses (tenant_id, module_id, license_type, status, activated_at, expires_at)
           VALUES ($1, $2, $3, 'active', NOW(), $4)
           ON CONFLICT DO NOTHING`,
          [r.tenant.id, mod.rows[0].id,
           needTrial ? 'trial' : 'subscription',
           needTrial ? new Date(Date.now() + (Number(mod.rows[0].trial_days) || 14) * 864e5) : null]);
      }
    } catch (licErr) { console.error('[public-signup/license]', licErr.message); }

    // МАЙСТЕР-ОДИНОЧКА (SaaS-аудит 06.07): одразу створюємо йому картку майстра
    // (інакше журнал/онлайн-запис порожні і незрозумілі) та вмикаємо соло-режим
    // (app_settings тепер per-tenant, міграція 217).
    if (accountType === 'solo') {
      try {
        const { runAs } = require('../lib/tenant');
        await runAs(r.tenant.id, async () => {
          const { getPool } = require('../db-pg');
          await getPool().query(
            `INSERT INTO masters (name, phone, specialty, active, provides_services)
             VALUES ($1, $2, NULL, true, true)
             ON CONFLICT DO NOTHING`, [ownerName, phone]);
          // лінкуємо owner-користувача з карткою майстра — інакше весь кабінет майстра
          // (/api/me/*, «мої клієнти») відповідає 403 «Тільки для майстра» (аудит 06.07, P0)
          await getPool().query(
            `UPDATE users u SET master_id = m.id FROM masters m
              WHERE m.phone = $1 AND u.phone = $1 AND u.master_id IS NULL`, [phone]);
          const { setSetting } = require('../lib/settings');
          await setSetting('solo_master_mode', true, null);
          // тип акаунта в онбординг + крок 'employees' авто-виконано (соло працює сам,
          // інакше чек-лист онбордингу навічно вимагає «додати співробітників», 100% недосяжні)
          await getPool().query(
            `UPDATE tenant_onboarding SET account_type='solo' WHERE tenant_id=$1`, [r.tenant.id]);
          try { await tm.completeStep(r.tenant.id, 'employees'); } catch (_) {}
          // дефолтний графік (пн-сб 09-18 на 30 днів) — інакше онлайн-запис
          // повертає нуль слотів і соло-майстер думає, що система зламана
          await getPool().query(
            `INSERT INTO master_schedule_days (master_id, work_date, start_time, end_time, source)
             SELECT m.id, gs::date, '09:00', '18:00', 'signup-default'
               FROM masters m,
                    generate_series(CURRENT_DATE, CURRENT_DATE + 89, '1 day') gs
              WHERE m.phone = $1 AND EXTRACT(ISODOW FROM gs) < 7
             ON CONFLICT DO NOTHING`, [phone]);
        });
      } catch (soloErr) { console.error('[public-signup/solo]', soloErr.message); }
    }

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
