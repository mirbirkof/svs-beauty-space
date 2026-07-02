/* lib/meta-ads.js — MKT-08 Meta Ads.
   Підключення ad-акаунтів, синк кампаній+статистики через Graph API (graceful:
   no-op якщо токен без скоупу ads_read), приймання Lead Ads → CRM (лід→клієнт→запис).
   Токени зберігаються зашифрованими (integration-secrets). RLS-таблиці →
   багатокрокові операції через withTx. Вебхук-маршрутизація лідів —
   кросс-тенантно по page_id (як Instagram по ig_user_id). */
const { query, withTx } = require('../db-pg');
const { encryptVal, decryptVal } = require('./integration-secrets');

const GRAPH = 'https://graph.facebook.com/v21.0';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Підключення акаунта ─────────────────────────────────────────────
// Перевіряємо токен через /me, зберігаємо зашифрованим.
async function connectAccount(opts = {}) {
  const { ad_account_id, access_token, facebook_page_id, instagram_account_id, pixel_id, branch_id } = opts;
  if (!ad_account_id || !access_token) throw new Error('ad_account_id-and-token-required');
  let name = null, ok = false, err = null;
  try {
    const r = await fetch(`${GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(access_token)}`);
    const j = await r.json();
    if (j && j.id) { ok = true; name = j.name || null; } else { err = j?.error?.message || 'token-invalid'; }
  } catch (e) { err = e.message; }
  if (!ok) throw new Error('token-check-failed: ' + (err || 'unknown'));
  const r = await query(
    `INSERT INTO meta_ad_accounts (branch_id, facebook_page_id, instagram_account_id, ad_account_id, pixel_id, access_token_enc, name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
     ON CONFLICT (tenant_id, ad_account_id) DO UPDATE SET
       facebook_page_id=EXCLUDED.facebook_page_id, instagram_account_id=EXCLUDED.instagram_account_id,
       pixel_id=EXCLUDED.pixel_id, access_token_enc=EXCLUDED.access_token_enc, name=EXCLUDED.name,
       status='active', last_error=NULL, updated_at=now()
     RETURNING id, ad_account_id, name, status, facebook_page_id, instagram_account_id, last_synced_at`,
    [branch_id || null, facebook_page_id || null, instagram_account_id || null, ad_account_id,
      pixel_id || null, encryptVal(access_token), name]);
  return r.rows[0];
}

async function listAccounts() {
  const r = await query(
    `SELECT id, ad_account_id, name, status, facebook_page_id, instagram_account_id, pixel_id,
            last_synced_at, last_error, created_at FROM meta_ad_accounts ORDER BY id`);
  return r.rows; // токен не віддаємо
}

async function disconnectAccount(id) {
  await query(`UPDATE meta_ad_accounts SET status='disconnected', access_token_enc=NULL, updated_at=now() WHERE id=$1`, [id]);
  return { ok: true };
}

async function _accountToken(id) {
  const r = await query('SELECT access_token_enc FROM meta_ad_accounts WHERE id=$1', [id]);
  const enc = r.rows[0]?.access_token_enc;
  return enc ? decryptVal(enc) : null;
}

