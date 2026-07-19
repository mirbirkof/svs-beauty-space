/* ═══ РЕЄСТР РОЗШИРЕНИХ МОДУЛІВ ═══════════════════════════════
 * Дає змогу додавати UI нових backend-модулів окремими файлами,
 * не чіпаючи монолітний index.html. Кожен модуль викликає
 * registerModule({page,title,group,icon,section,loader}).
 * __bootModules() інжектить пункти меню, секції сторінок,
 * заголовки та розширені завантажувачі (window.extLoaders).
 * ───────────────────────────────────────────────────────────── */
(function () {
  window.extLoaders = window.extLoaders || {};
  window.__modRegistry = window.__modRegistry || [];

  // Опис груп лівого меню для нових модулів
  var GROUPS = {
    analytics: { id: 'grp-ext-analytics', title: 'Аналітика та AI', icon: 'insights' },
    platform:  { id: 'grp-ext-platform',  title: 'Платформа та інфраструктура', icon: 'dns' },
    // існуючі групи моноліту — модульні сторінки інжектяться в них,
    // щоб «Аналітика та AI» не була звалищем фінансів і маркетингу
    finance:   { id: 'grp-finance',   title: 'Фінанси',   icon: 'payments' },
    marketing: { id: 'grp-marketing', title: 'Маркетинг', icon: 'campaign' },
    // вертикалі (18.07): групу видно ЛИШЕ своєму business_type — pre-hide за
    // localStorage (проти мигання), авторитетно показує/ховає applyEntitlements
    fitness:   { id: 'grp-fitness',   title: 'Фітнес',        icon: 'fitness_center', vertical: 'fitness' },
    dental:    { id: 'grp-dental',    title: 'Стоматологія',  icon: 'medical_services', vertical: 'dental' },
    wellness:  { id: 'grp-wellness',  title: 'Велнес',        icon: 'spa', vertical: 'wellness' }
  };

  window.registerModule = function (cfg) {
    if (!cfg || !cfg.page) return;
    window.__modRegistry.push(cfg);
  };

  // спільні хелпери для модулів (дублюють стиль монолітних loader'ів)
  window.modEsc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  window.modEmpty = function (msg) {
    return '<div style="padding:40px;text-align:center;color:#9aa0a6">' + (msg || 'Поки що порожньо') + '</div>';
  };
  window.modErr = function (el, e) {
    if (el) el.innerHTML = '<div style="padding:30px;text-align:center;color:#d9534f">Помилка завантаження: ' +
      window.modEsc((e && e.message) || e || 'невідома') + '</div>';
  };
  window.modCard = function (title, value, color) {
    return '<div class="card" style="flex:1;min-width:150px;padding:16px">' +
      '<div style="font-size:12px;color:#888">' + window.modEsc(title) + '</div>' +
      '<div style="font-size:26px;font-weight:700;color:' + (color || '#222') + '">' + (value == null ? '—' : value) + '</div></div>';
  };
  // безпечний виклик API (використовує глобальний api() монолітної адмінки)
  window.modApi = function (path, opts) {
    if (typeof api === 'function') return api(path, opts);
    return Promise.reject(new Error('api() недоступний'));
  };

  function ensureGroup(key) {
    var g = GROUPS[key] || GROUPS.analytics;
    var existing = document.getElementById(g.id);
    if (existing) return existing.querySelector('.sidebar-group-items');

    // контейнер навігації — батько будь-якої наявної групи меню
    var anyGroup = document.querySelector('.sidebar-group');
    if (!anyGroup) return null;
    var nav = anyGroup.parentNode;

    var wrap = document.createElement('div');
    wrap.className = 'sidebar-group';
    wrap.id = g.id;
    try {
      var curVert = window.BUSINESS_TYPE || localStorage.getItem('svs_vertical');
      if (g.vertical && curVert !== g.vertical) wrap.style.display = 'none';
    } catch (_e) {}
    wrap.innerHTML =
      '<div class="sidebar-group-header" onclick="toggleSidebarGroup(this)">' +
        '<span class="material-icons-round">' + g.icon + '</span>' +
        '<span class="lbl">' + g.title + '</span>' +
        '<span class="material-icons-round chevron">chevron_right</span>' +
      '</div>' +
      '<div class="sidebar-group-items"></div>';

    // вставляємо перед групою «Система»/«Налаштування», якщо знайдемо; інакше — в кінець
    var settingsItem = document.querySelector('.sidebar-item[data-page="settings"]');
    var settingsGroup = settingsItem ? settingsItem.closest('.sidebar-group') : null;
    if (settingsGroup && settingsGroup.parentNode === nav) nav.insertBefore(wrap, settingsGroup);
    else nav.appendChild(wrap);

    return wrap.querySelector('.sidebar-group-items');
  }

  function ensureSection(cfg) {
    var id = 'page-' + cfg.page;
    if (document.getElementById(id)) return;
    var anyPage = document.querySelector('.page');
    if (!anyPage) return;
    var host = anyPage.parentNode;
    var sec = document.createElement('div');
    sec.className = 'page';
    sec.id = id;
    sec.innerHTML =
      '<div class="page-head" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
        '<h2 style="margin:0;font-size:20px;font-weight:700">' + window.modEsc(cfg.title) + '</h2></div>' +
      '<div class="ext-mod-body">' + (cfg.section || '') + '</div>';
    host.appendChild(sec);
  }

  function addMenuItem(cfg, itemsBox) {
    if (!itemsBox) return;
    if (itemsBox.querySelector('.sidebar-item[data-page="' + cfg.page + '"]')) return;
    var a = document.createElement('a');
    a.className = 'sidebar-item';
    a.setAttribute('data-page', cfg.page);
    // owner-only модульний пункт (напр. Маркетинг-центр) — ховаємо адмінам через CSS
    // body.role-nonowner (Босс 19.07: «адміну маркетинг-центр бачити необовʼязково»).
    if (cfg.ownerOnly) a.setAttribute('data-owneronly', '1');
    a.setAttribute('onclick', "go('" + cfg.page + "')");
    a.innerHTML = '<span class="material-icons-round">' + (cfg.icon || 'widgets') + '</span>' +
      '<span class="lbl">' + window.modEsc(cfg.title) + '</span>';
    itemsBox.appendChild(a);
  }

  window.__bootModules = function () {
    var reg = window.__modRegistry || [];
    for (var i = 0; i < reg.length; i++) {
      var cfg = reg[i];
      try {
        // заголовок сторінки (pageTitles — глобальний const монолітної адмінки)
        try { if (typeof pageTitles !== 'undefined') pageTitles[cfg.page] = cfg.title; } catch (_e) {}
        // завантажувач
        if (typeof cfg.loader === 'function') window.extLoaders[cfg.page] = cfg.loader;
        // секція сторінки
        ensureSection(cfg);
        // пункт меню
        var box = ensureGroup(cfg.group);
        addMenuItem(cfg, box);
      } catch (e) { /* один битий модуль не валить решту */ }
    }
    // якщо адреса вже вказує на новий модуль — відкриваємо його
    try {
      var h = (location.hash || '').replace('#', '');
      if (h && window.extLoaders[h] && typeof go === 'function') go(h);
    } catch (_e2) {}
  };
})();
