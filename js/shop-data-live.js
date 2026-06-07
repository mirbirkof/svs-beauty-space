/* SVS Beauty Space — LIVE API helper (без статичних даних)
   Дані каталогу беремо з статичного shop-data.js (генерується watchdog'ом з БД).
   Цей файл лише ХЕЛПЕР для API-викликів: створити замовлення, логін, верифікація.
   Завантажується async — не блокує рендер вітрини.
*/
(function () {
  var FALLBACK_API = 'https://8a320a5167aa06.lhr.life'; // hardcoded fallback

  function api(path, opts) {
    opts = opts || {};
    var url = FALLBACK_API + path;
    return fetch(url, Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, opts)).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'invalid-json' }; }); });
  }

  window.SVS_API = {
    baseUrl: FALLBACK_API,
    createOrder: function (payload) {
      return api('/api/orders', { body: JSON.stringify(payload) });
    },
    requestCode: function (phone) {
      return api('/api/cabinet/request-code', { body: JSON.stringify({ phone: phone }) });
    },
    verifyCode: function (phone, code) {
      return api('/api/cabinet/verify', { body: JSON.stringify({ phone: phone, code: code }) });
    },
    refreshStock: function () {
      return fetch(FALLBACK_API + '/api/catalog/legacy/all').then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.products || !window.SHOP_PRODUCTS) return;
          var byId = {};
          d.products.forEach(function (p) { byId[p.id] = p; });
          window.SHOP_PRODUCTS.forEach(function (p) {
            var fresh = byId[p.id];
            if (!fresh) return;
            (p.volumes || []).forEach(function (v, i) {
              var fv = (fresh.volumes || [])[i];
              if (fv) { v.price = fv.price; v.stock = fv.stock; }
            });
          });
          window.SHOP_DATA_REFRESHED = new Date().toISOString();
          console.log('[shop-data-live] stock refreshed from API');
        }).catch(function (e) { console.warn('[shop-data-live] refresh skip:', e.message); });
    }
  };

  // Авто-освіження залишків після завантаження (не блокуюче)
  setTimeout(function () { try { window.SVS_API.refreshStock(); } catch (e) {} }, 1500);
})();