// ── Синк кампаній + інсайтів (graceful) ─────────────────────────────
// Потребує токен зі скоупом ads_read. Без нього Graph поверне помилку —
// помічаємо акаунт error і виходимо без винятку (рабочий потік не падає).
async function syncAccount(accountId) {
  const acc = (await query('SELECT * FROM meta_ad_accounts WHERE id=$1', [accountId])).rows[0];
  if (!acc) throw new Error('account-not-found');
  const token = await _accountToken(accountId);
  if (!token) return { synced: 0, skipped: 'no-token' };
  const actId = acc.ad_account_id.startsWith('act_') ? acc.ad_account_id : 'act_' + acc.ad_account_id;
  try {
    const url = `${GRAPH}/${actId}/campaigns?fields=id,name,objective,status,daily_budget,lifetime_budget,start_time,stop_time&limit=100&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'graph-error');
    const camps = j.data || [];
    let n = 0;
    for (const c of camps) {
      const cid = (await query(
        `INSERT INTO meta_campaigns (account_id, meta_campaign_id, name, objective, status, daily_budget, lifetime_budget, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id, meta_campaign_id) DO UPDATE SET
           name=EXCLUDED.name, objective=EXCLUDED.objective, status=EXCLUDED.status,
           daily_budget=EXCLUDED.daily_budget, lifetime_budget=EXCLUDED.lifetime_budget, updated_at=now()
         RETURNING id`,
        [accountId, c.id, c.name || null, c.objective || null, c.status || null,
          c.daily_budget ? Number(c.daily_budget) / 100 : null,
          c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
          c.start_time ? c.start_time.slice(0, 10) : null, c.stop_time ? c.stop_time.slice(0, 10) : null])).rows[0].id;
      await _syncCampaignInsights(cid, c.id, token);
      n++;
    }
    await query(`UPDATE meta_ad_accounts SET last_synced_at=now(), last_error=NULL, status='active' WHERE id=$1`, [accountId]);
    return { synced: n };
  } catch (e) {
    await query(`UPDATE meta_ad_accounts SET last_error=$2, status='error', updated_at=now() WHERE id=$1`, [accountId, String(e.message).slice(0, 300)]);
    return { synced: 0, error: e.message };
  }
}

async function _syncCampaignInsights(campaignId, metaCampaignId, token) {
  try {
    const fields = 'impressions,reach,clicks,spend,ctr,cpc,actions,date_start';
    const url = `${GRAPH}/${metaCampaignId}/insights?fields=${fields}&time_increment=1&date_preset=last_30d&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error || !Array.isArray(j.data)) return;
    for (const row of j.data) {
      const leads = _actionVal(row.actions, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped']);
      const conv = _actionVal(row.actions, ['offsite_conversion.fb_pixel_purchase', 'purchase']);
      const spend = round2(row.spend);
      const clicks = Number(row.clicks) || 0;
      const cpl = leads > 0 ? round2(spend / leads) : null;
      await query(
        `INSERT INTO meta_campaign_stats (campaign_id, date, impressions, reach, clicks, spend, leads, conversions, ctr, cpc, cpl)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (campaign_id, date) DO UPDATE SET
           impressions=EXCLUDED.impressions, reach=EXCLUDED.reach, clicks=EXCLUDED.clicks,
           spend=EXCLUDED.spend, leads=EXCLUDED.leads, conversions=EXCLUDED.conversions,
           ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc, cpl=EXCLUDED.cpl`,
        [campaignId, row.date_start, Number(row.impressions) || 0, Number(row.reach) || 0, clicks,
          spend, leads, conv, round2(row.ctr), round2(row.cpc), cpl]);
    }
  } catch (_) { /* інсайти best-effort */ }
}
function _actionVal(actions, types) {
  if (!Array.isArray(actions)) return 0;
  let s = 0;
  for (const a of actions) if (types.includes(a.action_type)) s += Number(a.value) || 0;
  return s;
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
       COALESCE(st.spend,0) AS spend, COALESCE(st.leads,0) AS leads,
       COALESCE(st.conversions,0) AS conversions,
       CASE WHEN COALESCE(st.spend,0)>0 AND COALESCE(st.conversions,0)>0
            THEN ROUND((st.conv_value/st.spend)::numeric,2) ELSE NULL END AS roas
     FROM meta_campaigns c
     LEFT JOIN (
       SELECT s.campaign_id, SUM(s.impressions) impressions, SUM(s.clicks) clicks,
              SUM(s.spend) spend, SUM(s.leads) leads, SUM(s.conversions) conversions,
              SUM(s.conversions*COALESCE(s.roas,0)) conv_value
       FROM meta_campaign_stats s WHERE true ${sWhere} GROUP BY s.campaign_id
     ) st ON st.campaign_id=c.id
     ${where} ORDER BY c.status, c.id DESC`, dArgs);
  return r.rows;
}

async function campaignStats(campaignId, { from, to } = {}) {
  const args = [campaignId]; const cond = ['campaign_id=$1'];
  if (from) { args.push(from); cond.push(`date>=$${args.length}`); }
  if (to) { args.push(to); cond.push(`date<=$${args.length}`); }
  const r = await query(`SELECT * FROM meta_campaign_stats WHERE ${cond.join(' AND ')} ORDER BY date`, args);
  return r.rows;
}

// Вкл/викл кампанію в Meta (graceful)
async function toggleCampaign(campaignId, status) {
  const c = (await query('SELECT * FROM meta_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!c) throw new Error('campaign-not-found');
  const token = await _accountToken(c.account_id);
  if (token) {
    try {
      await fetch(`${GRAPH}/${c.meta_campaign_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, access_token: token }),
      });
    } catch (_) { /* локально все одно оновимо */ }
  }
  const r = await query(`UPDATE meta_campaigns SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [campaignId, status]);
  return r.rows[0];
}

// ── Lead Ads ────────────────────────────────────────────────────────
// Маршрутизація вебхука: знайти tenant по page_id (кросс-тенантно, plain pool).
async function resolveTenantByPage(pageId) {
  const r = await query(`SELECT tenant_id, id FROM meta_ad_accounts WHERE facebook_page_id=$1 AND status<>'disconnected' LIMIT 1`, [pageId]);
  return r.rows[0] || null;
}

// Зберегти лід (у контексті tenant через runAs ззовні). Збагачення полів —
// через Graph (потребує leads_retrieval), без токена зберігаємо тільки id.
async function ingestLead({ accountId, leadgenId, pageId, formId, campaignId } = {}) {
  let fields = {};
  const tokRow = accountId
    ? await query('SELECT access_token_enc FROM meta_ad_accounts WHERE id=$1', [accountId])
    : { rows: [] };
  const token = tokRow.rows[0]?.access_token_enc ? decryptVal(tokRow.rows[0].access_token_enc) : null;
  if (token && leadgenId) {
    try {
      const r = await fetch(`${GRAPH}/${leadgenId}?access_token=${encodeURIComponent(token)}`);
      const j = await r.json();
      if (Array.isArray(j.field_data)) for (const f of j.field_data) fields[f.name] = (f.values || [])[0];
    } catch (_) { /* best-effort */ }
  }
  const name = fields.full_name || fields.name || [fields.first_name, fields.last_name].filter(Boolean).join(' ') || null;
  const r = await query(
    `INSERT INTO meta_leads (account_id, meta_lead_id, form_name, client_name, phone, email, service_interest, raw_data, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'new')
     ON CONFLICT (tenant_id, meta_lead_id) DO NOTHING
     RETURNING *`,
    [accountId || null, String(leadgenId), formId || null, name,
      fields.phone_number || fields.phone || null, fields.email || null,
      fields.service || fields.service_interest || null, JSON.stringify(fields)]);
  return r.rows[0] || null;
}

async function listLeads({ status, from, to, limit = 50 } = {}) {
  const cond = []; const args = [];
  if (status) { args.push(status); cond.push(`status=$${args.length}`); }
  if (from) { args.push(from); cond.push(`created_at>=$${args.length}`); }
  if (to) { args.push(to); cond.push(`created_at<=$${args.length}`); }
  args.push(Math.min(Number(limit) || 50, 200));
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const r = await query(`SELECT * FROM meta_leads ${where} ORDER BY created_at DESC LIMIT $${args.length}`, args);
  return r.rows;
}

async function updateLead(id, { status, notes, contacted_by } = {}) {
  const sets = ['updated_at=now()']; const args = [id];
  if (status) { args.push(status); sets.push(`status=$${args.length}`); if (status === 'contacted') sets.push('contacted_at=COALESCE(contacted_at,now())'); }
  if (notes !== undefined) { args.push(notes); sets.push(`notes=$${args.length}`); }
  if (contacted_by) { args.push(contacted_by); sets.push(`contacted_by=$${args.length}`); }
  const r = await query(`UPDATE meta_leads SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, args);
  return r.rows[0];
}

