/* ═══════════════════════════════════════════════════════
   COM-01 — NOTIFICATION HUB (центр уведомлений)

   Единый шлюз отправки всех уведомлений. Любой модуль вызывает
   hub.enqueue(...) вместо прямого обращения к каналу. Hub решает:
   что, куда, когда и с каким приоритетом отправить.

   Возможности:
   - очередь с приоритетами (1=critical … 4=low) + TTL
   - шаблонизатор с переменными {{x}} и условиями {{#if x}}…{{/if}}
   - мультиязычность (uk/ru/en) с авто-выбором по предпочтениям клиента
   - маршрутизатор каналов + fallback-цепочки (telegram→sms→email)
   - rate-limit: cooldown между сообщениями, дневной лимит маркетинга
   - DND (тихие часы), уважение отписок (opt-out)
   - retry с экспоненциальным backoff (1м→5м→30м)
   - дедупликация (dedup_key)
   - полный трекинг: queued→sending→sent→delivered→read|failed
   ═══════════════════════════════════════════════════════ */
const { getPool } = require('../db-pg');
const { tgSend } = require('../routes/telegram-notify');

const DEFAULT_TENANT = '00000000-0000-0000-0000-000000000000';
const PRIORITY = { critical: 1, high: 2, normal: 3, low: 4 };
const BACKOFF_MIN = [1, 5, 30]; // минуты между попытками

// ── Шаблонизатор ───────────────────────────────────────────────────
// Поддержка {{var}}, {{obj.path}} и {{#if var}}...{{/if}} (включая {{else}}).
function renderTemplate(tpl, vars = {}) {
  if (!tpl) return '';
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
  // условные блоки (нерекурсивно, одного уровня достаточно для шаблонов салона)
  let out = tpl.replace(
    /\{\{#if\s+([\w.]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_, cond, ifBlk, elseBlk) => {
      const v = get(cond);
      const truthy = Array.isArray(v) ? v.length > 0 : !!v;
      return truthy ? ifBlk : (elseBlk || '');
    }
  );
  // подстановка переменных
  out = out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = get(path);
    return v == null ? '' : String(v);
  });
  // экранированные переводы строк из БД
  return out.replace(/\\n/g, '\n');
}

// Загрузка шаблона с приоритетом: точный канал+язык → any-канал → uk-фолбэк
async function loadTemplate(pool, key, { channel = 'any', lang = 'uk' } = {}) {
  const r = await pool.query(
    `SELECT subject, body, category, channel, lang FROM notification_templates
     WHERE key = $1 AND active = TRUE
       AND channel IN ($2, 'any') AND lang IN ($3, 'uk')
     ORDER BY (channel = $2) DESC, (lang = $3) DESC LIMIT 1`,
    [key, channel, lang]
  );
  return r.rows[0] || null;
}

// ── Маршрутизация: какой адрес у клиента для канала ─────────────────
function recipientFor(channel, client) {
  if (!client) return null;
  switch (channel) {
    case 'telegram': return client.telegram_id ? String(client.telegram_id) : null;
    case 'sms':      return client.phone || null;
    case 'email':    return client.email || null;
    default:         return null;
  }
}

// Строит цепочку каналов: явная > предпочтения клиента > салонная по умолчанию,
// оставляя только те каналы, для которых у клиента есть адрес.
function buildChain({ explicitChannel, prefs, settings, client }) {
  let chain;
  if (explicitChannel) chain = [explicitChannel];
  else if (prefs?.channel_priority?.length) chain = prefs.channel_priority;
  else chain = settings?.default_chain?.length ? settings.default_chain : ['telegram', 'sms', 'email'];
  const live = channelStatus();
  // только каналы, для которых есть адрес у клиента И провайдер настроен
  return chain.filter((ch) => recipientFor(ch, client) && live[ch] !== false);
}

// ── Каналы доставки (адаптеры) ──────────────────────────────────────
// COM-02 SMS / COM-03 Email подключатся сюда же.
const smsTwilio = require('./channels/sms-twilio');
const smsTurbo = require('./channels/sms-turbosms');
const emailChannel = require('./channels/email-resend');

