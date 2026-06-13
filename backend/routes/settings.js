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
  // Профіль салону (DIKIDI-style): назва, телефони, адреса, час роботи, опис, напрямки, фото
  salon_profile: (v) => isObj(v),
  // Онлайн-запис: вкл/вимк, посилання, крок часу, мін. час до запису
  online_booking: (v) => isObj(v),
  // Передплата: вкл/вимк, % депозиту, мін. сума (грн)
  prepayment: (v) => isObj(v),
};

router.use(requirePerm()); // будь-який авторизований може читати

router.get('/', async (req, res) => {
  try {
    res.json({ ok: true, settings: await getAllSettings() });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    for (const k of keys) await setSetting(k, body[k], u.id || null);

    logAction({ user: u, action: 'settings.update', entity: 'settings', meta: body, ip: req.ip });
    res.json({ ok: true, settings: await getAllSettings() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