// Лід → клієнт (по телефону: знайти або створити). Атомарно.
async function leadToClient(leadId) {
  return withTx(async (client) => {
    const lead = (await client.query('SELECT * FROM meta_leads WHERE id=$1 FOR UPDATE', [leadId])).rows[0];
    if (!lead) throw new Error('lead-not-found');
    if (lead.client_id) return { client_id: lead.client_id, existed: true };
    // канон БД 380XXXXXXXXX (#107): Meta віддає '+380...' — без нормалізації плодились дублі
    const phone = require('./phone').normalizePhoneDb(lead.phone);
    let cid = null;
    if (phone) cid = (await client.query(`SELECT id FROM clients WHERE regexp_replace(phone,'\\D','','g') = regexp_replace($1,'\\D','','g') LIMIT 1`, [phone])).rows[0]?.id || null;
    if (!cid) {
      cid = (await client.query(
        `INSERT INTO clients (phone, name, source) VALUES ($1,$2,'meta-lead') RETURNING id`,
        [phone || null, lead.client_name || 'Meta Lead'])).rows[0].id;
    }
    await client.query(`UPDATE meta_leads SET client_id=$2, status=CASE WHEN status='new' THEN 'contacted' ELSE status END, updated_at=now() WHERE id=$1`, [leadId, cid]);
    return { client_id: cid, existed: false };
  });
}

