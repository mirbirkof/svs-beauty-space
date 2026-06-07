/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Нова Пошта API
   Документация: https://developers.novaposhta.ua/

   GET  /api/np/cities?q=Київ           — поиск города
   GET  /api/np/branches?city_ref=...   — отделения
   POST /api/np/calculate               — расчёт стоимости доставки
   POST /api/np/ttn                     — создать ТТН (admin)
   GET  /api/np/track/:ttn              — статус посылки

   ENV: NOVAPOSHTA_API_KEY (получить в кабинете НП)
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const https = require('https');
const router = express.Router();

const API_URL = 'https://api.novaposhta.ua/v2.0/json/';

function call(modelName, calledMethod, methodProperties = {}) {
  return new Promise((resolve, reject) => {
    if (!process.env.NOVAPOSHTA_API_KEY) {
      return reject(new Error('NOVAPOSHTA_API_KEY not configured'));
    }
    const data = JSON.stringify({
      apiKey: process.env.NOVAPOSHTA_API_KEY,
      modelName,
      calledMethod,
      methodProperties,
    });
    const url = new URL(API_URL);
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = https.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf);
          if (!parsed.success) return reject(new Error(parsed.errors?.join('; ') || 'np-error'));
          resolve(parsed.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function adminOnly(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.get('/cities', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q) return res.status(400).json({ error: 'q-required' });
    const data = await call('Address', 'searchSettlements', { CityName: q, Limit: 20 });
    res.json({ ok: true, items: data });
  } catch (e) {
    if (e.message.includes('not configured')) {
      return res.status(503).json({ error: 'np-not-configured', message: 'Ожидаются API ключи Нова Пошта' });
    }
    res.status(500).json({ error: 'np-failed', detail: e.message });
  }
});

router.get('/branches', async (req, res) => {
  try {
    const city_ref = req.query.city_ref;
    if (!city_ref) return res.status(400).json({ error: 'city_ref-required' });
    const data = await call('AddressGeneral', 'getWarehouses', {
      SettlementRef: city_ref, Limit: 200,
    });
    res.json({ ok: true, items: data });
  } catch (e) {
    if (e.message.includes('not configured')) {
      return res.status(503).json({ error: 'np-not-configured' });
    }
    res.status(500).json({ error: 'np-failed', detail: e.message });
  }
});

router.post('/calculate', async (req, res) => {
  try {
    const { city_sender, city_recipient, weight = 1, cost = 100 } = req.body || {};
    if (!city_sender || !city_recipient) return res.status(400).json({ error: 'cities-required' });
    const data = await call('InternetDocument', 'getDocumentPrice', {
      CitySender: city_sender,
      CityRecipient: city_recipient,
      Weight: weight,
      ServiceType: 'WarehouseWarehouse',
      Cost: cost,
      CargoType: 'Parcel',
      SeatsAmount: 1,
      PackCount: 1,
    });
    res.json({ ok: true, items: data });
  } catch (e) {
    if (e.message.includes('not configured')) {
      return res.status(503).json({ error: 'np-not-configured' });
    }
    res.status(500).json({ error: 'np-failed', detail: e.message });
  }
});

router.post('/ttn', adminOnly, async (req, res) => {
  try {
    // полная реализация после получения ключей и настройки отправителя
    res.status(501).json({ error: 'not-implemented-yet', hint: 'нужны NP API ключ + sender ref' });
  } catch (e) {
    res.status(500).json({ error: 'np-failed', detail: e.message });
  }
});

router.get('/track/:ttn', async (req, res) => {
  try {
    const data = await call('TrackingDocument', 'getStatusDocuments', {
      Documents: [{ DocumentNumber: req.params.ttn, Phone: '' }],
    });
    res.json({ ok: true, status: data[0] || null });
  } catch (e) {
    if (e.message.includes('not configured')) {
      return res.status(503).json({ error: 'np-not-configured' });
    }
    res.status(500).json({ error: 'np-failed', detail: e.message });
  }
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    configured: !!process.env.NOVAPOSHTA_API_KEY,
    message: process.env.NOVAPOSHTA_API_KEY ? 'ready' : 'awaiting-key',
  });
});

module.exports = router;
