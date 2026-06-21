/* routes/meta-ads.js — MKT-08 Meta Ads API.
   Префікс монтування: /api/meta-ads.
   - Lead Ads вебхук (GET verify + POST) — ПУБЛІЧНИЙ, до авторизації, з перевіркою
     підпису META_APP_SECRET; маршрутизація лідів кросс-тенантно по page_id → runAs.
   - Решта endpoint'ів — під requirePerm('marketing.read' | 'marketing.write')
     (owner має '*'). RLS гарантує ізоляцію по tenant у межах запиту. */
const express = require('express');
const router = express.Router();
const { requirePerm } = require('../lib/rbac');
const { verifyChallenge, verifySignature } = require('../lib/channels/instagram-meta');
const { runAs } = require('../lib/tenant');
const meta = require('../lib/meta-ads');

const fail = (res, e) => {
  const known = /required|not-found|invalid|token-check|disabled|mismatch/.test(e.message || '');
  res.status(known ? 400 : 500).json({
    error: process.env.NODE_ENV === 'production' && !known ? 'Internal server error' : e.message,
  });
};

/* ── Lead Ads вебхук (ПУБЛІЧНИЙ) ─────────────────────────────────────
   GET — верифікація підписки (Meta дзвонить раз при налаштуванні).
   POST — приймання leadgen-подій. Ізольований від instagram-webhook,
   щоб не зачепити робочий потік Instagram-інбоксу. */
router.get('/webhook', (req, res) => {
  const v = verifyChallenge(req.query, process.env.META_VERIFY_TOKEN);
  if (v.ok) return res.status(200).send(v.challenge);
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  // Підпис: у проді без META_APP_SECRET — дропаємо подію (захист від спуфінгу).
  const sig = verifySignature(req.rawBody, req.headers['x-hub-signature-256'], process.env.META_APP_SECRET);
  if (!sig.ok) return res.sendStatus(403);
  if (sig.skipped && process.env.NODE_ENV === 'production') return res.sendStatus(200);

  // Відповідаємо Meta одразу (вимога ≤ кілька секунд), обробляємо асинхронно.
  res.sendStatus(200);
  try {
    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const ch of changes) {
        if (ch.field !== 'leadgen') continue;
        const v = ch.value || {};
        const pageId = String(v.page_id || entry.id || '');
        if (!pageId) continue;
        const t = await meta.resolveTenantByPage(pageId);
        if (!t) { console.warn('[meta-ads] лід для невідомої сторінки', pageId); continue; }
        await runAs(t.tenant_id, () => meta.ingestLead({
          accountId: t.id, leadgenId: v.leadgen_id, pageId,
          formId: v.form_id, campaignId: v.campaign_id || null,
        })).catch((e) => console.error('[meta-ads] ingest', e.message));
      }
    }
  } catch (e) { console.error('[meta-ads] webhook', e.message); }
});

// ── Авторизація для решти ───────────────────────────────────────────
router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'marketing.read' : 'marketing.write';
  return requirePerm(perm)(req, res, next);
});

// ── Акаунти ─────────────────────────────────────────────────────────
router.get('/accounts', async (req, res) => {
  try { res.json({ items: await meta.listAccounts() }); } catch (e) { fail(res, e); }
});
router.post('/accounts/connect', async (req, res) => {
  try { res.json(await meta.connectAccount(req.body || {})); } catch (e) { fail(res, e); }
});
router.delete('/accounts/:id', async (req, res) => {
  try { res.json(await meta.disconnectAccount(Number(req.params.id))); } catch (e) { fail(res, e); }
});
router.post('/accounts/:id/sync', async (req, res) => {
  try { res.json(await meta.syncAccount(Number(req.params.id))); } catch (e) { fail(res, e); }
});

// ── Кампанії ────────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const { account_id, status, from, to } = req.query;
    res.json({ items: await meta.listCampaigns({ accountId: account_id ? Number(account_id) : undefined, status, from, to }) });
  } catch (e) { fail(res, e); }
});
router.get('/campaigns/:id/stats', async (req, res) => {
  try { res.json({ items: await meta.campaignStats(Number(req.params.id), { from: req.query.from, to: req.query.to }) }); } catch (e) { fail(res, e); }
});
router.post('/campaigns/:id/toggle', async (req, res) => {
  try {
    const status = (req.body?.status || '').toUpperCase();
    if (!['ACTIVE', 'PAUSED'].includes(status)) return res.status(400).json({ error: 'status-invalid' });
    res.json(await meta.toggleCampaign(Number(req.params.id), status));
  } catch (e) { fail(res, e); }
});

// ── Ліди ────────────────────────────────────────────────────────────
router.get('/leads', async (req, res) => {
  try {
    const { status, from, to, limit } = req.query;
    res.json({ items: await meta.listLeads({ status, from, to, limit }) });
  } catch (e) { fail(res, e); }
});
router.patch('/leads/:id', async (req, res) => {
  try {
    res.json(await meta.updateLead(Number(req.params.id), {
      status: req.body?.status, notes: req.body?.notes, contacted_by: req.user?.id || null,
    }));
  } catch (e) { fail(res, e); }
});
router.post('/leads/:id/create-client', async (req, res) => {
  try { res.json(await meta.leadToClient(Number(req.params.id))); } catch (e) { fail(res, e); }
});
router.post('/leads/:id/create-appointment', async (req, res) => {
  try { res.json(await meta.leadToAppointment(Number(req.params.id), req.body || {})); } catch (e) { fail(res, e); }
});

// ── ROI / аналітика ─────────────────────────────────────────────────
router.get('/roi', async (req, res) => {
  try { res.json(await meta.roi({ from: req.query.from, to: req.query.to })); } catch (e) { fail(res, e); }
});

module.exports = router;
