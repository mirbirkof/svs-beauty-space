/* lib/instagram-content.js — COM-10 доповнення: Instagram публікації + insights.
   Будується поверх наявного каналу (omni_channels.config, channel='instagram').
   Токени НЕ дублюються — page_token/ig_user_id беруться з конфігу салону.
   Усе graceful: без підключеного каналу повертає {skipped:'not-connected'},
   без валідного токена — {error}. Планувальник публікує per-tenant через runAs. */
const { query, getPool } = require('../db-pg');
const { GRAPH } = require('./channels/instagram-meta');

// Конфіг Instagram поточного тенанта (omni_channels — ізоляція явним WHERE,
// бо таблиця кросс-тенантна для вебхука; RLS на ній свідомо вимкнено).
async function channel() {
  const r = (await getPool().query(
    `SELECT enabled, config FROM omni_channels
       WHERE channel='instagram' AND tenant_id=current_tenant_id() LIMIT 1`)).rows[0];
  if (!r || !r.config) return null;
  const c = r.config;
  if (!c.ig_user_id || !c.page_token) return null;
  return { enabled: r.enabled, ig_user_id: c.ig_user_id, page_token: c.page_token };
}

async function gGet(path, params, token) {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `http_${r.status}` };
  return { ok: true, data };
}
async function gPost(path, params, token) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, access_token: token }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, status: r.status, error: data?.error?.message || `http_${r.status}` };
  return { ok: true, data };
}

/* ── Insights (метрики акаунта + медіа) ────────────────────── */

async function accountInsights({ period = 'day', days = 28 } = {}) {
  const ch = await channel();
  if (!ch) return { skipped: 'not-connected' };
  // Метрики профілю IG Graph (reach/impressions/profile_views) + follower_count
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const r = await gGet(`${ch.ig_user_id}/insights`,
    { metric: 'reach,impressions,profile_views', period, since: String(since) }, ch.page_token);
  const fr = await gGet(`${ch.ig_user_id}`, { fields: 'followers_count,media_count,username' }, ch.page_token);
  if (!r.ok && !fr.ok) return { error: r.error || fr.error };
  const metrics = {};
  for (const m of (r.data?.data || [])) {
    metrics[m.name] = (m.values || []).reduce((s, v) => s + (v.value || 0), 0);
  }
  return {
    username: fr.data?.username || null,
    followers_count: fr.data?.followers_count ?? null,
    media_count: fr.data?.media_count ?? null,
    reach: metrics.reach ?? null,
    impressions: metrics.impressions ?? null,
    profile_views: metrics.profile_views ?? null,
    period_days: days,
  };
}