// Вибір SMS-провайдера: укр. TurboSMS пріоритетний (альфа-ім'я, дешевше,
// доставка на укр. номери), Twilio — запасний. Перемикання — лише через env.
function smsProvider() {
  if (smsTurbo.isConfigured()) return smsTurbo;
  if (smsTwilio.isConfigured()) return smsTwilio;
  return null;
}
function smsConfigured() { return !!smsProvider(); }

const channels = {
  telegram: async (to, { body }) => {
    const res = await tgSend(to, body);
    return { providerId: res?.message_id ? String(res.message_id) : null };
  },
  sms: (to, msg) => {
    const p = smsProvider();
    if (!p) throw new Error('channel-sms-not-configured');
    return p.send(to, msg);
  },
  email: (to, msg) => emailChannel.send(to, msg),
};
function registerChannel(name, fn) { channels[name] = fn; }

// Какие каналы реально настроены (для UI/health и оптимизации цепочек)
function channelStatus() {
  return { telegram: true, sms: smsConfigured(), email: emailChannel.isConfigured() };
}

async function getSettings(pool) {
  // Настройки ТЕКУЩЕГО салона (RLS скоупит по контексту). Раньше всегда читались из
  // DEFAULT_TENANT — салон-арендатор жил по чужим лимитам/тихим часам (аудит-контроль).
  const r = await pool.query(`SELECT * FROM notification_settings WHERE tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::uuid, tenant_id) LIMIT 1`);
  return r.rows[0] || { paused: false, daily_limit_client: 5, cooldown_minutes: 5, dnd_start: 22, dnd_end: 9, default_chain: ['telegram', 'sms', 'email'] };
}

