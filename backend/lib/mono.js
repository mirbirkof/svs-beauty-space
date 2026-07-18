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

const { withRetry } = require('./retry');

// ── Per-tenant токен еквайрингу (аудит v6, блокер аренды) ────────────────
// Раніше єдиний process.env.MONO_TOKEN → гроші клієнтів САЛОНІВ-ОРЕНДАРІВ йшли
// на рахунок платформи. Тепер: салон Босса (дефолтний тенант / без контексту,
// кроны платформи) — платформенний токен з env; орендар — СВІЙ токен зі своїх
// налаштувань (integration-secrets, per-tenant, шифрований). Без свого токена
// клієнтські оплати орендаря чесно вимикаються (помилка, не чужий рахунок).
const _tokCache = new Map(); // tenantId -> { tok, exp }
async function resolveToken() {
  let tid = null, DEF = null;
  try {
    const t = require('./tenant');
    tid = t.getTenantId();
    DEF = t.DEFAULT_TENANT_ID;
  } catch (_) { /* поза контекстом — платформа */ }
  if (!tid || tid === DEF) {
    const tok = process.env.MONO_TOKEN;
    if (!tok) throw new Error('MONO_TOKEN not configured');
    return tok;
  }
  const hit = _tokCache.get(tid);
  if (hit && hit.exp > Date.now()) {
    if (!hit.tok) throw new Error('mono-not-configured-for-tenant');
    return hit.tok;
  }
  const { getTenantIntegrationSecret } = require('./integration-secrets');
  const tok = await getTenantIntegrationSecret('MONO_TOKEN'); // RLS: контекст цього салону
  _tokCache.set(tid, { tok, exp: Date.now() + 60 * 1000 });
  if (!tok) throw new Error('mono-not-configured-for-tenant');
  return tok;
}
function invalidateTokenCache(tenantId) { if (tenantId) _tokCache.delete(tenantId); else _tokCache.clear(); }

// Публічна обгортка: повторює запит при 429/5xx/таймауті (не втрачаємо платіж/статус).
function monoRequest(method, apiPath, body) {
  return withRetry(async () => _monoRequestOnce(method, apiPath, body, await resolveToken()),
    { label: 'mono', tries: 3, baseDelay: 500 });
}
function _monoRequestOnce(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
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
async function createInvoice({ amountUah, orderId, destination, basket, saveCardData }) {
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
    // Phase E (18.07): токенізація картки для автосписань підписки (потребує
    // активації токенізації у підтримці monobank). saveCardData={saveCard,walletId}.
    ...(saveCardData ? { saveCardData } : {}),
    ...(base ? {
      redirectUrl: `${base}/p/order-paid.html?order=${orderId}`,
      // Метка салона в webhook-URL (аудит-контроль): вебхук Mono не несёт tenant, а подпись
      // проверяется pubkey КОНКРЕТНОГО мерчанта. Для салона-арендатора кладём ?t=<tenantId>,
      // чтобы обработчик поднял его контекст и проверил подпись ЕГО токеном. Платформа
      // (салон Босса, дефолтный тенант) — без метки, как раньше.
      webHookUrl: `${base}/api/pay/mono/webhook${_tenantTag()}`,
    } : {}),
  };
  return monoRequest('POST', '/api/merchant/invoice/create', payload);
}

// Тег текущего тенанта для webhook-URL (пусто для платформы/вне контекста).
function _tenantTag() {
  try {
    const t = require('./tenant');
    const tid = t.getTenantId();
    if (tid && tid !== t.DEFAULT_TENANT_ID) return '?t=' + encodeURIComponent(tid);
  } catch (_) {}
  return '';
}

function getInvoiceStatus(invoiceId) {
  return monoRequest('GET', `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`);
}

function getMerchantDetails() {
  return monoRequest('GET', '/api/merchant/details');
}

// ── верификация подписи вебхука (X-Sign, ECDSA-SHA256) ──
// Per-merchant: у кожного токена свій pubkey (аудит v6) — кеш ключів по токену.
const _pubKeys = new Map(); // tokenHash -> { pem, at }

async function getPubKeyPem(force = false) {
  const tok = await resolveToken();
  const kh = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
  const hit = _pubKeys.get(kh);
  if (!force && hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.pem;
  const r = await monoRequest('GET', '/api/merchant/pubkey');
  if (!r.key) throw new Error('mono pubkey missing');
  const pem = Buffer.from(r.key, 'base64').toString('utf8');
  _pubKeys.set(kh, { pem, at: Date.now() });
  return pem;
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

// Phase E (18.07): списання зі збереженої картки (рекурент). Офіційна дока:
// POST /api/merchant/wallet/payment { cardToken, amount(коп), ccy, initiationKind:'merchant' }.
// Статус приходить вебхуком, як у звичайного інвойса.
async function walletPayment({ cardToken, amountUah, orderId, destination }) {
  const base = getPublicBase();
  return monoRequest('POST', '/api/merchant/wallet/payment', {
    cardToken,
    amount: Math.round(Number(amountUah) * 100),
    ccy: 980,
    initiationKind: 'merchant',
    paymentType: 'debit',
    merchantPaymInfo: { reference: String(orderId), destination: (destination || '').slice(0, 280) },
    ...(base ? { webHookUrl: `${base}/api/pay/mono/webhook` } : {}),
  });
}

// Каса-екран (Босс, 18.07): виписка мерчанта за період — усі success-оплати еквайрингу.
// GET /api/merchant/statement?from=<unix>&to=<unix> (офіційна дока, суми в копійках, date=RFC-3339).
async function merchantStatement(fromUnix, toUnix) {
  const q = `from=${Math.floor(fromUnix)}` + (toUnix ? `&to=${Math.floor(toUnix)}` : '');
  return monoRequest('GET', `/api/merchant/statement?${q}`);
}

// Особиста виписка (ВСІ приходи на рахунок, вкл. перекази на картку) — окремий
// ОСОБИСТИЙ токен MONO_PERSONAL_TOKEN (https://api.monobank.ua, QR-авторизація).
// Ліміт банку: 1 запит / 60 сек — виклики ОБОВʼЯЗКОВО кешувати (routes/paydesk.js).
function personalStatement(fromUnix, toUnix, account) {
  const token = process.env.MONO_PERSONAL_TOKEN;
  if (!token) return Promise.resolve(null);
  const acc = account || process.env.MONO_PERSONAL_ACCOUNT || '0';
  return withRetry(() => _monoRequestOnce('GET',
    `/personal/statement/${encodeURIComponent(acc)}/${Math.floor(fromUnix)}/${Math.floor(toUnix || Date.now() / 1000)}`,
    null, token), { label: 'mono-personal', tries: 2, baseDelay: 1000 });
}

module.exports = { createInvoice, getInvoiceStatus, getMerchantDetails, verifyWebhook, getPublicBase, invalidateTokenCache, walletPayment, merchantStatement, personalStatement };
