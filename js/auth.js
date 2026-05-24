/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Auth Frontend
   Screens: login-choice → login-user / login-master
            → verify-sms (masters) → account dashboard
   JWT stored in localStorage, 30-day session
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var API = 'http://localhost:3001/api';  // Change to production URL

  var currentUser = JSON.parse(localStorage.getItem('svs_user') || 'null');
  var authToken   = localStorage.getItem('svs_token') || null;

  // ── API helper ─────────────────────────────────────────
  function apiPost(url, data) {
    return fetch(API + url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: 'Bearer ' + authToken } : {}),
      },
      body: JSON.stringify(data),
    }).then(function (r) { return r.json(); });
  }

  function apiGet(url) {
    return fetch(API + url, {
      headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
    }).then(function (r) { return r.json(); });
  }

  // ── Session management ─────────────────────────────────
  function saveSession(token, user) {
    authToken = token;
    currentUser = user;
    localStorage.setItem('svs_token', token);
    localStorage.setItem('svs_user', JSON.stringify(user));
  }

  function clearSession() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('svs_token');
    localStorage.removeItem('svs_user');
  }

  // ── Render ─────────────────────────────────────────────
  var page = document.getElementById('authPage');

  function render(html) {
    page.innerHTML = html;
  }

  function showError(msg) {
    var el = document.getElementById('authError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function showSuccess(msg) {
    var el = document.getElementById('authSuccess');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function showLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.dataset.orig = btn.textContent;
      btn.textContent = '...';
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.orig || btn.textContent;
    }
  }

  // ── Screens ────────────────────────────────────────────

  // Screen 1: Already logged in → Dashboard
  function renderDashboard() {
    var u = currentUser;
    var isMaster = u.role === 'master';
    render(
      '<div class="auth-container">' +
        '<div class="auth-card">' +
          (isMaster ? '<div class="auth-master-header"><span class="master-badge-lg">Майстер</span>' + (u.approved ? '<span class="auth-approved">✓ Підтверджено</span>' : '<span class="auth-pending">На перевірці</span>') + '</div>' : '') +
          '<div class="auth-avatar">' + avatarHtml(u) + '</div>' +
          '<h1 class="auth-title">' + (u.name || 'Привіт!') + '</h1>' +
          '<p class="auth-subtitle">' + (u.email || u.phone || '') + '</p>' +
          (isMaster && !u.approved ?
            '<div class="auth-info-box">Ваш акаунт майстра на перевірці. Оптові ціни будуть доступні після підтвердження.</div>' : '') +
          (isMaster && u.approved ?
            '<div class="auth-info-box auth-info-box--success">Оптові ціни активні. Ви бачите спеціальні ціни для майстрів.</div>' : '') +
          '<div class="auth-actions">' +
            '<a href="shop.html" class="btn btn--filled auth-btn">До каталогу</a>' +
            '<button class="btn btn--ghost auth-btn" id="logoutBtn">Вийти</button>' +
          '</div>' +
          '<div class="auth-divider"></div>' +
          '<div class="auth-orders" id="ordersList"><p class="auth-orders-loading">Завантаження замовлень...</p></div>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('logoutBtn').addEventListener('click', function () {
      clearSession();
      renderChoice();
    });

    // Load orders
    loadOrders();
  }

  function avatarHtml(u) {
    if (u.avatar) return '<img src="' + u.avatar + '" alt="" class="auth-avatar__img">';
    var letter = (u.name || u.email || u.phone || '?')[0].toUpperCase();
    return '<div class="auth-avatar__placeholder">' + letter + '</div>';
  }

  function loadOrders() {
    apiGet('/payments/orders').then(function (data) {
      var el = document.getElementById('ordersList');
      if (!el) return;
      if (!data.orders || !data.orders.length) {
        el.innerHTML = '<p class="auth-no-orders">Замовлень поки немає</p>';
        return;
      }
      var html = '<h3 class="auth-orders-title">Мої замовлення</h3>';
      data.orders.forEach(function (o) {
        var date = new Date(o.created_at).toLocaleDateString('uk-UA');
        var statusMap = { pending: 'Очікує', paid: 'Оплачено', failed: 'Помилка' };
        html += '<div class="auth-order">' +
          '<span class="auth-order__id">#' + o.id + '</span>' +
          '<span class="auth-order__date">' + date + '</span>' +
          '<span class="auth-order__total">' + o.total + ' ₴</span>' +
          '<span class="auth-order__status auth-order__status--' + o.status + '">' + (statusMap[o.status] || o.status) + '</span>' +
        '</div>';
      });
      el.innerHTML = html;
    }).catch(function () {
      var el = document.getElementById('ordersList');
      if (el) el.innerHTML = '';
    });
  }

  // Screen 2: Choose login type
  function renderChoice() {
    render(
      '<div class="auth-container">' +
        '<div class="auth-card">' +
          '<h1 class="auth-title">Увійти</h1>' +
          '<p class="auth-subtitle">Оберіть спосіб входу</p>' +
          '<div class="auth-choice-grid">' +
            '<button class="auth-choice-btn" id="choiceUser">' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
              '<span>Я покупець</span>' +
              '<small>Через Google, Facebook або Apple</small>' +
            '</button>' +
            '<button class="auth-choice-btn" id="choiceMaster">' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a9 9 0 1 0 9 9"/><path d="M12 6v6l4 2"/><path d="M18 2v4M20 4h-4"/></svg>' +
              '<span>Я майстер</span>' +
              '<small>Підтвердження через SMS</small>' +
            '</button>' +
          '</div>' +
          '<a href="shop.html" class="auth-skip">Продовжити без входу →</a>' +
        '</div>' +
      '</div>'
    );
    document.getElementById('choiceUser').addEventListener('click', renderUserLogin);
    document.getElementById('choiceMaster').addEventListener('click', renderMasterLogin);
  }

  // Screen 3a: User login (OAuth)
  function renderUserLogin() {
    render(
      '<div class="auth-container">' +
        '<div class="auth-card">' +
          '<button class="auth-back" id="backBtn">← Назад</button>' +
          '<h1 class="auth-title">Вхід для покупців</h1>' +
          '<p class="auth-subtitle">Реєстрація відбувається автоматично</p>' +
          '<div id="authError" class="auth-error" style="display:none"></div>' +

          '<!-- Google Sign-In -->' +
          '<div class="auth-oauth-btn" id="googleSignInWrap">' +
            '<div id="g_id_onload" data-client_id="' + (window.GOOGLE_CLIENT_ID || '') + '" data-callback="__svsGoogleCallback" data-auto_prompt="false"></div>' +
            '<div class="g_id_signin" data-type="standard" data-size="large" data-theme="filled_black" data-text="sign_in_with" data-shape="rectangular" data-logo_alignment="left" data-width="320"></div>' +
            '<button class="auth-social-btn auth-social-btn--google" id="googleBtn">' +
              '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>' +
              'Увійти через Google' +
            '</button>' +
          '</div>' +

          '<!-- Facebook Sign-In -->' +
          '<button class="auth-social-btn auth-social-btn--facebook" id="facebookBtn">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>' +
            'Увійти через Facebook' +
          '</button>' +

          '<!-- Apple Sign-In -->' +
          '<button class="auth-social-btn auth-social-btn--apple" id="appleBtn">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>' +
            'Увійти через Apple' +
          '</button>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('backBtn').addEventListener('click', renderChoice);
    document.getElementById('googleBtn').addEventListener('click', initGoogleSignIn);
    document.getElementById('facebookBtn').addEventListener('click', initFacebookSignIn);
    document.getElementById('appleBtn').addEventListener('click', initAppleSignIn);
  }

  // Screen 3b: Master login (SMS)
  function renderMasterLogin() {
    render(
      '<div class="auth-container">' +
        '<div class="auth-card">' +
          '<button class="auth-back" id="backBtn">← Назад</button>' +
          '<h1 class="auth-title">Вхід для майстрів</h1>' +
          '<p class="auth-subtitle">Введіть номер телефону — надішлемо код</p>' +
          '<div id="authError" class="auth-error" style="display:none"></div>' +
          '<div class="auth-form">' +
            '<div class="auth-field">' +
              '<label>Ваше ім\'я (необов\'язково)</label>' +
              '<input type="text" id="masterName" placeholder="Ім\'я та прізвище" class="auth-input">' +
            '</div>' +
            '<div class="auth-field">' +
              '<label>Номер телефону</label>' +
              '<div class="auth-phone-wrap">' +
                '<span class="auth-phone-prefix">🇺🇦 +38</span>' +
                '<input type="tel" id="masterPhone" placeholder="067 123 45 67" class="auth-input auth-input--phone" maxlength="13">' +
              '</div>' +
            '</div>' +
            '<button class="btn btn--filled auth-btn auth-btn--full" id="sendSmsBtn">Отримати SMS-код</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('backBtn').addEventListener('click', renderChoice);
    document.getElementById('sendSmsBtn').addEventListener('click', function () {
      var phone = '0' + document.getElementById('masterPhone').value.replace(/\D/g, '');
      var name = document.getElementById('masterName').value.trim();
      if (phone.length < 10) return showError('Введіть коректний номер телефону');
      var btn = document.getElementById('sendSmsBtn');
      showLoading(btn, true);
      apiPost('/auth/sms/send', { phone: phone }).then(function (data) {
        showLoading(btn, false);
        if (data.ok) {
          renderSmsVerify(phone, name);
        } else {
          showError(data.error || 'Помилка відправки SMS');
        }
      }).catch(function () {
        showLoading(btn, false);
        showError('Помилка з\'єднання з сервером');
      });
    });
  }

  // Screen 4: SMS code verification
  function renderSmsVerify(phone, name) {
    render(
      '<div class="auth-container">' +
        '<div class="auth-card">' +
          '<button class="auth-back" id="backBtn">← Назад</button>' +
          '<h1 class="auth-title">Введіть код</h1>' +
          '<p class="auth-subtitle">Код відправлено на <strong>' + phone + '</strong></p>' +
          '<div id="authError" class="auth-error" style="display:none"></div>' +
          '<div id="authSuccess" class="auth-success" style="display:none"></div>' +
          '<div class="auth-form">' +
            '<div class="auth-field">' +
              '<input type="text" id="smsCode" placeholder="000000" class="auth-input auth-input--code" maxlength="6" autocomplete="one-time-code" inputmode="numeric">' +
            '</div>' +
            '<button class="btn btn--filled auth-btn auth-btn--full" id="verifyBtn">Підтвердити</button>' +
            '<button class="auth-resend" id="resendBtn">Надіслати ще раз</button>' +
          '</div>' +
          '<div class="auth-master-note">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>' +
            'Після реєстрації доступ до оптових цін буде активовано після підтвердження адміністратором.' +
          '</div>' +
        '</div>' +
      '</div>'
    );

    document.getElementById('backBtn').addEventListener('click', function () { renderMasterLogin(); });

    // Auto-submit on 6 chars
    document.getElementById('smsCode').addEventListener('input', function () {
      if (this.value.length === 6) verifyCode(phone, name);
    });

    document.getElementById('verifyBtn').addEventListener('click', function () {
      verifyCode(phone, name);
    });

    document.getElementById('resendBtn').addEventListener('click', function () {
      apiPost('/auth/sms/send', { phone: phone }).then(function (data) {
        if (data.ok) showSuccess('SMS надіслано ще раз');
        else showError(data.error || 'Помилка');
      });
    });
  }

  function verifyCode(phone, name) {
    var code = document.getElementById('smsCode').value.trim();
    if (code.length !== 6) return showError('Введіть 6-значний код');
    var btn = document.getElementById('verifyBtn');
    showLoading(btn, true);
    apiPost('/auth/sms/verify', { phone: phone, code: code, name: name }).then(function (data) {
      showLoading(btn, false);
      if (data.ok && data.token) {
        saveSession(data.token, data.user);
        renderDashboard();
      } else {
        showError(data.error || 'Невірний код');
      }
    }).catch(function () {
      showLoading(btn, false);
      showError('Помилка з\'єднання');
    });
  }

  // ── Google Sign-In ─────────────────────────────────────
  window.__svsGoogleCallback = function (response) {
    if (!response || !response.credential) return showError('Google auth failed');
    apiPost('/auth/oauth/google', { credential: response.credential }).then(function (data) {
      if (data.ok && data.token) {
        saveSession(data.token, data.user);
        renderDashboard();
      } else {
        showError(data.error || 'Google auth failed');
      }
    });
  };

  function initGoogleSignIn() {
    // Trigger Google One Tap or prompt
    if (window.google && window.google.accounts) {
      window.google.accounts.id.prompt();
    } else {
      showError('Google Sign-In не ініціалізовано. Перевірте GOOGLE_CLIENT_ID у конфігурації.');
    }
  }

  // ── Facebook Sign-In ────────────────────────────────────
  function initFacebookSignIn() {
    if (!window.FB) {
      // Load FB SDK dynamically
      window.fbAsyncInit = function () {
        FB.init({
          appId: window.FACEBOOK_APP_ID || '',
          cookie: true,
          xfbml: true,
          version: 'v18.0',
        });
        doFBLogin();
      };
      var script = document.createElement('script');
      script.src = 'https://connect.facebook.net/uk_UA/sdk.js';
      document.body.appendChild(script);
    } else {
      doFBLogin();
    }
  }

  function doFBLogin() {
    FB.login(function (response) {
      if (response.authResponse) {
        apiPost('/auth/oauth/facebook', { accessToken: response.authResponse.accessToken }).then(function (data) {
          if (data.ok && data.token) {
            saveSession(data.token, data.user);
            renderDashboard();
          } else {
            showError(data.error || 'Facebook auth failed');
          }
        });
      }
    }, { scope: 'email,public_profile' });
  }

  // ── Apple Sign-In ───────────────────────────────────────
  function initAppleSignIn() {
    if (!window.AppleID) {
      // Load Apple script
      var script = document.createElement('script');
      script.src = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
      script.onload = function () { doAppleSignIn(); };
      document.body.appendChild(script);
    } else {
      doAppleSignIn();
    }
  }

  function doAppleSignIn() {
    if (!window.AppleID) return showError('Apple Sign-In не доступний');
    AppleID.auth.init({
      clientId: window.APPLE_CLIENT_ID || '',
      scope: 'name email',
      redirectURI: window.location.origin + '/account.html',
      usePopup: true,
    });
    AppleID.auth.signIn().then(function (data) {
      apiPost('/auth/oauth/apple', {
        identityToken: data.authorization.id_token,
        user: data.user || null,
      }).then(function (resp) {
        if (resp.ok && resp.token) {
          saveSession(resp.token, resp.user);
          renderDashboard();
        } else {
          showError(resp.error || 'Apple auth failed');
        }
      });
    }).catch(function (err) {
      if (err.error !== 'popup_closed_by_user') showError('Apple auth failed');
    });
  }

  // ── Init ───────────────────────────────────────────────
  // Verify existing token
  if (authToken && currentUser) {
    apiGet('/auth/me').then(function (data) {
      if (data.user) {
        currentUser = data.user;
        localStorage.setItem('svs_user', JSON.stringify(data.user));
        renderDashboard();
      } else {
        clearSession();
        renderChoice();
      }
    }).catch(function () {
      // Server unavailable — show cached user
      renderDashboard();
    });
  } else {
    renderChoice();
  }

})();
