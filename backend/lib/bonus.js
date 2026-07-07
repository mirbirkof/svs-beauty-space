/* lib/bonus.js — FIN-01 Bonus System.
   Бонусний гаманець клієнта: нарахування за дії, списання частиною оплати,
   ручні коригування, FIFO-сгорання. Усі таблиці під RLS (tenant_id),
   тому багатокрокові операції йдуть через withTx (виставляє app.tenant_id).
   Баланс ніколи не від'ємний (CHECK + контроль у коді). */
const { query, withTx } = require('../db-pg');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Налаштування списання (1 рядок на tenant, лінива ініціалізація) ──
async function getSettings() {
  const r = await query('SELECT * FROM bonus_redemption_settings LIMIT 1');
  if (r.rows[0]) return r.rows[0];
  const ins = await query(
    `INSERT INTO bonus_redemption_settings DEFAULT VALUES
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at = now() RETURNING *`
  );
  return ins.rows[0];
}

async function saveSettings(patch = {}) {
  const cur = await getSettings();
  const fields = ['enabled', 'max_pay_percent', 'min_redeem_amount', 'exchange_rate',
    'hold_period_days', 'expiry_days', 'vip_no_expiry', 'excluded_categories'];
  const vals = {};
  for (const f of fields) if (patch[f] !== undefined) vals[f] = patch[f];
  if (!Object.keys(vals).length) return cur;
  const sets = Object.keys(vals).map((k, i) => `${k}=$${i + 1}`);
  const params = Object.values(vals).map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v));
  const r = await query(
    `UPDATE bonus_redemption_settings SET ${sets.join(', ')}, updated_at=now()
     WHERE tenant_id = current_tenant_id() RETURNING *`, params);
  return r.rows[0] || cur;
}

// ── Баланс ──────────────────────────────────────────────────────────
async function getBalance(clientId) {
  const r = await query('SELECT * FROM bonus_balances WHERE client_id=$1', [clientId]);
  return r.rows[0] || {
    client_id: Number(clientId), balance: 0, total_accrued: 0,
    total_redeemed: 0, total_expired: 0,
  };
}

async function getHistory(clientId, limit = 50) {
  const r = await query(
    `SELECT * FROM bonus_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2`,
    [clientId, Math.min(Number(limit) || 50, 200)]);
  return r.rows;
}

// Гарантує рядок балансу (всередині транзакції)
async function _ensureBalanceRow(client, clientId) {
  await client.query(
    `INSERT INTO bonus_balances (client_id) VALUES ($1)
     ON CONFLICT (tenant_id, client_id) DO NOTHING`, [clientId]);
}

// ── Мультиплікатор за тиром лояльності клієнта ──────────────────────
async function _tierMultiplier(client, clientId, multipliers) {
  if (!multipliers || typeof multipliers !== 'object') return 1;
  const r = await client.query(
    `SELECT cl.tier_name FROM clients c
     LEFT JOIN client_loyalty cl ON cl.client_phone = c.phone
     WHERE c.id=$1`, [clientId]);
  const tier = String(r.rows[0]?.tier_name || 'bronze').toLowerCase();
  const m = multipliers[tier];
  return m && Number(m) > 0 ? Number(m) : 1;
}

