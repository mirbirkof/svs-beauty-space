/* lib/google-ads.js — MKT-09 Google Ads.
   Підключення Google Ads акаунтів, синк кампаній+статистики та offline-конверсії
   (gclid → запис/візит → завантаження в Google Ads для Smart Bidding).

   Живий синк/upload через Google Ads API потребує:
     GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
     + refresh_token акаунта (OAuth). Без них усі мережеві виклики — graceful
     no-op (нічого не валиться). gclid ловиться при бронюванні завжди — конверсії
     накопичуються локально й вивантажуються коли зʼявиться доступ до API. */
const { query, withTx } = require('../db-pg');
const { encryptVal, decryptVal } = require('./integration-secrets');

const ADS_API = 'https://googleads.googleapis.com/v17';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function _apiConfigured() {
  return !!(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ── Підключення акаунта ─────────────────────────────────────────────
async function connectAccount(opts = {}) {
  const { customer_id, access_token, refresh_token, ga4_property_id, branch_id, name } = opts;
  if (!customer_id) throw new Error('customer_id-required');
  const cid = String(customer_id).replace(/[^0-9]/g, '');
  if (cid.length < 8) throw new Error('customer_id-invalid');
  const r = await query(
    `INSERT INTO google_ads_accounts (branch_id, customer_id, ga4_property_id, access_token_enc, refresh_token_enc, name, status)
     VALUES ($1,$2,$3,$4,$5,$6,'active')
     ON CONFLICT (tenant_id, customer_id) DO UPDATE SET
       ga4_property_id=EXCLUDED.ga4_property_id,
       access_token_enc=COALESCE(EXCLUDED.access_token_enc, google_ads_accounts.access_token_enc),
       refresh_token_enc=COALESCE(EXCLUDED.refresh_token_enc, google_ads_accounts.refresh_token_enc),
       name=EXCLUDED.name, status='active', last_error=NULL, updated_at=now()
     RETURNING id, customer_id, ga4_property_id, name, status, last_synced_at`,
    [branch_id || null, cid, ga4_property_id || null,
      access_token ? encryptVal(access_token) : null,
      refresh_token ? encryptVal(refresh_token) : null, name || null]);
  return r.rows[0];
}

async function listAccounts() {
  const r = await query(
    `SELECT id, customer_id, ga4_property_id, name, status, last_synced_at, last_error, created_at
     FROM google_ads_accounts ORDER BY id`);
  return r.rows; // токени не віддаємо
}

async function disconnectAccount(id) {
  await query(`UPDATE google_ads_accounts SET status='disconnected', access_token_enc=NULL, refresh_token_enc=NULL, updated_at=now() WHERE id=$1`, [id]);
  return { ok: true };
}

// Обмін refresh_token → свіжий access_token (graceful)
async function _accessTokenFor(accountId) {
  const a = (await query('SELECT refresh_token_enc FROM google_ads_accounts WHERE id=$1', [accountId])).rows[0];
  const refresh = a?.refresh_token_enc ? decryptVal(a.refresh_token_enc) : null;
  if (!refresh || !_apiConfigured()) return null;
  try {
    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh, grant_type: 'refresh_token',
    });
    const r = await fetch(OAUTH_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const j = await r.json();
    return j.access_token || null;
  } catch (_) { return null; }
}

// GAQL-запит до Google Ads API (graceful → null якщо не налаштовано)
async function _gaql(accountId, customerId, gaql) {
  const token = await _accessTokenFor(accountId);
  if (!token) return null;
  try {
    const r = await fetch(`${ADS_API}/customers/${customerId}/googleAds:searchStream`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
        'Content-Type': 'application/json',
        ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
      },
      body: JSON.stringify({ query: gaql }),
    });
    const j = await r.json();
    if (j.error || (Array.isArray(j) && j[0]?.error)) throw new Error((j.error?.message) || 'gads-api-error');
    // searchStream повертає масив батчів { results: [...] }
    const batches = Array.isArray(j) ? j : [j];
    const rows = [];
    for (const b of batches) if (Array.isArray(b.results)) rows.push(...b.results);
    return rows;
  } catch (e) { throw e; }
}

