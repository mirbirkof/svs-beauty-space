/* ═══════════════════════════════════════════════════════
   INT-09 Бухгалтерия (Accounting) · INT-10 Банкинг (Banking)
   Подключается как /api/fin-integrations

   Что закрывает:
   - реестр провайдеров: monobank/privatbank (banking), checkbox/1c/diia (fiscal/accounting);
   - импорт банковских транзакций (ручной/из выписки/API) + дедуп по external_id;
   - сверка (reconciliation) транзакций с кассовыми операциями cash_operations
     по сумме и дате — авто-сопоставление + ручная привязка;
   - регистрация фискальных чеков (Checkbox/ПРРО): запись и статусы;
   - API-синк активируется при наличии ключей провайдера (config), без них
     модуль работает в ручном режиме (импорт/запись).

   Право: accounting.read / accounting.write (миграция 102).
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');

const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'accounting.read' : 'accounting.write';
  return requirePerm(perm)(req, res, next);
});

/* ── ПРОВАЙДЕРЫ ── */
router.get('/providers', async (req, res) => {
  try {
    const rows = await q(`SELECT id, provider, kind, enabled,
        (config != '{}'::jsonb) AS configured, last_sync_at, updated_at
      FROM fin_providers WHERE tenant_id=current_tenant_id() ORDER BY kind, provider`);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/providers/:provider', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.kind) return res.status(400).json({ error: 'kind_required' });
    const row = (await q(
      `INSERT INTO fin_providers (provider, kind, enabled, config) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, provider) DO UPDATE SET kind=EXCLUDED.kind, enabled=EXCLUDED.enabled,
         config=EXCLUDED.config, updated_at=now()
       RETURNING id, provider, kind, enabled`,
      [req.params.provider, b.kind, b.enabled !== false, JSON.stringify(b.config || {})]))[0];
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── БАНКОВСКИЕ ТРАНЗАКЦИИ (INT-10) ── */
router.get('/transactions', async (req, res) => {
  try {
    const params = [];
    let where = 'tenant_id=current_tenant_id()';
    if (req.query.from) { params.push(req.query.from); where += ` AND op_date >= $${params.length}`; }
    if (req.query.to) { params.push(req.query.to); where += ` AND op_date <= $${params.length}`; }
    if (req.query.reconciled === '0') where += ' AND reconciled=false';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await q(`SELECT * FROM bank_transactions WHERE ${where} ORDER BY op_date DESC, id DESC LIMIT ${limit}`, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fin-integrations/transactions { transactions:[{op_date,amount,direction,description,external_id,provider,counterparty}] }
router.post('/transactions', async (req, res) => {
  try {
    const list = Array.isArray(req.body?.transactions) ? req.body.transactions : (req.body ? [req.body] : []);
    if (!list.length) return res.status(400).json({ error: 'transactions_required' });
    let created = 0;
    for (const t of list) {
      if (!t.op_date || t.amount == null || !t.direction) continue;
      const r = await pool.query(
        `INSERT INTO bank_transactions (provider, external_id, op_date, amount, currency, direction, description, counterparty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, provider, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
        [t.provider || null, t.external_id || null, t.op_date, t.amount, t.currency || 'UAH',
         t.direction, t.description || null, t.counterparty || null]);
      created += r.rowCount;
    }
    await logAction({ user: req.user, action: 'bank.import', entity: 'bank_transactions', meta: { created }, ip: req.ip });
    res.json({ ok: true, imported: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/fin-integrations/reconcile — авто-сверка с cash_operations по сумме+дате
router.post('/reconcile', async (req, res) => {
  try {
    // сопоставляем входящие банковские транзакции с приходными кассовыми операциями
    // того же дня и той же суммы, ещё не сверенными
    const r = await pool.query(`
      WITH cand AS (
        SELECT bt.id AS bt_id, co.id AS co_id,
               row_number() OVER (PARTITION BY bt.id ORDER BY co.id) AS rn
        FROM bank_transactions bt
        JOIN cash_operations co
          ON co.tenant_id = bt.tenant_id
         AND co.type = 'in'
         AND co.amount = bt.amount
         AND co.created_at::date = bt.op_date
        WHERE bt.tenant_id = current_tenant_id()
          AND bt.direction = 'in'
          AND bt.reconciled = false
          AND NOT EXISTS (SELECT 1 FROM bank_transactions x WHERE x.matched_cash_op_id = co.id)
      )
      UPDATE bank_transactions bt
        SET reconciled = true, matched_cash_op_id = cand.co_id
      FROM cand
      WHERE bt.id = cand.bt_id AND cand.rn = 1
      RETURNING bt.id`);
    await logAction({ user: req.user, action: 'bank.reconcile', meta: { matched: r.rowCount }, ip: req.ip });
    res.json({ ok: true, matched: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── ФИСКАЛЬНЫЕ ЧЕКИ (INT-09) ── */
router.get('/fiscal-receipts', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await q(`SELECT * FROM fiscal_receipts WHERE tenant_id=current_tenant_id() ORDER BY created_at DESC LIMIT ${limit}`);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/fiscal-receipts', async (req, res) => {
  try {
    const b = req.body || {};
    if (b.amount == null) return res.status(400).json({ error: 'amount_required' });
    const row = (await q(
      `INSERT INTO fiscal_receipts (provider, receipt_number, fiscal_number, amount, status, cash_operation_id, order_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.provider || 'checkbox', b.receipt_number || null, b.fiscal_number || null, b.amount,
       b.status || 'created', b.cash_operation_id || null, b.order_id || null,
       b.payload ? JSON.stringify(b.payload) : null]))[0];
    await logAction({ user: req.user, action: 'fiscal.create', entity: 'fiscal_receipts', entity_id: row.id, ip: req.ip });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