// ── Нарахування ─────────────────────────────────────────────────────
// opts: { clientId, amount?, checkAmount?, ruleId?, type?, branchId?,
//         sourceType?, sourceId?, description?, expiryDays?, applyTier? }
async function accrue(opts = {}) {
  const clientId = Number(opts.clientId);
  if (!clientId) throw new Error('clientId-required');
  return withTx(async (client) => {
    const settings = await _resolveSettings(client);
    let amount = round2(opts.amount || 0);
    let ruleId = opts.ruleId || null;
    let expiryDays = opts.expiryDays;
    let type = opts.type || 'accrual';

    // якщо передано чек і правило — рахуємо за правилом (percent_check)
    if (opts.checkAmount != null && (opts.ruleId || opts.autoRule)) {
      const rule = await _pickRule(client, opts.ruleId, opts.triggerEvent || 'payment', opts.category);
      if (!rule) return null;
      ruleId = rule.id;
      const check = round2(opts.checkAmount);
      // нульовий/відʼємний чек не дає бонусів — інакше fixed-правило нараховує «з повітря»
      if (check <= 0) return null;
      if (check < Number(rule.min_check_amount)) return null;
      if (rule.type === 'percent_check') amount = round2(check * Number(rule.percent) / 100);
      else amount = round2(Number(rule.fixed_amount));
      const mult = opts.applyTier === false ? 1 : await _tierMultiplier(client, clientId, rule.loyalty_multipliers);
      amount = round2(amount * mult);
      if (rule.max_accrual != null) amount = Math.min(amount, Number(rule.max_accrual));
      if (rule.expiry_days != null) expiryDays = rule.expiry_days;
      type = 'accrual';
    }
    if (amount <= 0) return null;

    const days = expiryDays != null ? Number(expiryDays)
      : (settings.vip_no_expiry ? null : Number(settings.expiry_days || 365));
    const expiresAt = days && days > 0 ? `now() + interval '${days} days'` : 'NULL';

    await _ensureBalanceRow(client, clientId);
    // FOR UPDATE на балансі серіалізує конкурентні accrue одного клієнта
    const bal = (await client.query('SELECT balance FROM bonus_balances WHERE client_id=$1 FOR UPDATE', [clientId])).rows[0];

    // Ідемпотентність за джерелом: повторний виклик з тим самим (sourceType, sourceId)
    // повертає вже існуюче нарахування і НЕ подвоює баланс. DB-гарантія —
    // ux_bonus_tx_accrual_source (міграція 198), тут швидкий шлях під локом балансу.
    if (opts.sourceId != null) {
      const dupe = await client.query(
        `SELECT * FROM bonus_transactions
          WHERE client_id=$1 AND type=$2 AND source_type IS NOT DISTINCT FROM $3 AND source_id=$4
          LIMIT 1`,
        [clientId, type, opts.sourceType || null, opts.sourceId]);
      if (dupe.rows[0]) return dupe.rows[0];
    }

    const newBal = round2(Number(bal.balance) + amount);

    const ins = await client.query(
      `INSERT INTO bonus_transactions
        (client_id, branch_id, type, amount, balance_after, remaining, rule_id, source_type, source_id, description, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, ${expiresAt})
       ON CONFLICT (tenant_id, client_id, source_type, source_id)
         WHERE source_id IS NOT NULL AND type='accrual' DO NOTHING
       RETURNING *`,
      [clientId, opts.branchId || null, type, amount, newBal, amount, ruleId,
        opts.sourceType || null, opts.sourceId || null, opts.description || null]);
    if (!ins.rows[0]) {
      // програли гонку унікальному індексу — віддаємо існуючу транзакцію без зміни балансу
      const ex = await client.query(
        `SELECT * FROM bonus_transactions
          WHERE client_id=$1 AND type=$2 AND source_type IS NOT DISTINCT FROM $3 AND source_id=$4 LIMIT 1`,
        [clientId, type, opts.sourceType || null, opts.sourceId]);
      return ex.rows[0] || null;
    }
    const tx = ins.rows[0];

    await client.query(
      `UPDATE bonus_balances SET balance=$1, total_accrued=total_accrued+$2,
         last_accrual_at=now(), updated_at=now() WHERE client_id=$3`,
      [newBal, amount, clientId]);
    return tx;
  });
}

// ── Списання (FIFO по найближчому сгоранню) ─────────────────────────
// Скільки бонусів РЕАЛЬНО спишеться при цих opts (та ж логіка обрізки, що й redeem, але read-only).
// Потрібно, щоб каса рахувала знижку рівно на суму, яку redeem фактично спише (інакше грошова діра).
// Повертає ефективну суму бонусів (0, якщо списання неможливе/нижче мінімуму/вимкнено).
async function previewRedeem(opts = {}) {
  const clientId = Number(opts.clientId);
  let amount = round2(opts.amount || 0);
  if (!clientId || amount <= 0) return 0;
  return withTx(async (client) => {
    const settings = await _resolveSettings(client);
    if (settings.enabled === false) return 0;
    if (amount < Number(settings.min_redeem_amount)) return 0;
    if (opts.checkAmount != null) {
      const rate = Number(settings.exchange_rate) || 1;
      const maxMoney = round2(Number(opts.checkAmount) * Number(settings.max_pay_percent) / 100);
      const maxBonus = round2(maxMoney / rate);
      if (amount > maxBonus) amount = maxBonus;
    }
    if (amount <= 0) return 0;
    await _ensureBalanceRow(client, clientId);
    const bal = (await client.query('SELECT balance FROM bonus_balances WHERE client_id=$1', [clientId])).rows[0];
    const b = Number(bal?.balance || 0);
    if (b < amount) amount = round2(b);
    return amount > 0 ? amount : 0;
  }).catch(() => 0);
}

