/* routes/tenant-mgmt.js — SAS-06 Tenant Management. /api/tenant-mgmt
   Суперадмин (guard saas.read/saas.write) — кросс-тенантные операции платформы:
     GET  /dashboard                      сводка по всем тенантам + health + открытые тикеты
     GET  /tenants                        список (status/search/limit/offset)
     GET  /tenants/:id                    детали тенанта (лицензия, онбординг, health)
     POST /tenants/:id/block              приостановить (status=suspended)
     POST /tenants/:id/unblock            вернуть (status=active)
     GET  /tenants/:id/onboarding         прогресс онбординга
     PATCH /tenants/:id/onboarding        csm/notes
     POST /tenants/:id/onboarding/complete  отметить шаг
     GET  /tenants/:id/health             посчитать health сейчас
     POST /tenants/:id/health/check       записать health-чек в историю
     POST /health/check-all               прогнать health по всем активным
     GET  /tickets                        список тикетов (tenant/status/priority/assigned)
     GET  /tickets/:id                     тикет + переписка (incl. internal)
     PATCH /tickets/:id                   статус/приоритет/назначение/internal_notes
     POST /tickets/:id/reply              ответ персонала (is_staff)
     GET  /support/stats                  метрики поддержки
   Tenant-facing (guard users.read/write — салон видит только своё):
     GET  /my/onboarding                  свой онбординг
     POST /my/onboarding/complete         отметить свой шаг
     GET  /my/tickets                     свои тикеты
     POST /my/tickets                     создать тикет
     GET  /my/tickets/:id                 свой тикет (без internal)
     POST /my/tickets/:id/reply           ответ клиента */
const express = require('express');
const router = express.Router();
const { requirePerm, requirePlatform, logAction } = require('../lib/rbac');
const { getTenantId } = require('../lib/tenant');
const tm = require('../lib/tenant-mgmt');

// Захист control-plane: усі суперадмін-маршрути (крім салонних /my/*) доступні
// лише оператору платформи. Без цього власник салону (роль owner з правами "*")
// проходив би requirePerm('saas.*') і бачив кросс-тенантні дані всіх салонів.
const platformGuard = requirePlatform();
router.use((req, res, next) => {
  if (req.path.startsWith('/my/') || req.path === '/my') return next();
  return platformGuard(req, res, next);
});

// RLS-контекст для кросс-тенантних операцій (баг реєстрації 13.07):
// запит платформи йде з GUC = платформенний тенант, тому RLS-таблиці
// (tenant_licenses, users, payments_saas, plan_change_log, health, tickets...)
// мовчки ховали/відкидали рядки ЧУЖОГО салону — профіль без власника/платежів,
// purge видаляв 0 рядків. Операції над конкретним салоном виконуємо в ЙОГО
// контексті, списки по всіх салонах — без tenant-фільтра (runAs(null) = прямий запит).
const { runAsPlatform } = require('../lib/tenant');
router.use((req, res, next) => {
  if (req.path.startsWith('/my/') || req.path === '/my') return next();
  const m = req.path.match(/^\/tenants\/([0-9a-f-]{36})(\/|$)/i);
  return runAsPlatform(m ? m[1] : null, () => next());
});

const fail = (res, e) => {
  console.error('[tenant-mgmt]', e);
  const msg = e.message || '';
  const code = /not-found/.test(msg) ? 404 : /required|invalid/.test(msg) ? 400 : 500;
  res.status(code).json({ error: process.env.NODE_ENV === 'production' && code === 500 ? 'Internal server error' : msg });
};

// ── СУПЕРАДМИН: дашборд / тенанты ────────────────────────────────────
router.get('/dashboard', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.dashboard()); } catch (e) { fail(res, e); }
});

