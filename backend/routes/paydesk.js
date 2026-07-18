/* routes/paydesk.js — «Каса-екран» (Босс, 18.07.2026). /api/paydesk
   Живий екран вхідних оплат Mono на рецепцію: хто/коли/скільки — без відкривання банку.
   Правила Босса:
   - видно ТІЛЬКИ СЬОГОДНІ (Київ): сервер сам визначає день, параметрів дати НЕМАЄ —
     історію через цей екран подивитись неможливо в принципі;
   - доступ ТІЛЬКИ за PIN (хеш у app_settings 'paydesk_pin_hash'); сесія екрана 14 год;
   - PIN встановлює власник (логін+пароль CRM прямо з екрана або повторно з нього ж).
   Джерела: (1) виписка мерчанта Mono (еквайринг: pay-link/QR) — кеш 30с;
            (2) особиста виписка Mono (усі приходи на картку) — ТІЛЬКИ якщо задано
                MONO_PERSONAL_TOKEN; кеш 90с (ліміт банку 1 запит/60с). */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db-pg');

const router = express.Router();
const pool = getPool();

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// PIN-сесії екрана: в памʼяті (рестарт сервера = повторний ввід PIN — прийнятно для екрана)
const _sessions = new Map(); // token → { tenantId, exp }
const SESSION_MS = 14 * 3600 * 1000;
function newSession(tenantId) {
  const t = 'pd_' + crypto.randomBytes(18).toString('hex');
  _sessions.set(t, { tenantId, exp: Date.now() + SESSION_MS });
  if (_sessions.size > 500) { // страховка від розпухання
    for (const [k, v] of _sessions) if (v.exp < Date.now()) _sessions.delete(k);
  }
  return t;
}
function checkSession(req) {
  const t = req.get('X-Paydesk-Token');
  const s = t && _sessions.get(t);
  if (!s || s.exp < Date.now()) return null;
  return s;
}

const pinLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too-many-attempts' } });

// Початок СЬОГОДНІ за Києвом (unix seconds)
function kyivDayStartUnix() {
  const now = new Date();
  const kyiv = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
  const dayStartKyiv = new Date(kyiv.getFullYear(), kyiv.getMonth(), kyiv.getDate());
  // зсув між локальним поданням і реальним моментом
  const offset = kyiv.getTime() - now.getTime();
  return Math.floor((dayStartKyiv.getTime() - offset) / 1000);
}

async function getPinHash() {
  return require('../lib/settings').getSetting('paydesk_pin_hash', null);
}

/* ── Встановлення PIN: власник підтверджує себе логіном+паролем CRM ── */
router.post('/set-pin', pinLimiter, async (req, res) => {
  try {
    const { identifier, password, pin } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'owner-credentials-required' });
    if (!/^\d{4,8}$/.test(String(pin || ''))) return res.status(400).json({ error: 'pin-4-8-digits' });
    const { verifyPassword, normalizePhone } = require('../lib/auth-core');
    const { getTenantId } = require('../lib/tenant');
    const tid = getTenantId();
    // самодостатній пошук власника В ПОТОЧНОМУ тенанті (телефон або email)
    const idn = String(identifier).trim();
    const params = idn.includes('@') ? [idn.toLowerCase()] : [normalizePhone(idn.replace(/\D/g, ''))];
    const cand = (await pool.query(
      `SELECT u.id, u.password_hash, u.is_active, r.code AS role_code, r.level AS role_level
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $2 AND ${idn.includes('@') ? 'LOWER(u.email)=$1' : 'u.phone=$1'}`,
      [params[0], tid])).rows;
    let owner = null;
    for (const u of cand) {
      if (!(u.role_code === 'owner' || Number(u.role_level) >= 100)) continue;
      if (u.is_active === false || !u.password_hash) continue;
      if (await verifyPassword(password, u.password_hash)) { owner = u; break; }
    }
    if (!owner) return res.status(403).json({ error: 'owner-only', message: 'Лише власник може встановити PIN' });
    await require('../lib/settings').setSetting('paydesk_pin_hash', sha(pin), owner.id);
    res.json({ ok: true });
  } catch (e) { console.error('[paydesk:set-pin]', e.message); res.status(500).json({ error: 'set-pin-failed' }); }
});