// opts: { clientId, amount (бонусів), checkAmount?, branchId?, sourceType?, sourceId?, description? }
async function redeem(opts = {}) {
  const clientId = Number(opts.clientId);
  let amount = round2(opts.amount || 0);
  if (!clientId || amount <= 0) throw new Error('clientId-and-amount-required');
  return withTx(async (client) => {
    const settings = await _resolveSettings(client);
    if (settings.enabled === false) throw new Error('redemption-disabled');
    if (amount < Number(settings.min_redeem_amount)) throw new Error('below-min-redeem');

    // ліміт % від чека (у бонусах через exchange_rate: 1 бонус = rate грн)
    if (opts.checkAmount != null) {
      const rate = Number(settings.exchange_rate) || 1;
      const maxMoney = round2(Number(opts.checkAmount) * Number(settings.max_pay_percent) / 100);
      const maxBonus = round2(maxMoney / rate);
      if (amount > maxBonus) amount = maxBonus;
    }
    if (amount <= 0) throw new Error('zero-after-limit');

    await _ensureBalanceRow(client, clientId);
    const bal = (await client.query('SELECT balance FROM bonus_balances WHERE client_id=$1 FOR UPDATE', [clientId])).rows[0];
    if (Number(bal.balance) < amount) throw new Error('insufficient-balance');

    // FIFO: гасимо найраніше сгораючі нарахування (NULL expires_at — в кінець)
    const lots = (await client.query(
      `SELECT id, remaining FROM bonus_transactions
       WHERE client_id=$1 AND remaining > 0
       ORDER BY expires_at ASC NULLS LAST, created_at ASC FOR UPDATE`, [clientId])).rows;
    let left = amount;
    for (const lot of lots) {
      if (left <= 0) break;
      const take = Math.min(Number(lot.remaining), left);
      await client.query('UPDATE bonus_transactions SET remaining=remaining-$1 WHERE id=$2', [take, lot.id]);
      left = round2(left - take);
    }
    if (left > 0.001) throw new Error('fifo-mismatch');

    const newBal = round2(Number(bal.balance) - amount);
    const tx = (await client.query(
      `INSERT INTO bonus_transactions
        (client_id, branch_id, type, amount, balance_after, remaining, source_type, source_id, description)
       VALUES ($1,$2,'redemption',$3,$4,0,$5,$6,$7) RETURNING *`,
      [clientId, opts.branchId || null, -amount, newBal,
        opts.sourceType || null, opts.sourceId || null, opts.description || null])).rows[0];
    await client.query(
      `UPDATE bonus_balances SET balance=$1, total_redeemed=total_redeemed+$2,
         last_redemption_at=now(), updated_at=now() WHERE client_id=$3`,
      [newBal, amount, clientId]);
    return { tx, redeemed: amount, money: round2(amount * (Number(settings.exchange_rate) || 1)) };
  });
}

