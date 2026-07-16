/* ═══════════════════════════════════════════════════════════════
   Нагадування про візити в Telegram (Етап 5 онлайн-запису).

   За 24 години і за 2 години до візиту — повідомлення з кнопками:
   [✅ Буду] [🔁 Перенести] [✖ Скасувати] (обробка у booking-bot, prefix bk:r:).

   Правила проти спаму:
   - запис створений < 25 год до візиту → 24-год нагадування не шлемо
   - запис створений < 3 год до візиту → 2-год нагадування не шлемо
   - дедуп у booking_reminders (PK appointment_id+kind) — навіть якщо
     tick працює у двох процесах, повідомлення піде одне
   - послідовні послуги одного візиту групуються в одне повідомлення
   ═══════════════════════════════════════════════════════════════ */
const KYIV = 'Europe/Kyiv';
const TICK_MS = 5 * 60 * 1000;

let _started = false, _tableReady = false;

async function ensureTable(pool) {
  if (_tableReady) return;
  // на проді app_tenant не має CREATE у public — таблицю створює міграція 201.
  // CREATE тут лише страховка для dev; якщо прав нема — перевіряємо, що таблиця вже є.
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS booking_reminders (
         appointment_id INTEGER NOT NULL,
         kind TEXT NOT NULL,
         sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (appointment_id, kind))`);
  } catch (e) {
    await pool.query(`SELECT 1 FROM booking_reminders LIMIT 1`); // немає таблиці/прав → кинеться далі
  }
  _tableReady = true;
}

async function tick(pool, tg) {
  await ensureTable(pool);
  const due = await pool.query(
    `SELECT a.id, c.telegram_id,
            to_char(a.starts_at AT TIME ZONE '${KYIV}', 'HH24:MI') AS t,
            (a.starts_at AT TIME ZONE '${KYIV}')::date::text AS d,
            a.starts_at, s.name AS service_name,
            COALESCE(NULLIF(m.online_title,''), m.name) AS master_name,
            k.kind
       FROM appointments a
       JOIN clients c ON c.id = a.client_id AND c.telegram_id IS NOT NULL
       LEFT JOIN services s ON s.id = a.service_id
       LEFT JOIN masters m ON m.id = a.master_id
      CROSS JOIN LATERAL (SELECT CASE
         WHEN a.starts_at BETWEEN NOW() + interval '20 hours' AND NOW() + interval '24 hours'
              AND a.created_at < a.starts_at - interval '25 hours' THEN '24h'
         WHEN a.starts_at BETWEEN NOW() + interval '70 minutes' AND NOW() + interval '2 hours'
              AND a.created_at < a.starts_at - interval '3 hours' THEN '2h'
         ELSE NULL END AS kind) k
      WHERE a.status IN ('booked','confirmed')
        AND k.kind IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM booking_reminders r
                         WHERE r.appointment_id = a.id AND r.kind = k.kind)
      ORDER BY c.telegram_id, a.starts_at`);
  // пост-візитні оцінки — незалежно від нагадувань (свій дедуп всередині)
  try { await ratingTick(pool, tg); } catch (e) { console.error('[reminders/rate]', e.message); }
  if (!due.rows.length) return;

  // групуємо: один клієнт + один день + один kind = одне повідомлення
  const groups = new Map();
  for (const r of due.rows) {
    const key = `${r.telegram_id}|${r.kind}|${r.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  for (const items of groups.values()) {
    const first = items[0];
    const ids = items.map(x => x.id);
    // claim ДО відправки: хто вставив — той і шле (захист від другого процесу)
    const claim = await pool.query(
      `INSERT INTO booking_reminders (appointment_id, kind)
       SELECT unnest($1::int[]), $2 ON CONFLICT DO NOTHING RETURNING appointment_id`,
      [ids, first.kind]);
    if (!claim.rows.length) continue;

    const svc = items.map(x => x.service_name).filter(Boolean).join(' + ') || 'візит';
    const master = first.master_name ? `, майстер ${first.master_name}` : '';
    const text = first.kind === '24h'
      ? `🔔 Нагадуємо: <b>завтра о ${first.t}</b> — ${svc}${master}.\nВсе в силі?`
      : `🔔 Вже <b>сьогодні о ${first.t}</b> чекаємо вас: ${svc}${master} 💛`;
    const idsKey = ids.join('.');
    try {
      await tg('sendMessage', {
        chat_id: Number(first.telegram_id), parse_mode: 'HTML', text,
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Буду', callback_data: `bk:r:ok:${idsKey}` }],
          [{ text: '🔁 Перенести', callback_data: `bk:r:mv:${idsKey}` },
           { text: '✖ Скасувати', callback_data: `bk:r:cn:${idsKey}` }],
        ] },
      });
    } catch (e) {
      console.error('[reminders/send]', e.message);
      // не дійшло — знімаємо claim, спробуємо наступним tick
      await pool.query(`DELETE FROM booking_reminders WHERE appointment_id = ANY($1::int[]) AND kind=$2`,
        [ids, first.kind]).catch(() => {});
    }
  }
}

