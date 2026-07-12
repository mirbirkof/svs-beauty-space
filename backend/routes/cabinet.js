/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Cabinet Content (M20)
   Все endpoints под Bearer-токеном клиента (cabinet-auth).

   GET /api/cabinet/visits   → визиты: майбутні + історія (BeautyPro sync)
   GET /api/cabinet/orders   → замовлення магазину + статус оплати
   GET /api/cabinet/loyalty  → бонуси: баланс, рівень, до наступного
   GET /api/cabinet/summary  → зведення для головної кабінету
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const { getPool } = require('../db-pg');
const { authClient } = require('./cabinet-auth');

const router = express.Router();

// ── визиты: будущие + история ──
router.get('/visits', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT a.id, a.starts_at, a.ends_at, a.price, a.status,
              s.name AS service, m.name AS master
       FROM appointments a
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN masters m ON m.id = a.master_id
       WHERE a.client_id = $1
       ORDER BY a.starts_at DESC
       LIMIT $2 OFFSET $3`,
      [req.client.id, limit, offset]
    );
    const now = Date.now();
    const upcoming = [], past = [];
    for (const v of r.rows) {
      (new Date(v.starts_at).getTime() >= now ? upcoming : past).push(v);
    }
    upcoming.reverse(); // ближайший первым
    res.json({ ok: true, upcoming, past, total: r.rowCount });
  } catch (e) {
    console.error('[cabinet:visits]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── заказы магазина ──
router.get('/orders', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT o.id, o.total, o.status, o.created_at, o.delivery_type,
              COALESCE(json_agg(json_build_object(
                'name', oi.product_name, 'qty', oi.qty, 'price', oi.unit_price
              ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items,
              (SELECT p.status FROM payments p
                WHERE p.order_id = o.id AND p.provider = 'mono'
                ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.client_id = $1
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.client.id, limit, offset]
    );
    res.json({ ok: true, orders: r.rows });
  } catch (e) {
    console.error('[cabinet:orders]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── бонусы и уровень лояльности ──
async function loyaltyFor(client) {
  const pool = getPool();
  const phone = String(client.phone || '').replace(/\D/g, '');

  // Баланс — из ЕДИНОГО кошелька (аудит v6/257): раньше кабинет показывал SUM(loyalty_ledger),
  // которого не существовало в кассе — клиент видел баланс, который негде потратить.
  const bal = await pool.query(
    `SELECT COALESCE(MAX(balance), 0)::numeric AS balance FROM bonus_balances WHERE client_id = $1`,
    [client.id]
  );

  // потрачено всего: max(total_spent из BeautyPro, сумма прошедших визитов) + оплаченные заказы
  // (GREATEST — чтобы не задвоить, если BeautyPro начнёт отдавать total_spent)
  const spent = await pool.query(
    `SELECT
       GREATEST(
         COALESCE((SELECT total_spent FROM clients WHERE id = $1), 0),
         COALESCE((SELECT SUM(COALESCE(real_amount, price)) FROM appointments
                   WHERE client_id = $1 AND starts_at < NOW() AND status NOT IN ('cancelled')), 0)
       ) +
       COALESCE((SELECT SUM(total) FROM orders WHERE client_id = $1 AND status IN ('paid','completed','delivered')), 0) AS total`,
    [client.id]
  );
  const total = parseFloat(spent.rows[0].total || 0);

  const tier = await pool.query(
    `SELECT name, bonus_percent, min_spent FROM loyalty_tiers WHERE min_spent <= $1 ORDER BY min_spent DESC LIMIT 1`,
    [total]
  );
  const next = await pool.query(
    `SELECT name, bonus_percent, min_spent FROM loyalty_tiers WHERE min_spent > $1 ORDER BY min_spent ASC LIMIT 1`,
    [total]
  );
  return {
    balance: parseFloat(bal.rows[0].balance),
    total_spent: total,
    tier: tier.rows[0] || { name: 'Bronze', bonus_percent: 3 },
    next_tier: next.rows[0] || null,
    to_next: next.rows[0] ? Math.max(0, parseFloat(next.rows[0].min_spent) - total) : 0,
    phone,
  };
}

router.get('/loyalty', authClient(), async (req, res) => {
  try {
    res.json({ ok: true, ...(await loyaltyFor(req.client)) });
  } catch (e) {
    console.error('[cabinet:loyalty]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── зведення для головної кабінету ──
router.get('/summary', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const [nextVisit, lastOrder, loyal] = await Promise.all([
      pool.query(
        `SELECT a.starts_at, s.name AS service, m.name AS master
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN masters m ON m.id = a.master_id
         WHERE a.client_id = $1 AND a.starts_at >= NOW() AND a.status NOT IN ('cancelled')
         ORDER BY a.starts_at ASC LIMIT 1`,
        [req.client.id]
      ),
      pool.query(
        `SELECT id, total, status, created_at FROM orders WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [req.client.id]
      ),
      loyaltyFor(req.client),
    ]);
    res.json({
      ok: true,
      client: { name: req.client.name, phone: req.client.phone },
      next_visit: nextVisit.rows[0] || null,
      last_order: lastOrder.rows[0] || null,
      loyalty: loyal,
    });
  } catch (e) {
    console.error('[cabinet:summary]', e.message);
    res.status(500).json({ error: 'internal' });
  }
});