// ── Ручне коригування (+/-) ─────────────────────────────────────────
async function manualAdjust(opts = {}) {
  const clientId = Number(opts.clientId);
  const delta = round2(opts.amount || 0);
  if (!clientId || !delta) throw new Error('clientId-and-amount-required');
  if (delta > 0) {
    return accrue({ clientId, amount: delta, type: 'manual_add',
      description: opts.description || 'Ручне нарахування', branchId: opts.branchId,
      expiryDays: opts.expiryDays, sourceType: 'manual' });
  }
  // ручне списання — без лімітів % чека, але не нижче 0
  return withTx(async (client) => {
    await _ensureBalanceRow(client, clientId);
    const bal = (await client.query('SELECT balance FROM bonus_balances WHERE client_id=$1 FOR UPDATE', [clientId])).rows[0];
    const take = Math.min(Number(bal.balance), Math.abs(delta));
    if (take <= 0) throw new Error('insufficient-balance');
    const lots = (await client.query(
      `SELECT id, remaining FROM bonus_transactions WHERE client_id=$1 AND remaining > 0
       ORDER BY expires_at ASC NULLS LAST, created_at ASC FOR UPDATE`, [clientId])).rows;
    let left = take;
    for (const lot of lots) {
      if (left <= 0) break;
      const t = Math.min(Number(lot.remaining), left);
      await client.query('UPDATE bonus_transactions SET remaining=remaining-$1 WHERE id=$2', [t, lot.id]);
      left = round2(left - t);
    }
    const newBal = round2(Number(bal.balance) - take);
    const tx = (await client.query(
      `INSERT INTO bonus_transactions
        (client_id, branch_id, type, amount, balance_after, remaining, source_type, source_id, description, adjusted_by)
       VALUES ($1,$2,'manual_deduct',$3,$4,0,$5,$6,$7,$8) RETURNING *`,
      [clientId, opts.branchId || null, -take, newBal,
        opts.sourceType || 'manual', opts.sourceId || null,
        opts.description || 'Ручне списання', opts.adjustedBy || null])).rows[0];
    await client.query(
      // total_redeemed теж оновлюємо — інакше агрегат розсинхронізується з balance (formula ≠ balance)
      `UPDATE bonus_balances SET balance=$1, total_redeemed=COALESCE(total_redeemed,0)+$3, updated_at=now() WHERE client_id=$2`,
      [newBal, clientId, take]);
    return tx;
  });
}

// ── Сгорання (cron) — гасить remaining у прострочених нарахувань ─────
// Працює глобально (без HTTP tenant-контексту), тому ВСЕ скоупимо по tenant_id
// явно: client_id — SERIAL у межах tenant і збігається між салонами.
async function expireBonuses() {
  return withTx(async (client) => {
    const expired = (await client.query(
      `SELECT id, tenant_id, client_id, remaining FROM bonus_transactions
       WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() FOR UPDATE`)).rows;
    if (!expired.length) return { expired: 0, clients: 0 };
    const byKey = {}; // "tenant|client" → { tenant_id, client_id, amt }
    for (const lot of expired) {
      const k = `${lot.tenant_id}|${lot.client_id}`;
      if (!byKey[k]) byKey[k] = { tenant_id: lot.tenant_id, client_id: lot.client_id, amt: 0 };
      byKey[k].amt = round2(byKey[k].amt + Number(lot.remaining));
      await client.query('UPDATE bonus_transactions SET remaining=0 WHERE id=$1', [lot.id]);
    }
    let total = 0;
    for (const { tenant_id, client_id, amt } of Object.values(byKey)) {
      const bal = (await client.query(
        'SELECT balance FROM bonus_balances WHERE tenant_id=$1 AND client_id=$2 FOR UPDATE',
        [tenant_id, client_id])).rows[0];
      if (!bal) continue;
      const newBal = round2(Math.max(0, Number(bal.balance) - amt));
      await client.query(
        `INSERT INTO bonus_transactions (tenant_id, client_id, type, amount, balance_after, remaining, source_type, description)
         VALUES ($1,$2,'expired',$3,$4,0,'system','Сгорання бонусів')`, [tenant_id, client_id, -amt, newBal]);
      await client.query(
        `UPDATE bonus_balances SET balance=$1, total_expired=total_expired+$2, updated_at=now()
         WHERE tenant_id=$3 AND client_id=$4`, [newBal, amt, tenant_id, client_id]);
      total = round2(total + amt);
    }
    return { expired: round2(total), clients: Object.keys(byKey).length };
  });
}