// Лід → запис. Створює клієнта якщо ще нема, потім appointment.
async function leadToAppointment(leadId, { service_id, master_id, starts_at, price } = {}) {
  if (!starts_at) throw new Error('starts_at-required');
  const { client_id } = await leadToClient(leadId);
  return withTx(async (client) => {
    const appt = (await client.query(
      `INSERT INTO appointments (client_id, master_id, service_id, starts_at, status, price, source)
       VALUES ($1,$2,$3,$4,'planned',$5,'meta-lead') RETURNING id, starts_at`,
      [client_id, master_id || null, service_id || null, starts_at, price || null])).rows[0];
    await client.query(`UPDATE meta_leads SET appointment_id=$2, status='booked', updated_at=now() WHERE id=$1`, [leadId, appt.id]);
    return { appointment_id: appt.id, client_id, starts_at: appt.starts_at };
  });
}

// ── ROI / аналітика ─────────────────────────────────────────────────
async function roi({ from, to } = {}) {
  const args = []; const cond = [];
  if (from) { args.push(from); cond.push(`s.date>=$${args.length}`); }
  if (to) { args.push(to); cond.push(`s.date<=$${args.length}`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const a = (await query(
    `SELECT COALESCE(SUM(s.spend),0) AS spend, COALESCE(SUM(s.leads),0) AS leads,
            COALESCE(SUM(s.conversions),0) AS conversions, COALESCE(SUM(s.clicks),0) AS clicks,
            COALESCE(SUM(s.impressions),0) AS impressions
     FROM meta_campaign_stats s ${where}`, args)).rows[0];
  const leadsRow = (await query(
    `SELECT COUNT(*) FILTER (WHERE status='new') AS new,
            COUNT(*) FILTER (WHERE status='contacted') AS contacted,
            COUNT(*) FILTER (WHERE status='booked') AS booked,
            COUNT(*) FILTER (WHERE status='visited') AS visited,
            COUNT(*) FILTER (WHERE status='lost') AS lost,
            COUNT(*) AS total FROM meta_leads`)).rows[0];
  const spend = Number(a.spend), leads = Number(a.leads) || Number(leadsRow.total);
  return {
    spend: round2(spend), impressions: Number(a.impressions), clicks: Number(a.clicks),
    leads, conversions: Number(a.conversions),
    cpl: leads > 0 ? round2(spend / leads) : null,
    cpc: Number(a.clicks) > 0 ? round2(spend / Number(a.clicks)) : null,
    funnel: leadsRow,
  };
}

// Cron: синк усіх активних акаунтів (глобально, скоупиться по tenant в межах рядків)
async function syncAllAccounts() {
  const accs = (await query(`SELECT id, tenant_id FROM meta_ad_accounts WHERE status IN ('active','error') AND access_token_enc IS NOT NULL`)).rows;
  let total = 0;
  const { runAs } = require('./tenant');
  for (const a of accs) {
    try { const r = await runAs(a.tenant_id, () => syncAccount(a.id)); total += (r.synced || 0); }
    catch (e) { console.error('[meta-ads] sync', a.id, e.message); }
  }
  return { accounts: accs.length, synced: total };
}

module.exports = {
  GRAPH, connectAccount, listAccounts, disconnectAccount, syncAccount,
  listCampaigns, campaignStats, toggleCampaign,
  resolveTenantByPage, ingestLead, listLeads, updateLead, leadToClient, leadToAppointment,
  roi, syncAllAccounts,
};