// ── Синк кампаній + статистики (graceful) ───────────────────────────
async function syncAccount(accountId) {
  const acc = (await query('SELECT * FROM google_ads_accounts WHERE id=$1', [accountId])).rows[0];
  if (!acc) throw new Error('account-not-found');
  if (!_apiConfigured()) return { synced: 0, skipped: 'api-not-configured' };
  try {
    const gaql = `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status,
        campaign_budget.amount_micros,
        metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
        metrics.conversions_value, metrics.ctr, metrics.average_cpc, segments.date
      FROM campaign WHERE segments.date DURING LAST_30_DAYS`;
    const rows = await _gaql(accountId, acc.customer_id, gaql);
    if (rows === null) return { synced: 0, skipped: 'no-token' };
    let n = 0; const seen = new Set();
    for (const row of rows) {
      const c = row.campaign || {}; const m = row.metrics || {}; const seg = row.segments || {};
      const budget = row.campaignBudget?.amountMicros ? Number(row.campaignBudget.amountMicros) / 1e6 : null;
      const campRowId = (await query(
        `INSERT INTO google_ads_campaigns (account_id, google_campaign_id, name, type, status, daily_budget)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, google_campaign_id) DO UPDATE SET
           name=EXCLUDED.name, type=EXCLUDED.type, status=EXCLUDED.status,
           daily_budget=EXCLUDED.daily_budget, updated_at=now()
         RETURNING id`,
        [accountId, String(c.id), c.name || null, c.advertisingChannelType || null, c.status || null, budget])).rows[0].id;
      if (!seen.has(campRowId)) { seen.add(campRowId); n++; }
      const spend = m.costMicros ? Number(m.costMicros) / 1e6 : 0;
      const clicks = Number(m.clicks) || 0;
      const convVal = round2(m.conversionsValue);
      await query(
        `INSERT INTO google_ads_stats (campaign_id, date, impressions, clicks, spend, conversions, conversion_value, ctr, cpc, roas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (campaign_id, date) DO UPDATE SET
           impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks, spend=EXCLUDED.spend,
           conversions=EXCLUDED.conversions, conversion_value=EXCLUDED.conversion_value,
           ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc, roas=EXCLUDED.roas`,
        [campRowId, seg.date, Number(m.impressions) || 0, clicks, round2(spend),
          Math.round(Number(m.conversions) || 0), convVal, round2(m.ctr),
          m.averageCpc ? round2(Number(m.averageCpc) / 1e6) : null,
          spend > 0 ? round2(convVal / spend) : null]);
    }
    await query(`UPDATE google_ads_accounts SET last_synced_at=now(), last_error=NULL, status='active' WHERE id=$1`, [accountId]);
    return { synced: n };
  } catch (e) {
    await query(`UPDATE google_ads_accounts SET last_error=$2, status='error', updated_at=now() WHERE id=$1`, [accountId, String(e.message).slice(0, 300)]);
    return { synced: 0, error: e.message };
  }
}