// ── Правила (CRUD-хелпери для роута) ────────────────────────────────
async function listRules() {
  return (await query('SELECT * FROM bonus_rules ORDER BY priority DESC, id')).rows;
}
async function createRule(b = {}) {
  const r = await query(
    `INSERT INTO bonus_rules
      (branch_id,name,type,trigger_event,percent,fixed_amount,category,min_check_amount,
       visit_series_count,loyalty_multipliers,max_accrual,hold_days,expiry_days,priority,is_active,valid_from,valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [b.branch_id || null, b.name, b.type || 'percent_check', b.trigger_event || 'payment',
      b.percent || 0, b.fixed_amount || 0, b.category || 'all', b.min_check_amount || 0,
      b.visit_series_count || 0, JSON.stringify(b.loyalty_multipliers || { bronze: 1, silver: 1.5, gold: 2 }),
      b.max_accrual ?? null, b.hold_days || 0, b.expiry_days ?? null, b.priority || 0,
      b.is_active !== false, b.valid_from || null, b.valid_until || null]);
  return r.rows[0];
}
async function updateRule(id, b = {}) {
  const allow = ['branch_id', 'name', 'type', 'trigger_event', 'percent', 'fixed_amount', 'category',
    'min_check_amount', 'visit_series_count', 'loyalty_multipliers', 'max_accrual', 'hold_days',
    'expiry_days', 'priority', 'is_active', 'valid_from', 'valid_until'];
  const vals = {};
  for (const k of allow) if (b[k] !== undefined) vals[k] = (k === 'loyalty_multipliers' && b[k] && typeof b[k] === 'object') ? JSON.stringify(b[k]) : b[k];
  if (!Object.keys(vals).length) return (await query('SELECT * FROM bonus_rules WHERE id=$1', [id])).rows[0];
  const sets = Object.keys(vals).map((k, i) => `${k}=$${i + 2}`);
  const r = await query(
    `UPDATE bonus_rules SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`,
    [id, ...Object.values(vals)]);
  return r.rows[0];
}
async function deleteRule(id) {
  await query('DELETE FROM bonus_rules WHERE id=$1', [id]);
  return { ok: true };
}

// ── Аналітика (зведення по tenant) ──────────────────────────────────
async function analytics() {
  const a = (await query(
    `SELECT COALESCE(SUM(balance),0) AS liability,
            COALESCE(SUM(total_accrued),0) AS accrued,
            COALESCE(SUM(total_redeemed),0) AS redeemed,
            COALESCE(SUM(total_expired),0) AS expired,
            COUNT(*) FILTER (WHERE balance > 0) AS active_clients
     FROM bonus_balances`)).rows[0];
  const last30 = (await query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE amount>0),0) AS accrued_30,
            COALESCE(-SUM(amount) FILTER (WHERE type='redemption'),0) AS redeemed_30
     FROM bonus_transactions WHERE created_at >= now() - interval '30 days'`)).rows[0];
  return { ...a, ...last30 };
}

// ── Внутрішні ───────────────────────────────────────────────────────
async function _resolveSettings(client) {
  const r = await client.query('SELECT * FROM bonus_redemption_settings LIMIT 1');
  if (r.rows[0]) return r.rows[0];
  const ins = await client.query(
    `INSERT INTO bonus_redemption_settings DEFAULT VALUES
     ON CONFLICT (tenant_id) DO UPDATE SET updated_at=now() RETURNING *`);
  return ins.rows[0];
}
// Підбір правила: явне id або найвищий пріоритет за подією/категорією
async function _pickRule(client, ruleId, triggerEvent, category) {
  if (ruleId) {
    const r = await client.query('SELECT * FROM bonus_rules WHERE id=$1 AND is_active=true', [ruleId]);
    return r.rows[0] || null;
  }
  const r = await client.query(
    `SELECT * FROM bonus_rules
     WHERE is_active=true AND trigger_event=$1
       AND (category=$2 OR category='all')
       AND (valid_from IS NULL OR valid_from <= now())
       AND (valid_until IS NULL OR valid_until >= now())
     ORDER BY priority DESC, id LIMIT 1`, [triggerEvent, category || 'all']);
  return r.rows[0] || null;
}

module.exports = {
  getSettings, saveSettings, getBalance, getHistory,
  accrue, redeem, previewRedeem, manualAdjust, expireBonuses,
  listRules, createRule, updateRule, deleteRule, analytics,
};
