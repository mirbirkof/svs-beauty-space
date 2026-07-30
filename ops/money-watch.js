#!/usr/bin/env node
/* ops/money-watch.js — НОЧНОЙ ФИНАНСОВЫЙ СТОРОЖ CRM (Loop Engineering, слой 4).
 *
 * ЗАЧЕМ. 28.07 касса была завышена задвоенной записью (двойной клик админа). Нашёл это
 * человек, вручную, после жалобы владельца. Расписания у нас были, но они «по будильнику»:
 * проверяют здоровье сервисов, а не СМЫСЛ данных. Этот сторож проверяет деньги — сам,
 * каждую ночь, и пишет владельцу ТОЛЬКО когда есть что сказать (тишина = всё чисто).
 *
 * ЧТО ПРОВЕРЯЕТ (каждая проверка — отдельный класс ошибки, найденный на реальных данных):
 *   1. Задвоенная выручка: записи-близнецы и повторы клиент+услуга в один день.
 *   2. Оплаты-призраки: деньги, висящие на удалённых/отменённых записях или без записи вообще.
 *   3. Сходимость кассы: касса дня == сумма операций дня (защита от расхождения витрин).
 *   4. Аномалия дня: выручка резко выпадает из своего дня недели (z-оценка) — либо праздник,
 *      либо забыли провести оплаты. Владелец решает сам, сторож только показывает.
 *   5. Неоплаченные вчерашние визиты: услуга оказана, деньги не проведены.
 *   6. Здоровье защиты: на месте ли индекс от дублей (миграция 286).
 *
 * ПРИНЦИП: сторож НИЧЕГО не чинит в деньгах сам — деньги правит только человек. Он находит,
 * доказывает цифрой и показывает, что именно проверить. Это осознанно: автоправка денег без
 * человека — недопустимый риск (правило P1).
 *
 * Запуск: node -r dotenv/config ops/money-watch.js [--quiet]
 *   --quiet — не слать «всё чисто» (для крона; по умолчанию тоже молчит при чистоте)
 */
const { Client } = require('pg');
const { execSync } = require('child_process');

const KYIV = "AT TIME ZONE 'Europe/Kiev'";
const ART = "COALESCE(a.bp_state,'') NOT IN ('bp_deleted','not_in_bukon','phantom_dup')";

function money(v) { return Math.round(Number(v || 0)).toLocaleString('uk-UA') + ' ₴'; }

// --dry / MONEY_WATCH_DRY=1 — надрукувати текст у консоль і НЕ надсилати власнику.
// Потрібно, щоб перевіряти правки сторожа без спаму в Telegram (урок 30.07).
const DRY = process.argv.includes('--dry') || process.env.MONEY_WATCH_DRY === '1';

