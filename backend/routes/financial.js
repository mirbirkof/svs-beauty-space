/* routes/financial.js — FIN-04 Фінансовий центр.
   Єдина точка для керівника: виручка/витрати/прибуток + KPI + порівняння періодів,
   щоденна Telegram-зведення (digest). Не джерело первинних даних — консолідує
   існуючі (cash_operations, orders, appointments). Доступ: reports.finance.
   Cron: щодня о заданий час шле зведення Босу в Telegram. */
const express = require('express');
const { getPool } = require('../db-pg');
const { requirePerm } = require('../lib/rbac');
const { tgSend } = require('./telegram-notify');

const router = express.Router();
const pool = getPool();

// ── Київський час ────────────────────────────────────────
function kyivDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function kyivHM(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kiev', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

// Межі періоду [from, to] (ISO timestamptz) за пресетом або кастомом
function periodBounds(query) {
  const today = kyivDate();
  const preset = query.period || 'month';
  let fromD, toD;
  const now = new Date(today + 'T12:00:00');
  if (preset === 'today') { fromD = toD = today; }
  else if (preset === 'week') {
    const dow = (now.getDay() + 6) % 7; const mon = new Date(now); mon.setDate(now.getDate() - dow);
    fromD = fmt(mon); toD = today;
  } else if (preset === 'custom') {
    fromD = query.date_from || today; toD = query.date_to || today;
  } else { // month
    fromD = today.slice(0, 8) + '01'; toD = today;
  }
  return { from: `${fromD} 00:00:00+03`, to: `${toD} 23:59:59+03`, fromD, toD };
}
function fmt(d) { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

// Зсунути період назад на його довжину (для порівняння)
function prevBounds(fromD, toD) {
  const a = new Date(fromD + 'T12:00:00'), b = new Date(toD + 'T12:00:00');
  const days = Math.round((b - a) / 86400000) + 1;
  const pb = new Date(a); pb.setDate(a.getDate() - 1);
  const pa = new Date(pb); pa.setDate(pb.getDate() - (days - 1));
  return { from: `${fmt(pa)} 00:00:00+03`, to: `${fmt(pb)} 23:59:59+03` };
}

// ── Консолідований знімок за період ──────────────────────
async function snapshot(from, to) {
  const q = (sql, p = []) => pool.query(sql, p).then(r => r.rows).catch(() => []);
  const [svc, prodSalon, orders, expRows, cogsR, appts, newCli] = await Promise.all([
    q(`SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int c FROM cash_operations WHERE type='in' AND category='sale_service' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT COALESCE(SUM(amount),0)::numeric s, COUNT(*)::int c FROM cash_operations WHERE type='in' AND category='sale_product' AND ref_type IS DISTINCT FROM 'order' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT COALESCE(SUM(total),0)::numeric s, COUNT(*)::int c FROM orders WHERE status='paid' AND created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT category, COALESCE(SUM(amount),0)::numeric sum FROM cash_operations WHERE type='out' AND created_at BETWEEN $1 AND $2 GROUP BY category ORDER BY sum DESC`, [from, to]),
    q(`SELECT COALESCE(SUM(ABS(sm.delta)*COALESCE(pv.wholesale,0)),0)::numeric cogs FROM stock_movements sm JOIN product_variants pv ON pv.id=sm.variant_id WHERE (sm.reason IN ('sale','order') OR sm.reason LIKE 'order:%') AND sm.delta<0 AND sm.created_at BETWEEN $1 AND $2`, [from, to]),
    q(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int done,
              COUNT(DISTINCT client_id) FILTER (WHERE status NOT IN ('cancelled','noshow') AND starts_at <= NOW())::int uniq,
              COUNT(*) FILTER (WHERE status='cancelled' AND COALESCE(bp_state,'') <> 'bp_deleted')::int cancelled,
              COUNT(*) FILTER (WHERE status='noshow' AND COALESCE(bp_state,'') <> 'bp_deleted')::int noshow
         FROM appointments WHERE starts_at BETWEEN $1 AND $2`, [from, to]),
    // "Нові клієнти" = ПЕРШИЙ реальний візит у періоді, а НЕ дата імпорту в clients.created_at
    // (вся база завантажена одним днем → created_at у всіх = дата імпорту, KPI був би завищений).
    q(`SELECT COUNT(*)::int c FROM (
         SELECT client_id, MIN(starts_at) AS fv FROM appointments
          WHERE status NOT IN ('cancelled','noshow') AND client_id IS NOT NULL
          GROUP BY client_id
       ) t WHERE fv BETWEEN $1 AND $2`, [from, to]),
  ]);
  const revServices = Number(svc[0]?.s || 0);
  const revProducts = Number(prodSalon[0]?.s || 0) + Number(orders[0]?.s || 0);
  const revTotal = revServices + revProducts;
  const expByCat = expRows.map(r => ({ category: r.category, sum: Number(r.sum) }));
  const expTotal = expByCat.reduce((a, r) => a + r.sum, 0);
  const cogs = Number(cogsR[0]?.cogs || 0);
  const grossProfit = revTotal - cogs;
  const netProfit = grossProfit - expTotal;
  const txCount = Number(svc[0]?.c || 0) + Number(prodSalon[0]?.c || 0) + Number(orders[0]?.c || 0);
  return {
    revenue: { services: revServices, products: revProducts, total: revTotal },
    expenses: { by_category: expByCat, total: expTotal },
    profit: { cogs, gross: grossProfit, net: netProfit, margin_pct: revTotal > 0 ? Math.round(netProfit / revTotal * 100) : 0 },
    metrics: {
      transaction_count: txCount,
      avg_check: txCount > 0 ? Math.round(revTotal / txCount) : 0,
      done_appts: Number(appts[0]?.done || 0),
      unique_clients: Number(appts[0]?.uniq || 0),
      new_clients: Number(newCli[0]?.c || 0),
      cancelled_appts: Number(appts[0]?.cancelled || 0),
      noshow_appts: Number(appts[0]?.noshow || 0),
    },
  };
}

const pct = (cur, prev) => prev > 0 ? Math.round((cur - prev) / prev * 1000) / 10 : (cur > 0 ? 100 : 0);

// ── GET /api/financial/dashboard ─────────────────────────
router.get('/dashboard', requirePerm('reports.finance'), async (req, res) => {
  try {
    const { from, to, fromD, toD } = periodBounds(req.query);
    const cur = await snapshot(from, to);
    let comparison = null;
    if (req.query.compare !== '0') {
      const pb = prevBounds(fromD, toD);
      const prev = await snapshot(pb.from, pb.to);
      comparison = {
        revenue: { prev: prev.revenue.total, change_pct: pct(cur.revenue.total, prev.revenue.total) },
        expenses: { prev: prev.expenses.total, change_pct: pct(cur.expenses.total, prev.expenses.total) },
        profit: { prev: prev.profit.net, change_pct: pct(cur.profit.net, prev.profit.net) },
        avg_check: { prev: prev.metrics.avg_check, change_pct: pct(cur.metrics.avg_check, prev.metrics.avg_check) },
      };
    }
    res.json({ period: { from: fromD, to: toD }, ...cur, comparison });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── GET /api/financial/dashboard/trend ───────────────────
router.get('/dashboard/trend', requirePerm('reports.finance'), async (req, res) => {
  try {
    const days = Math.min(Math.max(+req.query.days || 30, 7), 365);
    const r = await pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'Europe/Kiev','YYYY-MM-DD') d,
              SUM(amount)::numeric v
         FROM cash_operations
        WHERE type='in' AND category IN ('sale_service','sale_product')
          AND created_at >= NOW() - ($1||' days')::interval
        GROUP BY d ORDER BY d`, [days]);
    res.json({ metric: 'revenue', days, data: r.rows.map(x => ({ date: x.d, value: Number(x.v) })) });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── Telegram-зведення ────────────────────────────────────
const CAT_LABELS = { rent: 'Оренда', salary: 'Зарплата', payroll: 'Зарплата', purchase: 'Закупівлі', marketing: 'Маркетинг', utilities: 'Комуналка', supplies: 'Витратні', other: 'Інше' };

async function buildDigest(opts = {}) {
  const today = kyivDate();
  const from = `${today} 00:00:00+03`, to = `${today} 23:59:59+03`;
  const s = await snapshot(from, to);
  const lines = [];
  const dStr = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kiev', day: '2-digit', month: 'long' }).format(new Date());
  lines.push(`<b>📊 Фінансова зведення за ${dStr}</b>`);
  lines.push('');
  lines.push(`💰 Виручка: <b>${s.revenue.total.toLocaleString('uk-UA')} ₴</b>`);
  lines.push(`   • послуги ${s.revenue.services.toLocaleString('uk-UA')} ₴ · товари ${s.revenue.products.toLocaleString('uk-UA')} ₴`);
  lines.push(`🧾 Чеків: <b>${s.metrics.transaction_count}</b> · середній ${s.metrics.avg_check.toLocaleString('uk-UA')} ₴`);
  lines.push(`👥 Клієнтів: ${s.metrics.unique_clients} (нових ${s.metrics.new_clients})`);
  lines.push(`❌ Скасувань: <b>${s.metrics.cancelled_appts}</b>${s.metrics.noshow_appts ? ` · неявок: ${s.metrics.noshow_appts}` : ''}`);
  if (opts.include_expenses !== false && s.expenses.total > 0) {
    lines.push('');
    lines.push(`💸 Витрати: <b>${s.expenses.total.toLocaleString('uk-UA')} ₴</b>`);
    for (const e of s.expenses.by_category.slice(0, 4)) {
      lines.push(`   • ${CAT_LABELS[e.category] || e.category}: ${e.sum.toLocaleString('uk-UA')} ₴`);
    }
  }
  lines.push('');
  const profIcon = s.profit.net >= 0 ? '🟢' : '🔴';
  lines.push(`${profIcon} Прибуток: <b>${s.profit.net.toLocaleString('uk-UA')} ₴</b> (маржа ${s.profit.margin_pct}%)`);
  if (opts.include_comparison !== false) {
    const lastWeek = new Date(); lastWeek.setDate(lastWeek.getDate() - 7);
    const lw = kyivDate(lastWeek);
    const sp = await snapshot(`${lw} 00:00:00+03`, `${lw} 23:59:59+03`);
    const ch = pct(s.revenue.total, sp.revenue.total);
    const arrow = ch > 0 ? '📈' : ch < 0 ? '📉' : '➡️';
    lines.push(`${arrow} Тиждень тому виручка була ${sp.revenue.total.toLocaleString('uk-UA')} ₴ (${ch > 0 ? '+' : ''}${ch}%)`);
  }
  return lines.join('\n');
}

// ── GET / PUT налаштування ───────────────────────────────
router.get('/digest/settings', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM financial_digest_settings WHERE id=1`);
    res.json(r.rows[0] || {});
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/digest/settings', requirePerm('reports.finance'), async (req, res) => {
  try {
    const allowed = ['channel', 'telegram_chat_id', 'send_time', 'include_expenses', 'include_top', 'include_comparison', 'skip_weekends', 'is_active'];
    const sets = [], vals = [];
    for (const k of allowed) if (k in (req.body || {})) { vals.push(req.body[k]); sets.push(`${k}=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    const r = await pool.query(`UPDATE financial_digest_settings SET ${sets.join(', ')}, updated_at=NOW() WHERE id=1 RETURNING *`, vals);
    res.json({ ok: true, settings: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── POST надіслати зараз (тест) ──────────────────────────
router.post('/digest/send-now', requirePerm('reports.finance'), async (req, res) => {
  try {
    const st = (await pool.query(`SELECT * FROM financial_digest_settings WHERE id=1`)).rows[0] || {};
    let chat = st.telegram_chat_id || process.env.ADMIN_TG_CHAT;
    // Фолбэк: если chat_id нигде не задан — шлём текущему залогиненному админу
    // (его telegram_id, если аккаунт залинкован с Telegram — тем же каналом, что и коды входа).
    if (!chat && req.user?.id) {
      const u = await pool.query(`SELECT telegram_id FROM users WHERE id=$1`, [req.user.id]);
      if (u.rows[0]?.telegram_id) chat = String(u.rows[0].telegram_id);
    }
    if (!chat) return res.status(400).json({ error: 'no-chat-id', hint: 'відкрийте «Щоденна зведення» і вкажіть Telegram chat_id, або залінкуйте свій акаунт із Telegram' });
    const text = await buildDigest(st);
    await tgSend(chat, text);
    res.json({ ok: true, sent_to: chat });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── CRON: щоденне зведення ───────────────────────────────
let cronRef = null;
async function digestTick() {
  try {
    const st = (await pool.query(`SELECT *, to_char(last_sent_date,'YYYY-MM-DD') AS last_sent_str FROM financial_digest_settings WHERE id=1`)).rows[0];
    if (!st || !st.is_active) return;
    const today = kyivDate();
    // last_sent_str — чистая строка YYYY-MM-DD из БД (без TZ-сдвига; раньше повторная
    // конвертация DATE→Date→kyivDate сдвигала день вперёд и бот пропускал сутки).
    if (st.last_sent_str && st.last_sent_str === today) return; // вже слали сьогодні
    if (st.skip_weekends) {
      const dow = new Date(today + 'T12:00:00').getDay();
      if (dow === 0 || dow === 6) return;
    }
    if (kyivHM() < (st.send_time || '21:00')) return; // ще не час
    const chat = st.telegram_chat_id || process.env.ADMIN_TG_CHAT;
    if (!chat) return;
    const text = await buildDigest(st);
    await tgSend(chat, text);
    await pool.query(`UPDATE financial_digest_settings SET last_sent_date=$1 WHERE id=1`, [today]);
    console.log('[fin-digest] sent to', chat);
  } catch (e) { console.error('[fin-digest] tick error:', e.message); }
}
function startDigestCron() {
  if (cronRef) return;
  setTimeout(digestTick, 60 * 1000);
  cronRef = setInterval(digestTick, 5 * 60 * 1000); // перевірка кожні 5 хв
  cronRef.unref();
  console.log('[fin-digest] cron started (check every 5 min)');
}
startDigestCron();

module.exports = router;
