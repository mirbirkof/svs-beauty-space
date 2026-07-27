// Ежедневный сторож зарплатных цифр (Jarvis, 16.07.2026).
// Сверяет выручку услуг за ТЕКУЩИЙ месяц двумя независимыми путями:
//   1) appointments (то, что берёт /payroll/calculate — полный чек услуг)
//   2) cash_operations sale_service, привязанные к записи (ref_type<>'bp_sale')
// Архивные продажи BeautyPro (ref_type='bp_sale', без appointment) вынесены отдельно
// и в расхождение НЕ входят — их не исправить, это импорт закрытой системы (20.07).
// Расхождение >1 грн по любому мастеру → алерт Боссу с направлением (визит без кассы /
// касса без визита) и справкой по архиву. Всё ровно → строка в лог и молчит.
const { Client } = require(require('path').join(__dirname, '..', 'backend', 'node_modules', 'pg'));
const { execSync } = require('child_process');

const EPS = 1.0; // грн

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // Окно: с 1-го числа по ВЧЕРА включительно. Сегодняшний день не сверяем —
  // живые операции (оплата пробита, визит ещё не закрыт) дают ложные расхождения
  // (проверено 16.07: закрытые дни сходятся в 0, «мимо» были только сегодняшние).
  // Даты формируем ЛОКАЛЬНО (сервер Europe/Kyiv): toISOString даёт UTC и
  // сдвигает границы на день назад (поймано 16.07 — окно съехало на 30.06–14.07).
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const p1 = new Date(); p1.setDate(1); p1.setHours(0, 0, 0, 0);
  const p2 = new Date(); p2.setHours(0, 0, 0, 0); // сегодня 00:00 = граница «по вчера»
  if (iso(p1) === iso(p2)) { console.log('[payroll-audit] 1-е число — закрытых дней ещё нет, пропуск'); return; }

  // 27.07: у цей же список додано 'migrate' — історія, перенесена майстром міграції при
  // переїзді салону. Її каса лишилась у старій системі, у нашій CRM її НІКОЛИ не буде →
  // без виключення кожен новий SaaS-клієнт отримував би вічний алерт з першого дня.
  // Тільки НАШІ (операційні) візити: імпортовані з Букона (source beautypro/bukon_import) мають
  // касу в старій системі, а не в нашій CRM — їх сверка з нашою касою дає ФАЛЬШИВЕ розходження
  // (Босс 20.07: після доімпорту ~48к «розбіжностей» — усі це імпорт без каси, лише 1 реальний).
  // Симетрично з касою: нижче беремо s_attached (без bp_sale-архіву). Той самий клас, що «Забули провести».
  const appts = await c.query(
    `SELECT master_id, SUM(COALESCE(real_amount,price,0))::numeric s
       FROM appointments WHERE starts_at>=$1 AND starts_at<$2
        AND (status IN ('done','completed') OR (status='confirmed' AND real_synced_at IS NOT NULL))
        AND (source NOT IN ('beautypro','bukon_import','migrate') OR source IS NULL)
      GROUP BY master_id`, [iso(p1), iso(p2)]);
  // Кассу делим на два потока:
  //   s_attached — оплаты, привязанные к записи (ref_type<>'bp_sale'); их и сверяем с визитами
  //   s_legacy   — архивные продажи из старой BeautyPro (ref_type='bp_sale', без appointment).
  // Легаси не исправить (это импорт закрытой системы), поэтому в расхождение НЕ включаем,
  // а показываем справочно — иначе сторож орал бы каждый день на неисправимый хвост (20.07).
  // Симетрично з візитами: касу, привʼязану до ІМПОРТНИХ візитів (beautypro/bukon_import), теж
  // виключаємо з s_attached — інакше зʼявляється зворотній перекіс «каса є, візиту немає»
  // (Босс 20.07). Каса без привʼязки до візиту (пряма продажа, a.source IS NULL) — лишається.
  const cash = await c.query(
    `SELECT co.master_id,
            COALESCE(SUM(co.amount) FILTER (WHERE co.ref_type IS DISTINCT FROM 'bp_sale'
                       AND (a.source IS NULL OR a.source NOT IN ('beautypro','bukon_import'))),0)::numeric s_attached,
            COALESCE(SUM(co.amount) FILTER (WHERE co.ref_type = 'bp_sale'),0)::numeric s_legacy
       FROM cash_operations co
       LEFT JOIN appointments a ON co.ref_type='appointment' AND a.id=co.ref_id
      WHERE co.type='in' AND co.category='sale_service'
        AND co.created_at>=$1 AND co.created_at<$2 GROUP BY co.master_id`, [iso(p1), iso(p2)]);
  const names = {};
  (await c.query('SELECT id,name FROM masters')).rows.forEach(r => names[r.id] = r.name);
  await c.end();

  const cm = {}; cash.rows.forEach(r => cm[r.master_id] = +r.s_attached);
  const lg = {}; cash.rows.forEach(r => lg[r.master_id] = +r.s_legacy);
  const am = {}; appts.rows.forEach(r => am[r.master_id] = +r.s);
  const ids = [...new Set([...Object.keys(cm), ...Object.keys(am)])];

  const bad = [];
  for (const id of ids) {
    const a = am[id] || 0, k = cm[id] || 0, leg = lg[id] || 0;
    if (Math.abs(a - k) > EPS) {
      const dir = a > k ? 'візит проведено, каса не пробита' : 'каса є, візиту немає';
      let line = `${names[id] || '#' + id}: візити=${a.toFixed(2)} каса=${k.toFixed(2)} (розбіжність ${(a - k).toFixed(2)}, ${dir})`;
      if (leg > EPS) line += ` [архів BeautyPro ${leg.toFixed(2)}грн — окремо, не помилка]`;
      bad.push(line);
    }
  }

  const stamp = new Date().toISOString().slice(0, 16);
  if (!bad.length) { console.log(`[payroll-audit ${stamp}] OK — ${ids.length} мастеров, визиты=касса копейка в копейку`); return; }

  console.log(`[payroll-audit ${stamp}] РАСХОЖДЕНИЕ:\n` + bad.join('\n'));
  const msg = `⚠ ЗП-сторож: выручка визиты≠касса за текущий месяц!\n${bad.join('\n')}\nПроверь кассу/визиты — % мастерам может посчитаться неверно.`;
  try {
    execSync(`curl -s -m 15 -X POST http://127.0.0.1:3005/notify -H "x-notify-token: ${process.env.RESTART_TOKEN || 'jarvis-restart-2026'}" -H "Content-Type: application/json" -d @-`, { input: JSON.stringify({ text: msg }) });
  } catch (e) { console.log('notify failed:', e.message); }
})().catch(e => { console.error('[payroll-audit] ERR', e.message); process.exit(1); });