// ── Кампанії з агрегованою статистикою (для UI) ─────────────────────
async function listCampaigns({ accountId, status, from, to } = {}) {
  const cond = []; const args = [];
  if (accountId) { args.push(accountId); cond.push(`c.account_id=$${args.length}`); }
  if (status) { args.push(status); cond.push(`c.status=$${args.length}`); }
  const dCond = []; const dArgs = [...args];
  if (from) { dArgs.push(from); dCond.push(`s.date>=$${dArgs.length}`); }
  if (to) { dArgs.push(to); dCond.push(`s.date<=$${dArgs.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const sWhere = dCond.length ? 'AND ' + dCond.join(' AND ') : '';
  const r = await query(
    `SELECT c.*,
       COALESCE(st.impressions,0) AS impressions, COALESCE(st.clicks,0) AS clicks,
       COALESCE(st.spend,0) AS spend, COALESCE(st.conversions,0) AS conversions,
       COALESCE(st.conversion_value,0) AS conversion_value,
       CASE WHEN COALESCE(st.spend,0)>0 THEN ROUND((st.conversion_value/st.spend)::numeric,2) ELSE NULL END AS roas
     FROM google_ads_campaigns c
     LEFT JOIN (
       SELECT s.campaign_id, SUM(s.impressions) impressions, SUM(s.clicks) clicks,
              SUM(s.spend) spend, SUM(s.conversions) conversions, SUM(s.conversion_value) conversion_value
       FROM google_ads_stats s WHERE true ${sWhere} GROUP BY s.campaign_id
     ) st ON st.campaign_id=c.id
     ${where} ORDER BY c.status, c.id DESC`, dArgs);
  return r.rows;
}

async function campaignStats(campaignId, { from, to } = {}) {
  const args = [campaignId]; const cond = ['campaign_id=$1'];
  if (from) { args.push(from); cond.push(`date>=$${args.length}`); }
  if (to) { args.push(to); cond.push(`date<=$${args.length}`); }
  const r = await query(`SELECT * FROM google_ads_stats WHERE ${cond.join(' AND ')} ORDER BY date`, args);
  return r.rows;
}

// Вкл/викл кампанію (graceful — локальний стан завжди оновлюємо)
async function toggleCampaign(campaignId, status) {
  const c = (await query('SELECT * FROM google_ads_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!c) throw new Error('campaign-not-found');
  const acc = (await query('SELECT customer_id FROM google_ads_accounts WHERE id=$1', [c.account_id])).rows[0];
  const token = await _accessTokenFor(c.account_id);
  if (token && acc) {
    try {
      await fetch(`${ADS_API}/customers/${acc.customer_id}/campaigns:mutate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'Content-Type': 'application/json',
          ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
        },
        body: JSON.stringify({ operations: [{ update: { resourceName: `customers/${acc.customer_id}/campaigns/${c.google_campaign_id}`, status }, updateMask: 'status' }] }),
      });
    } catch (_) { /* локально все одно оновимо */ }
  }
  const r = await query(`UPDATE google_ads_campaigns SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [campaignId, status]);
  return r.rows[0];
}

// ── Конверсії / gclid ───────────────────────────────────────────────
// Записати конверсію (gclid ловиться при бронюванні; візит — при відмітці приходу).
async function recordConversion({ gclid, client_id, appointment_id, conversion_type = 'booking', conversion_value, conversion_time } = {}) {
  if (!gclid && !appointment_id && !client_id) throw new Error('gclid-or-ref-required');
  const r = await query(
    `INSERT INTO google_ads_conversions (account_id, gclid, client_id, appointment_id, conversion_type, conversion_value, conversion_time)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now())) RETURNING *`,
    [null, gclid || null, client_id || null, appointment_id || null, conversion_type, conversion_value ?? null, conversion_time || null]);
  return r.rows[0];
}

// Хук бронювання: якщо в записі є gclid — зафіксувати конверсію 'booking' (best-effort).
async function captureBookingGclid({ gclid, client_id, appointment_id, value } = {}) {
  if (!gclid) return null;
  try { return await recordConversion({ gclid, client_id, appointment_id, conversion_type: 'booking', conversion_value: value }); }
  catch (e) { console.error('[gads] captureBookingGclid', e.message); return null; }
}

async function listConversions({ uploaded, limit = 100 } = {}) {
  const cond = []; const args = [];
  if (uploaded === true) cond.push('uploaded_to_google=true');
  if (uploaded === false) cond.push('uploaded_to_google=false');
  args.push(Math.min(Number(limit) || 100, 500));
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await query(`SELECT * FROM google_ads_conversions ${where} ORDER BY conversion_time DESC LIMIT $${args.length}`, args);
  return r.rows;
}

// Вивантаження offline-конверсій у Google Ads (graceful). Без API — лишаються pending.
async function uploadConversions() {
  const pending = (await query(
    `SELECT c.*, a.customer_id FROM google_ads_conversions c
     LEFT JOIN google_ads_accounts a ON a.id=c.account_id
     WHERE c.uploaded_to_google=false AND c.gclid IS NOT NULL`)).rows;
  if (!pending.length) return { uploaded: 0, pending: 0 };
  if (!_apiConfigured()) return { uploaded: 0, pending: pending.length, skipped: 'api-not-configured' };
  let uploaded = 0;
  for (const c of pending) {
    const accId = c.account_id || (await query(`SELECT id FROM google_ads_accounts WHERE status='active' LIMIT 1`)).rows[0]?.id;
    if (!accId) continue;
    const token = await _accessTokenFor(accId);
    const cust = c.customer_id || (await query('SELECT customer_id FROM google_ads_accounts WHERE id=$1', [accId])).rows[0]?.customer_id;
    if (!token || !cust) continue;
    try {
      const r = await fetch(`${ADS_API}/customers/${cust}:uploadClickConversions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`, 'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
          'Content-Type': 'application/json',
          ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
        },
        body: JSON.stringify({
          conversions: [{
            gclid: c.gclid,
            conversionDateTime: new Date(c.conversion_time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00:00'),
            conversionValue: Number(c.conversion_value) || 0, currencyCode: 'UAH',
          }],
          partialFailure: true,
        }),
      });
      const j = await r.json();
      if (!j.error) {
        await query(`UPDATE google_ads_conversions SET uploaded_to_google=true, uploaded_at=now() WHERE id=$1`, [c.id]);
        uploaded++;
      }
    } catch (e) { console.error('[gads] upload', c.id, e.message); }
  }
  return { uploaded, pending: pending.length - uploaded };
}

// ── Ключові слова / пошукові запити (live-only, graceful → []) ──────
async function listKeywords({ accountId, campaignId } = {}) {
  if (!_apiConfigured() || !accountId) return { items: [], note: 'live-only' };
  const acc = (await query('SELECT customer_id FROM google_ads_accounts WHERE id=$1', [accountId])).rows[0];
  if (!acc) return { items: [] };
  try {
    const gaql = `SELECT ad_group_criterion.keyword.text, ad_group_criterion.quality_info.quality_score,
        metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM keyword_view WHERE segments.date DURING LAST_30_DAYS
      ${campaignId ? `AND campaign.id = ${Number(campaignId)}` : ''} ORDER BY metrics.clicks DESC LIMIT 100`;
    const rows = await _gaql(accountId, acc.customer_id, gaql) || [];
    return { items: rows.map((r) => ({
      text: r.adGroupCriterion?.keyword?.text, quality_score: r.adGroupCriterion?.qualityInfo?.qualityScore,
      impressions: Number(r.metrics?.impressions) || 0, clicks: Number(r.metrics?.clicks) || 0,
      conversions: Number(r.metrics?.conversions) || 0, spend: r.metrics?.costMicros ? round2(Number(r.metrics.costMicros) / 1e6) : 0,
    })) };
  } catch (e) { return { items: [], error: e.message }; }
}

async function searchTerms({ accountId, campaignId } = {}) {
  if (!_apiConfigured() || !accountId) return { items: [], note: 'live-only' };
  const acc = (await query('SELECT customer_id FROM google_ads_accounts WHERE id=$1', [accountId])).rows[0];
  if (!acc) return { items: [] };
  try {
    const gaql = `SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, metrics.conversions, metrics.cost_micros
      FROM search_term_view WHERE segments.date DURING LAST_30_DAYS
      ${campaignId ? `AND campaign.id = ${Number(campaignId)}` : ''} ORDER BY metrics.clicks DESC LIMIT 100`;
    const rows = await _gaql(accountId, acc.customer_id, gaql) || [];
    return { items: rows.map((r) => ({
      term: r.searchTermView?.searchTerm, impressions: Number(r.metrics?.impressions) || 0,
      clicks: Number(r.metrics?.clicks) || 0, conversions: Number(r.metrics?.conversions) || 0,
      spend: r.metrics?.costMicros ? round2(Number(r.metrics.costMicros) / 1e6) : 0,
    })) };
  } catch (e) { return { items: [], error: e.message }; }
}

// ── ROI / аналітика ─────────────────────────────────────────────────
async function roi({ from, to } = {}) {
  const args = []; const cond = [];
  if (from) { args.push(from); cond.push(`s.date>=$${args.length}`); }
  if (to) { args.push(to); cond.push(`s.date<=$${args.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const a = (await query(
    `SELECT COALESCE(SUM(s.spend),0) AS spend, COALESCE(SUM(s.clicks),0) AS clicks,
            COALESCE(SUM(s.impressions),0) AS impressions, COALESCE(SUM(s.conversions),0) AS conversions,
            COALESCE(SUM(s.conversion_value),0) AS conversion_value
     FROM google_ads_stats s ${where}`, args)).rows[0];
  const conv = (await query(
    `SELECT COUNT(*) FILTER (WHERE conversion_type='booking') AS bookings,
            COUNT(*) FILTER (WHERE conversion_type='visit') AS visits,
            COUNT(*) FILTER (WHERE uploaded_to_google=false) AS pending_upload,
            COUNT(*) AS total FROM google_ads_conversions`)).rows[0];
  const spend = Number(a.spend), conversions = Number(a.conversions) || Number(conv.bookings);
  const recs = [];
  if (spend > 0 && conversions === 0) recs.push('Є витрати без конверсій — перевірте релевантність ключових слів і посадкову сторінку.');
  if (Number(conv.pending_upload) > 0) recs.push(`${conv.pending_upload} offline-конверсій очікують вивантаження — підключіть Google Ads API для Smart Bidding.`);
  return {
    total_spend: round2(spend), impressions: Number(a.impressions), clicks: Number(a.clicks),
    total_conversions: conversions, conversion_value: round2(a.conversion_value),
    cpa: conversions > 0 ? round2(spend / conversions) : null,
    cpc: Number(a.clicks) > 0 ? round2(spend / Number(a.clicks)) : null,
    roas: spend > 0 ? round2(Number(a.conversion_value) / spend) : null,
    funnel: conv, recommendations: recs,
  };
}

