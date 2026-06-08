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

const { requirePerm } = require('../lib/rbac');

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

/**
 * POST /api/np/ttn — створення ТТН
 * body: {
 *   recipient_name, recipient_phone,
 *   city_recipient_ref, warehouse_recipient_ref,  (або recipient_address для адресної доставки)
 *   weight=0.5, cost, description='Косметика',
 *   payer='Recipient'|'Sender', payment_method='Cash'|'NonCash',
 *   order_id (optional — для логу)
 * }
 * env: NOVAPOSHTA_SENDER_REF, NP_SENDER_CONTACT_REF, NP_SENDER_PHONE,
 *      NP_SENDER_CITY_REF, NP_SENDER_WAREHOUSE_REF
 */
router.post('/ttn', requirePerm('novaposhta.write'), async (req, res) => {
  try {
    const {
      recipient_name, recipient_phone,
      city_recipient_ref, warehouse_recipient_ref,
      weight = 0.5, cost, description = 'Косметика SVS Beauty World',
      payer = 'Recipient', payment_method = 'Cash',
      order_id,
    } = req.body || {};

    // Перевірки даних
    if (!recipient_name || !recipient_phone) return res.status(400).json({ error: 'recipient_name+phone required' });
    if (!city_recipient_ref || !warehouse_recipient_ref) return res.status(400).json({ error: 'city_recipient_ref+warehouse_recipient_ref required' });
    if (!cost) return res.status(400).json({ error: 'cost (вартість товару) required' });

    // Перевірки env-конфігурації відправника
    const senderRef = process.env.NOVAPOSHTA_SENDER_REF;
    const senderContactRef = process.env.NP_SENDER_CONTACT_REF;
    const senderPhone = process.env.NP_SENDER_PHONE;
    const senderCityRef = process.env.NP_SENDER_CITY_REF;
    const senderWarehouseRef = process.env.NP_SENDER_WAREHOUSE_REF;
    const missing = [];
    if (!senderRef) missing.push('NOVAPOSHTA_SENDER_REF');
    if (!senderContactRef) missing.push('NP_SENDER_CONTACT_REF');
    if (!senderPhone) missing.push('NP_SENDER_PHONE');
    if (!senderCityRef) missing.push('NP_SENDER_CITY_REF');
    if (!senderWarehouseRef) missing.push('NP_SENDER_WAREHOUSE_REF');
    if (missing.length) {
      return res.status(503).json({ error: 'sender-not-configured', missing, hint: 'Налаштуйте відправника в кабінеті НП → візьміть Ref-и → додайте в Render env' });
    }

    // Сьогоднішня дата у форматі DD.MM.YYYY
    const d = new Date();
    const dateStr = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;

    const data = await call('InternetDocument', 'save', {
      PayerType: payer,                   // 'Sender' або 'Recipient'
      PaymentMethod: payment_method,      // 'Cash' або 'NonCash'
      DateTime: dateStr,
      CargoType: 'Parcel',
      Weight: weight,
      ServiceType: 'WarehouseWarehouse',
      SeatsAmount: 1,
      Description: description,
      Cost: cost,
      // Відправник (з env)
      CitySender: senderCityRef,
      Sender: senderRef,
      SenderAddress: senderWarehouseRef,
      ContactSender: senderContactRef,
      SendersPhone: senderPhone,
      // Отримувач (з тіла запиту)
      CityRecipient: city_recipient_ref,
      RecipientAddress: warehouse_recipient_ref,
      RecipientsPhone: recipient_phone,
      RecipientType: 'PrivatePerson',
      Recipient: '',                      // для PrivatePerson передаємо через NewAddress модель або порожньо
      ContactRecipient: '',
      // Дані фіз-особи отримувача (НП створить контакт автоматом)
      RecipientName: recipient_name,
    });

    // Записати ТТН в замовлення якщо order_id переданий
    const ttn = data[0]?.IntDocNumber;
    const ref = data[0]?.Ref;
    if (order_id && ttn) {
      try {
        const { getPool } = require('../db-pg');
        await getPool().query(
          `UPDATE orders SET shipping_ttn = $1, shipping_provider = 'novaposhta', updated_at = NOW() WHERE id = $2`,
          [ttn, order_id]
        );
      } catch (e) { console.error('[np/ttn] failed to update order', e.message); }
    }

    res.json({ ok: true, ttn, ref, raw: data[0] });
  } catch (e) {
    if (e.message.includes('not configured')) {
      return res.status(503).json({ error: 'np-not-configured' });
    }
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