async function listMedia({ limit = 12 } = {}) {
  const ch = await channel();
  if (!ch) return { skipped: 'not-connected', items: [] };
  const r = await gGet(`${ch.ig_user_id}/media`,
    { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count', limit: String(limit) },
    ch.page_token);
  if (!r.ok) return { error: r.error, items: [] };
  return { items: r.data?.data || [] };
}

async function mediaInsights(mediaId) {
  const ch = await channel();
  if (!ch) return { skipped: 'not-connected' };
  const r = await gGet(`${mediaId}/insights`,
    { metric: 'reach,impressions,saved,likes,comments,shares' }, ch.page_token);
  if (!r.ok) return { error: r.error };
  const out = {};
  for (const m of (r.data?.data || [])) out[m.name] = m.values?.[0]?.value ?? null;
  return out;
}

/* ── Публікація (Content Publishing API) ───────────────────── */

// Двокроковий флоу Meta: створити контейнер → опублікувати.
async function _publishContainer(ch, { media_type, image_url, video_url, caption, children, product_tags }) {
  let creationId;
  if (media_type === 'CAROUSEL' && Array.isArray(children) && children.length) {
    const childIds = [];
    for (const url of children.slice(0, 10)) {
      const cc = await gPost(`${ch.ig_user_id}/media`, { image_url: url, is_carousel_item: true }, ch.page_token);
      if (!cc.ok) return { ok: false, error: `child: ${cc.error}` };
      childIds.push(cc.data.id);
    }
    const carousel = await gPost(`${ch.ig_user_id}/media`,
      { media_type: 'CAROUSEL', caption: caption || '', children: childIds.join(',') }, ch.page_token);
    if (!carousel.ok) return { ok: false, error: carousel.error };
    creationId = carousel.data.id;
  } else if (media_type === 'REELS') {
    const c = await gPost(`${ch.ig_user_id}/media`,
      { media_type: 'REELS', video_url, caption: caption || '' }, ch.page_token);
    if (!c.ok) return { ok: false, error: c.error };
    creationId = c.data.id;
  } else {
    const params = { image_url, caption: caption || '' };
    // теги товарів (працюють лише зі схваленим каталогом Meta Shopping)
    if (Array.isArray(product_tags) && product_tags.length) params.product_tags = JSON.stringify(product_tags);
    const c = await gPost(`${ch.ig_user_id}/media`, params, ch.page_token);
    if (!c.ok) return { ok: false, error: c.error };
    creationId = c.data.id;
  }
  const pub = await gPost(`${ch.ig_user_id}/media_publish`, { creation_id: creationId }, ch.page_token);
  if (!pub.ok) return { ok: false, error: pub.error };
  return { ok: true, ig_media_id: pub.data.id };
}

// Опублікувати негайно. Повертає {ok, ig_media_id} або {error}.
async function publishNow(post) {
  const ch = await channel();
  if (!ch) return { skipped: 'not-connected' };
  if (post.media_type !== 'REELS' && post.media_type !== 'CAROUSEL' && !post.image_url)
    throw new Error('image_url required');
  const r = await _publishContainer(ch, post);
  if (!r.ok) return { error: r.error };
  // дістати permalink (best-effort)
  let permalink = null;
  try {
    const pr = await gGet(`${r.ig_media_id}`, { fields: 'permalink' }, ch.page_token);
    permalink = pr.ok ? pr.data?.permalink : null;
  } catch { /* не критично */ }
  return { ok: true, ig_media_id: r.ig_media_id, permalink };
}

/* ── Планувальник (persistent, RLS, cron) ──────────────────── */

async function schedulePost({ media_type, image_url, video_url, caption, children, product_tags, scheduled_at, created_by }) {
  const mt = ['IMAGE', 'CAROUSEL', 'REELS'].includes(media_type) ? media_type : 'IMAGE';
  // якщо scheduled_at не вказано/в минулому — публікуємо одразу
  const now = Date.now();
  const due = scheduled_at ? new Date(scheduled_at).getTime() : 0;
  if (!scheduled_at || due <= now) {
    const res = await publishNow({ media_type: mt, image_url, video_url, caption, children, product_tags });
    const status = res.ok ? 'published' : (res.skipped ? 'scheduled' : 'failed');
    const row = (await getPool().query(
      `INSERT INTO instagram_scheduled_posts
         (media_type,image_url,video_url,children,caption,product_tags,scheduled_at,status,ig_media_id,permalink,error,created_by,published_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [mt, image_url || null, video_url || null, children ? JSON.stringify(children) : null,
       caption || null, product_tags ? JSON.stringify(product_tags) : null,
       status, res.ig_media_id || null, res.permalink || null, res.error || res.skipped || null,
       created_by || null, res.ok ? new Date() : null])).rows[0];
    return { ...row, _result: res };
  }
  const row = (await getPool().query(
    `INSERT INTO instagram_scheduled_posts
       (media_type,image_url,video_url,children,caption,product_tags,scheduled_at,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8) RETURNING *`,
    [mt, image_url || null, video_url || null, children ? JSON.stringify(children) : null,
     caption || null, product_tags ? JSON.stringify(product_tags) : null, scheduled_at, created_by || null])).rows[0];
  return row;
}

async function listScheduled({ status, limit = 50 } = {}) {
  const cond = ['tenant_id=current_tenant_id()'];
  const params = [];
  if (status) { params.push(status); cond.push(`status=$${params.length}`); }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  return (await getPool().query(
    `SELECT * FROM instagram_scheduled_posts WHERE ${cond.join(' AND ')}
      ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ${lim}`, params)).rows;
}

async function cancelScheduled(id) {
  const r = await getPool().query(
    `UPDATE instagram_scheduled_posts SET status='canceled'
       WHERE id=$1 AND tenant_id=current_tenant_id() AND status='scheduled' RETURNING id`, [id]);
  return r.rowCount > 0;
}

// Cron: опублікувати всі дозрілі заплановані пости. Глобальний read,
// публікація у контексті тенанта через runAs (як meta-ads/google-ads).
async function runScheduled() {
  const due = (await query(
    `SELECT id, tenant_id FROM instagram_scheduled_posts
      WHERE status='scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= now()
      ORDER BY scheduled_at LIMIT 100`)).rows;
  if (!due.length) return { due: 0, published: 0 };
  const { runAs } = require('./tenant');
  let published = 0;
  for (const d of due) {
    try {
      await runAs(d.tenant_id, async () => {
        const pool = getPool();
        // атомарно беремо в роботу, щоб не публікувати двічі
        const lock = await pool.query(
          `UPDATE instagram_scheduled_posts SET status='publishing'
            WHERE id=$1 AND status='scheduled' RETURNING *`, [d.id]);
        if (!lock.rowCount) return;
        const p = lock.rows[0];
        const res = await publishNow({
          media_type: p.media_type, image_url: p.image_url, video_url: p.video_url,
          caption: p.caption, children: p.children, product_tags: p.product_tags });
        if (res.ok) {
          await pool.query(
            `UPDATE instagram_scheduled_posts SET status='published', ig_media_id=$2, permalink=$3, published_at=now(), error=NULL WHERE id=$1`,
            [p.id, res.ig_media_id, res.permalink || null]);
          published++;
        } else {
          // not-connected → повертаємо у scheduled (спробуємо пізніше); інакше failed
          const back = res.skipped ? 'scheduled' : 'failed';
          await pool.query(
            `UPDATE instagram_scheduled_posts SET status=$2, error=$3 WHERE id=$1`,
            [p.id, back, res.error || res.skipped || 'unknown']);
        }
      });
    } catch (e) { console.error('[ig-content] runScheduled', d.id, e.message); }
  }
  return { due: due.length, published };
}

/* ── Зведення для дашборда ─────────────────────────────────── */
async function summary() {
  const insights = await accountInsights({ days: 28 }).catch(() => ({ error: 'insights-failed' }));
  const scheduledCount = (await getPool().query(
    `SELECT count(*)::int n FROM instagram_scheduled_posts
       WHERE tenant_id=current_tenant_id() AND status='scheduled'`)).rows[0].n;
  return { insights, scheduled_count: scheduledCount };
}

module.exports = {
  channel, accountInsights, listMedia, mediaInsights,
  publishNow, schedulePost, listScheduled, cancelScheduled, runScheduled, summary,
};
