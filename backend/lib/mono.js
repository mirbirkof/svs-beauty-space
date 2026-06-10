/* ═══════════════════════════════════════════════════════
   Mono Acquiring client
   Docs: https://monobank.ua/api-docs/acquiring

   ENV: MONO_TOKEN — токен мерчанта (X-Token)
   ═══════════════════════════════════════════════════════ */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API_HOST = 'api.monobank.ua';

function monoRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = process.env.MONO_TOKEN;
    if (!token) return reject(new Error('MONO_TOKEN not configured'));
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      method,
      hostname: API_HOST,
      path: apiPath,
      headers: {
        'X-Token': token,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = { raw: buf }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const err = new Error(`mono ${res.statusCode}: ${parsed.errText || parsed.errCode || buf.slice(0, 200)}`);
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error('mono-timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Публичный base URL для redirect/webhook.
 *  Приоритет: MONO_PUBLIC_URL (постоянный домен) → tunnel/current-url.txt (ротируется).
 *  Читаем файл при КАЖДОМ создании инвойса — туннель мог ротироваться. */
function getPublicBase() {
  if (process.env.MONO_PUBLIC_URL) return process.env.MONO_PUBLIC_URL.replace(/\/$/, '');
  try {
    const p = path.join(__dirname, '..', '..', 'tunnel', 'current-url.txt');
    const url = fs.readFileSync(p, 'utf8').trim();
    if (url.startsWith('http')) return url.replace(/\/$/, '');
  } catch { /* no tunnel file */ }
  return null;
}

/** Создать инвойс. amountUah — гривны (переводим в копейки). */
async function createInvoice({ amountUah, orderId, destination, basket }) {
  const base = getPublicBase();
  const payload = {
    amount: Math.round(Number(amountUah) * 100),
    ccy: 980,
    merchantPaymInfo: {
      reference: String(orderId),
      destination: destination || `Замовлення №${orderId} — SVS Beauty World`,
      ...(basket && basket.length ? {
        basketOrder: basket.map(b => ({
          name: String(b.name).slice(0, 128),
          qty: b.qty,
          sum: Math.round(Number(b.unit_price) * 100), // цена за единицу, копейки
          total: Math.round(Number(b.line_total) * 100),
          unit: 'шт.',
        })),
      } : {}),
    },
    validity: 24 * 3600, // сутки на оплату
    ...(base ? {
      redirectUrl: `${base}/p/order-paid.html?order=${orderId}`,
      webHookUrl: `${base}/api/pay/mono/webhook`,
    } : {}),
  };
  return monoRequest('POST', '/api/merchant/invoice/create', payload);
}

function getInvoiceStatus(invoiceId) {
  return monoRequest('GET', `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`);
}

function getMerchantDetails() {
  return monoRequest('GET', '/api/merchant/details');
}

// ── верификация подписи вебхука (X-Sign, ECDSA-SHA256) ──
let _pubKeyPem = null;
let _pubKeyAt = 0;

async function getPubKeyPem(force = false) {
  if (!force && _pubKeyPem && Date.now() - _pubKeyAt < 24 * 3600 * 1000) return _pubKeyPem;
  const r = await monoRequest('GET', '/api/merchant/pubkey');
  if (!r.key) throw new Error('mono pubkey missing');
  _pubKeyPem = Buffer.from(r.key, 'base64').toString('utf8');
  _pubKeyAt = Date.now();
  return _pubKeyPem;
}

/** rawBody — Buffer тела запроса БЕЗ изменений, xSign — заголовок X-Sign (base64) */
async function verifyWebhook(rawBody, xSign) {
  if (!xSign || !rawBody) return false;
  const check = (pem) => {
    const v = crypto.createVerify('SHA256');
    v.update(rawBody);
    v.end();
    return v.verify(pem, Buffer.from(xSign, 'base64'));
  };
  try {
    if (check(await getPubKeyPem())) return true;
    // ключ мог ротироваться на стороне Mono — обновляем и пробуем ещё раз
    return check(await getPubKeyPem(true));
  } catch (e) {
    console.error('[mono:verify]', e.message);
    return false;
  }
}

module.exports = { createInvoice, getInvoiceStatus, getMerchantDetails, verifyWebhook, getPublicBase };
