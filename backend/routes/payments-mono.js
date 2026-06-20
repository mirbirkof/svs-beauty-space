/* ═══════════════════════════════════════════════════════
   SVS Beauty World — Mono Acquiring (M29 Payment Gateway)

   POST /api/pay/mono/invoice          {order_id} → создать/вернуть инвойс
   POST /api/pay/mono/webhook          ← Mono (X-Sign verified)
   GET  /api/pay/mono/status/:orderId  → статус оплаты (с live-поллингом)
   GET  /api/pay/mono/health           → конфиг/мерчант

   Страховка от ротации туннеля: вебхук может не дойти →
   cron каждые 3 мин поллит pending-инвойсы напрямую у Mono.
   ═══════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const { getPool, applyTenant } = require('../db-pg');
const mono = require('../lib/mono');
const { getSetting } = require('../lib/settings');

const FINAL = ['success', 'failure', 'reversed', 'expired'];

// телефон владельца личного кабинета (clients.phone по client_id); fallback — что записано в брони
async function cabinetPhone(pool, clientId, fallback) {
  if (!clientId) return fallback || '';
  try {
    const r = await pool.query('SELECT phone FROM clients WHERE id = $1', [clientId]);
    return (r.rows[0] && r.rows[0].phone) || fallback || '';
  } catch (_) { return fallback || ''; }
}

// ── применить статус инвойса (вебхук И поллинг идут сюда — один путь) ──
async function applyInvoiceStatus(data) {
  const pool = getPool();
  const invoiceId = data.invoiceId;
  if (!invoiceId) return { ok: false, reason: 'no-invoice-id' };

  const cur = await pool.query(
    `SELECT id, order_id, booking_id, amount, status, purpose FROM payments WHERE provider = 'mono' AND invoice_id = $1`,
    [invoiceId]
  );
  if (!cur.rowCount) {
    // не замовлення магазину — можливо, це рахунок підписки SaaS (payments_saas)
    try {
      const billing = require('../lib/billing');
      const r = await billing.payInvoiceViaMono(invoiceId, data);
      if (r.ok) return r; // оброблено білінгом підписок
    } catch (e) { console.error('[mono:saas-webhook]', e.message); }
    return { ok: false, reason: 'unknown-invoice' };
  }
  const p = cur.rows[0];

  // финальный статус уже зафиксирован — идемпотентность (вебхук может прийти повторно)
  if (FINAL.includes(p.status)) return { ok: true, status: p.status, dedup: true };
  if (p.status === data.status) return { ok: true, status: p.status, unchanged: true };

  // сверка суммы: success с суммой МЕНЬШЕ счёта = аномалия (недоплата/частичная оплата) —
  // не подтверждаем автоматом, фиксируем и зовём админа
  if (data.status === 'success' && data.amount != null) {
    const expectedKop = Math.round(Number(p.amount) * 100);
    if (expectedKop > 0 && Number(data.amount) < expectedKop) {
      await pool.query(
        `UPDATE payments SET status = 'amount_mismatch', failure_reason = $1, raw = $2, updated_at = NOW() WHERE id = $3`,
        [`paid ${data.amount} kop, expected ${expectedKop} kop`, JSON.stringify(data), p.id]
      );
      console.error(`[mono] AMOUNT MISMATCH invoice ${invoiceId}: paid ${data.amount}, expected ${expectedKop}`);
      if (process.env.ADMIN_TG_CHAT) {
        const { tgSend } = require('./telegram-notify');
        tgSend(process.env.ADMIN_TG_CHAT,
          `⚠️ <b>Mono: сума не збігається</b>\nІнвойс ${invoiceId}\nОчікували ${(expectedKop / 100).toFixed(2)} грн, прийшло ${(Number(data.amount) / 100).toFixed(2)} грн\nЗамовлення/запис НЕ підтверджено автоматично — перевірте вручну.`)
          .catch(() => {});
      }
      return { ok: true, status: 'amount_mismatch' };
    }
  }

  await pool.query(
    `UPDATE payments SET status = $1, failure_reason = $2, raw = $3, updated_at = NOW() WHERE id = $4`,
    [data.status, data.failureReason || null, JSON.stringify(data), p.id]
  );

  if (data.status === 'success' && p.booking_id && p.purpose === 'visit') {
    // ── оплата послуги ПІСЛЯ візиту ──
    const paid = data.amount ? data.amount / 100 : p.amount;
    const upd = await pool.query(
      `UPDATE online_bookings SET visit_paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND visit_paid_at IS NULL
       RETURNING id, client_id, client_name, client_phone, service_name, telegram_id, bp_appointment_id`,
      [p.booking_id]
    );
    if (upd.rowCount) {
      const b = upd.rows[0];
      // телефон в уведомлении = телефон владельца кабинета (clients.phone), не телефон из карточки BP
      b.client_phone = await cabinetPhone(pool, b.client_id, b.client_phone);
      // провести в BeautyPro: чеки на счёт TG-бот + зелёная запись (fire-and-forget)
      if (b.bp_appointment_id) {
        const bp = require('../beautyproClient');
        bp.closeAppointmentAsPaid(b.bp_appointment_id, paid)
          .then(r => console.log('[mono:bp-close]', b.bp_appointment_id, JSON.stringify(r)))
          .catch(e => console.error('[mono:bp-close]', b.bp_appointment_id, e.message));
      }
      if (b.telegram_id) {
        bookingBotSend(b.telegram_id,
          `✅ Оплату ${Math.round(paid)} грн отримано. Дякуємо, що ви з нами! 💛`)
          .catch(e => console.error('[mono:visit-notify-client]', e.message));
      }
      if (process.env.ADMIN_TG_CHAT) {
        const { tgSend } = require('./telegram-notify');
        tgSend(process.env.ADMIN_TG_CHAT,
          `💳 <b>Оплата візиту онлайн</b>\n${b.client_name || ''} ${b.client_phone || ''}\n${b.service_name || ''}\nMono: ${Math.round(paid)} грн`)
          .catch(e => console.error('[mono:visit-notify-admin]', e.message));
      }
    }
  } else if (data.status === 'success' && p.booking_id) {
    // ── предоплата за онлайн-запись ──
    const paid = data.amount ? data.amount / 100 : p.amount;
    const upd = await pool.query(
      `UPDATE online_bookings SET prepaid_amount = $1, prepaid_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND prepaid_at IS NULL
       RETURNING id, client_id, client_name, client_phone, service_name, date_from, telegram_id`,
      [paid, p.booking_id]
    );
    if (upd.rowCount) {
      const b = upd.rows[0];
      b.client_phone = await cabinetPhone(pool, b.client_id, b.client_phone);
      const when = b.date_from ? new Date(b.date_from).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      // клиенту — через booking-бот (он точно с ним общался)
      if (b.telegram_id) {
        bookingBotSend(b.telegram_id,
          `✅ Передоплату ${Math.round(paid)} грн отримано!\nВаш запис${b.service_name ? ` на «${b.service_name}»` : ''}${when ? ` ${when}` : ''} підтверджено повністю. До зустрічі!`)
          .catch(e => console.error('[mono:booking-notify-client]', e.message));
      }
      if (process.env.ADMIN_TG_CHAT) {
        const { tgSend } = require('./telegram-notify');
        tgSend(process.env.ADMIN_TG_CHAT,
          `💳 <b>Передоплата за запис</b>\n${b.client_name || ''} ${b.client_phone || ''}\n${b.service_name || ''}${when ? `, ${when}` : ''}\nMono: ${Math.round(paid)} грн`)
          .catch(e => console.error('[mono:booking-notify-admin]', e.message));
      }
    }
  } else if (data.status === 'success') {
    // Атомарно: помечаем оплаченным + списываем остаток + снимаем резерв + пишем движение склада.
    // WHERE status='new' RETURNING — идемпотентность: только первая доставка вебхука делает работу.
    let paidOk = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const upd = await client.query(
        `UPDATE orders SET status = 'paid', updated_at = NOW()
         WHERE id = $1 AND status = 'new' RETURNING id`,
        [p.order_id]
      );
      if (upd.rowCount) {
        paidOk = true;
        const its = await client.query(
          `SELECT variant_id, qty FROM order_items WHERE order_id = $1`, [p.order_id]
        );
        for (const it of its.rows) {
          if (it.variant_id == null) continue;
          await client.query(
            `UPDATE product_variants
                SET stock_qty    = GREATEST(0, COALESCE(stock_qty,0)    - $1),
                    reserved_qty = GREATEST(0, COALESCE(reserved_qty,0) - $1)
              WHERE id = $2`,
            [it.qty, it.variant_id]
          );
          await client.query(
            `INSERT INTO stock_movements (variant_id, delta, reason, ref_id)
             VALUES ($1, $2, $3, $4)`,
            [it.variant_id, -it.qty, `order:${p.order_id}`, p.order_id]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[mono:success:stock]', e.message);
    } finally { client.release(); }
    if (paidOk) {
      // уведомления fire-and-forget
      try {
        const { notifyOrderStatus, tgSend } = require('./telegram-notify');
        notifyOrderStatus(p.order_id, 'paid').catch(e => console.error('[mono:notify-client]', e.message));
        if (process.env.ADMIN_TG_CHAT) {
          const amt = Number.isFinite(data.amount) ? (data.amount / 100).toFixed(2) : '—';
          tgSend(process.env.ADMIN_TG_CHAT,
            `💳 <b>Оплачено замовлення №${p.order_id}</b>\nMono: ${amt} грн`)
            .catch(e => console.error('[mono:notify-admin]', e.message));
        }
      } catch (e) { console.error('[mono:notify:load]', e.message); }
    }
  } else if (['failure', 'expired', 'reversed'].includes(data.status)) {
    // неоплаченный/протухший инвойс → отменяем заказ и возвращаем зарезервированный остаток
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await applyTenant(client);
      const upd = await client.query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND status = 'new' RETURNING id`,
        [p.order_id]
      );
      if (upd.rowCount) {
        const its = await client.query(
          `SELECT variant_id, qty FROM order_items WHERE order_id = $1`, [p.order_id]
        );
        for (const it of its.rows) {
          if (it.variant_id == null) continue;
          await client.query(
            `UPDATE product_variants
                SET reserved_qty = GREATEST(0, COALESCE(reserved_qty,0) - $1)
              WHERE id = $2`,
            [it.qty, it.variant_id]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('[mono:cancel:release]', e.message);
    } finally { client.release(); }
    console.log(`[mono] invoice ${invoiceId} → ${data.status} (order ${p.order_id})`);
  }
  return { ok: true, status: data.status };
}

// ── создать инвойс для заказа (вызывается и из orders.js) ──
async function createInvoiceForOrder(orderId) {
  const pool = getPool();
  const r = await pool.query(`SELECT id, total, status FROM orders WHERE id = $1`, [orderId]);
  if (!r.rowCount) { const e = new Error('order-not-found'); e.code = 404; throw e; }
  const order = r.rows[0];
  if (order.status !== 'new') { const e = new Error(`order-status-${order.status}`); e.code = 409; throw e; }

  // идемпотентность: живой pending-инвойс возвращаем повторно
  const existing = await pool.query(
    `SELECT invoice_id, page_url, status FROM payments
     WHERE order_id = $1 AND provider = 'mono'
       AND status IN ('created','processing','hold')
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [orderId]
  );
  if (existing.rowCount && existing.rows[0].page_url) {
    return { invoiceId: existing.rows[0].invoice_id, pageUrl: existing.rows[0].page_url, reused: true };
  }

  const items = await pool.query(
    `SELECT product_name AS name, qty, unit_price, line_total FROM order_items WHERE order_id = $1`,
    [orderId]
  );
  const inv = await mono.createInvoice({
    amountUah: order.total,
    orderId,
    basket: items.rows,
  });
  await pool.query(
    `INSERT INTO payments (order_id, provider, invoice_id, page_url, amount, status)
     VALUES ($1, 'mono', $2, $3, $4, 'created')`,
    [orderId, inv.invoiceId, inv.pageUrl, order.total]
  );
  return { invoiceId: inv.invoiceId, pageUrl: inv.pageUrl };
}

// ── предоплата за онлайн-запись (online_bookings) ──
// Налаштування читаються з кабінету (app_settings.prepayment); якщо там нічого —
// fallback на серверну змінну BOOKING_DEPOSIT_PERCENT (історична поведінка).
const ENV_DEPOSIT_PERCENT = Math.min(100, Math.max(0, parseInt(process.env.BOOKING_DEPOSIT_PERCENT || '30', 10) || 0));
async function getPrepaymentConfig() {
  const s = await getSetting('prepayment', null);
  if (s && typeof s === 'object') {
    const enabled = s.enabled !== false; // за замовч. увімкнено, якщо ключ існує
    const percent = Math.min(100, Math.max(0, parseInt(s.percent, 10) || 0));
    const minAmount = Math.max(0, parseInt(s.min_amount, 10) || 0);
    return { enabled, percent: enabled ? percent : 0, minAmount };
  }
  return { enabled: ENV_DEPOSIT_PERCENT > 0, percent: ENV_DEPOSIT_PERCENT, minAmount: 0 };
}

// отправка через booking-бота (клиент гарантированно начинал с ним диалог)
function bookingBotSend(chatId, text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return Promise.reject(new Error('no-booking-bot-token'));
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...opts }),
    signal: AbortSignal.timeout(10000),
  }).then(async r => {
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || 'tg-send-failed');
    return j;
  });
}

async function createInvoiceForBooking(bookingId) {
  const cfg = await getPrepaymentConfig();
  const pool = getPool();
  const r = await pool.query(
    `SELECT b.id, b.status, b.service_name, b.client_name, b.telegram_id, b.prepaid_at,
            s.price, s.name AS local_service_name,
            cl.prepayment_required
     FROM online_bookings b
     LEFT JOIN services s ON s.beautypro_id = b.service_id
     LEFT JOIN clients cl ON cl.id = b.client_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!r.rowCount) { const e = new Error('booking-not-found'); e.code = 404; throw e; }
  const b = r.rows[0];
  if (b.prepaid_at) return { alreadyPaid: true };
  if (!b.price || Number(b.price) <= 0) return null; // цена неизвестна — без предоплаты

  // Передоплата: індивідуальна вимога клієнта (100%) має пріоритет над глобальною політикою.
  // За замовч. передоплати немає — лише для «ризикових» клієнтів з прапорцем у картці.
  const percent = b.prepayment_required === true ? 100 : (cfg.enabled ? cfg.percent : 0);
  if (!percent) return null; // ні флага клієнта, ні глобальної передоплати → без рахунку

  let deposit = Math.round(Number(b.price) * percent / 100);
  if (percent < 100 && cfg.minAmount) deposit = Math.max(deposit, cfg.minAmount); // мін. сума (тільки для часткової)
  deposit = Math.min(Math.max(1, deposit), Math.round(Number(b.price))); // не більше повної ціни
  const serviceName = b.service_name || b.local_service_name || 'послугу';

  // идемпотентность: живой pending-инвойс не дублируем
  const existing = await pool.query(
    `SELECT invoice_id, page_url FROM payments
     WHERE booking_id = $1 AND provider = 'mono'
       AND status IN ('created','processing','hold')
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY id DESC LIMIT 1`,
    [bookingId]
  );
  if (existing.rowCount && existing.rows[0].page_url) {
    return { invoiceId: existing.rows[0].invoice_id, pageUrl: existing.rows[0].page_url, amount: deposit, serviceName, reused: true };
  }

  const inv = await mono.createInvoice({
    amountUah: deposit,
    orderId: `appt-${bookingId}`,
    destination: `Передоплата за запис: ${serviceName} — SVS Beauty Space`.slice(0, 280),
  });
  await pool.query(
    `INSERT INTO payments (booking_id, provider, invoice_id, page_url, amount, status)
     VALUES ($1, 'mono', $2, $3, $4, 'created')`,
    [bookingId, inv.invoiceId, inv.pageUrl, deposit]
  );
  return { invoiceId: inv.invoiceId, pageUrl: inv.pageUrl, amount: deposit, serviceName };
}

// ── оплата послуги ПІСЛЯ візиту: інвойс на повну суму ──
async function createInvoiceForVisit(bookingId) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT b.id, b.service_name, b.telegram_id, b.visit_paid_at,
            a.price AS visit_price, s.price AS svc_price, s.name AS local_service_name
     FROM online_bookings b
     LEFT JOIN appointments a ON a.beautypro_id = b.bp_appointment_id
     LEFT JOIN services s ON s.beautypro_id = b.service_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (!r.rowCount) { const e = new Error('booking-not-found'); e.code = 404; throw e; }
  const b = r.rows[0];
  if (b.visit_paid_at) return { alreadyPaid: true };
  // цена закрытого визита из BP приоритетна (там реальный чек), fallback — прайс услуги
  const amount = Math.round(Number(b.visit_price || b.svc_price || 0));
  if (!amount || amount <= 0) return null;
  const serviceName = b.service_name || b.local_service_name || 'послугу';

  // идемпотентность: живой pending-инвойс не дублируем
  const existing = await pool.query(
    `SELECT invoice_id, page_url FROM payments
     WHERE booking_id = $1 AND provider = 'mono' AND purpose = 'visit'
       AND status IN ('created','processing','hold')
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY id DESC LIMIT 1`,
    [bookingId]
  );
  if (existing.rowCount && existing.rows[0].page_url) {
    return { invoiceId: existing.rows[0].invoice_id, pageUrl: existing.rows[0].page_url, amount, serviceName, reused: true };
  }

  const inv = await mono.createInvoice({
    amountUah: amount,
    orderId: `visit-${bookingId}`,
    destination: `Оплата послуги: ${serviceName} — SVS Beauty Space`.slice(0, 280),
  });
  await pool.query(
    `INSERT INTO payments (booking_id, provider, invoice_id, page_url, amount, status, purpose)
     VALUES ($1, 'mono', $2, $3, $4, 'created', 'visit')`,
    [bookingId, inv.invoiceId, inv.pageUrl, amount]
  );
  return { invoiceId: inv.invoiceId, pageUrl: inv.pageUrl, amount, serviceName };
}

// ── отправить клиенту ссылку на оплату в TG (если привязан) ──
async function sendPayLinkToClient(orderId, pageUrl) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT c.telegram_id, o.total FROM orders o LEFT JOIN clients c ON c.id = o.client_id WHERE o.id = $1`,
    [orderId]
  );
  if (!r.rowCount || !r.rows[0].telegram_id) return { ok: false, reason: 'no-telegram-id' };
  const { tgSend } = require('./telegram-notify');
  await tgSend(r.rows[0].telegram_id,
    `<b>Замовлення №${orderId}</b>\nСума: ${Math.round(r.rows[0].total)} грн\n\nОплатіть онлайн через Mono:`,
    { reply_markup: { inline_keyboard: [[{ text: '💳 Оплатити', url: pageUrl }]] } });
  return { ok: true };
}

// ── HTTP: создать инвойс ──
router.post('/invoice', async (req, res) => {
  try {
    const orderId = parseInt(req.body?.order_id, 10);
    if (!orderId) return res.status(400).json({ error: 'order-id-required' });
    const inv = await createInvoiceForOrder(orderId);
    sendPayLinkToClient(orderId, inv.pageUrl).catch(() => {});
    res.json({ ok: true, order_id: orderId, invoice_id: inv.invoiceId, pay_url: inv.pageUrl, reused: !!inv.reused });
  } catch (e) {
    console.error('[mono:invoice]', e.message);
    res.status(e.code || 502).json({ error: e.message });
  }
});

// ── HTTP: вебхук от Mono (требует req.rawBody — см. shop-api.js) ──
router.post('/webhook', async (req, res) => {
  try {
    const ok = await mono.verifyWebhook(req.rawBody, req.get('X-Sign'));
    if (!ok) {
      console.error('[mono:webhook] bad signature, ip=', req.ip);
      return res.status(403).json({ error: 'bad-signature' });
    }
    const result = await applyInvoiceStatus(req.body || {});
    res.json(result); // 200 всегда при валидной подписи — иначе Mono ретраит
  } catch (e) {
    console.error('[mono:webhook]', e);
    res.status(500).json({ error: 'internal' });
  }
});

// ── HTTP: статус оплаты заказа (+ live-поллинг если pending) ──
router.get('/status/:orderId', async (req, res) => {
  try {
    const pool = getPool();
    const orderId = parseInt(req.params.orderId, 10);
    if (!orderId) return res.status(400).json({ error: 'bad-id' });
    const r = await pool.query(
      `SELECT invoice_id, page_url, status, amount, updated_at FROM payments
       WHERE order_id = $1 AND provider = 'mono' ORDER BY id DESC LIMIT 1`,
      [orderId]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'no-payment' });
    let p = r.rows[0];
    // вебхук мог потеряться (ротация туннеля) — спрашиваем Mono напрямую
    if (!FINAL.includes(p.status)) {
      try {
        const live = await mono.getInvoiceStatus(p.invoice_id);
        if (live.status && live.status !== p.status) {
          await applyInvoiceStatus(live);
          p = { ...p, status: live.status };
        }
      } catch (e) { console.error('[mono:status:poll]', e.message); }
    }
    res.json({ ok: true, order_id: orderId, payment: p });
  } catch (e) {
    console.error('[mono:status]', e);
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/health', async (req, res) => {
  try {
    const merchant = await mono.getMerchantDetails();
    res.json({ ok: true, configured: true, merchant: merchant.merchantName, public_base: mono.getPublicBase() });
  } catch (e) {
    res.status(503).json({ ok: false, configured: !!process.env.MONO_TOKEN, error: e.message });
  }
});

// ── cron: поллинг pending-инвойсов (страховка от потерянных вебхуков) ──
let _cronTimer = null;
function startCron() {
  if (_cronTimer) return;
  // Миграция применена 10.06.2026 под owner-ролью (app_tenant не владеет таблицами):
  //   payments.purpose TEXT; online_bookings.visit_invoice_sent_at/visit_paid_at TIMESTAMPTZ
  _cronTimer = setInterval(async () => {
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT invoice_id FROM payments
         WHERE provider = 'mono' AND status IN ('created','processing','hold')
           AND created_at > NOW() - INTERVAL '25 hours'
         LIMIT 50`
      );
      for (const row of r.rows) {
        try {
          const live = await mono.getInvoiceStatus(row.invoice_id);
          await applyInvoiceStatus(live);
        } catch (e) { console.error('[mono:cron]', row.invoice_id, e.message); }
      }

      // страховка для рахунків підписки SaaS (payments_saas) — поллимо pending mono-лінки
      try {
        const sr = await pool.query(
          `SELECT gateway_payment_id FROM payments_saas
           WHERE gateway='monobank' AND status IN ('pending','processing')
             AND created_at > NOW() - INTERVAL '25 hours' LIMIT 50`
        );
        for (const row of sr.rows) {
          try {
            const live = await mono.getInvoiceStatus(row.gateway_payment_id);
            await applyInvoiceStatus(live);
          } catch (e) { console.error('[mono:cron:saas]', row.gateway_payment_id, e.message); }
        }
      } catch (e) { console.error('[mono:cron:saas-scan]', e.message); }

      // новые подтверждённые записи (из TG-бота) без предоплаты и без инвойса →
      // создать инвойс и прислать кнопку «Оплатити» прямо в чат клиента
      const nb = await pool.query(
        `SELECT b.id, b.telegram_id FROM online_bookings b
         WHERE b.status = 'confirmed' AND b.prepaid_at IS NULL AND b.telegram_id IS NOT NULL
           AND b.created_at > NOW() - INTERVAL '6 hours'
           AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.provider = 'mono')
         LIMIT 20`
      );
      for (const b of nb.rows) {
        try {
          const inv = await createInvoiceForBooking(b.id);
          if (inv && inv.pageUrl) {
            await bookingBotSend(b.telegram_id,
              `💳 Передоплата за запис: ${inv.amount} грн\nОплатіть онлайн (картка / Apple Pay / Google Pay):`,
              { reply_markup: { inline_keyboard: [[{ text: `Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] } });
            console.log('[mono:prepay-scan] invoice sent, booking', b.id);
          }
        } catch (e) { console.error('[mono:prepay-scan]', b.id, e.message); }
      }
      // ── оплата ПІСЛЯ візиту: BP закрыл визит (done/completed, НЕ paid — те
      //    рассчитались на месте) → шлём ссылку на полную сумму, один раз ──
      const fv = await pool.query(
        `SELECT b.id, b.telegram_id FROM online_bookings b
         JOIN appointments a ON a.beautypro_id = b.bp_appointment_id
         WHERE a.status = 'done' AND LOWER(COALESCE(a.bp_state,'')) <> 'paid'
           AND b.telegram_id IS NOT NULL
           AND b.visit_paid_at IS NULL AND b.visit_invoice_sent_at IS NULL
           AND a.ends_at > NOW() - INTERVAL '3 days' AND a.ends_at < NOW()
         LIMIT 20`
      );
      for (const b of fv.rows) {
        try {
          const inv = await createInvoiceForVisit(b.id);
          if (inv && inv.pageUrl) {
            await bookingBotSend(b.telegram_id,
              `💛 Дякуємо за візит!\n\nЗа бажанням можете оплатити послугу онлайн — ${inv.amount} грн (картка / Apple Pay / Google Pay).\nЯкщо ви вже розрахувалися в салоні — просто проігноруйте це повідомлення.`,
              { reply_markup: { inline_keyboard: [[{ text: `💳 Оплатити ${inv.amount} грн`, url: inv.pageUrl }]] } });
          }
          // помечаем в любом случае (нет цены/уже оплачено) — чтобы не долбить каждые 3 мин
          await pool.query(`UPDATE online_bookings SET visit_invoice_sent_at = NOW() WHERE id = $1`, [b.id]);
          if (inv && inv.pageUrl) console.log('[mono:visit-scan] pay link sent, booking', b.id);
        } catch (e) { console.error('[mono:visit-scan]', b.id, e.message); }
      }
    } catch (e) { console.error('[mono:cron]', e.message); }
  }, 3 * 60 * 1000);
  _cronTimer.unref();
  console.log('[mono] pending-invoice poller started (3 min)');
}

module.exports = router;
module.exports.createInvoiceForOrder = createInvoiceForOrder;
module.exports.createInvoiceForBooking = createInvoiceForBooking;
module.exports.createInvoiceForVisit = createInvoiceForVisit;
module.exports.bookingBotSend = bookingBotSend;
module.exports.sendPayLinkToClient = sendPayLinkToClient;
module.exports.applyInvoiceStatus = applyInvoiceStatus;
module.exports.startCron = startCron;
