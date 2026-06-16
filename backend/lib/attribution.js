/* lib/attribution.js — мультиканальна атрибуція (MKT-10).
   Моделі: first / last / linear / time_decay / position (40-20-40).
   Конверсії = appointments(status=done, price>0); цінність ділиться по точках дотику
   клієнта, що сталися ДО конверсії. Якщо точок немає — конверсія йде в канал 'direct'. */
const { getPool } = require('../db-pg');

const MODELS = ['first', 'last', 'linear', 'time_decay', 'position'];
const DECAY_HALFLIFE_DAYS = 7;

// Нормалізація каналу з utm/referrer.
function normalizeChannel({ channel, utm_source, utm_medium, referrer }) {
  if (channel) return channel.toLowerCase();
  const s = (utm_source || '').toLowerCase();
  if (s) {
    if (/google/.test(s)) return /cpc|ppc|paid|ads/.test((utm_medium || '').toLowerCase()) ? 'google_ads' : 'google';
    if (/facebook|meta|fb/.test(s)) return 'meta';
    if (/instagram|ig/.test(s)) return 'instagram';
    if (/tiktok/.test(s)) return 'tiktok';
    return s;
  }
  if (referrer) {
    try { const h = new URL(referrer).hostname.replace(/^www\./, ''); if (h) return h; } catch { /* ignore */ }
  }
  return 'direct';
}

// Записати точку дотику.
async function track(opts = {}) {
  const pool = getPool();
  const channel = normalizeChannel(opts);
  const r = await pool.query(
    `INSERT INTO marketing_touchpoints
       (client_id, anon_id, occurred_at, channel, utm_source, utm_medium, utm_campaign,
        utm_term, utm_content, gclid, fbclid, referrer, landing_path)
     VALUES ($1,$2,COALESCE($3,NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, channel, occurred_at`,
    [opts.client_id || null, opts.anon_id || null, opts.occurred_at || null, channel,
     opts.utm_source || null, opts.utm_medium || null, opts.utm_campaign || null,
     opts.utm_term || null, opts.utm_content || null, opts.gclid || null, opts.fbclid || null,
     opts.referrer || null, opts.landing_path || null]);
  return r.rows[0];
}

// Прив'язати анонімні точки до клієнта (виклик при ідентифікації/реєстрації).
async function linkAnon(anonId, clientId) {
  if (!anonId || !clientId) return 0;
  const pool = getPool();
  const r = await pool.query(
    `UPDATE marketing_touchpoints SET client_id=$1 WHERE anon_id=$2 AND client_id IS NULL`,
    [clientId, anonId]);
  return r.rowCount;
}

// Ваги точок дотику для конкретної моделі. tps відсортовані за часом ASC.
function weights(model, tps, conversionAt) {
  const n = tps.length;
  if (n === 0) return [];
  if (model === 'first') return tps.map((_, i) => (i === 0 ? 1 : 0));
  if (model === 'last') return tps.map((_, i) => (i === n - 1 ? 1 : 0));
  if (model === 'linear') return tps.map(() => 1 / n);
  if (model === 'position') {
    if (n === 1) return [1];
    if (n === 2) return [0.5, 0.5];
    const w = tps.map(() => 0.2 / (n - 2));
    w[0] = 0.4; w[n - 1] = 0.4;
    return w;
  }
  if (model === 'time_decay') {
    const conv = new Date(conversionAt).getTime();
    const raw = tps.map(t => {
      const days = (conv - new Date(t.occurred_at).getTime()) / 86400000;
      return Math.pow(2, -Math.max(0, days) / DECAY_HALFLIFE_DAYS);
    });
    const sum = raw.reduce((a, b) => a + b, 0) || 1;
    return raw.map(x => x / sum);
  }
  return tps.map(() => 1 / n);
}

const keyOf = tp => tp.channel || 'direct';
const campKeyOf = tp => `${tp.channel || 'direct'} | ${tp.utm_campaign || '(no campaign)'}`;

