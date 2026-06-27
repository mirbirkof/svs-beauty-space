/* SVS Beauty Space — LIVE API helper (без статичних даних)
   Дані каталогу беремо з статичного shop-data.js (генерується watchdog'ом з БД).
   Цей файл лише ХЕЛПЕР для API-викликів: створити замовлення, логін, верифікація.
   Завантажується async — не блокує рендер вітрини.
*/
(function () {
  // Відмовостійкий доступ до CRM: основний Render → резервний, якщо основний лежить.
  // Живий адрес кешуємо в sessionStorage, щоб не пінгувати щоразу.
  var ENDPOINTS = ['https://svs-shop-api.onrender.com', 'https://svs-shop-api-backup.onrender.com'];
  function liveBase() {
    try { var c = sessionStorage.getItem('svs_shop_base'); if (c && ENDPOINTS.indexOf(c) >= 0) return c; } catch (e) {}
    return ENDPOINTS[0];
  }
  function svsFetch(path, opts) {
    var eps = ENDPOINTS.slice(), cached = liveBase();
    var ci = eps.indexOf(cached); if (ci > 0) { eps.splice(ci, 1); eps.unshift(cached); }
    var i = 0;
    function go() {
      return fetch(eps[i] + path, opts).then(function (r) {
        if (r.status >= 500 && i < eps.length - 1) { i++; return go(); }
        try { if (r.ok) sessionStorage.setItem('svs_shop_base', eps[i]); } catch (e) {}
        return r;
      }).catch(function (e) { if (i < eps.length - 1) { i++; return go(); } throw e; });
    }
    return go();
  }

  function api(path, opts) {
    opts = opts || {};
    return svsFetch(path, Object.assign({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, opts)).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'invalid-json' }; }); });
  }

  window.SVS_API = {
    baseUrl: liveBase(),
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
      return svsFetch('/api/catalog/legacy/all', { method: 'GET' }).then(function (r) { return r.json(); })
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