function notify(text) {
  if (DRY) { console.log('--- DRY, текст не надіслано ---\n' + text + '\n--- кінець ---'); return true; }
  try {
    execSync(
      `curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${process.env.RESTART_TOKEN || 'jarvis-restart-2026'}" -H "Content-Type: application/json" -d @-`,
      { input: JSON.stringify({ text }) });
    return true;
  } catch (e) { console.log('[money-watch] notify failed:', e.message); return false; }
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = (sql, p = []) => c.query(sql, p).then(r => r.rows).catch(e => { console.log('[q]', e.message); return []; });
  const findings = [];   // {level:'red'|'warn', title, detail}

  // ── 1. Задвоенная выручка ────────────────────────────────
  const dupes = await q(`
    WITH x AS (
      SELECT a.id, a.master_id, a.starts_at, a.client_id, a.service_id,
             COALESCE(c.name, a.client_name,'?') AS client,
             (SELECT COALESCE(SUM(o.amount),0)::numeric FROM cash_operations o
               WHERE o.ref_type='appointment' AND o.ref_id=a.id AND o.type='in') AS paid
      FROM appointments a LEFT JOIN clients c ON c.id=a.client_id
      WHERE a.status NOT IN ('cancelled','noshow') AND a.client_id IS NOT NULL
        AND a.service_id IS NOT NULL AND ${ART}
        AND a.starts_at >= NOW() - INTERVAL '14 days'
    )
    SELECT client, to_char(starts_at ${KYIV},'DD.MM') AS day, COUNT(*)::int AS n,
           (SUM(paid) - MAX(paid))::numeric AS excess, array_agg(id ORDER BY id) AS ids
    FROM x GROUP BY client, service_id, master_id, starts_at, day
    HAVING COUNT(*) > 1 AND (SUM(paid) - MAX(paid)) > 0
    ORDER BY excess DESC`);
  if (dupes.length) {
    const total = dupes.reduce((s, d) => s + Number(d.excess), 0);
    findings.push({
      level: 'red', title: `Задвоєна виручка: ${dupes.length} випадк(ів) на ${money(total)}`,
      detail: dupes.slice(0, 5).map(d => `• ${d.day} · ${d.client} · зайве ${money(d.excess)} (записи ${d.ids.join(', ')})`).join('\n'),
    });
  }

  // ── 2. Оплаты-призраки ───────────────────────────────────
  const ghosts = await q(`
    SELECT 'на видалених записах' AS kind, COUNT(*)::int n, COALESCE(SUM(o.amount),0)::numeric s
      FROM cash_operations o JOIN appointments a ON a.id=o.ref_id AND o.ref_type='appointment'
     WHERE o.type='in' AND o.created_at >= NOW() - INTERVAL '30 days'
       AND COALESCE(a.bp_state,'') IN ('bp_deleted','not_in_bukon','phantom_dup')
    UNION ALL
    SELECT 'на скасованих візитах', COUNT(*)::int, COALESCE(SUM(o.amount),0)::numeric
      FROM cash_operations o JOIN appointments a ON a.id=o.ref_id AND o.ref_type='appointment'
     WHERE o.type='in' AND o.created_at >= NOW() - INTERVAL '30 days'
       AND a.status IN ('cancelled','noshow')
    UNION ALL
    SELECT 'без візиту взагалі', COUNT(*)::int, COALESCE(SUM(o.amount),0)::numeric
      FROM cash_operations o
     WHERE o.type='in' AND o.ref_type='appointment' AND o.created_at >= NOW() - INTERVAL '30 days'
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id=o.ref_id)`);
  // Розділяємо два різні випадки (перевірено на живих даних 28.07):
  //  • «на видалених записах», де візит ВИКОНАНО і гроші отримані — це не крадіжка каси,
  //    а конфлікт міток: BeautyPro видалив запис після перенесення. Гроші законні, але
  //    такий візит випадає зі статистики → жовтий сигнал, рішення за власником.
  //  • оплата на СКАСОВАНОМУ візиті або взагалі без візиту — це червоне, гроші висять у повітрі.
  const ghostMarks = await q(`
    SELECT COUNT(*)::int n, COALESCE(SUM(o.amount),0)::numeric s
      FROM cash_operations o JOIN appointments a ON a.id=o.ref_id AND o.ref_type='appointment'
     WHERE o.type='in' AND o.created_at >= NOW() - INTERVAL '30 days'
       AND COALESCE(a.bp_state,'') IN ('bp_deleted','not_in_bukon','phantom_dup')
       AND a.status IN ('done','completed')`);
  const hardGhosts = ghosts.filter(g => g.n > 0 && g.kind !== 'на видалених записах');
  if (hardGhosts.length) {
    findings.push({
      level: 'red', title: 'Гроші висять на неіснуючих візитах',
      detail: hardGhosts.map(g => `• ${g.kind}: ${g.n} операц. на ${money(g.s)}`).join('\n'),
    });
  }
  if (ghostMarks[0] && ghostMarks[0].n > 0) {
    findings.push({
      level: 'warn', title: `${ghostMarks[0].n} оплачених візитів позначені як видалені`,
      detail: `На ${money(ghostMarks[0].s)}. Гроші отримані й у касі залишаються — але ці візити не потрапляють у статистику майстрів і клієнтів. Причина: запис видалили у старій програмі вже після перенесення.`,
    });
  }

  // ── 3. Сходимость витрин кассы за вчера ──────────────────
  const rec = await q(`
    SELECT COALESCE(SUM(amount) FILTER (WHERE category IN ('sale_service','sale_product')),0)::numeric AS sales,
           COALESCE(SUM(amount),0)::numeric AS all_in
      FROM cash_operations
     WHERE type='in' AND (created_at ${KYIV})::date = (NOW() ${KYIV})::date - 1`);
  const r0 = rec[0] || {};
  if (Number(r0.all_in) - Number(r0.sales) !== 0) {
    findings.push({
      level: 'warn', title: 'Вчора були надходження поза продажами',
      detail: `Продажі ${money(r0.sales)}, усього прихід ${money(r0.all_in)} — різниця ${money(Number(r0.all_in) - Number(r0.sales))} (інші категорії).`,
    });
  }

  // ── 4. Аномалия вчерашнего дня (z-оценка внутри своего дня недели) ──
  const anom = await q(`
    WITH d AS (
      SELECT (created_at ${KYIV})::date AS day,
             EXTRACT(DOW FROM created_at ${KYIV})::int AS dow,
             SUM(amount)::numeric AS v
        FROM cash_operations
       WHERE type='in' AND category IN ('sale_service','sale_product')
         AND created_at >= NOW() - INTERVAL '90 days'
       GROUP BY 1,2
    ), stat AS (
      SELECT dow, AVG(v) AS avg_v, NULLIF(STDDEV_SAMP(v),0) AS sd_v, COUNT(*)::int AS n
        FROM d GROUP BY dow
    )
    SELECT d.day, d.v, s.avg_v, s.sd_v, s.n,
           ROUND(((d.v - s.avg_v) / s.sd_v)::numeric, 2) AS z
      FROM d JOIN stat s ON s.dow = d.dow
     WHERE d.day = (NOW() ${KYIV})::date - 1 AND s.n >= 5 AND s.sd_v IS NOT NULL`);
  if (anom.length && Math.abs(Number(anom[0].z)) >= 2) {
    const a = anom[0];
    const up = Number(a.z) > 0;
    // Алерт без причини = марний алерт. Одразу показуємо, ЩО саме дало відхилення:
    // розбивку послуги/товар і найбільші операції дня — щоб не питати «а чому?».
    const split = await q(`
      SELECT category, COUNT(*)::int n, SUM(amount)::numeric s
        FROM cash_operations
       WHERE type='in' AND category IN ('sale_service','sale_product')
         AND (created_at ${KYIV})::date = (NOW() ${KYIV})::date - 1
       GROUP BY 1 ORDER BY 3 DESC`);
    const NAMES = { sale_service: 'послуги', sale_product: 'товар/матеріали' };
    const top = await q(`
      SELECT amount::numeric, COALESCE(description,'') AS d
        FROM cash_operations
       WHERE type='in' AND category IN ('sale_service','sale_product')
         AND (created_at ${KYIV})::date = (NOW() ${KYIV})::date - 1
       ORDER BY amount DESC LIMIT 3`);
    const lines = [`Вчора ${money(a.v)}, зазвичай у цей день тижня ${money(a.avg_v)}.`];
    if (split.length) lines.push('Склад: ' + split.map(s => `${NAMES[s.category] || s.category} ${money(s.s)} (${s.n})`).join(' · '));
    if (top.length) lines.push('Найбільші: ' + top.map(t => `${money(t.amount)} — ${t.d.slice(0, 40)}`).join('; '));
    lines.push(up
      ? 'Зростання зазвичай дає один дорогий візит або роздрібний продаж — перевірте, чи немає задвоєння серед найбільших.'
      : 'Падіння — перевірте, чи всі оплати проведені.');
    findings.push({
      level: 'warn',
      title: up ? 'Вчора виручка помітно вища за звичайну' : 'Вчора виручка помітно нижча за звичайну',
      detail: lines.join('\n'),
    });
  }

  // ── 5. Вчерашние визиты без оплаты ───────────────────────
  const unpaid = await q(`
    SELECT COUNT(*)::int n, COALESCE(SUM(COALESCE(a.real_amount, a.price)),0)::numeric s
      FROM appointments a
     WHERE a.status IN ('done','completed') AND ${ART}
       AND (a.starts_at ${KYIV})::date = (NOW() ${KYIV})::date - 1
       AND a.pay_settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM cash_operations o
                        WHERE o.ref_type='appointment' AND o.ref_id=a.id AND o.type='in')`);
  if (unpaid[0] && unpaid[0].n > 0) {
    findings.push({
      level: 'warn', title: `Вчора ${unpaid[0].n} візит(ів) без проведеної оплати`,
      detail: `На суму приблизно ${money(unpaid[0].s)} — послуга виконана, гроші в касі не проведені.`,
    });
  }

  // ── 6. Здоровье защиты от дублей ─────────────────────────
  const guard = await q(`SELECT indexname FROM pg_indexes
     WHERE tablename='appointments' AND indexname LIKE 'uq_appt_no_exact_dup%'`);
  if (!guard.length) {
    findings.push({
      level: 'red', title: 'Захист від записів-близнюків ВІДКЛЮЧЕНО',
      detail: 'Унікальний індекс відсутній — подвійний клік знову може задвоїти касу. Потрібна міграція 286.',
    });
  }

  await c.end();

  // ── Отчёт ────────────────────────────────────────────────
  const stamp = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
  if (!findings.length) {
    console.log(`[money-watch] ${stamp} — чисто, повідомлення не надсилаю`);
    return;
  }
  const red = findings.filter(f => f.level === 'red');
  const head = red.length
    ? `🔴 <b>Фінансовий сторож: знайдено ${red.length} проблем(и)</b>`
    : `🟡 <b>Фінансовий сторож: варто перевірити</b>`;
  const body = findings.map(f => `${f.level === 'red' ? '🔴' : '🟡'} <b>${f.title}</b>\n${f.detail}`).join('\n\n');
  const msg = `${head}\n\n${body}\n\n<i>Перевірка кожної ночі. Тиша = все чисто.</i>`;
  console.log(`[money-watch] ${stamp} — знайдено ${findings.length}, надсилаю`);
  notify(msg);
})().catch(e => { console.error('[money-watch] FATAL', e.message); process.exit(1); });