// Збір offline-конверсій з виконаних записів: якщо клієнт мав gclid-дотик
// (система атрибуції MKT-10 → marketing_touchpoints), фіксуємо 'visit'-конверсію.
// Не чіпає потік бронювання — читаємо вже готові дані, дедуп по appointment_id.
async function harvestConversions() {
  const rows = (await query(
    `SELECT a.id AS appointment_id, a.client_id, COALESCE(a.price,0) AS value, a.starts_at,
            tp.gclid
       FROM appointments a
       JOIN LATERAL (
         SELECT gclid FROM marketing_touchpoints t
          WHERE t.client_id = a.client_id AND t.gclid IS NOT NULL
            AND t.occurred_at <= a.starts_at
          ORDER BY t.occurred_at DESC LIMIT 1
       ) tp ON true
      WHERE a.status='done' AND a.client_id IS NOT NULL
        AND a.starts_at >= now() - interval '60 days'
        AND NOT EXISTS (
          SELECT 1 FROM google_ads_conversions c
           WHERE c.appointment_id = a.id AND c.conversion_type='visit')
      LIMIT 500`)).rows;
  let n = 0;
  for (const r of rows) {
    try {
      await recordConversion({ gclid: r.gclid, client_id: r.client_id, appointment_id: r.appointment_id,
        conversion_type: 'visit', conversion_value: Number(r.value) || 0, conversion_time: r.starts_at });
      n++;
    } catch (e) { console.error('[gads] harvest', r.appointment_id, e.message); }
  }
  return { harvested: n };
}

// Cron: синк усіх активних акаунтів (per-tenant через runAs) + збір/вивантаження конверсій
async function syncAllAccounts() {
  const accs = (await query(`SELECT id, tenant_id FROM google_ads_accounts WHERE status IN ('active','error')`)).rows;
  let total = 0;
  const { runAs } = require('./tenant');
  for (const a of accs) {
    try {
      const r = await runAs(a.tenant_id, async () => {
        const s = await syncAccount(a.id);
        try { await harvestConversions(); } catch (e) { console.error('[gads] harvest', e.message); }
        await uploadConversions();
        return s;
      });
      total += (r.synced || 0);
    } catch (e) { console.error('[gads] sync', a.id, e.message); }
  }
  return { accounts: accs.length, synced: total };
}

module.exports = {
  ADS_API, connectAccount, listAccounts, disconnectAccount, syncAccount,
  listCampaigns, campaignStats, toggleCampaign,
  recordConversion, captureBookingGclid, listConversions, uploadConversions,
  harvestConversions, listKeywords, searchTerms, roi, syncAllAccounts,
};
