/* routes/crm-card.js — CRM-04 CRM Card (картка клієнта, 360°).
   Агрегатор: збирає дані клієнта з усіх модулів в одному місці. Власні таблиці —
   тільки client_notes та client_preferences (157). Кожне джерело обгорнуте в safe()
   щоб відсутня/порожня таблиця не валила картку (graceful aggregation).
   Монтаж: /api/clients. Доступ: GET = clients.read; мутації = clients.write. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm, logAction } = require('../lib/rbac');
const { maskPhone, shouldMaskPhones } = require('../lib/settings');

const router = express.Router();
const pool = getPool();
const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
const safe = (promise, fallback) => promise.catch(() => fallback);
const err = (res, e) => { console.error('[crm-card]', e); res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'internal' : e.message }); };

router.use((req, res, next) => {
  const perm = req.method === 'GET' ? 'clients.read' : 'clients.write';
  return requirePerm(perm)(req, res, next);
});

// ── GET /api/clients/:id/card — повна картка (агрегація) ──
router.get('/:id(\\d+)/card', async (req, res) => {
  try {
    const id = +req.params.id;
    const client = (await safe(q(`SELECT * FROM clients WHERE id=$1`, [id]), []))[0];
    if (!client) return res.status(404).json({ error: 'not found' });
    // Майстер салону не бачить номер клієнта (одиночка/тумблер — бачать)
    if (await shouldMaskPhones(req.user)) {
      client.phone = maskPhone(client.phone);
      client.phone_hidden = true;
    }

    const [stats, bonus, recentVisits, recentOrders, loyalty, prefs] = await Promise.all([
      safe(q(
        `SELECT COUNT(*) FILTER (WHERE status='done')::int AS visits_done,
                COUNT(*) FILTER (WHERE status='noshow')::int AS noshow,
                -- витрати клієнта = РЕАЛЬНІ гроші з каси (не ціни журналу; Босс 19.07)
                COALESCE((SELECT SUM(co.amount) FROM cash_operations co
                          JOIN appointments a2 ON co.ref_type='appointment' AND co.ref_id=a2.id AND co.tenant_id=a2.tenant_id
                         WHERE a2.client_id=$1 AND co.type='in' AND co.category IN ('sale_service','sale_product')),0) AS visits_sum,
                MIN(starts_at) FILTER (WHERE status='done') AS first_visit,
                MAX(starts_at) FILTER (WHERE status='done') AS last_visit
           FROM appointments WHERE client_id=$1`, [id]), [{}]),
      safe(q(`SELECT COALESCE(SUM(amount),0) AS balance FROM bonus_transactions WHERE client_id=$1`, [id]), [{ balance: 0 }]),
      safe(q(
        `SELECT a.id, a.starts_at, a.status, a.price, m.name AS master_name,
                COALESCE(NULLIF(a.services_text,''), s.name) AS service_name
           FROM appointments a LEFT JOIN masters m ON m.id=a.master_id
           LEFT JOIN services s ON s.id=a.service_id
          WHERE a.client_id=$1 ORDER BY a.starts_at DESC LIMIT 5`, [id]), []),
      safe(q(`SELECT id, total, status, created_at FROM orders WHERE client_id=$1 ORDER BY created_at DESC LIMIT 5`, [id]), []),
      safe(q(
        `SELECT t.name, t.min_spent FROM loyalty_tiers t
          WHERE t.min_spent <= COALESCE((SELECT total_spent FROM clients WHERE id=$1),0)
          ORDER BY t.min_spent DESC LIMIT 1`, [id]), []),
      safe(q(`SELECT * FROM client_preferences WHERE client_id=$1 AND tenant_id = current_tenant_id()`, [id]), []),
    ]);

    const s = stats[0] || {};
    const isVip = (client.tags || []).includes('VIP');
    res.json({
      client,
      stats: {
        visits_done: s.visits_done || 0,
        noshow: s.noshow || 0,
        visits_sum: Number(s.visits_sum || 0),
        first_visit: s.first_visit || null,
        last_visit: s.last_visit || client.last_visit_at || null,
        avg_check: s.visits_done ? Math.round(Number(s.visits_sum || 0) / s.visits_done) : 0,
        ltv: Number(client.total_spent || 0),
      },
      bonus_balance: Number(bonus[0]?.balance || 0),
      loyalty_level: loyalty[0]?.name || null,
      is_vip: isVip,
      tags: client.tags || [],
      preferences: prefs[0] || null,
      recent_visits: recentVisits,
      recent_orders: recentOrders,
    });
  } catch (e) { err(res, e); }
});

// ── GET /api/clients/:id/timeline — хронологія подій ──
router.get('/:id(\\d+)/timeline', async (req, res) => {
  try {
    const id = +req.params.id;
    const type = req.query.type || null;
    const limit = Math.min(+req.query.limit || 50, 200);
    const offset = +req.query.offset || 0;
    const events = [];

    if (!type || type === 'visit') {
      const rows = await safe(q(
        `SELECT a.id, a.starts_at AS date, a.status, a.price, m.name AS master_name,
                COALESCE(NULLIF(a.services_text,''), s.name) AS service_name
           FROM appointments a LEFT JOIN masters m ON m.id=a.master_id
           LEFT JOIN services s ON s.id=a.service_id
          WHERE a.client_id=$1 ORDER BY a.starts_at DESC LIMIT 100`, [id]), []);
      for (const r of rows) events.push({
        type: r.status === 'cancelled' ? 'cancel' : (r.status === 'noshow' ? 'noshow' : 'visit'),
        date: r.date, title: r.service_name || 'Візит',
        details: { master: r.master_name, price: r.price, status: r.status },
      });
    }
    if (!type || type === 'order') {
      const rows = await safe(q(`SELECT id, total, status, created_at AS date FROM orders WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]), []);
      for (const r of rows) events.push({ type: 'order', date: r.date, title: `Замовлення #${r.id}`, details: { total: Number(r.total), status: r.status } });
    }
    if (!type || type === 'bonus') {
      const rows = await safe(q(`SELECT id, type AS bt, amount, description, created_at AS date FROM bonus_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]), []);
      for (const r of rows) events.push({ type: 'bonus', date: r.date, title: r.bt, details: { amount: Number(r.amount), description: r.description } });
    }
    if (!type || type === 'message') {
      const rows = await safe(q(`SELECT id, channel, 'out' AS direction, body, created_at AS date FROM notifications WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]), []);
      for (const r of rows) events.push({ type: 'message', date: r.date, title: `${r.channel || 'msg'} ${r.direction || ''}`.trim(), details: { body: r.body } });
    }
    if (!type || type === 'review') {
      const rows = await safe(q(`SELECT id, rating, text, created_at AS date FROM reviews WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]), []);
      for (const r of rows) events.push({ type: 'review', date: r.date, title: `Відгук ${r.rating}★`, details: { text: r.text } });
    }

    events.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ events: events.slice(offset, offset + limit), total: events.length });
  } catch (e) { err(res, e); }
});

// ── GET /api/clients/:id/visits — історія візитів + статистика ──
router.get('/:id(\\d+)/visits', async (req, res) => {
  try {
    const id = +req.params.id;
    const params = [id], wh = ['a.client_id=$1'];
    if (req.query.master_id) { params.push(+req.query.master_id); wh.push(`a.master_id=$${params.length}`); }
    if (req.query.status) { params.push(req.query.status); wh.push(`a.status=$${params.length}`); }
    if (req.query.from) { params.push(req.query.from); wh.push(`a.starts_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); wh.push(`a.starts_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const limit = Math.min(+req.query.limit || 50, 200);
    const items = await safe(q(
      `SELECT a.id, a.starts_at, a.ends_at, a.status, a.price, m.name AS master_name,
              COALESCE(NULLIF(a.services_text,''), s.name) AS service_name
         FROM appointments a LEFT JOIN masters m ON m.id=a.master_id
         LEFT JOIN services s ON s.id=a.service_id
        WHERE ${wh.join(' AND ')} ORDER BY a.starts_at DESC LIMIT ${limit}`, params), []);
    const fav = (await safe(q(
      `SELECT m.name AS master, COUNT(*)::int AS cnt FROM appointments a JOIN masters m ON m.id=a.master_id
        WHERE a.client_id=$1 AND a.status='done' GROUP BY m.name ORDER BY cnt DESC LIMIT 1`, [id]), []))[0];
    res.json({ items, favorite_master: fav?.master || null });
  } catch (e) { err(res, e); }
});

// ── GET /api/clients/:id/orders — історія покупок ──
router.get('/:id(\\d+)/orders', async (req, res) => {
  try {
    const id = +req.params.id;
    const params = [id], wh = ['o.client_id=$1'];
    if (req.query.status) { params.push(req.query.status); wh.push(`o.status=$${params.length}`); }
    if (req.query.from) { params.push(req.query.from); wh.push(`o.created_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); wh.push(`o.created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const limit = Math.min(+req.query.limit || 50, 200);
    const items = await safe(q(`SELECT o.* FROM orders o WHERE ${wh.join(' AND ')} ORDER BY o.created_at DESC LIMIT ${limit}`, params), []);
    const agg = (await safe(q(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total),0) AS sum FROM orders WHERE client_id=$1 AND status NOT IN ('cancelled','refunded')`, [id]), [{}]))[0] || {};
    res.json({ items, total_orders: agg.cnt || 0, total_sum: Number(agg.sum || 0), avg_check: agg.cnt ? Math.round(Number(agg.sum) / agg.cnt) : 0 });
  } catch (e) { err(res, e); }
});

// ── GET /api/clients/:id/finances — бонуси, сертифікати, абонементи, LTV ──
router.get('/:id(\\d+)/finances', async (req, res) => {
  try {
    const id = +req.params.id;
    const [bonus, bonusLog, certs, subs, client] = await Promise.all([
      safe(q(`SELECT COALESCE(SUM(amount),0) AS balance FROM bonus_transactions WHERE client_id=$1`, [id]), [{ balance: 0 }]),
      safe(q(`SELECT id, type, amount, balance_after, description, created_at FROM bonus_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50`, [id]), []),
      safe(q(`SELECT id, code, type, original_amount, remaining_amount, status, valid_until FROM gift_certificates WHERE recipient_phone=(SELECT phone FROM clients WHERE id=$1) OR buyer_phone=(SELECT phone FROM clients WHERE id=$1) ORDER BY valid_until DESC`, [id]), []),
      safe(q(`SELECT id, subscription_number, status, visits_remaining, started_at, expires_at FROM subscriptions WHERE client_id=$1 ORDER BY started_at DESC`, [id]), []),
      safe(q(`SELECT total_spent, loyalty_points FROM clients WHERE id=$1`, [id]), [{}]),
    ]);
    res.json({
      bonus_balance: Number(bonus[0]?.balance || 0),
      bonus_history: bonusLog,
      gift_certificates: certs,
      subscriptions: subs,
      ltv: Number(client[0]?.total_spent || 0),
      loyalty_points: client[0]?.loyalty_points || 0,
    });
  } catch (e) { err(res, e); }
});

// ── GET /api/clients/:id/communications — історія повідомлень ──
router.get('/:id(\\d+)/communications', async (req, res) => {
  try {
    const id = +req.params.id;
    const params = [id], wh = ['client_id=$1'];
    if (req.query.channel) { params.push(req.query.channel); wh.push(`channel=$${params.length}`); }
    const limit = Math.min(+req.query.limit || 50, 200);
    const items = await safe(q(`SELECT id, channel, category, subject, body, status, created_at FROM notifications WHERE ${wh.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`, params), []);
    res.json({ items });
  } catch (e) { err(res, e); }
});

// ── ПРЕДПОЧТЕНИЯ ──
router.get('/:id(\\d+)/preferences', async (req, res) => {
  try {
    const r = await q(`SELECT * FROM client_preferences WHERE client_id=$1 AND tenant_id = current_tenant_id()`, [+req.params.id]);
    res.json({ preferences: r[0] || null });
  } catch (e) { err(res, e); }
});
router.put('/:id(\\d+)/preferences', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await q(
      `INSERT INTO client_preferences (client_id, preferred_master_id, backup_master_id, preferred_time,
              preferred_services, communication_channel, language, allergies, contraindications, notes_master, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (client_id) DO UPDATE SET
         preferred_master_id=EXCLUDED.preferred_master_id, backup_master_id=EXCLUDED.backup_master_id,
         preferred_time=EXCLUDED.preferred_time, preferred_services=EXCLUDED.preferred_services,
         communication_channel=EXCLUDED.communication_channel, language=EXCLUDED.language,
         allergies=EXCLUDED.allergies, contraindications=EXCLUDED.contraindications,
         notes_master=EXCLUDED.notes_master, tags=EXCLUDED.tags, updated_at=NOW()
       RETURNING *`,
      [+req.params.id, b.preferred_master_id || null, b.backup_master_id || null, b.preferred_time || null,
       b.preferred_services || null, b.communication_channel || null, b.language || 'uk', b.allergies || null,
       b.contraindications || null, b.notes_master || null, b.tags || null]);
    res.json({ ok: true, preferences: r[0] });
  } catch (e) { err(res, e); }
});

// ── ЗАМІТКИ ──
router.get('/:id(\\d+)/notes', async (req, res) => {
  try {
    res.json({ items: await q(`SELECT * FROM client_notes WHERE client_id=$1 AND tenant_id = current_tenant_id() ORDER BY pinned DESC, created_at DESC`, [+req.params.id]) });
  } catch (e) { err(res, e); }
});
router.post('/:id(\\d+)/notes', async (req, res) => {
  try {
    if (!req.body?.note) return res.status(400).json({ error: 'note required' });
    const r = await q(`INSERT INTO client_notes (client_id, author_name, note, pinned) VALUES ($1,$2,$3,$4) RETURNING *`,
      [+req.params.id, req.user?.display_name || null, req.body.note, !!req.body.pinned]);
    logAction({ user: req.user, action: 'client.note.add', entity: 'client', entity_id: +req.params.id, ip: req.ip }).catch(()=>{});
    res.json({ ok: true, note: r[0] });
  } catch (e) { err(res, e); }
});
router.patch('/:id(\\d+)/notes/:noteId(\\d+)', async (req, res) => {
  try {
    const allowed = ['note', 'pinned'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(+req.params.noteId, +req.params.id);
    const r = await q(`UPDATE client_notes SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length - 1} AND client_id=$${vals.length} AND tenant_id = current_tenant_id() RETURNING *`, vals);
    if (!r[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, note: r[0] });
  } catch (e) { err(res, e); }
});
router.delete('/:id(\\d+)/notes/:noteId(\\d+)', async (req, res) => {
  try {
    await q(`DELETE FROM client_notes WHERE id=$1 AND client_id=$2 AND tenant_id = current_tenant_id()`, [+req.params.noteId, +req.params.id]);
    res.json({ ok: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
