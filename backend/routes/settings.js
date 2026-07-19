/* Глобальні налаштування CRM
   GET   /api/settings           → усі налаштування (будь-який авторизований)
   PATCH /api/settings           → змінити (тільки owner/admin)
   Body: { masters_see_phone: true }  */
const express = require('express');
const router = express.Router();
const { requirePerm, hasPermission, logAction } = require('../lib/rbac');
const { getAllSettings, setSetting } = require('../lib/settings');

// дозволені ключі + валідатори (захист від довільного запису)
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ALLOWED = {
  masters_see_phone: (v) => typeof v === 'boolean',
  // Чи можуть майстри самі займати/блокувати свій час у журналі (заметка #50, дефолт false)
  masters_can_block_time: (v) => typeof v === 'boolean',
  // Чи може адмін редагувати записи минулих днів у журналі (заметка #95, дефолт false; власник може завжди)
  allow_edit_past: (v) => typeof v === 'boolean',
  // Чи може адмін керувати послугами/розцінками майстрів (Босс 19.07, дефолт false; власник завжди)
  admin_edit_master_services: (v) => typeof v === 'boolean',
  // Строк дії дозволу (ISO-час). null = безстроково. Коли час минув — дозвіл автоматично не діє.
  allow_edit_past_until: (v) => v === null || (typeof v === 'string' && !isNaN(Date.parse(v))),
  // Профіль салону (DIKIDI-style): назва, телефони, адреса, час роботи, опис, напрямки, фото
  salon_profile: (v) => isObj(v),
  // Онлайн-запис: вкл/вимк, посилання, крок часу, мін. час до запису
  online_booking: (v) => isObj(v),
  // Передплата: вкл/вимк, % депозиту, мін. сума (грн)
  prepayment: (v) => isObj(v),
  // ── Налаштування власника (BeautyPro-рівень) ──
  // Видимість для майстрів: бачать чужі записи / фінанси / контакти клієнтів
  masters_visibility: (v) => isObj(v),
  // Лояльність: % кешбеку, поріг списання, рівні, термін дії балів
  loyalty: (v) => isObj(v),
  // Сповіщення: канали (sms/telegram), за скільки годин нагадування, шаблони
  notifications: (v) => isObj(v),
  // Фінанси: валюта, % комісії за замовч., РРО/фіскалізація, податок
  finance: (v) => isObj(v),
  // Політика скасування: мін. години до скасування, штраф за неявку
  cancellation: (v) => isObj(v),
  // Способи оплати: які увімкнені (готівка/картка/mono/apple/google)
  payment_methods: (v) => isObj(v),
  // Робочий час салону за замовчуванням (графік по днях тижня)
  working_hours: (v) => isObj(v),
};

router.use(requirePerm()); // будь-який авторизований може читати

// Чутливі налаштування власника — не віддаємо майстру/клієнту.
const SENSITIVE_KEYS = ['finance', 'loyalty', 'masters_visibility', 'notifications', 'cancellation'];
const BACK_OFFICE = ['owner', 'admin', 'manager', 'accountant', 'marketer', 'reception'];

router.get('/', async (req, res) => {
  try {
    const all = await getAllSettings();
    const role = (req.user && req.user.role) || '';
    if (!BACK_OFFICE.includes(role) && all && typeof all === 'object') {
      for (const k of SENSITIVE_KEYS) delete all[k];
    }
    res.json({ ok: true, settings: all });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.patch('/', async (req, res) => {
  try {
    const u = req.user || {};
    const canWrite = hasPermission(u.permissions, '*') || ['owner', 'admin'].includes(u.role);
    if (!canWrite) return res.status(403).json({ error: 'forbidden', message: 'Лише власник або адмін може змінювати налаштування' });

    const body = req.body || {};
    const keys = Object.keys(body).filter(k => k in ALLOWED);
    if (!keys.length) return res.status(400).json({ error: 'no-valid-keys' });

    for (const k of keys) {
      if (!ALLOWED[k](body[k])) return res.status(400).json({ error: 'bad-value', key: k });
    }

    // ── Тарифні фічі (Майстер PRO): УВІМКНЕННЯ депозиту / SMS-каналу вимагає фічу плану.
    // Вимкнення і решта налаштувань — вільно. Платформа/старі салони — без обмежень
    // (featureAllowed fail-open, якщо для плану немає рядка фічі).
    try {
      const { isPlatformTenant } = require('../lib/tenant');
      if (!(isPlatformTenant && isPlatformTenant())) {
        const { requireFeature } = require('../lib/feature-gate');
        const gate = async (fkey) => new Promise((resolve) => {
          requireFeature(fkey)(req, { status: () => ({ json: () => resolve(false) }) }, () => resolve(true));
        });
        if (body.prepayment && body.prepayment.enabled === true && !(await gate('booking.prepay'))) {
          return res.status(403).json({ error: 'feature-locked', feature: 'booking.prepay',
            message: 'Передоплата при записі доступна на тарифі Майстер PRO. Спробуйте 14 днів безкоштовно у розділі «Моя підписка».' });
        }
        if (body.notifications && body.notifications.sms === true && !(await gate('sms.reminders'))) {
          return res.status(403).json({ error: 'feature-locked', feature: 'sms.reminders',
            message: 'SMS-нагадування доступні на тарифі Майстер PRO. Спробуйте 14 днів безкоштовно у розділі «Моя підписка».' });
        }
        // АВТО-нагадування (DIKIDI-логіка: головний платний тригер) — будь-який авто-канал
        if (body.notifications && (body.notifications.telegram === true || body.notifications.viber === true)
            && !(await gate('notify.auto'))) {
          return res.status(403).json({ error: 'feature-locked', feature: 'notify.auto',
            message: 'Автоматичні нагадування доступні на тарифі Майстер PRO (безкоштовно — ручні: готовий шаблон, надсилаєте самі). Спробуйте PRO 14 днів безкоштовно.' });
        }
      }
    } catch (e) { console.error('[settings/feature-gate]', e.message); /* fail-open */ }

    for (const k of keys) await setSetting(k, body[k], u.id || null);

    logAction({ user: u, action: 'settings.update', entity: 'settings', meta: body, ip: req.ip });
    res.json({ ok: true, settings: await getAllSettings() });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

module.exports = router;
