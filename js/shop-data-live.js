/* SVS Beauty Space — LIVE catalog loader
   Заміняє статичний shop-data.js, тягне дані з backend API в реальному часі.
   Fallback: якщо API недоступний — намагається завантажити локальний shop-data.js.
*/

(function () {
  var API_URL_FILE = 'tunnel-url.txt'; // optional: file with current tunnel URL
  var FALLBACK_API = 'https://df8c25eb133af2.lhr.life'; // hardcoded fallback
  var ENDPOINT = '/api/catalog/legacy/all';

  function loadFromAPI(baseUrl) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', baseUrl + ENDPOINT, false); // sync
      xhr.timeout = 5000;
      xhr.send(null);
      if (xhr.status !== 200) return null;
      var data = JSON.parse(xhr.responseText);
      if (!data || !data.products) return null;
      return data;
    } catch (e) {
      console.warn('[shop-data-live] API error:', e.message);
      return null;
    }
  }

  function applyData(data) {
    window.SHOP_BRANDS = data.brands || [];
    window.SHOP_CATEGORIES = data.categories || [];
    window.SHOP_CATEGORY_GROUPS = data.category_groups || [];
    // Normalize: legacy adapter returns volumes with .v / .price / .wholesale / .stock
    window.SHOP_PRODUCTS = (data.products || []).map(function (p) {
      return {
        id: p.id,
        name: p.name,
        brand: p.brand,
        category: p.category,
        photo: p.photo,
        desc: p.desc || '',
        volumes: (p.volumes || []).map(function (v) {
          return {
            v: v.v,
            price: v.price,
            wholesale: v.wholesale,
            stock: v.stock || 0,
            variant_id: v.variant_id || null
          };
        })
      };
    });
    window.SHOP_DATA_SOURCE = 'live';
    window.SHOP_DATA_FETCHED_AT = data.generated_at || new Date().toISOString();
    console.log('[shop-data-live] loaded', window.SHOP_PRODUCTS.length, 'products from API');
  }

  function loadFallbackStatic() {
    // Підвантажуємо синхронно старий shop-data.js
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'js/shop-data.js', false);
      xhr.send(null);
      if (xhr.status === 200) {
        // eslint-disable-next-line no-eval
        eval(xhr.responseText);
        window.SHOP_DATA_SOURCE = 'static-fallback';
        console.warn('[shop-data-live] using static fallback');
        return true;
      }
    } catch (e) { console.error('[shop-data-live] fallback failed:', e.message); }
    return false;
  }

  // Try live first
  var data = loadFromAPI(FALLBACK_API);
  if (data) {
    applyData(data);
  } else {
    loadFallbackStatic();
  }

  // Expose helper for cart -> order via API
  window.SVS_API = {
    baseUrl: FALLBACK_API,
    createOrder: function (payload) {
      return fetch(FALLBACK_API + '/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); });
    },
    requestCode: function (phone) {
      return fetch(FALLBACK_API + '/api/cabinet/request-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone })
      }).then(function (r) { return r.json(); });
    },
    verifyCode: function (phone, code) {
      return fetch(FALLBACK_API + '/api/cabinet/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, code: code })
      }).then(function (r) { return r.json(); });
    }
  };
})();
