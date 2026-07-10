/* tenant-boot.js — единая мультитенантность для всех фронт-страниц (пресейл-блокер #7).
 *
 * Проблема: только admin/index.html и qa.html слали X-Tenant-Slug. Остальные страницы
 * (кабинет мастера, публичная запись, ~12 админ-подстраниц) заголовок не слали → сервер
 * резолвил дефолтный салон (Босса): мастер арендатора получал 401 → logout-цикл, а
 * публичная запись показывала услуги Босса всем салонам.
 *
 * Решение: подключить этот скрипт ПЕРВЫМ на странице. Он определяет slug салона из
 * ?tenant=<slug> в URL (и кэширует его), либо из ранее сохранённого localStorage, и
 * оборачивает window.fetch так, что КО ВСЕМ запросам к /api/ добавляется X-Tenant-Slug.
 * Если slug не определён (владелец основного салона — без ?tenant=) — ничего не меняется,
 * поведение идентично прежнему (дефолтный тенант).
 */
(function () {
  var slug = '';
  try {
    var q = new URLSearchParams(location.search).get('tenant');
    if (q) { localStorage.setItem('svs_tenant_slug', q); slug = q; }
    else { slug = localStorage.getItem('svs_tenant_slug') || ''; }
  } catch (e) { /* приватный режим и т.п. */ }
  window.__tenantSlug = slug;
  window.tenantHeader = function () { return slug ? { 'X-Tenant-Slug': slug } : {}; };
  if (!slug || !window.fetch) return;

  var _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      if (url.indexOf('/api/') !== -1) {
        init = init || {};
        var src = (init && init.headers) || (typeof input === 'object' && input && input.headers) || {};
        var h = new Headers(src);
        if (!h.has('X-Tenant-Slug')) h.set('X-Tenant-Slug', slug);
        init.headers = h;
        // если передавали Request-объект + init.headers — fetch применит init.headers
      }
    } catch (e) { /* не мешаем запросу при любой ошибке обёртки */ }
    return _fetch.call(this, input, init);
  };
})();
