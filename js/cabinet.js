/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Особистий кабінет (M20)
   Логін за телефоном (SMS-код) → дашборд:
   рівень лояльності, візити (майбутні/історія), замовлення.
   API: /api/cabinet/* (cabinet-auth + cabinet content)
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Відмовостійкий доступ до CRM: основний Render → резервний при відмові основного.
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

  var token = localStorage.getItem('svs_cab_token') || null;
  var page = document.getElementById('authPage');

  // ── helpers ────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {},
      opts.headers || {}
    );
    return svsFetch(path, opts).then(function (r) {
      if (r.status === 401) { logout(false); throw new Error('unauthorized'); }
      return r.json();
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' }) +
      ', ' + d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtUah(n) { return Math.round(Number(n) || 0).toLocaleString('uk-UA') + ' грн'; }
  function render(html) { page.innerHTML = html; }
  function showError(msg) {
    var el = document.getElementById('authError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function logout(callApi) {
    if (callApi !== false && token) { api('/api/cabinet/logout', { method: 'POST' }).catch(function () {}); }
    token = null;
    localStorage.removeItem('svs_cab_token');
    renderLogin();
  }

  // ── screen: логін ──────────────────────────────────────
  function renderLogin() {
    render(
      '<div class="auth-card">' +
        '<div class="auth-card__logo"><span class="auth-card__logo-main">SVS</span><span class="auth-card__logo-sub">Beauty Space</span></div>' +
        '<h1 class="auth-card__title">Особистий кабінет</h1>' +
        '<p class="auth-card__subtitle">Вкажіть номер телефону — надішлемо код підтвердження</p>' +
        '<div class="auth-error" id="authError" style="display:none"></div>' +
        '<div class="auth-field"><label>Номер телефону</label>' +
          '<input type="tel" id="phoneInput" placeholder="+380 __ ___ __ __" autocomplete="tel"></div>' +
        '<button class="auth-btn-primary" id="sendCodeBtn">Отримати код</button>' +
      '</div>'
    );
    var btn = document.getElementById('sendCodeBtn');
    var input = document.getElementById('phoneInput');
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    btn.addEventListener('click', function () {
      var phone = input.value.replace(/\D/g, '');
      if (phone.length < 10) return showError('Перевірте номер телефону');
      btn.disabled = true; btn.textContent = 'Надсилаємо…';
      api('/api/cabinet/request-code', { method: 'POST', body: JSON.stringify({ phone: phone }) })
        .then(function (d) {
          if (d.ok === false || d.error) throw new Error(d.error || 'failed');
          if (d.mode === 'telegram-link-required') return renderLinkTelegram(phone, d);
          renderCode(phone);
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Отримати код'; showError('Не вдалось надіслати код. Спробуйте ще раз.'); });
    });
  }

  // ── screen: привʼязка Telegram ─────────────────────────
  function renderLinkTelegram(phone, d) {
    var botUrl = (d && d.bot_url) || 'https://t.me/Svs_beautybot';
    var botName = (d && d.bot) || '@Svs_beautybot';
    render(
      '<div class="auth-card">' +
        '<h1 class="auth-card__title">Підтвердіть номер у Telegram</h1>' +
        '<p class="auth-card__subtitle">Щоб увійти в кабінет, відкрийте нашого бота ' + esc(botName) +
          ', натисніть «Старт» і поділіться номером телефону. Це потрібно один раз.</p>' +
        '<a class="auth-btn-primary" style="display:block;text-align:center;text-decoration:none" href="' + botUrl + '" target="_blank" rel="noopener">Відкрити бота</a>' +
        '<button class="auth-btn-primary" id="retryBtn" style="margin-top:12px;background:transparent;border:1px solid currentColor">Я поділився номером — надіслати код</button>' +
        '<a class="auth-back" href="#" id="backBtn">← Змінити номер</a>' +
      '</div>'
    );
    document.getElementById('backBtn').addEventListener('click', function (e) { e.preventDefault(); renderLogin(); });
    document.getElementById('retryBtn').addEventListener('click', function () {
      var btn = document.getElementById('retryBtn');
      btn.disabled = true; btn.textContent = 'Надсилаємо…';
      api('/api/cabinet/request-code', { method: 'POST', body: JSON.stringify({ phone: phone }) })
        .then(function (d2) {
          if (d2.mode === 'telegram') return renderCode(phone);
          btn.disabled = false; btn.textContent = 'Я поділився номером — надіслати код';
          showError('Номер ще не привʼязано. Відкрийте бота і поділіться номером.');
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Я поділився номером — надіслати код'; showError('Не вдалось надіслати код. Спробуйте ще раз.'); });
    });
  }

  // ── screen: код ────────────────────────────────────────
  function renderCode(phone) {
    render(
      '<div class="auth-card">' +
        '<h1 class="auth-card__title">Введіть код</h1>' +
        '<p class="auth-card__subtitle">Надіслали код у Telegram (номер +' + esc(phone) + ')</p>' +
        '<div class="auth-error" id="authError" style="display:none"></div>' +
        '<div class="auth-field"><label>Код із Telegram</label>' +
          '<input type="text" inputmode="numeric" maxlength="4" id="codeInput" placeholder="••••" autocomplete="one-time-code"></div>' +
        '<button class="auth-btn-primary" id="verifyBtn">Увійти</button>' +
        '<a class="auth-back" href="#" id="backBtn">← Змінити номер</a>' +
      '</div>'
    );
    var btn = document.getElementById('verifyBtn');
    var input = document.getElementById('codeInput');
    input.focus();
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    document.getElementById('backBtn').addEventListener('click', function (e) { e.preventDefault(); renderLogin(); });
    btn.addEventListener('click', function () {
      var code = input.value.trim();
      if (code.length !== 4) return showError('Код — 4 цифри');
      btn.disabled = true; btn.textContent = 'Перевіряємо…';
      api('/api/cabinet/verify', { method: 'POST', body: JSON.stringify({ phone: phone, code: code }) })
        .then(function (d) {
          if (!d.token) throw new Error(d.error || 'bad-code');
          token = d.token;
          localStorage.setItem('svs_cab_token', token);
          renderDashboard();
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Увійти'; showError('Невірний код. Спробуйте ще раз.'); });
    });
  }

  // ── screen: дашборд ────────────────────────────────────
  function renderDashboard() {
    render('<div class="auth-card"><div class="auth-spinner"></div><p class="auth-card__subtitle" style="text-align:center">Завантажуємо ваш кабінет…</p></div>');
    Promise.all([
      api('/api/cabinet/summary'),
      api('/api/cabinet/visits'),
      api('/api/cabinet/orders'),
    ]).then(function (res) {
      var sum = res[0], visits = res[1], orders = res[2];
      var L = sum.loyalty || {};
      var html =
        '<div class="auth-card auth-dashboard">' +
          '<h1 class="auth-card__title">Вітаємо' + (sum.client && sum.client.name ? ', ' + esc(sum.client.name) : '') + '!</h1>' +

          // лояльність
          '<div class="cab-loyalty">' +
            '<div class="cab-loyalty__tier">' + esc(L.tier ? L.tier.name : '') +
              ' · знижка-бонус ' + esc(L.tier ? Math.round(L.tier.bonus_percent) : 0) + '%</div>' +
            '<div class="cab-loyalty__row"><span>Бонусний баланс</span><b>' + fmtUah(L.balance) + '</b></div>' +
            '<div class="cab-loyalty__row"><span>Витрачено всього</span><b>' + fmtUah(L.total_spent) + '</b></div>' +
            (L.next_tier
              ? '<div class="cab-loyalty__next">До рівня ' + esc(L.next_tier.name) + ' — ще ' + fmtUah(L.to_next) + '</div>'
              : '<div class="cab-loyalty__next">Максимальний рівень 💎</div>') +
          '</div>' +

          // найближчий візит
          (sum.next_visit
            ? '<div class="cab-section"><h2>Найближчий візит</h2>' +
              '<div class="cab-visit cab-visit--next">' +
                '<b>' + esc(fmtDate(sum.next_visit.starts_at)) + '</b><br>' +
                esc(sum.next_visit.service || '') + (sum.next_visit.master ? ' · ' + esc(sum.next_visit.master) : '') +
              '</div></div>'
            : '') +

          // майбутні візити
          renderVisits('Майбутні візити', visits.upcoming, 'У вас немає запланованих візитів') +
          // історія
          renderVisits('Історія візитів', (visits.past || []).slice(0, 10), 'Історія поки порожня') +
          // замовлення
          renderOrders(orders.orders || []) +

          '<button class="auth-logout-btn" id="logoutBtn">Вийти</button>' +
        '</div>';
      render(html);
      document.getElementById('logoutBtn').addEventListener('click', function () { logout(); });
    }).catch(function (e) {
      if (e.message !== 'unauthorized') {
        render('<div class="auth-card"><div class="auth-error" style="display:block">Не вдалось завантажити кабінет. Оновіть сторінку.</div></div>');
      }
    });
  }

  function renderVisits(title, list, emptyText) {
    var h = '<div class="cab-section"><h2>' + title + '</h2>';
    if (!list || !list.length) return h + '<p class="cab-empty">' + emptyText + '</p></div>';
    list.forEach(function (v) {
      h += '<div class="cab-visit">' +
        '<b>' + esc(fmtDate(v.starts_at)) + '</b><br>' +
        esc(v.service || 'Послуга') + (v.master ? ' · ' + esc(v.master) : '') +
        (v.price ? '<span class="cab-visit__price">' + fmtUah(v.price) + '</span>' : '') +
      '</div>';
    });
    return h + '</div>';
  }

  function renderOrders(list) {
    var h = '<div class="cab-section"><h2>Замовлення</h2>';
    if (!list.length) return h + '<p class="cab-empty">Замовлень поки немає</p></div>';
    var STATUS = { new: 'Нове', paid: 'Оплачено', completed: 'Виконано', delivered: 'Доставлено', cancelled: 'Скасовано' };
    list.slice(0, 10).forEach(function (o) {
      var items = (o.items || []).map(function (i) { return esc(i.name) + ' ×' + i.qty; }).join(', ');
      var paidMark = (o.payment_status === 'success' || o.status === 'paid') ? ' status-paid' : '';
      h += '<div class="auth-order-card">' +
        '<div><b>№' + o.id + '</b> · ' + new Date(o.created_at).toLocaleDateString('uk-UA') +
        ' <span class="cab-status' + paidMark + '">' + esc(STATUS[o.status] || o.status) + '</span></div>' +
        (items ? '<div class="cab-order__items">' + items + '</div>' : '') +
        '<div class="cab-visit__price">' + fmtUah(o.total) + '</div>' +
      '</div>';
    });
    return h + '</div>';
  }

  // ── старт ──────────────────────────────────────────────
  if (token) renderDashboard(); else renderLogin();
})();