/* ── Вхід за PIN ── */
router.post('/login', pinLimiter, async (req, res) => {
  try {
    const hash = await getPinHash();
    // Босс (18.07): «убери пока что пинкод» — поки PIN не встановлено, екран
    // відкривається БЕЗ нього. Механіка лишається: щойно власник задасть PIN
    // (set-pin), вхід знову вимагатиме код.
    if (!hash) {
      const { getTenantId } = require('../lib/tenant');
      return res.json({ ok: true, token: newSession(getTenantId()), open: true });
    }
    if (sha(String(req.body?.pin || '')) !== hash) return res.status(401).json({ error: 'bad-pin' });
    const { getTenantId } = require('../lib/tenant');
    res.json({ ok: true, token: newSession(getTenantId()) });
  } catch (e) { console.error('[paydesk:login]', e.message); res.status(500).json({ error: 'login-failed' }); }
});

/* ── Сьогоднішні приходи (єдиний ендпоінт даних — дат у параметрах НЕМАЄ) ── */
const _cache = new Map(); // tenantId → { at, data } / 'personal' → { at, data }
router.get('/today', async (req, res) => {
  try {
    const sess = checkSession(req);
    if (!sess) return res.status(401).json({ error: 'pin-required' });
    const from = kyivDayStartUnix();
    const mono = require('../lib/mono');
    const items = [];

    // 1) Еквайринг (мерчант): кеш 30с
    const ck = 'm:' + sess.tenantId;
    const hit = _cache.get(ck);
    let mlist = hit && Date.now() - hit.at < 30000 ? hit.data : null;
    if (!mlist) {
      try {
        const st = await mono.merchantStatement(from);
        mlist = (st && st.list) || [];
        _cache.set(ck, { at: Date.now(), data: mlist });
      } catch (e) { mlist = (hit && hit.data) || []; }
    }
    for (const p of mlist) {
      if (p.status !== 'success') continue;
      items.push({
        id: 'acq:' + p.invoiceId,
        time: new Date(p.date).getTime() / 1000,
        amount: Math.round(Number(p.amount)) / 100,
        source: 'Оплата карткою (еквайринг)',
        desc: p.destination || '',
        masked: p.maskedPan || '',
      });
    }

    // 2) Особистий рахунок (усі приходи, вкл. перекази) — якщо підключено токен
    if (process.env.MONO_PERSONAL_TOKEN) {
      const hp = _cache.get('p');
      let plist = hp && Date.now() - hp.at < 90000 ? hp.data : null; // ліміт банку 1/60с
      if (!plist) {
        try {
          plist = (await mono.personalStatement(from)) || [];
          _cache.set('p', { at: Date.now(), data: plist });
        } catch (e) { plist = (hp && hp.data) || []; }
      }
      for (const t of plist) {
        if (Number(t.amount) <= 0) continue; // тільки ПРИХОДИ
        items.push({
          id: 'per:' + t.id,
          time: Number(t.time),
          amount: Math.round(Number(t.amount)) / 100,
          source: 'Надходження на картку',
          desc: [t.description, t.comment].filter(Boolean).join(' · '),
          masked: '',
        });
      }
    }

    // страховка «тільки сьогодні» (банк міг віддати ширше)
    const todayOnly = items.filter(i => i.time >= from);
    todayOnly.sort((a, b) => b.time - a.time);
    res.json({
      ok: true,
      date: new Date().toLocaleDateString('uk-UA', { timeZone: 'Europe/Kiev' }),
      total: Math.round(todayOnly.reduce((s, i) => s + i.amount, 0) * 100) / 100,
      count: todayOnly.length,
      personal_connected: !!process.env.MONO_PERSONAL_TOKEN,
      items: todayOnly.slice(0, 200),
    });
  } catch (e) { console.error('[paydesk:today]', e.message); res.status(500).json({ error: 'load-failed' }); }
});

module.exports = router;