// Текущий час в Киеве
function kyivHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('uk-UA', { hour: 'numeric', hour12: false, timeZone: 'Europe/Kyiv' }).format(d));
}
function inDnd(hour, start, end) {
  if (start == null || end == null) return false;
  return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/* ── Постановка в очередь ───────────────────────────────────────────
   opts: {
     clientId, recipient?, channel?, fallbackChain?,
     templateKey? + vars?  |  body? (+subject?),
     category?, priority? ('critical'|...|number), scheduledAt?, ttlMinutes?,
     dedupKey?, source?, createdBy?, lang?
   }
   Возвращает { id, status } либо { skipped, reason }.                */
async function enqueue(opts = {}) {
  const pool = getPool();
  const settings = await getSettings(pool);

  // данные клиента + предпочтения
  let client = null, prefs = null;
  if (opts.clientId) {
    const c = await pool.query(`SELECT id, name, phone, email, telegram_id FROM clients WHERE id = $1`, [opts.clientId]);
    client = c.rows[0] || null;
    const p = await pool.query(`SELECT * FROM notification_prefs WHERE client_id = $1`, [opts.clientId]);
    prefs = p.rows[0] || null;
  }

  const category = opts.category || 'transactional';
  const priority = typeof opts.priority === 'number' ? opts.priority : (PRIORITY[opts.priority] || PRIORITY.normal);
  const isCritical = priority === PRIORITY.critical;

  // отписка (opt-out) — critical всегда проходит
  if (!isCritical && prefs) {
    if (prefs.unsubscribed_at) return { skipped: true, reason: 'unsubscribed' };
    if (category === 'marketing' && prefs.marketing_opt_in === false) return { skipped: true, reason: 'marketing-opt-out' };
    if (category === 'transactional' && prefs.transactional_opt_in === false) return { skipped: true, reason: 'transactional-opt-out' };
  }

  // цепочка каналов. Явный recipient+channel (без clientId) — отправляем напрямую,
  // не фильтруя по адресам клиента (адресов в карточке может не быть).
  let chain, recipient, channel;
  if (opts.recipient && opts.channel) {
    chain = opts.fallbackChain || [opts.channel];
    channel = opts.channel;
    recipient = opts.recipient;
  } else {
    chain = opts.fallbackChain || buildChain({ explicitChannel: opts.channel, prefs, settings, client });
    if (!chain.length) return { skipped: true, reason: 'no-reachable-channel' };
    channel = chain[0];
    recipient = opts.recipient || recipientFor(channel, client);
  }
  if (!chain.length || !recipient) return { skipped: true, reason: 'no-reachable-channel' };

  // рендер тела
  let body = opts.body, subject = opts.subject || null;
  if (opts.templateKey) {
    const lang = opts.lang || 'uk';
    const tpl = await loadTemplate(pool, opts.templateKey, { channel, lang });
    if (!tpl) return { skipped: true, reason: 'template-not-found:' + opts.templateKey };
    body = renderTemplate(tpl.body, opts.vars || {});
    subject = tpl.subject ? renderTemplate(tpl.subject, opts.vars || {}) : null;
  }
  if (!body) return { skipped: true, reason: 'empty-body' };

  // DND для не-critical: откладываем до конца тихих часов (не отбрасываем)
  let scheduledAt = opts.scheduledAt ? new Date(opts.scheduledAt) : new Date();
  if (!isCritical) {
    const ds = prefs?.dnd_start ?? settings.dnd_start;
    const de = prefs?.dnd_end ?? settings.dnd_end;
    const h = kyivHour(scheduledAt);
    if (inDnd(h, ds, de)) {
      const d = new Date(scheduledAt);
      // сдвиг на ближайший dnd_end
      let add = (de - h + 24) % 24; if (add === 0) add = 24;
      d.setHours(d.getHours() + add, 0, 0, 0);
      scheduledAt = d;
    }
  }

  const ttlAt = opts.ttlMinutes ? new Date(Date.now() + opts.ttlMinutes * 60000) : null;

  try {
    // Аудит-контроль: НЕ передаём tenant_id — колонка имеет DEFAULT current_tenant_id()
    // и RLS. В HTTP-контексте салона подставится ЕГО tenant, в кроне (forEachTenant) —
    // тоже правильный. Раньше хардкод DEFAULT_TENANT сваливал уведомления всех салонов
    // в дефолтный тенант (утечка данных между арендаторами).
    const r = await pool.query(
      `INSERT INTO notifications
         (client_id, template_key, category, priority, channel, fallback_chain,
          recipient, subject, body, payload, dedup_key, status, scheduled_at, ttl_at,
          max_attempts, next_attempt_at, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$14,$12,$15,$16)
       ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [opts.clientId || null, opts.templateKey || null, category, priority,
       channel, chain, recipient, subject, body, JSON.stringify(opts.vars || opts.payload || {}),
       opts.dedupKey || null, scheduledAt, ttlAt, opts.maxAttempts || 3, opts.source || null, opts.createdBy || null]
    );
    if (!r.rowCount) return { skipped: true, reason: 'duplicate' };
    return { id: Number(r.rows[0].id), status: 'queued' };
  } catch (e) {
    return { skipped: true, reason: 'enqueue-error', error: e.message };
  }
}

// ── Rate-limit проверки перед отправкой ─────────────────────────────
async function rateAllow(pool, n, settings) {
  if (n.priority === PRIORITY.critical || !n.client_id) return { ok: true };
  // cooldown: было ли отправлено что-то этому клиенту недавно
  if (settings.cooldown_minutes > 0) {
    const cd = await pool.query(
      `SELECT 1 FROM notifications
       WHERE client_id = $1 AND status IN ('sent','delivered','read')
         AND sent_at > NOW() - ($2 || ' minutes')::interval
         AND priority > 1 LIMIT 1`,
      [n.client_id, String(settings.cooldown_minutes)]
    );
    if (cd.rowCount) return { ok: false, reason: 'cooldown' };
  }
  // дневной лимит маркетинга
  if (n.category === 'marketing' && settings.daily_limit_client > 0) {
    const dl = await pool.query(
      `SELECT count(*)::int c FROM notifications
       WHERE client_id = $1 AND category = 'marketing'
         AND status IN ('sent','delivered','read')
         AND sent_at > NOW() - interval '24 hours'`,
      [n.client_id]
    );
    if (dl.rows[0].c >= settings.daily_limit_client) return { ok: false, reason: 'daily-limit' };
  }
  return { ok: true };
}

// Phase A (18.07): місячний ліміт SMS тарифу (max_sms_month) — раніше існував «на папері»
// (free=0, starter=500, professional=2000, enterprise=безліміт), а канал слав без ліку.
// Перевіряємо в контексті тенанта (RLS сама фільтрує notifications по tenant_id).
// Збій перевірки → fail-open: помилка БД не повинна класти нагадування клієнтам.
// tenant_id береться З САМОГО запису notification (НЕ з ALS): хвилинний воркер
// (routes/notifications.js workerTick) крутиться БЕЗ tenant-контексту — через ALS
// ліміт там мовчки перетворився б на безліміт. Явний WHERE працює в обох контекстах.
const SMS_LEGACY_SLUG = { solo: 'free', pro: 'professional' };
async function smsMonthlyAllow(pool, tenantId) {
  try {
    if (!tenantId) return { ok: true };
    // Індивідуальний override оператора має пріоритет (як у plan-limits.tenantLimit)
    const ov = await pool.query(
      `SELECT overrides->>'limit:max_sms_month' AS v FROM tenant_licenses WHERE tenant_id=$1 LIMIT 1`,
      [tenantId]);
    let limit = null, soft = false;
    const ovVal = ov.rows[0] && ov.rows[0].v;
    if (ovVal != null && ovVal !== '' && Number.isFinite(Number(ovVal))) limit = Number(ovVal);
    else {
      const r = await pool.query(
        `SELECT pl.limit_value, pl.is_soft FROM tenant_licenses tl
           JOIN saas_plans_v2 p ON p.slug = COALESCE($1::jsonb->>tl.plan_code, tl.plan_code)
           JOIN plan_limits pl ON pl.plan_id = p.id AND pl.limit_key = 'max_sms_month'
          WHERE tl.tenant_id = $2 ORDER BY tl.updated_at DESC NULLS LAST LIMIT 1`,
        [JSON.stringify(SMS_LEGACY_SLUG), tenantId]);
      if (!r.rows.length) return { ok: true }; // немає сіду ліміту → не блокуємо
      limit = Number(r.rows[0].limit_value); soft = !!r.rows[0].is_soft;
    }
    if (limit == null || limit < 0 || soft) return { ok: true };
    const c = await pool.query(
      `SELECT count(*)::int n FROM notifications
        WHERE tenant_id=$1 AND channel='sms' AND status IN ('sent','delivered','read')
          AND sent_at >= date_trunc('month', NOW())`, [tenantId]);
    const used = Number(c.rows[0] && c.rows[0].n) || 0;
    if (used >= limit) return { ok: false, used, limit };
    return { ok: true };
  } catch (e) { return { ok: true }; }
}

// Переход на следующий канал в цепочке (fallback)
function nextChannel(n) {
  const chain = n.fallback_chain || [];
  const idx = chain.indexOf(n.channel);
  return idx >= 0 && idx < chain.length - 1 ? chain[idx + 1] : null;
}

/* ── Воркер очереди ─────────────────────────────────────────────────
   Берёт готовые к отправке по приоритету, отправляет, ведёт retry/fallback. */
async function processQueue(limit = 30) {
  const pool = getPool();
  const settings = await getSettings(pool);
  if (settings.paused) return { paused: true, sent: 0 };

  // просроченные по TTL — отменяем
  await pool.query(
    `UPDATE notifications SET status='cancelled', last_error='ttl-expired', updated_at=NOW()
     WHERE status='queued' AND ttl_at IS NOT NULL AND ttl_at < NOW()`
  );

  const due = await pool.query(
    `SELECT * FROM notifications
     WHERE status='queued' AND next_attempt_at <= NOW()
       AND (ttl_at IS NULL OR ttl_at > NOW())
     ORDER BY priority ASC, next_attempt_at ASC
     LIMIT $1`,
    [limit]
  );

  let sent = 0, failed = 0, skipped = 0;
  for (const n of due.rows) {
    const gate = await rateAllow(pool, n, settings);
    if (!gate.ok) {
      // переносим на 30 минут, не сжигаем попытку
      await pool.query(
        `UPDATE notifications SET next_attempt_at = NOW() + interval '30 minutes',
           last_error=$2, updated_at=NOW() WHERE id=$1`, [n.id, 'rate:' + gate.reason]);
      skipped++; continue;
    }
    // SMS понад місячний ліміт тарифу → одразу наступний канал ланцюжка (email),
    // без каналу — cancelled з явною причиною (щоб було видно в журналі, а не тиша).
    if (n.channel === 'sms') {
      const sg = await smsMonthlyAllow(pool, n.tenant_id);
      if (!sg.ok) {
        const fb = nextChannel(n);
        const c2 = n.client_id ? (await pool.query(`SELECT phone,email,telegram_id FROM clients WHERE id=$1`, [n.client_id])).rows[0] : null;
        const addr = fb ? recipientFor(fb, c2) : null;
        if (fb && addr) {
          await pool.query(
            `UPDATE notifications SET channel=$2, recipient=$3, status='queued',
               last_error=$4, next_attempt_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [n.id, fb, addr, `sms-plan-limit:${sg.used}/${sg.limit}`]);
        } else {
          await pool.query(
            `UPDATE notifications SET status='cancelled', last_error=$2, updated_at=NOW() WHERE id=$1`,
            [n.id, `sms-plan-limit:${sg.used}/${sg.limit}`]);
        }
        skipped++; continue;
      }
    }
    await pool.query(`UPDATE notifications SET status='sending', updated_at=NOW() WHERE id=$1`, [n.id]);
    const adapter = channels[n.channel];
    try {
      if (!adapter) throw new Error('no-adapter:' + n.channel);
      const out = await adapter(n.recipient, { body: n.body, subject: n.subject });
      await pool.query(
        `UPDATE notifications SET status='sent', sent_at=NOW(), provider_msg_id=$2,
           attempts=attempts+1, last_error=NULL, updated_at=NOW() WHERE id=$1`,
        [n.id, out?.providerId || null]
      );
      sent++;
    } catch (e) {
      const attempts = n.attempts + 1;
      const fb = nextChannel(n);
      if (fb) {
        // откат на следующий канал — новый адрес, попытки с нуля для канала
        const c = n.client_id ? (await pool.query(`SELECT phone,email,telegram_id FROM clients WHERE id=$1`, [n.client_id])).rows[0] : null;
        const addr = recipientFor(fb, c);
        if (addr) {
          await pool.query(
            `UPDATE notifications SET channel=$2, recipient=$3, status='queued',
               next_attempt_at=NOW(), last_error=$4, updated_at=NOW() WHERE id=$1`,
            [n.id, fb, addr, `fallback from ${n.channel}: ${e.message}`]);
          failed++; continue;
        }
      }
      if (attempts >= n.max_attempts) {
        await pool.query(
          `UPDATE notifications SET status='failed', failed_at=NOW(), attempts=$2,
             last_error=$3, updated_at=NOW() WHERE id=$1`, [n.id, attempts, e.message]);
      } else {
        const backoff = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
        await pool.query(
          `UPDATE notifications SET status='queued', attempts=$2,
             next_attempt_at = NOW() + ($3 || ' minutes')::interval,
             last_error=$4, updated_at=NOW() WHERE id=$1`, [n.id, attempts, String(backoff), e.message]);
      }
      failed++;
    }
  }
  return { sent, failed, skipped, picked: due.rowCount };
}

module.exports = {
  enqueue, processQueue, renderTemplate, registerChannel, channelStatus,
  recipientFor, getSettings, PRIORITY, DEFAULT_TENANT,
};