// ── Отмена и перенос визита клиентом ─────────────────────────────────────────
// Правила: только свой визит, только будущий, только booked/confirmed.
// Окно «не позднее чем за N минут» настраивается в booking_settings.cancel_notice_minutes (дефолт 120).
// Крос-тенантний фікс (раунд3): кеш вікна скасування ПЕР-ТЕНАНТ (був глобальний →
// салон Б брав налаштування салону А).
const { getTenantId: _tidNotice } = require('../lib/tenant');
const _noticeCache = new Map();
async function cancelNoticeMs(pool) {
  const tid = String(_tidNotice() || 'default');
  const hit = _noticeCache.get(tid);
  if (hit && Date.now() - hit.at < 60000) return hit.ms; // кэш на минуту
  let ms = 120 * 60000;
  try {
    const r = await pool.query(`SELECT cancel_notice_minutes FROM booking_settings WHERE id = 1`);
    if (r.rows[0]) ms = Number(r.rows[0].cancel_notice_minutes) * 60000;
  } catch (_) { /* колонки ещё нет — работаем на дефолте 120 мин */ }
  _noticeCache.set(tid, { ms, at: Date.now() });
  return ms;
}

async function ownFutureVisit(pool, clientId, visitId) {
  const r = await pool.query(
    `SELECT a.*, s.name AS service, m.name AS master
       FROM appointments a
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN masters m ON m.id = a.master_id
      WHERE a.id = $1 AND a.client_id = $2`, [visitId, clientId]);
  const v = r.rows[0];
  if (!v) return { err: { code: 404, msg: 'Візит не знайдено' } };
  if (!['booked', 'confirmed'].includes(v.status)) return { err: { code: 409, msg: 'Цей візит вже не можна змінити' } };
  const noticeMs = await cancelNoticeMs(pool);
  if (new Date(v.starts_at).getTime() - Date.now() < noticeMs)
    return { err: { code: 409, msg: `Змінити візит можна не пізніше ніж за ${Math.round(noticeMs / 3600000 * 10) / 10} год. Зателефонуйте в салон` } };
  return { v };
}

function notifySalon(html) {
  if (!process.env.ADMIN_TG_CHAT) return;
  try { const { tgSend } = require('./telegram-notify'); tgSend(process.env.ADMIN_TG_CHAT, html).catch(() => {}); }
  catch (_) {}
}

router.post('/visits/:id(\\d+)/cancel', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const { v, err } = await ownFutureVisit(pool, req.client.id, +req.params.id);
    if (err) return res.status(err.code).json({ error: err.msg });
    await pool.query(
      `UPDATE appointments SET status='cancelled', updated_at=NOW(),
              notes = COALESCE(notes,'') || ' [скасовано клієнтом ' || to_char(NOW(),'DD.MM HH24:MI') || ']'
        WHERE id = $1`, [v.id]);
    notifySalon(`🚫 <b>Клієнт скасував запис</b>\n${v.service || 'послуга'} · ${v.master || 'майстер'}\n${new Date(v.starts_at).toLocaleString('uk-UA')}\nКлієнт #${req.client.id}`);
    res.json({ ok: true });
  } catch (e) { console.error('[cabinet:cancel]', e.message); res.status(500).json({ error: 'internal' }); }
});

router.post('/visits/:id(\\d+)/reschedule', authClient(), async (req, res) => {
  try {
    const pool = getPool();
    const newStart = new Date(req.body?.starts_at || '');
    if (isNaN(newStart)) return res.status(400).json({ error: 'Невірна дата (starts_at)' });
    if (newStart.getTime() - Date.now() < await cancelNoticeMs(pool))
      return res.status(409).json({ error: 'Новий час занадто близько — оберіть пізніший' });
    const { v, err } = await ownFutureVisit(pool, req.client.id, +req.params.id);
    if (err) return res.status(err.code).json({ error: err.msg });
    const durMs = new Date(v.ends_at) - new Date(v.starts_at);
    const newEnd = new Date(newStart.getTime() + durMs);
    // мастер не должен быть занят в новое время (пересечение интервалов, кроме отменённых)
    const busy = await pool.query(
      `SELECT 1 FROM appointments
        WHERE master_id = $1 AND id <> $2 AND status NOT IN ('cancelled','noshow')
          AND starts_at < $4 AND ends_at > $3 LIMIT 1`,
      [v.master_id, v.id, newStart.toISOString(), newEnd.toISOString()]);
    if (busy.rowCount) return res.status(409).json({ error: 'Цей час вже зайнято — оберіть інший' });
    await pool.query(
      `UPDATE appointments SET starts_at=$2, ends_at=$3, status='booked', updated_at=NOW(),
              notes = COALESCE(notes,'') || ' [перенесено клієнтом ' || to_char(NOW(),'DD.MM HH24:MI') || ']'
        WHERE id = $1`, [v.id, newStart.toISOString(), newEnd.toISOString()]);
    notifySalon(`🔁 <b>Клієнт переніс запис</b>\n${v.service || 'послуга'} · ${v.master || 'майстер'}\nБуло: ${new Date(v.starts_at).toLocaleString('uk-UA')}\nСтало: ${newStart.toLocaleString('uk-UA')}\nКлієнт #${req.client.id}`);
    res.json({ ok: true, starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() });
  } catch (e) { console.error('[cabinet:reschedule]', e.message); res.status(500).json({ error: 'internal' }); }
});

module.exports = router;
