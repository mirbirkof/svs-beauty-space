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
  // Витрати показуємо ПОВНІСТЮ (з зарплатою майстрів як окрема категорія — як оренда),
  // але прибуток рахуємо ДО виплат майстрам, а їх частку — окремим рядком (рішення Боса 28.06).
  const MASTER_CATS = ['salary', 'payroll'];
  const expByCat = expRows.map(r => ({ category: r.category, sum: Number(r.sum) })); // ВСІ статті, вкл. ЗП
  const expTotal = expByCat.reduce((a, r) => a + r.sum, 0);                            // повні витрати
  const masterPayouts = expByCat.filter(r => MASTER_CATS.includes(r.category)).reduce((a, r) => a + r.sum, 0);
  const opex = expTotal - masterPayouts;                                               // витрати без ЗП майстрів
  const cogs = Number(cogsR[0]?.cogs || 0);
  const grossProfit = revTotal - cogs;
  const profitBeforeMasters = grossProfit - opex;        // прибуток ДО виплат майстрам
  const netProfit = grossProfit - expTotal;              // чистий прибуток (після майстрів)
  const txCount = Number(svc[0]?.c || 0) + Number(prodSalon[0]?.c || 0) + Number(orders[0]?.c || 0);
  return {
    revenue: { services: revServices, products: revProducts, total: revTotal },
    expenses: { by_category: expByCat, total: expTotal },
    master_payouts: masterPayouts,
    profit: { cogs, gross: grossProfit, before_masters: profitBeforeMasters, net: netProfit,
              margin_pct: revTotal > 0 ? Math.round(profitBeforeMasters / revTotal * 100) : 0 },
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
  const pbm = (s.profit.before_masters != null ? s.profit.before_masters : s.profit.net);
  const profIcon = pbm >= 0 ? '🟢' : '🔴';
  lines.push(`${profIcon} Прибуток до виплат майстрам: <b>${pbm.toLocaleString('uk-UA')} ₴</b> (маржа ${s.profit.margin_pct}%)`);
  if (s.master_payouts > 0) {
    lines.push(`💇 Виплати майстрам: <b>${s.master_payouts.toLocaleString('uk-UA')} ₴</b>`);
    lines.push(`🟢 Чистий прибуток: <b>${s.profit.net.toLocaleString('uk-UA')} ₴</b>`);
  }
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

// ── SNAPSHOTS: предрозрахунок для миттєвого дашборду ──────
// Межі періоду за типом і датою
function snapBounds(type, dateStr) {
  const d = dateStr || kyivDate();
  if (type === 'weekly') {
    const base = new Date(d + 'T12:00:00'); const dow = (base.getDay() + 6) % 7;
    const mon = new Date(base); mon.setDate(base.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: `${fmt(mon)} 00:00:00+03`, to: `${fmt(sun)} 23:59:59+03`, period_date: fmt(mon) };
  }
  if (type === 'monthly') {
    const first = d.slice(0, 8) + '01';
    const base = new Date(first + 'T12:00:00'); const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    return { from: `${first} 00:00:00+03`, to: `${fmt(last)} 23:59:59+03`, period_date: first };
  }
  return { from: `${d} 00:00:00+03`, to: `${d} 23:59:59+03`, period_date: d }; // daily
}

router.get('/snapshots', requirePerm('reports.finance'), async (req, res) => {
  try {
    const type = ['daily', 'weekly', 'monthly'].includes(req.query.period_type) ? req.query.period_type : 'daily';
    const limit = Math.min(Math.max(+req.query.limit || 30, 1), 365);
    const r = await pool.query(
      `SELECT period_type, period_date, data, generated_at FROM financial_snapshots
        WHERE period_type=$1 ORDER BY period_date DESC LIMIT $2`, [type, limit]);
    res.json({ period_type: type, count: r.rows.length, items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Перерахувати знімок(и). { period_type, period_date } або діапазон { period_type, days }
router.post('/snapshots/recalculate', requirePerm('reports.finance'), async (req, res) => {
  try {
    const type = ['daily', 'weekly', 'monthly'].includes(req.body?.period_type) ? req.body.period_type : 'daily';
    const targets = [];
    if (req.body?.days && type === 'daily') {
      const n = Math.min(Math.max(+req.body.days, 1), 90);
      for (let i = 0; i < n; i++) { const d = new Date(); d.setDate(d.getDate() - i); targets.push(kyivDate(d)); }
    } else {
      targets.push(req.body?.period_date || kyivDate());
    }
    let count = 0;
    for (const dateStr of targets) {
      const b = snapBounds(type, dateStr);
      const data = await snapshot(b.from, b.to);
      await pool.query(
        `INSERT INTO financial_snapshots (period_type, period_date, data, generated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (period_type, period_date) DO UPDATE SET data=EXCLUDED.data, generated_at=NOW()`,
        [type, b.period_date, JSON.stringify(data)]);
      count++;
    }
    res.json({ ok: true, period_type: type, recalculated: count });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── WIDGETS: налаштовуваний дашборд ──────────────────────
const WIDGET_TYPES = ['revenue_today', 'expense_breakdown', 'profit_trend', 'kpi_card', 'top_masters', 'category_pie'];

router.get('/widgets', requirePerm('reports.finance'), async (req, res) => {
  try {
    const uid = req.user?.id || null;
    const r = await pool.query(
      `SELECT * FROM financial_widgets WHERE user_id IS NULL OR user_id=$1 ORDER BY position, id`, [uid]);
    res.json({ items: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.post('/widgets', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!WIDGET_TYPES.includes(b.widget_type)) return res.status(400).json({ error: 'bad widget_type', allowed: WIDGET_TYPES });
    const r = await pool.query(
      `INSERT INTO financial_widgets (user_id, widget_type, title, config, position, is_visible)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user?.id || null, b.widget_type, b.title || null, JSON.stringify(b.config || {}), Number(b.position) || 0, b.is_visible !== false]);
    res.json({ ok: true, widget: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.put('/widgets/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const b = req.body || {}; const sets = [], vals = [];
    for (const k of ['title', 'position', 'is_visible']) if (k in b) { vals.push(b[k]); sets.push(`${k}=$${vals.length}`); }
    if ('config' in b) { vals.push(JSON.stringify(b.config || {})); sets.push(`config=$${vals.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE financial_widgets SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true, widget: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.delete('/widgets/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM financial_widgets WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── EXPORT: знімок дашборду → файл/розшарене посилання ───
const crypto = require('crypto');
router.post('/export', requirePerm('reports.finance'), async (req, res) => {
  try {
    const scope = ['full_dashboard', 'widget', 'custom_report'].includes(req.body?.scope) ? req.body.scope : 'full_dashboard';
    const format = ['xlsx', 'pdf', 'csv', 'json'].includes(req.body?.format) ? req.body.format : 'xlsx';
    const { from, to, fromD, toD } = periodBounds(req.body || {});
    const data = await snapshot(from, to);
    const payload = { scope, period: { from: fromD, to: toD }, generated_at: new Date().toISOString(), data };
    const share = req.body?.share === true;
    const token = share ? crypto.randomBytes(16).toString('hex') : null;
    const sharedUntil = share ? new Date(Date.now() + 7 * 86400000).toISOString() : null;
    const r = await pool.query(
      `INSERT INTO financial_exports (scope, format, params, status, payload, share_token, shared_until, created_by)
       VALUES ($1,$2,$3,'ready',$4,$5,$6,$7) RETURNING id, scope, format, status, share_token, shared_until, created_at`,
      [scope, format, JSON.stringify(req.body?.params || {}), JSON.stringify(payload), token, sharedUntil, req.user?.id || null]);
    const out = r.rows[0];
    if (token) out.share_url = `/api/financial/export/shared/${token}`;
    res.json({ ok: true, export: out });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

router.get('/export/:id', requirePerm('reports.finance'), async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM financial_exports WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not-found' });
    res.json(r.rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// Публічне розшарене посилання (без auth) — лише поки не протермінувалось
router.get('/export/shared/:token', async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM financial_exports WHERE share_token=$1`, [req.params.token]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'not-found' });
    if (row.shared_until && new Date(row.shared_until) < new Date()) return res.status(410).json({ error: 'expired' });
    res.json({ scope: row.scope, format: row.format, payload: row.payload, created_at: row.created_at });
  } catch (e) { console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message }); }
});

// ── CRON: щоденне зведення + нічний снапшот ──────────────
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
// Фоновий перерахунок знімка поточного дня (щоб дашборд вантажився миттєво з snapshot)
let snapRef = null;
async function snapshotTick() {
  try {
    const b = snapBounds('daily', kyivDate());
    const data = await snapshot(b.from, b.to);
    await pool.query(
      `INSERT INTO financial_snapshots (period_type, period_date, data, generated_at)
       VALUES ('daily',$1,$2,NOW())
       ON CONFLICT (period_type, period_date) DO UPDATE SET data=EXCLUDED.data, generated_at=NOW()`,
      [b.period_date, JSON.stringify(data)]);
  } catch (e) { /* таблиці може ще не бути до міграції — тихо */ }
}
function startDigestCron() {
  if (cronRef) return;
  setTimeout(digestTick, 60 * 1000);
  cronRef = setInterval(digestTick, 5 * 60 * 1000); // перевірка кожні 5 хв
  cronRef.unref();
  setTimeout(snapshotTick, 90 * 1000);
  snapRef = setInterval(snapshotTick, 15 * 60 * 1000); // знімок дня кожні 15 хв
  snapRef.unref();
  console.log('[fin-digest] cron started (check every 5 min, snapshot every 15 min)');
}
startDigestCron();

module.exports = router;