router.get('/tenants', requirePerm('saas.read'), async (req, res) => {
  try {
    res.json(await tm.listTenants({
      status: req.query.status || null, search: req.query.search || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

// Создать новый салон: тенант + владелец + подписка с авто-сроком (admin-managed онбординг)
router.post('/tenants', requirePerm('saas.write'), async (req, res) => {
  try {
    const { name, phone, password, owner_name, email, plan_code, cycle, trial } = req.body || {};
    const r = await tm.createTenant(name, { phone, password, owner_name, email, plan_code, cycle, trial }, req.user);
    await logAction({ user: req.user, action: 'tenant.create', entity: 'tenants', entity_id: r.tenant.id, ip: req.ip });
    res.status(201).json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

router.get('/tenants/:id', requirePerm('saas.read'), async (req, res) => {
  try {
    const d = await tm.tenantDetail(req.params.id);
    if (!d) return res.status(404).json({ error: 'tenant-not-found' });
    res.json(d);
  } catch (e) { fail(res, e); }
});

// Повний профіль підписника: підписка, рахунки, платежі, ліцензія+overrides,
// ліміти тарифу, використання, історія планів, власник, нотатки платформи.
router.get('/tenants/:id/profile', requirePerm('saas.read'), async (req, res) => {
  try {
    const p = await tm.tenantProfile(req.params.id);
    if (!p) return res.status(404).json({ error: 'tenant-not-found' });
    res.json(p);
  } catch (e) { fail(res, e); }
});

// Редагування тенанта оператором: назва, службові нотатки, вертикаль бізнесу
router.patch('/tenants/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.updateTenant(req.params.id, { name: req.body?.name, notes: req.body?.notes });
    // Вертикаль (beauty/fitness/dental) — визначає, які модулі «існують» для тенанта
    if (req.body?.business_type !== undefined) {
      const bt = String(req.body.business_type);
      if (!['beauty', 'fitness', 'dental', 'wellness'].includes(bt)) {
        return res.status(400).json({ error: 'bad-business-type', allowed: ['beauty', 'fitness', 'dental', 'wellness'] });
      }
      const { getPool } = require('../db-pg');
      await getPool().query(`UPDATE tenants SET business_type=$1 WHERE id=$2`, [bt, req.params.id]);
      try { require('../lib/vertical').invalidateVerticalCache(req.params.id); } catch (_) {}
    }
    await logAction({ user: req.user, action: 'tenant.update', entity: 'tenants', entity_id: req.params.id, ip: req.ip, meta: req.body?.business_type ? { business_type: req.body.business_type } : undefined });
    res.json({ ok: true, tenant: r });
  } catch (e) { fail(res, e); }
});

// Індивідуальна ліцензія: статус/строки + overrides фіч і лімітів конкретного салону
router.post('/tenants/:id/license', requirePerm('saas.write'), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await tm.setLicense(req.params.id, {
      status: b.status, trial_ends_at: b.trial_ends_at, expires_at: b.expires_at,
      feature_overrides: b.feature_overrides, limit_overrides: b.limit_overrides,
    });
    await logAction({ user: req.user, action: 'tenant.license', entity: 'tenant_licenses', entity_id: req.params.id, ip: req.ip, meta: { overrides: r.overrides } });
    res.json({ ok: true, license: r });
  } catch (e) { fail(res, e); }
});

// Подарувати дні підписки (компенсація/бонус/продовження тріалу)
router.post('/tenants/:id/gift-days', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.giftDays(req.params.id, req.body?.days, req.body?.reason || null);
    await logAction({ user: req.user, action: 'tenant.gift_days', entity: 'tenants', entity_id: req.params.id, ip: req.ip, meta: { days: r.days } });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/block', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.setStatus(req.params.id, 'suspended', req.body?.reason || null);
    await logAction({ user: req.user, action: 'tenant.block', entity: 'tenants', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, tenant: r });
  } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/unblock', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.setStatus(req.params.id, 'active', req.body?.reason || null);
    await logAction({ user: req.user, action: 'tenant.unblock', entity: 'tenants', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, tenant: r });
  } catch (e) { fail(res, e); }
});

// ── GDPR оффбординг: НЕЗВОРОТНЄ видалення всіх даних салону ───────────
// Тіло: { confirm_name }. Салон має бути cancelled/suspended. Радимо спершу
// зробити експорт (GET /api/backup/export від імені салону) для портативності ПД.
router.post('/tenants/:id/purge', requirePerm('saas.write'), async (req, res) => {
  try {
    const r = await tm.purgeTenant(req.params.id, { confirmName: req.body?.confirm_name }, req.user);
    await logAction({ user: req.user, action: 'tenant.purge', entity: 'tenants', entity_id: req.params.id, ip: req.ip, meta: { rows: r.rows_deleted, tables: r.tables_cleared } });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: онбординг тенанта ────────────────────────────────────
router.get('/tenants/:id/onboarding', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.getOnboarding(req.params.id)); } catch (e) { fail(res, e); }
});

router.patch('/tenants/:id/onboarding', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.updateOnboarding(req.params.id, req.body || {})); } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/onboarding/complete', requirePerm('saas.write'), async (req, res) => {
  try {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step-required' });
    res.json(await tm.completeStep(req.params.id, step));
  } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: health ───────────────────────────────────────────────
router.get('/tenants/:id/health', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.computeHealth(req.params.id)); } catch (e) { fail(res, e); }
});