// ── Пост-візитний запит оцінки (264, Босс 13.07): done-візити, що завершились
// 2..26 год тому, клієнт з Telegram → «оцініть майстра» ⭐1-5 (bk:rate у booking-bot).
// Той самий дедуп booking_reminders (kind='rate'); visit_ratings під RLS — tick
// вже виконується в контексті свого тенанта.
async function ratingTick(pool, tg) {
  const due = await pool.query(
    `SELECT a.id, c.telegram_id,
            COALESCE(NULLIF(m.online_title,''), m.name) AS master_name,
            (a.starts_at AT TIME ZONE '${KYIV}')::date::text AS d
       FROM appointments a
       JOIN clients c ON c.id = a.client_id AND c.telegram_id IS NOT NULL
       LEFT JOIN masters m ON m.id = a.master_id
      WHERE a.status = 'done'
        AND COALESCE(a.ends_at, a.starts_at) BETWEEN NOW() - interval '26 hours' AND NOW() - interval '2 hours'
        AND NOT EXISTS (SELECT 1 FROM booking_reminders r WHERE r.appointment_id = a.id AND r.kind = 'rate')
        AND NOT EXISTS (SELECT 1 FROM visit_ratings vr WHERE vr.appointment_id = a.id)
      ORDER BY c.telegram_id, a.starts_at`);
  if (!due.rows.length) return;
  const groups = new Map();
  for (const r of due.rows) {
    const key = `${r.telegram_id}|${r.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const items of groups.values()) {
    const first = items[0];
    const ids = items.map(x => x.id);
    const claim = await pool.query(
      `INSERT INTO booking_reminders (appointment_id, kind)
       SELECT unnest($1::int[]), 'rate' ON CONFLICT DO NOTHING RETURNING appointment_id`, [ids]);
    if (!claim.rows.length) continue;
    const idsKey = ids.join('.');
    const master = first.master_name ? `майстра <b>${first.master_name}</b>` : 'майстра';
    try {
      await tg('sendMessage', {
        chat_id: Number(first.telegram_id), parse_mode: 'HTML',
        text: `Дякуємо за візит! 💛\nОцініть, будь ласка, ${master} — це допомагає нам ставати кращими:`,
        reply_markup: { inline_keyboard: [
          [1, 2, 3, 4, 5].map(n => ({ text: `${n}⭐`, callback_data: `bk:rate:${idsKey}:${n}` })),
        ] },
      });
    } catch (e) {
      console.error('[reminders/rate-send]', e.message);
      await pool.query(`DELETE FROM booking_reminders WHERE appointment_id = ANY($1::int[]) AND kind='rate'`,
        [ids]).catch(() => {});
    }
  }
}

function start(getPool, tg, opts) {
  if (_started) return;
  _started = true;
  opts = opts || {};
  const run = async () => {
    const pool = getPool();
    // 1) салон платформи — бот з env (як і раніше). runAs обмежує RLS своїм тенантом.
    try {
      if (opts.runAs && opts.defaultTenantId) await opts.runAs(opts.defaultTenantId, () => tick(pool, tg));
      else await tick(pool, tg);
    } catch (e) { console.error('[reminders/tick]', e.message); }
    // 2) SAS: УСІ активні салони-орендарі (не лише з власним ботом!) — соло на СПІЛЬНОМУ
    //    боті теж має отримувати нагадування (раніше цикл йшов лише по connected-ботах,
    //    і Free/PRO-орендар без свого бота лишався без нагадувань — дірка 17.07).
    //    Бот: свій якщо підключений, інакше спільний (getBotForTenant вирішує).
    //    Гейт: авто-нагадування — платна фіча notify.auto (DIKIDI). Free → скіп (ручні).
    if (opts.runAs && opts.tgFor && opts.getBotForTenant) {
      try {
        const tens = (await pool.query(
          `SELECT id FROM tenants WHERE COALESCE(is_internal,false)=false AND COALESCE(status,'active')='active'`)).rows;
        for (const t of tens) {
          if (String(t.id) === String(opts.defaultTenantId)) continue;
          await opts.runAs(t.id, async () => {
            try {
              if (opts.featureAllowed) {
                const f = await opts.featureAllowed('notify.auto');
                if (f && f.ok === false) return; // Free-тариф: ручні нагадування
              }
              const bot = await opts.getBotForTenant(t.id);
              if (bot && bot.token) await tick(pool, opts.tgFor(bot.token));
            } catch (e) { console.error('[reminders/tenant]', t.id, e.message); }
          });
        }
      } catch (e) { console.error('[reminders/tenants]', e.message); }
    } else if (opts.listConnectedBots && opts.runAs && opts.tgFor) {
      // fallback: стара поведінка, якщо getBotForTenant не передали
      try {
        const bots = await opts.listConnectedBots(pool);
        for (const b of bots) {
          if (String(b.tenant_id) === String(opts.defaultTenantId)) continue;
          await opts.runAs(b.tenant_id, () => tick(pool, opts.tgFor(b.bot_token)))
            .catch((e) => console.error('[reminders/tenant]', b.tenant_id, e.message));
        }
      } catch (e) { console.error('[reminders/bots]', e.message); }
    }
  };
  setTimeout(run, 30 * 1000);        // перший прохід через 30с після старту
  setInterval(run, TICK_MS);
}

module.exports = { start, tick };
