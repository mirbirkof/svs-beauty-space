/* routes/booking-catalog.js — публічний каталог для онлайн-запису (БЕЗ авторизації).
   Джерело правди — НАША БД: послуги + реальна звʼязка майстер↔послуга (master_services).
   Віддає лише активних майстрів з увімкненим онлайн-записом, що реально надають послугу.
   id послуг/майстрів = beautypro_id (GUID) щоб /slots на booking-api приймав їх напряму. */
const express = require('express');
const { getPool } = require('../db-pg');
const router = express.Router();
const pool = getPool();

router.get('/catalog', async (req, res) => {
  try {
    const svc = await pool.query(`
      SELECT COALESCE(s.beautypro_id::text,'svc-'||s.id) AS id, s.name,
             COALESCE(s.name_ua,s.name) AS name_ua, s.duration_min AS duration,
             s.price::float AS price, s.category, s.color, s.photo_urls
        FROM services s
       WHERE s.active IS NOT FALSE AND s.deleted_at IS NULL
         -- лише послуги, які реально надає хоча б один активний майстер з онлайн-записом
         -- (інакше клієнт бачить послугу, але записатися нема до кого = тупик)
         AND EXISTS (
           SELECT 1 FROM master_services ms
             JOIN masters m ON m.id = ms.master_id
            WHERE ms.service_id = s.id AND ms.active IS NOT FALSE
              AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE)
       ORDER BY s.sort_order NULLS LAST, s.name`);

    const mst = await pool.query(`
      SELECT COALESCE(m.beautypro_id::text,'mst-'||m.id) AS id,
             COALESCE(NULLIF(m.online_title,''), m.name) AS name,
             m.specialty, m.avatar, m.online_rank,
             COALESCE(
               json_agg(COALESCE(s.beautypro_id::text,'svc-'||s.id))
                 FILTER (WHERE s.id IS NOT NULL), '[]'
             ) AS services
        FROM masters m
        JOIN master_services ms ON ms.master_id = m.id AND ms.active IS NOT FALSE
        JOIN services s ON s.id = ms.service_id AND s.active IS NOT FALSE AND s.deleted_at IS NULL
       WHERE m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE
       GROUP BY m.id
       ORDER BY m.online_rank NULLS LAST, name`);

    res.set('Cache-Control', 'public, max-age=120');
    res.json({ services: svc.rows, masters: mst.rows, source: 'crm-db' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /catalog/services — публічний пошук/фільтр/сортування/пагінація послуг.

   Тенант-ізоляція: запит іде через getPool() у HTTP-контексті tenantMiddleware,
   db-pg обгортає кожен query транзакцією з SET LOCAL ROLE app_tenant + GUC
   app.tenant_id → RLS (міграція 015) віддає ЛИШЕ послуги поточного салону.
   Усі параметри передаються через $1..$N (без конкатенації) — захист від SQLi.

   Query-параметри (усі опційні):
     q          — пошук по name / name_ua / name_en / description (ILIKE)
     category   — точна категорія (services.category)
     master_id  — фільтр по майстру (внутрішній masters.id АБО beautypro_id)
     price_min  — мінімальна ціна (грн)
     price_max  — максимальна ціна (грн)
     sort       — price_asc | price_desc | name | popular (дефолт: ручний порядок)
     page       — сторінка з 1 (дефолт 1)
     limit      — розмір сторінки (дефолт 50, max 100)
   ───────────────────────────────────────────────────────────────────── */
router.get('/catalog/services', async (req, res) => {
  try {
    const { q, category } = req.query;

    // Пагінація: клампимо limit у [1..100], page ≥ 1.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    // Діапазон ціни: тільки скінченні невідʼємні числа.
    const priceMin = Number.isFinite(parseFloat(req.query.price_min)) && parseFloat(req.query.price_min) >= 0
      ? parseFloat(req.query.price_min) : null;
    const priceMax = Number.isFinite(parseFloat(req.query.price_max)) && parseFloat(req.query.price_max) >= 0
      ? parseFloat(req.query.price_max) : null;

    const conds = [
      's.active IS NOT FALSE',
      's.deleted_at IS NULL',
      // лише послуги, які реально надає хоча б один активний майстер з онлайн-записом
      `EXISTS (
         SELECT 1 FROM master_services ms
           JOIN masters m ON m.id = ms.master_id
          WHERE ms.service_id = s.id AND ms.active IS NOT FALSE
            AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE)`,
    ];
    const params = [];

    if (q && String(q).trim()) {
      params.push('%' + String(q).trim().toLowerCase() + '%');
      const p = '$' + params.length;
      conds.push(`(LOWER(s.name) LIKE ${p}
                  OR LOWER(COALESCE(s.name_ua,'')) LIKE ${p}
                  OR LOWER(COALESCE(s.name_en,'')) LIKE ${p}
                  OR LOWER(COALESCE(s.description,'')) LIKE ${p})`);
    }
    if (category && String(category).trim()) {
      params.push(String(category).trim());
      conds.push(`s.category = $${params.length}`);
    }
    if (priceMin != null) { params.push(priceMin); conds.push(`s.price >= $${params.length}`); }
    if (priceMax != null) { params.push(priceMax); conds.push(`s.price <= $${params.length}`); }
    if (req.query.master_id && String(req.query.master_id).trim()) {
      // приймаємо і внутрішній id (число), і beautypro_id (GUID/текст)
      params.push(String(req.query.master_id).trim());
      const mp = '$' + params.length;
      conds.push(`EXISTS (
         SELECT 1 FROM master_services ms2
           JOIN masters m2 ON m2.id = ms2.master_id
          WHERE ms2.service_id = s.id AND ms2.active IS NOT FALSE
            AND m2.active IS NOT FALSE AND m2.online_booking_enabled IS NOT FALSE
            AND (m2.id::text = ${mp} OR m2.beautypro_id::text = ${mp}))`);
    }

    const where = conds.join(' AND ');

    // Сортування — лише з білого списку (без інтерполяції вводу в SQL).
    const sortMap = {
      price_asc: 's.price ASC NULLS LAST, s.name',
      price_desc: 's.price DESC NULLS LAST, s.name',
      name: 'COALESCE(s.name_ua, s.name) ASC',
      popular: 'popularity DESC, s.sort_order NULLS LAST, s.name',
    };
    const orderBy = sortMap[req.query.sort] || 's.sort_order NULLS LAST, s.name';

    // popularity рахуємо тільки коли реально сортуємо по ній (економимо JOIN).
    const popSelect = req.query.sort === 'popular'
      ? `, (SELECT COUNT(*) FROM online_bookings ob WHERE ob.service_id = COALESCE(s.beautypro_id::text, 'svc-'||s.id)) AS popularity`
      : '';

    params.push(limit); const lp = params.length;
    params.push(offset); const op = params.length;

    const rows = await pool.query(`
      SELECT COALESCE(s.beautypro_id::text,'svc-'||s.id) AS id, s.id AS internal_id,
             s.name, COALESCE(s.name_ua,s.name) AS name_ua, s.name_en,
             s.description, s.slug, s.duration_min AS duration,
             s.price::float AS price, s.category, s.color, s.photo_urls,
             s.is_new, s.is_hit, s.is_discounted${popSelect}
        FROM services s
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT $${lp} OFFSET $${op}`, params);

    const cnt = await pool.query(
      `SELECT COUNT(*)::int AS total FROM services s WHERE ${where}`,
      params.slice(0, params.length - 2));
    const total = cnt.rows[0].total;

    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      items: rows.rows,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 1,
      has_more: offset + rows.rows.length < total,
      source: 'crm-db',
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /catalog/seo — SEO-метадані каталогу (загальні OG-теги салону)
   GET /catalog/seo/:id — SEO-метадані конкретної послуги (за beautypro_id або id)

   Повертає title, description, OG-теги та JSON-LD у форматі JSON, щоб фронт/SSR
   міг віддати правильні meta-теги. Тенант-ізоляція — через RLS (як вище).
   ───────────────────────────────────────────────────────────────────── */
async function tenantBrand() {
  // Назва салону для OG: беремо з tenants поточного контексту (RLS лишає 1 рядок).
  try {
    const t = await pool.query(
      `SELECT name, slug FROM tenants WHERE id = current_setting('app.tenant_id', true)::uuid LIMIT 1`);
    return t.rows[0] || null;
  } catch (_) { return null; }
}

router.get('/catalog/seo', async (req, res) => {
  try {
    const brand = await tenantBrand();
    const salon = (brand && brand.name) || 'Салон краси';
    const cnt = await pool.query(`
      SELECT COUNT(*)::int AS total FROM services s
       WHERE s.active IS NOT FALSE AND s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM master_services ms JOIN masters m ON m.id = ms.master_id
                      WHERE ms.service_id = s.id AND ms.active IS NOT FALSE
                        AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE)`);
    const total = cnt.rows[0].total;
    const title = `Послуги та ціни — ${salon}`;
    const description = `Онлайн-каталог послуг ${salon}: ${total} послуг, актуальні ціни, запис онлайн до майстра у зручний час.`;
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      title,
      description,
      og: {
        'og:type': 'website',
        'og:title': title,
        'og:description': description,
        'og:site_name': salon,
      },
      twitter: { 'twitter:card': 'summary', 'twitter:title': title, 'twitter:description': description },
      services_count: total,
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

router.get('/catalog/seo/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const r = await pool.query(`
      SELECT COALESCE(s.beautypro_id::text,'svc-'||s.id) AS id,
             s.name, COALESCE(s.name_ua,s.name) AS name_ua,
             s.description, s.meta_title, s.meta_description,
             s.price::float AS price, s.duration_min AS duration,
             s.photo_urls, s.category
        FROM services s
       WHERE s.active IS NOT FALSE AND s.deleted_at IS NULL
         AND (s.beautypro_id::text = $1 OR ('svc-'||s.id) = $1 OR s.id::text = $1)
       LIMIT 1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'not_found' });
    const s = r.rows[0];
    const brand = await tenantBrand();
    const salon = (brand && brand.name) || 'Салон краси';
    const svcName = s.name_ua || s.name;
    const title = s.meta_title || `${svcName} — ${salon}`;
    const description = s.meta_description
      || (s.description ? String(s.description).slice(0, 300)
          : `${svcName} у ${salon}. Ціна ${s.price} грн, тривалість ${s.duration} хв. Запис онлайн.`);
    let image = null;
    try {
      const arr = typeof s.photo_urls === 'string' ? JSON.parse(s.photo_urls) : s.photo_urls;
      if (Array.isArray(arr) && arr.length) image = arr[0];
    } catch (_) {}
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      title,
      description,
      og: {
        'og:type': 'product',
        'og:title': title,
        'og:description': description,
        'og:site_name': salon,
        ...(image ? { 'og:image': image } : {}),
      },
      jsonld: {
        '@context': 'https://schema.org',
        '@type': 'Service',
        name: svcName,
        description,
        category: s.category || undefined,
        provider: { '@type': 'BeautySalon', name: salon },
        offers: { '@type': 'Offer', price: s.price, priceCurrency: 'UAH' },
      },
    });
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /catalog/sitemap.xml — sitemap публічних послуг поточного тенанта.
   Тенант-ізоляція через RLS. Базовий URL — з заголовків запиту (host тенанта).
   ───────────────────────────────────────────────────────────────────── */
router.get('/catalog/sitemap.xml', async (req, res) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.get('host') || '';
    const base = host ? `${proto}://${host}` : '';
    const r = await pool.query(`
      SELECT COALESCE(s.slug, COALESCE(s.beautypro_id::text,'svc-'||s.id)) AS ref,
             s.updated_at
        FROM services s
       WHERE s.active IS NOT FALSE AND s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM master_services ms JOIN masters m ON m.id = ms.master_id
                      WHERE ms.service_id = s.id AND ms.active IS NOT FALSE
                        AND m.active IS NOT FALSE AND m.online_booking_enabled IS NOT FALSE)
       ORDER BY s.sort_order NULLS LAST, s.name`);
    const esc = (str) => String(str).replace(/[<>&'"]/g, (c) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
    const urls = r.rows.map((row) => {
      const loc = esc(`${base}/services/${row.ref}`);
      const lastmod = row.updated_at ? `\n    <lastmod>${new Date(row.updated_at).toISOString().slice(0, 10)}</lastmod>` : '';
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    res.send(xml);
  } catch (e) {
    console.error(e); res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : e.message });
  }
});

module.exports = router;