router.post('/tenants/:id/health/check', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.runHealthCheck(req.params.id)); } catch (e) { fail(res, e); }
});

router.post('/health/check-all', requirePerm('saas.write'), async (req, res) => {
  try { res.json(await tm.runHealthAll()); } catch (e) { fail(res, e); }
});

// ── СУПЕРАДМИН: тикеты поддержки ─────────────────────────────────────
router.get('/tickets', requirePerm('saas.read'), async (req, res) => {
  try {
    res.json(await tm.listTickets({
      tenantId: req.query.tenant_id || null, status: req.query.status || null,
      priority: req.query.priority || null, assigned: req.query.assigned || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.get('/tickets/:id', requirePerm('saas.read'), async (req, res) => {
  try {
    const t = await tm.getTicket(Number(req.params.id), { includeInternal: true });
    if (!t) return res.status(404).json({ error: 'ticket-not-found' });
    res.json(t);
  } catch (e) { fail(res, e); }
});

router.patch('/tickets/:id', requirePerm('saas.write'), async (req, res) => {
  try {
    const t = await tm.updateTicket(Number(req.params.id), req.body || {});
    if (!t) return res.status(404).json({ error: 'ticket-not-found' });
    await logAction({ user: req.user, action: 'ticket.update', entity: 'tenant_support_tickets', entity_id: req.params.id, ip: req.ip });
    res.json({ ok: true, ticket: t });
  } catch (e) { fail(res, e); }
});

router.post('/tickets/:id/reply', requirePerm('saas.write'), async (req, res) => {
  try {
    const reply = await tm.replyTicket(Number(req.params.id), {
      message: req.body?.message, internal: !!req.body?.internal, isStaff: true, user: req.user,
    });
    res.json({ ok: true, reply });
  } catch (e) { fail(res, e); }
});

router.get('/support/stats', requirePerm('saas.read'), async (req, res) => {
  try { res.json(await tm.supportStats()); } catch (e) { fail(res, e); }
});

// ── TENANT-FACING: свой онбординг / тикеты (current_tenant_id) ────────
/* ── Самозакриття акаунта (анти-lock-in, Phase D 18.07.2026) ────────────────
   GDPR right-to-erasure self-service: раніше видалити акаунт міг лише оператор.
   Тепер власник закриває сам: підтвердження назвою → підписка cancelled +
   tenants.status='cancelled' (вхід блокується) → сигнал оператору платформи.
   ФІЗИЧНЕ видалення даних — НЕ тут: 30 днів на «передумав» (закон CRM-DIARY:
   даних не видаляємо автоматично), purge робить оператор наявним інструментом. */
router.post('/my/close-account', requirePerm('users.write'), async (req, res) => {
  try {
    const u = req.user || {};
    const isOwner = u.role === 'owner' || Number(u.role_level) >= 100;
    if (!isOwner) return res.status(403).json({ error: 'owner-only', message: 'Закрити акаунт може лише власник' });
    const tid = getTenantId();
    const { getPool } = require('../db-pg');
    const t = (await getPool().query(`SELECT id, name, slug, status FROM tenants WHERE id=$1`, [tid])).rows[0];
    if (!t) return res.status(404).json({ error: 'tenant-not-found' });
    if (String(req.body?.confirm_name || '').trim() !== String(t.name).trim()) {
      return res.status(400).json({ error: 'confirm-name-mismatch',
        message: 'Введіть точну назву закладу для підтвердження' });
    }
    // підписка → cancelled (без автопродовжень/рахунків), тенант → cancelled (вхід закрито)
    try {
      const billing = require('../lib/billing');
      const sub = await billing.getSubscription(tid);
      if (sub && !['cancelled'].includes(sub.status)) await billing.cancelSubscription(tid, { reason: 'self-close' });
    } catch (be) { console.error('[close-account:sub]', be.message); }
    await getPool().query(`UPDATE tenants SET status='cancelled', updated_at=NOW() WHERE id=$1`, [tid]);
    await logAction({ user: u, action: 'tenant.self-close', entity: 'tenants', entity_id: tid, ip: req.ip,
      meta: { reason: (req.body?.reason || '').slice(0, 300) } });
    // сигнал оператору платформи (той самий канал, що й прострочені підписки)
    if (process.env.ADMIN_TG_CHAT) {
      try {
        const { tgSend } = require('./telegram-notify');
        await tgSend(process.env.ADMIN_TG_CHAT,
          `<b>🚪 Самозакриття акаунта</b>\n${t.name} (${t.slug})\nПричина: ${(req.body?.reason || 'не вказано').slice(0, 200)}\nДані зберігаються 30 днів — purge вручну, якщо не передумають.`);
      } catch (ne) { console.error('[close-account:notify]', ne.message); }
    }
    res.json({ ok: true, closed: true,
      message: 'Акаунт закрито. Дані зберігаються 30 днів — напишіть у підтримку, якщо передумаєте. Повний експорт: /api/backup/export-full' });
  } catch (e) { fail(res, e); }
});

router.get('/my/onboarding', requirePerm('users.read'), async (req, res) => {
  try { res.json(await tm.getOnboarding(getTenantId())); } catch (e) { fail(res, e); }
});

router.post('/my/onboarding/complete', requirePerm('users.write'), async (req, res) => {
  try {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step-required' });
    res.json(await tm.completeStep(getTenantId(), step));
  } catch (e) { fail(res, e); }
});

router.get('/my/tickets', requirePerm('users.read'), async (req, res) => {
  try {
    res.json(await tm.listTickets({
      tenantId: getTenantId(), status: req.query.status || null,
      limit: Math.min(Number(req.query.limit) || 50, 200), offset: Number(req.query.offset) || 0,
    }));
  } catch (e) { fail(res, e); }
});

router.post('/my/tickets', requirePerm('users.write'), async (req, res) => {
  try {
    const t = await tm.createTicket(getTenantId(), req.body || {}, req.user);
    res.status(201).json({ ok: true, ticket: t });
  } catch (e) { fail(res, e); }
});

router.get('/my/tickets/:id', requirePerm('users.read'), async (req, res) => {
  try {
    const t = await tm.getTicket(Number(req.params.id), { includeInternal: false });
    if (!t || String(t.ticket.tenant_id) !== String(getTenantId())) return res.status(404).json({ error: 'ticket-not-found' });
    res.json(t);
  } catch (e) { fail(res, e); }
});

router.post('/my/tickets/:id/reply', requirePerm('users.write'), async (req, res) => {
  try {
    const cur = await tm.getTicket(Number(req.params.id), { includeInternal: false });
    if (!cur || String(cur.ticket.tenant_id) !== String(getTenantId())) return res.status(404).json({ error: 'ticket-not-found' });
    const reply = await tm.replyTicket(Number(req.params.id), {
      message: req.body?.message, internal: false, isStaff: false, user: req.user,
    });
    res.json({ ok: true, reply });
  } catch (e) { fail(res, e); }
});

module.exports = router;