// Порахувати атрибуцію за період. Повертає розподіл доходу по каналах для кожної моделі.
async function compute({ from, to } = {}) {
  const pool = getPool();
  const fromTs = from || '1970-01-01';
  const toTs = to || '2999-01-01';

  // Конверсії з клієнтом
  const conv = (await pool.query(
    `SELECT a.id, a.client_id, a.starts_at AS conv_at, COALESCE(a.price,0)::float AS value
       FROM appointments a
      WHERE a.status='done' AND COALESCE(a.price,0) > 0
        AND a.client_id IS NOT NULL
        AND a.starts_at >= $1 AND a.starts_at < $2`, [fromTs, toTs])).rows;

  // Усі точки дотику клієнтів, що конвертували
  const clientIds = [...new Set(conv.map(c => c.client_id))];
  let tpByClient = new Map();
  if (clientIds.length) {
    const tps = (await pool.query(
      `SELECT client_id, occurred_at, channel, utm_campaign
         FROM marketing_touchpoints
        WHERE client_id = ANY($1::int[])
        ORDER BY client_id, occurred_at ASC`, [clientIds])).rows;
    for (const t of tps) {
      if (!tpByClient.has(t.client_id)) tpByClient.set(t.client_id, []);
      tpByClient.get(t.client_id).push(t);
    }
  }

  const models = {};
  for (const m of MODELS) models[m] = { byChannel: {}, byCampaign: {} };
  let totalRevenue = 0, convWithTp = 0, convDirect = 0;

  for (const c of conv) {
    totalRevenue += c.value;
    let tps = (tpByClient.get(c.client_id) || []).filter(t => new Date(t.occurred_at) <= new Date(c.conv_at));
    if (tps.length === 0) {
      // немає відомих дотиків → пряма/невідома
      convDirect++;
      for (const m of MODELS) {
        models[m].byChannel['direct'] = (models[m].byChannel['direct'] || 0) + c.value;
        models[m].byCampaign['direct | (no campaign)'] = (models[m].byCampaign['direct | (no campaign)'] || 0) + c.value;
      }
      continue;
    }
    convWithTp++;
    for (const m of MODELS) {
      const w = weights(m, tps, c.conv_at);
      tps.forEach((t, i) => {
        const v = c.value * w[i];
        const ch = keyOf(t), ck = campKeyOf(t);
        models[m].byChannel[ch] = (models[m].byChannel[ch] || 0) + v;
        models[m].byCampaign[ck] = (models[m].byCampaign[ck] || 0) + v;
      });
    }
  }

  // Зведення: таблиця канал → дохід по кожній моделі (для порівняння)
  const channels = new Set();
  for (const m of MODELS) Object.keys(models[m].byChannel).forEach(c => channels.add(c));
  const comparison = [...channels].map(ch => {
    const row = { channel: ch };
    for (const m of MODELS) row[m] = Math.round((models[m].byChannel[ch] || 0) * 100) / 100;
    return row;
  }).sort((a, b) => b.last - a.last);

  return {
    period: { from: fromTs, to: toTs },
    conversions: conv.length, total_revenue: Math.round(totalRevenue * 100) / 100,
    conversions_with_touchpoints: convWithTp, conversions_direct: convDirect,
    models: MODELS, comparison,
    by_campaign: Object.fromEntries(MODELS.map(m => [m,
      Object.entries(models[m].byCampaign).map(([k, v]) => ({ campaign: k, revenue: Math.round(v * 100) / 100 }))
        .sort((a, b) => b.revenue - a.revenue)])),
  };
}

// UTM-звіт: точки дотику по source/medium/campaign + скільки з них дали конверсію.
async function utmReport({ from, to } = {}) {
  const pool = getPool();
  const fromTs = from || '1970-01-01', toTs = to || '2999-01-01';
  const r = await pool.query(
    `SELECT COALESCE(utm_source,'(none)') utm_source,
            COALESCE(utm_medium,'(none)') utm_medium,
            COALESCE(utm_campaign,'(none)') utm_campaign,
            COUNT(*)::int touches,
            COUNT(DISTINCT COALESCE(client_id::text, anon_id))::int visitors,
            COUNT(DISTINCT client_id)::int identified
       FROM marketing_touchpoints
      WHERE occurred_at >= $1 AND occurred_at < $2
      GROUP BY 1,2,3 ORDER BY touches DESC LIMIT 200`, [fromTs, toTs]);
  return { period: { from: fromTs, to: toTs }, rows: r.rows };
}

module.exports = { MODELS, track, linkAnon, compute, utmReport, normalizeChannel };
