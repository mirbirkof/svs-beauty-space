/* SVS Beauty CRM — общий каркас для отдельных страниц админки.
   Подключение в <head>:
     <link rel="stylesheet" href="/admin/assets/admin-shell.css">
   В конце <body>:
     <script src="/admin/assets/admin-shell.js" data-title="Назва сторінки"></script>
   Контент страницы должен лежать в <div class="content"> (шелл обернёт его в .main). */
(function () {
  // Якщо сторінка відкрита ВСЕРЕДИНІ iframe (єдиний каркас index.html) — НЕ малюємо
  // власне ліве меню й topbar: вони вже є у батьківському вікні. Лишаємо тільки контент.
  const EMBEDDED = window.self !== window.top;
  // Единое меню в стиле DIKIDI — зеркало admin/index.html.
  const NAV = [
    { icon: 'dashboard', label: 'Дашборд', href: '/admin/index.html#dashboard' },
    { icon: 'event_note', label: 'Журнал записів', href: '/admin/index.html#journal' },
    { icon: 'calendar_month', label: 'Графік роботи', href: '/admin/index.html#settings' },
    { icon: 'content_cut', label: 'Послуги', href: '/admin/index.html#services' },
    { icon: 'account_tree', label: 'Категорії послуг', href: '/admin/index.html#svccats' },
    { group: 'Клієнти', icon: 'people', items: [
      { icon: 'groups', label: 'Усі клієнти', href: '/admin/index.html#clients' },
      { icon: 'queue', label: 'Лист очікування', href: '/admin/index.html#waitlist' },
      { icon: 'replay', label: 'Повторні візити', href: '/admin/index.html#repeat' },
      { icon: 'block', label: 'Чорний список', href: '/admin/index.html#blacklist' },
    ] },
    { group: 'Просування', icon: 'campaign', items: [
      { icon: 'local_offer', label: 'Акції / Промокоди', href: '/admin/index.html#promos' },
      { icon: 'star_rate', label: 'Відгуки', href: '/admin/index.html#reviews' },
      { icon: 'reviews', label: 'Відгуки / Промо (запис)', href: '/admin/dikidi.html' },
    ] },
    { group: 'Спілкування', icon: 'forum', items: [
      { icon: 'inbox', label: 'Інбокс (Instagram/DM)', href: '/admin/inbox.html' },
    ] },
    { group: 'Маркетинг', icon: 'campaign', items: [
      { icon: 'notifications_active', label: 'Центр повідомлень', href: '/admin/crm-marketing.html#center' },
      { icon: 'groups', label: 'Сегменти', href: '/admin/crm-marketing.html#segments' },
      { icon: 'send', label: 'Кампанії / Розсилки', href: '/admin/crm-marketing.html#campaigns' },
      { icon: 'bolt', label: 'Авто-тригери', href: '/admin/crm-marketing.html#triggers' },
      { icon: 'ads_click', label: 'Реклама Meta', href: '/admin/meta-ads.html' },
      { icon: 'travel_explore', label: 'Реклама Google', href: '/admin/google-ads.html' },
      { icon: 'history', label: 'Нагадування (записи)', href: '/admin/index.html#reminders' },
    ] },
    { icon: 'payments', label: 'Зарплата', href: '/admin/index.html#payroll' },
    { icon: 'flag', label: 'План місяця', href: '/admin/index.html#plan' },
    { group: 'Продажі', icon: 'sell', items: [
      { icon: 'shopping_bag', label: 'Замовлення', href: '/admin/index.html#orders' },
      { icon: 'point_of_sale', label: 'Каса магазину', href: '/admin/crm-extra.html#cashbox' },
      { icon: 'language', label: 'Вітрина (сайт)', href: 'https://svs-beauty-space.vercel.app' },
    ] },
    { group: 'Фінанси', icon: 'account_balance_wallet', items: [
      { icon: 'swap_vert', label: 'Доходи і Витрати', href: '/admin/index.html#finance' },
      { icon: 'loyalty', label: 'Бонуси', href: '/admin/bonus.html' },
      { icon: 'point_of_sale', label: 'Рахунки і каси', href: '/admin/crm-extra.html' },
      { icon: 'groups', label: 'Контрагенти', href: '/admin/index.html#contractors' },
      { icon: 'insights', label: 'Звіти (P&L, RFM)', href: '/admin/crm-extra.html#reports' },
      { icon: 'file_download', label: 'Експорт CSV', href: '/admin/export.html' },
    ] },
    { group: 'Товари', icon: 'storefront', items: [
      { icon: 'inventory_2', label: 'Товари', href: '/admin/index.html#products' },
      { icon: 'warehouse', label: 'Склад', href: '/admin/index.html#stock' },
      { icon: 'fact_check', label: 'Інвентаризація', href: '/admin/crm-extra.html#inventory' },
    ] },
    { icon: 'badge', label: 'Майстри / Співробітники', href: '/admin/crm-extra.html#users' },
    { group: 'Налаштування', icon: 'settings', items: [
      { icon: 'storefront', label: 'Профіль', href: '/admin/index.html#settings' },
      { icon: 'event_available', label: 'Онлайн-запис', href: '/admin/index.html#settings' },
      { icon: 'payments', label: 'Передплата', href: '/admin/index.html#settings' },
      { icon: 'schedule', label: 'Графік змін', href: '/admin/index.html#settings' },
      { icon: 'visibility', label: 'Конфіденційність', href: '/admin/index.html#settings' },
      { icon: 'tune', label: 'Бізнес-налаштування', href: '/admin/index.html#settings' },
      { icon: 'meeting_room', label: 'Кабінети / ресурси', href: '/admin/index.html#settings' },
      { icon: 'inventory_2', label: 'Розхідники', href: '/admin/index.html#settings' },
      { icon: 'admin_panel_settings', label: 'Доступ до проєкту', href: '/admin/crm-extra.html#users-access' },
    ] },
    { group: 'Система', icon: 'tune', items: [
      { icon: 'monitor_heart', label: 'Системний статус', href: '/admin/dashboard.html' },
      { icon: 'store', label: 'Управління магазинами', href: '/admin/crm-extra.html#branches' },
      { icon: 'hub', label: 'Інтеграції', href: '/admin/integrations.html' },
      { icon: 'sync', label: 'BeautyPro синхро', href: '/admin/index.html#sync' },
      { icon: 'history', label: 'Аудит', href: '/admin/crm-extra.html#audit' },
      { icon: 'security', label: 'Безпека', href: '/admin/security.html' },
    ] },
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
  const hash = location.hash || '';
  function isActive(href) {
    if (href.startsWith('http')) return false;
    const [p, h] = href.split('#');
    if (p.replace(/\/+$/, '') !== here) return false;
    return h ? ('#' + h) === hash : !hash;
  }
  function renderItem(it) {
    const active = isActive(it.href) ? ' active' : '';
    const ext = it.href.startsWith('http') ? ' target="_blank"' : '';
    return `<a class="sidebar-item${active}" href="${it.href}"${ext}><span class="material-icons-round">${it.icon}</span> ${it.label}</a>`;
  }
  const items = NAV.map((n) => {
    if (n.group) {
      const open = n.items.some((it) => isActive(it.href)) ? ' open' : '';
      const sub = n.items.map(renderItem).join('');
      return `<div class="sidebar-group${open}">` +
        `<div class="sidebar-group-header" onclick="this.parentElement.classList.toggle('open')">` +
        `<span class="material-icons-round">${n.icon}</span> ${n.group}` +
        `<span class="material-icons-round chevron">chevron_right</span></div>` +
        `<div class="sidebar-group-items">${sub}</div></div>`;
    }
    return renderItem(n);
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

  // Обернуть контент в .main + topbar.
  // У вбудованому режимі (iframe всередині index.html) topbar НЕ малюємо —
  // він уже є в батьківському каркасі; лишаємо тільки контент.
  const main = document.createElement('div');
  main.className = 'main';
  main.innerHTML = EMBEDDED ? '' :
    '<div class="topbar">' +
    '<button class="sb-toggle" title="Згорнути меню" onclick="window.toggleSidebar()"><span class="material-icons-round">menu_open</span></button>' +
    '<button class="burger" onclick="document.getElementById(\'svsSidebar\').classList.toggle(\'open\')">' +
    '<span class="material-icons-round">menu</span></button><h2>' + title + '</h2></div>';
  if (EMBEDDED) { main.style.marginLeft = '0'; main.style.width = '100%'; }

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
  if (!EMBEDDED) body.appendChild(aside); // у вбудованому режимі своє ліве меню не малюємо
  body.appendChild(main);

  // ── Згортання меню (icon-rail), стан спільний з index.html ──
  window.toggleSidebar = function () {
    const on = document.documentElement.classList.toggle('sb-collapsed');
    try { localStorage.setItem('svs_sb_collapsed', on ? '1' : '0'); } catch (_) {}
  };
  // стан застосовується inline-скриптом у <head> кожної сторінки (до рендера — без мигання);
  // тут лише підстраховка, якщо скрипт у <head> відсутній
  if (localStorage.getItem('svs_sb_collapsed') === '1') document.documentElement.classList.add('sb-collapsed');

  // Закрытие меню по клику мимо (мобайл)
  document.addEventListener('click', (e) => {
    if (window.innerWidth > 900) return;
    if (!aside.contains(e.target) && !e.target.closest('.burger')) aside.classList.remove('open');
  });

  // Заголовок topbar = активний розділ. На сторінках, де власні вкладки приховані
  // (навігація йде з лівого меню через #hash), синхронізуємо заголовок з активною вкладкою.
  const titleEl = main.querySelector('.topbar h2');
  if (document.querySelector('nav.tabs') && titleEl) {
    const syncTabTitle = () => {
      const a = document.querySelector('nav.tabs button.active');
      if (a) titleEl.textContent = a.textContent.trim();
    };
    syncTabTitle();
    window.addEventListener('hashchange', () => setTimeout(syncTabTitle, 40));
    document.addEventListener('click', (e) => { if (e.target.closest('nav.tabs button')) setTimeout(syncTabTitle, 40); });
  }

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

  // Плавающая кнопка "Заметки" — единый виджет обратной связи на всех страницах.
  // У вбудованому режимі кнопку дає батьківський каркас — щоб не було двох однакових.
  if (!EMBEDDED && !document.querySelector('script[src*="notes-widget.js"]')) {
    const s = document.createElement('script');
    s.src = '/admin/assets/notes-widget.js';
    document.body.appendChild(s);
  }
})();
