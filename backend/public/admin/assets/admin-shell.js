/* SVS Beauty CRM — общий каркас для отдельных страниц админки.
   Подключение в <head>:
     <link rel="stylesheet" href="/admin/assets/admin-shell.css">
   В конце <body>:
     <script src="/admin/assets/admin-shell.js" data-title="Назва сторінки"></script>
   Контент страницы должен лежать в <div class="content"> (шелл обернёт его в .main). */
(function () {
  const NAV = [
    { section: 'Головне' },
    { icon: 'dashboard', label: 'Дашборд', href: '/admin/index.html#dashboard' },
    { icon: 'event_note', label: 'Журнал записів', href: '/admin/index.html#journal' },
    { icon: 'people', label: 'Клієнти', href: '/admin/index.html#clients' },
    { section: 'Салон' },
    { icon: 'queue', label: 'Лист очікування', href: '/admin/index.html#waitlist' },
    { icon: 'notifications_active', label: 'Нагадування', href: '/admin/index.html#reminders' },
    { icon: 'replay', label: 'Повторні візити', href: '/admin/index.html#repeat' },
    { icon: 'payments', label: 'Зарплата', href: '/admin/index.html#payroll' },
    { icon: 'block', label: 'Чорний список', href: '/admin/index.html#blacklist' },
    { icon: 'reviews', label: 'Відгуки / Промо (запис)', href: '/admin/dikidi.html' },
    { section: 'SVS Beauty World' },
    { icon: 'shopping_bag', label: 'Замовлення', href: '/admin/index.html#orders' },
    { icon: 'inventory_2', label: 'Товари', href: '/admin/index.html#products' },
    { icon: 'warehouse', label: 'Склад', href: '/admin/index.html#stock' },
    { icon: 'fact_check', label: 'Інвентаризація', href: '/admin/crm-extra.html#inventory' },
    { icon: 'local_offer', label: 'Акції / Промокоди', href: '/admin/index.html#promos' },
    { icon: 'star_rate', label: 'Відгуки (магазин)', href: '/admin/index.html#reviews' },
    { icon: 'point_of_sale', label: 'Каса магазину', href: '/admin/crm-extra.html#cashbox' },
    { section: 'Фінанси' },
    { icon: 'point_of_sale', label: 'Каса (загальна)', href: '/admin/crm-extra.html' },
    { icon: 'insights', label: 'Звіти (P&L, RFM)', href: '/admin/crm-extra.html#reports' },
    { icon: 'file_download', label: 'Експорт CSV', href: '/admin/export.html' },
    { section: 'Система' },
    { icon: 'monitor_heart', label: 'Системний статус', href: '/admin/dashboard.html' },
    { icon: 'store', label: 'Філії', href: '/admin/crm-extra.html#branches' },
    { icon: 'manage_accounts', label: 'Користувачі', href: '/admin/crm-extra.html#users' },
    { icon: 'sync', label: 'BeautyPro синхро', href: '/admin/index.html#sync' },
    { icon: 'history', label: 'Аудит', href: '/admin/crm-extra.html#audit' },
  ];

  // ── Единый токен (миграция со старого ключа admin_token) ──
  const old = localStorage.getItem('admin_token');
  if (old && !localStorage.getItem('svs_admin_token')) localStorage.setItem('svs_admin_token', old);
  window.adminToken = () => localStorage.getItem('svs_admin_token') || '';
  window.adminLogout = function () {
    localStorage.removeItem('svs_admin_token');
    localStorage.removeItem('admin_token');
    location.href = '/admin/index.html';
  };
  window.adminFetch = function (path, opts = {}) {
    return fetch(path, {
      ...opts,
      headers: { 'X-Admin-Token': adminToken(), 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  };

  // ── Рендер шелла ──
  const here = location.pathname.replace(/\/+$/, '');
  const items = NAV.map((n) => {
    if (n.section) return `<div class="sidebar-section">${n.section}</div>`;
    const active = !n.href.includes('#') && n.href.replace(/\/+$/, '') === here ? ' active' : '';
    const ext = n.href.startsWith('http') ? ' target="_blank"' : '';
    return `<a class="sidebar-item${active}" href="${n.href}"${ext}><span class="material-icons-round">${n.icon}</span> ${n.label}</a>`;
  }).join('');

  const aside = document.createElement('aside');
  aside.className = 'sidebar';
  aside.id = 'svsSidebar';
  aside.innerHTML =
    '<div class="sidebar-logo"><h1>SVS Beauty</h1><span>CRM &amp; Управління</span></div>' +
    '<nav class="sidebar-nav">' + items + '</nav>' +
    '<div class="sidebar-footer"><button onclick="adminLogout()">' +
    '<span class="material-icons-round" style="font-size:18px">logout</span> Вийти</button></div>';

  const me = document.currentScript;
  const title = (me && me.dataset.title) || document.title || '';

  // Обернуть контент в .main + topbar
  const main = document.createElement('div');
  main.className = 'main';
  main.innerHTML =
    '<div class="topbar"><button class="burger" onclick="document.getElementById(\'svsSidebar\').classList.toggle(\'open\')">' +
    '<span class="material-icons-round">menu</span></button><h2>' + title + '</h2></div>';

  const body = document.body;
  const content = document.querySelector('.content');
  if (content) {
    content.parentNode.removeChild(content);
    main.appendChild(content);
  } else {
    // обернуть всё содержимое body
    const wrap = document.createElement('div');
    wrap.className = 'content';
    while (body.firstChild) wrap.appendChild(body.firstChild);
    main.appendChild(wrap);
  }
  body.appendChild(aside);
  body.appendChild(main);

  // Закрытие меню по клику мимо (мобайл)
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 900) return;
    if (!aside.contains(e.target) && !e.target.closest('.burger')) aside.classList.remove('open');
  });

  // Шрифты/иконки, если страница их не подключила
  if (!document.querySelector('link[href*="Material+Icons"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/icon?family=Material+Icons+Round';
    document.head.appendChild(l);
  }
  if (!document.querySelector('link[href*="family=Inter"]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(l);
  }
})();
