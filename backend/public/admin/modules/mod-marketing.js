/* ═══ UI-МОДУЛЬ: Маркетинг ═══════════════════════════════════
 * Реєструє сторінки групи «Аналітика та AI»:
 *   • mktcenter   — Маркетинг-центр (routes/marketing-center.js)
 *   • forms       — Конструктор форм (routes/forms.js)
 *   • refmkt      — Реферальний маркетинг (routes/referral-marketing.js) MKT-05
 *   • beforeafter — Фото До/Після (routes/portfolio.js) SAL-09
 * Захисний рендер: відсутнє поле → '—', порожній масив → modEmpty.
 * ─────────────────────────────────────────────────────────── */
(function () {
  // ── спільні дрібні хелпери ──
  var TBL = 'width:100%;border-collapse:collapse';
  var TH = 'padding:11px 14px;text-align:left;font-size:12px;color:#888;border-bottom:1px solid #eee';
  var TD = 'padding:11px 14px;border-bottom:1px solid #f2f2f2;font-size:13px';
  function dash(v) { return (v == null || v === '') ? '—' : window.modEsc(v); }
  function num(v) { return (v == null || v === '' || isNaN(Number(v))) ? '—' : Number(v).toLocaleString('uk-UA'); }
  function pct(v) { return (v == null || isNaN(Number(v))) ? '—' : Number(v).toFixed(1) + '%'; }

  // ═══════════════════════════════════════════════════════════
  // 1) МАРКЕТИНГ-ЦЕНТР
  // ═══════════════════════════════════════════════════════════
  window.registerModule({
    page: 'mktcenter',
    title: 'Маркетинг-центр',
    group: 'marketing',
    ownerOnly: true, // Босс 19.07: адміну бачити необовʼязково — лише власник
    icon: 'campaign',
    section: '<div id="mktcenter-root"></div>',
    loader: async function () {
      var root = document.getElementById('mktcenter-root');
      if (!root) return;
      root.innerHTML = window.modEmpty('Завантаження…');
      try {
        var dash_ = await window.modApi('/api/marketing-center/dashboard');
        var funnel = await window.modApi('/api/marketing-center/funnel').catch(function () { return { funnel: [] }; });

        var kpi = (dash_ && dash_.kpi) || {};
        var html = '';

        // KPI-картки
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">';
        html += window.modCard('Нові клієнти', num(kpi.new_clients),
          (kpi.new_clients_delta_pct != null && kpi.new_clients_delta_pct < 0) ? '#d9534f' : '#2e7d32');
        html += window.modCard('Виручка, ₴', num(kpi.revenue), '#222');
        html += window.modCard('LTV, ₴', num(kpi.ltv), '#222');
        html += window.modCard('Витрати, ₴', num(kpi.marketing_spend), '#222');
        html += window.modCard('CAC, ₴', num(kpi.cac), '#222');
        html += window.modCard('ROI', kpi.roi == null ? '—' : Number(kpi.roi).toFixed(2),
          (kpi.roi != null && kpi.roi < 0) ? '#d9534f' : '#2e7d32');
        html += '</div>';

        // Воронка
        var stages = (funnel && Array.isArray(funnel.funnel)) ? funnel.funnel : [];
        html += '<div class="card" style="padding:16px;margin-bottom:18px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Воронка привернення</h3>';
        if (!stages.length) {
          html += window.modEmpty('Немає даних воронки');
        } else {
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">Етап</th>' +
            '<th style="' + TH + ';text-align:right">Значення</th>' +
            '<th style="' + TH + ';text-align:right">Конверсія</th></tr></thead><tbody>';
          stages.forEach(function (s) {
            html += '<tr>' +
              '<td style="' + TD + '">' + dash(s.label || s.stage) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(s.value) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + (s.conversion_pct == null ? '—' : pct(s.conversion_pct)) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        // Топ-канали
        var ch = (dash_ && Array.isArray(dash_.top_channels)) ? dash_.top_channels : [];
        html += '<div class="card" style="padding:16px;margin-bottom:18px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Топ канали привернення</h3>';
        if (!ch.length) {
          html += window.modEmpty('Немає каналів');
        } else {
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">Канал</th>' +
            '<th style="' + TH + ';text-align:right">Нових клієнтів</th></tr></thead><tbody>';
          ch.forEach(function (c) {
            html += '<tr>' +
              '<td style="' + TD + '">' + dash(c.channel) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(c.clients) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        // Найближчі активності
        var up = (dash_ && Array.isArray(dash_.upcoming_activities)) ? dash_.upcoming_activities : [];
        html += '<div class="card" style="padding:16px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Найближчі активності' +
          (dash_ && dash_.active_campaigns != null ? ' · активних кампаній: ' + window.modEsc(dash_.active_campaigns) : '') +
          '</h3>';
        if (!up.length) {
          html += window.modEmpty('Немає запланованих активностей');
        } else {
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">Назва</th>' +
            '<th style="' + TH + '">Тип</th>' +
            '<th style="' + TH + '">Дата</th></tr></thead><tbody>';
          up.forEach(function (a) {
            html += '<tr>' +
              '<td style="' + TD + '">' + dash(a.title) + '</td>' +
              '<td style="' + TD + '">' + dash(a.type) + '</td>' +
              '<td style="' + TD + '">' + dash(a.start_date ? String(a.start_date).slice(0, 10) : null) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        root.innerHTML = html;
      } catch (e) {
        window.modErr(root, e);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 2) КОНСТРУКТОР ФОРМ
  // ═══════════════════════════════════════════════════════════
  window.registerModule({
    page: 'forms',
    title: 'Конструктор форм',
    group: 'marketing',
    icon: 'dynamic_form',
    section: '<div id="forms-root"></div>',
    loader: async function () {
      var root = document.getElementById('forms-root');
      if (!root) return;
      root.innerHTML = window.modEmpty('Завантаження…');
      try {
        var list = await window.modApi('/api/forms');
        var tpls = await window.modApi('/api/forms/templates').catch(function () { return { rows: [] }; });

        var forms = (list && Array.isArray(list.rows)) ? list.rows : [];
        var templates = (tpls && Array.isArray(tpls.rows)) ? tpls.rows : [];

        var html = '';

        // Пояснення (заметка #80: «незрозуміло що це»)
        html += '<div style="background:#f0f4ff;border:1px solid #d8e0ff;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13.5px;line-height:1.6;color:#33415c">' +
          '<b>Конструктор форм</b> — анкети для клієнтів: запис на консультацію, опитування якості, згода на обробку даних, бриф перед процедурою. ' +
          'Готову форму отримуєте посиланням — клієнт заповнює, відповіді збираються тут. ' +
          (forms.length ? '' : 'Своїх форм ще немає — оберіть готовий <b>шаблон нижче</b> або натисніть «Нова форма».') +
          '</div>';

        // KPI-картки
        var totalSubs = forms.reduce(function (s, f) { return s + (Number(f.submit_count) || 0); }, 0);
        var published = forms.filter(function (f) { return f.status === 'published'; }).length;
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">';
        html += window.modCard('Усього форм', num(forms.length), '#222');
        html += window.modCard('Опубліковано', num(published), '#2e7d32');
        html += window.modCard('Усього відповідей', num(totalSubs), '#222');
        html += window.modCard('Шаблонів', num(templates.length), '#222');
        html += '</div>';

        // Таблиця форм
        html += '<div class="card" style="padding:16px;margin-bottom:18px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Форми</h3>';
        if (!forms.length) {
          html += window.modEmpty('Поки що немає форм');
        } else {
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">Назва</th>' +
            '<th style="' + TH + '">Статус</th>' +
            '<th style="' + TH + '">Доступ</th>' +
            '<th style="' + TH + ';text-align:right">Полів</th>' +
            '<th style="' + TH + ';text-align:right">Відповідей</th>' +
            '<th style="' + TH + ';text-align:right">Переглядів</th></tr></thead><tbody>';
          forms.forEach(function (f) {
            html += '<tr>' +
              '<td style="' + TD + '">' + dash(f.title) + '</td>' +
              '<td style="' + TD + '">' + dash(f.status) + '</td>' +
              '<td style="' + TD + '">' + dash(f.access_type) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(f.field_count) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(f.submit_count) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(f.view_count) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        // Шаблони
        html += '<div class="card" style="padding:16px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Шаблони форм</h3>';
        if (!templates.length) {
          html += window.modEmpty('Немає системних шаблонів');
        } else {
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">Назва</th>' +
            '<th style="' + TH + '">Категорія</th>' +
            '<th style="' + TH + ';text-align:right">Полів</th></tr></thead><tbody>';
          templates.forEach(function (t) {
            html += '<tr>' +
              '<td style="' + TD + '">' + dash(t.title) +
                (t.description ? '<div style="color:#999;font-size:12px">' + dash(t.description) + '</div>' : '') +
              '</td>' +
              '<td style="' + TD + '">' + dash(t.template_category) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(t.field_count) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        root.innerHTML = html;
      } catch (e) {
        window.modErr(root, e);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 3) РЕФЕРАЛЬНИЙ МАРКЕТИНГ (MKT-05)
  // ═══════════════════════════════════════════════════════════
  window.registerModule({
    page: 'refmkt',
    title: 'Реферальний маркетинг',
    group: 'marketing',
    icon: 'share',
    section: '<div id="refmkt-root"></div>',
    loader: async function () {
      var root = document.getElementById('refmkt-root');
      if (!root) return;
      root.innerHTML = window.modEmpty('Завантаження…');
      try {
        // Паралельно завантажуємо програму, аналітику та лідерборд
        var prog = await window.modApi('/api/referral-marketing/program').catch(function () { return null; });
        var analytics = await window.modApi('/api/referral-marketing/analytics').catch(function () { return {}; });
        var lb = await window.modApi('/api/referral-marketing/leaderboard?limit=10').catch(function () { return { leaderboard: [] }; });
        var materials = await window.modApi('/api/referral-marketing/materials').catch(function () { return { items: [] }; });

        var html = '';

        // ── Блок: Поточна програма ──────────────────────────────
        html += '<div class="card" style="padding:18px;margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
        html += '<h3 style="margin:0;font-size:16px">Реферальна програма</h3>';
        if (prog && prog.landing_slug) {
          html += '<a href="/api/referral-marketing/landing/' + window.modEsc(prog.landing_slug) +
            '" target="_blank" style="font-size:13px;color:#5e86c8;text-decoration:none">' +
            '<span class="material-icons-round" style="font-size:14px;vertical-align:-2px">open_in_new</span> Лендинг</a>';
        }
        html += '</div>';
        if (!prog) {
          html += window.modEmpty('Програму ще не налаштовано. Зверніться до адміністратора.');
        } else {
          html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px">';
          html += '<div><span style="font-size:12px;color:#888">Назва</span><div style="font-weight:600">' + dash(prog.name) + '</div></div>';
          html += '<div><span style="font-size:12px;color:#888">Slug лендингу</span><div style="font-family:monospace">' + dash(prog.landing_slug) + '</div></div>';
          html += '<div><span style="font-size:12px;color:#888">Реферер отримає</span><div>' + dash(prog.referrer_reward_description) + '</div></div>';
          html += '<div><span style="font-size:12px;color:#888">Друг отримає</span><div>' + dash(prog.friend_reward_description) + '</div></div>';
          html += '<div><span style="font-size:12px;color:#888">Статус</span><div>' +
            (prog.active ? '<span style="color:#16a34a;font-weight:600">✔ Активна</span>' : '<span style="color:#d9534f">✘ Неактивна</span>') +
            '</div></div>';
          html += '</div>';
        }
        html += '</div>';

        // ── Блок: Аналітика воронки ──────────────────────────────
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">';
        html += window.modCard('Вірусний коефіцієнт', analytics.viral_coefficient != null ? Number(analytics.viral_coefficient).toFixed(2) : '—',
          (analytics.viral_coefficient > 1) ? '#16a34a' : '#222');
        html += window.modCard('CAC реферал, ₴', num(analytics.cac_referral), '#222');
        html += window.modCard('CAC інші канали, ₴', num(analytics.cac_other), '#222');
        html += window.modCard('LTV рефереди, ₴', num(analytics.ltv_referral), '#222');
        html += window.modCard('LTV звичайні, ₴', num(analytics.ltv_regular), '#222');
        html += '</div>';

        // Воронка (якщо є)
        if (analytics.funnel && (analytics.funnel.clicks || analytics.funnel.registrations)) {
          var f = analytics.funnel;
          html += '<div class="card" style="padding:16px;margin-bottom:16px">';
          html += '<h3 style="margin:0 0 10px;font-size:14px;color:#888">Воронка реферальної програми</h3>';
          html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
          var steps = [
            { label: 'Кліки', val: f.clicks },
            { label: 'Реєстрації', val: f.registrations },
            { label: 'Перший візит', val: f.first_visits },
            { label: 'Повторні', val: f.repeat_visits }
          ];
          steps.forEach(function (s) {
            html += '<div class="card" style="flex:1;min-width:120px;padding:12px;text-align:center">' +
              '<div style="font-size:11px;color:#888">' + window.modEsc(s.label) + '</div>' +
              '<div style="font-size:22px;font-weight:700">' + (s.val != null ? Number(s.val).toLocaleString('uk-UA') : '—') + '</div></div>';
          });
          html += '</div></div>';
        }

        // ── Блок: Лідерборд ─────────────────────────────────────
        var lbItems = (lb && Array.isArray(lb.leaderboard)) ? lb.leaderboard : (Array.isArray(lb) ? lb : []);
        html += '<div class="card" style="padding:16px;margin-bottom:16px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Лідерборд рефереров (поточний місяць)</h3>';
        if (!lbItems.length) {
          html += window.modEmpty('Даних поки немає');
        } else {
          var LEVEL_COLOR = { bronze: '#cd7f32', silver: '#9e9e9e', gold: '#f9a825', platinum: '#5e86c8' };
          html += '<table style="' + TBL + '"><thead><tr>' +
            '<th style="' + TH + '">#</th>' +
            '<th style="' + TH + '">Клієнт</th>' +
            '<th style="' + TH + '">Рівень</th>' +
            '<th style="' + TH + ';text-align:right">Рефералів</th>' +
            '<th style="' + TH + ';text-align:right">Конверт.</th>' +
            '<th style="' + TH + ';text-align:right">Винагорода, ₴</th>' +
            '</tr></thead><tbody>';
          lbItems.forEach(function (r, i) {
            var lvl = r.level || 'bronze';
            var col = LEVEL_COLOR[lvl] || '#888';
            html += '<tr>' +
              '<td style="' + TD + ';font-weight:700;color:#888">' + (r.rank || i + 1) + '</td>' +
              '<td style="' + TD + '">' + dash(r.client_name || r.full_name || r.client_id) + '</td>' +
              '<td style="' + TD + '"><span style="color:' + col + ';font-weight:600;text-transform:capitalize">' + window.modEsc(lvl) + '</span></td>' +
              '<td style="' + TD + ';text-align:right">' + num(r.referrals_count) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(r.referrals_converted) + '</td>' +
              '<td style="' + TD + ';text-align:right">' + num(r.total_reward) + '</td>' +
              '</tr>';
          });
          html += '</tbody></table>';
        }
        html += '</div>';

        // ── Блок: Промоматеріали ─────────────────────────────────
        var mats = (materials && Array.isArray(materials.items)) ? materials.items
          : (Array.isArray(materials) ? materials : []);
        html += '<div class="card" style="padding:16px">';
        html += '<h3 style="margin:0 0 12px;font-size:15px">Промоматеріали</h3>';
        if (!mats.length) {
          html += window.modEmpty('Матеріалів поки немає');
        } else {
          var TYPE_ICON = { text: 'notes', banner: 'image', story: 'slideshow', flyer: 'picture_as_pdf', card: 'credit_card' };
          html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px">';
          mats.forEach(function (m) {
            var ico = TYPE_ICON[m.type] || 'article';
            html += '<div class="card" style="padding:12px">' +
              '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">' +
                '<span class="material-icons-round" style="font-size:18px;color:#5e86c8">' + ico + '</span>' +
                '<span style="font-weight:600;font-size:14px">' + dash(m.title) + '</span>' +
              '</div>' +
              '<div style="font-size:11px;color:#888;margin-bottom:4px">Тип: ' + window.modEsc(m.type || '—') + '</div>' +
              (m.active ? '<span style="font-size:11px;color:#16a34a">● Активний</span>' :
                '<span style="font-size:11px;color:#aaa">○ Неактивний</span>') +
              '</div>';
          });
          html += '</div>';
        }
        html += '</div>';

        root.innerHTML = html;
      } catch (e) {
        window.modErr(root, e);
      }
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 4) ФОТО ДО/ПІСЛЯ (SAL-09)
  // ═══════════════════════════════════════════════════════════
  window.registerModule({
    page: 'beforeafter',
    title: 'Фото До/Після',
    group: 'marketing',
    icon: 'photo_library',
    section: '<div id="beforeafter-root"></div>',
    loader: async function () {
      var root = document.getElementById('beforeafter-root');
      if (!root) return;
      root.innerHTML = window.modEmpty('Завантаження…');

      // ── стан фільтрів ──
      var state = { category: '', status: '', in_portfolio: '', page: 0, limit: 30 };

      async function render() {
        root.innerHTML = window.modEmpty('Завантаження…');
        try {
          var qs = '?limit=' + state.limit + '&offset=' + (state.page * state.limit);
          if (state.category) qs += '&category=' + encodeURIComponent(state.category);
          if (state.status)   qs += '&status='   + encodeURIComponent(state.status);
          if (state.in_portfolio) qs += '&in_portfolio=1';

          var list    = await window.modApi('/api/portfolio' + qs);
          var stats   = await window.modApi('/api/portfolio/stats').catch(function () { return {}; });
          var consents= await window.modApi('/api/portfolio/consents?limit=20').catch(function () { return { items: [] }; });

          var photos   = (list && Array.isArray(list.rows)) ? list.rows : [];
          var statData = stats || {};
          var conItems = (consents && Array.isArray(consents.items)) ? consents.items : [];

          var html = '';

          // ── KPI-картки ──
          html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">';
          html += window.modCard('Усього фото', num(statData.total_photos), '#222');
          html += window.modCard('Перегляди портфоліо', num(statData.total_views), '#2e7d32');
          var totalCats = (Array.isArray(statData.photos_by_category) ? statData.photos_by_category.length : 0);
          html += window.modCard('Категорій', num(totalCats), '#222');
          var topEmpName = (Array.isArray(statData.top_employees) && statData.top_employees.length)
            ? statData.top_employees[0].master : '—';
          html += window.modCard('Топ майстер', window.modEsc(topEmpName), '#5e86c8');
          html += '</div>';

          // ── Фільтри ──
          html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">';
          html += '<select id="ba-cat" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
            '<option value="">Всі категорії</option>' +
            ['haircut','coloring','nails','extensions','makeup','cosmetology','other'].map(function (c) {
              return '<option value="' + c + '"' + (state.category === c ? ' selected' : '') + '>' + c + '</option>';
            }).join('') +
            '</select>';
          html += '<select id="ba-status" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
            '<option value="">Всі статуси</option>' +
            ['uploaded','moderated','published','rejected','removed'].map(function (s) {
              return '<option value="' + s + '"' + (state.status === s ? ' selected' : '') + '>' + s + '</option>';
            }).join('') +
            '</select>';
          html += '<label style="font-size:13px;display:flex;align-items:center;gap:5px;cursor:pointer">' +
            '<input type="checkbox" id="ba-portfolio"' + (state.in_portfolio ? ' checked' : '') + '> В портфоліо</label>';
          html += '<button id="ba-filter-btn" style="padding:6px 16px;background:#5e86c8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Фільтр</button>';
          html += '</div>';

          // ── Таблиця фото ──
          html += '<div class="card" style="padding:16px;margin-bottom:18px">';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
          html += '<h3 style="margin:0;font-size:15px">Список фото (' + num(photos.length) + ')</h3>';
          html += '<span style="font-size:12px;color:#888">Сторінка ' + (state.page + 1) + '</span>';
          html += '</div>';

          if (!photos.length) {
            html += window.modEmpty('Фото не знайдено');
          } else {
            html += '<div style="overflow-x:auto"><table style="' + TBL + '"><thead><tr>' +
              '<th style="' + TH + '">Фото</th>' +
              '<th style="' + TH + '">Майстер</th>' +
              '<th style="' + TH + '">Клієнт</th>' +
              '<th style="' + TH + '">Категорія</th>' +
              '<th style="' + TH + '">Статус</th>' +
              '<th style="' + TH + '">Порт.</th>' +
              '<th style="' + TH + '">Дата</th>' +
              '<th style="' + TH + '">Дії</th>' +
              '</tr></thead><tbody>';

            var STATUS_BADGE = {
              uploaded:  'background:#e3f2fd;color:#1565c0',
              moderated: 'background:#e8f5e9;color:#2e7d32',
              published: 'background:#e0f7fa;color:#006064',
              rejected:  'background:#fce4ec;color:#b71c1c',
              removed:   'background:#f5f5f5;color:#9e9e9e'
            };

            photos.forEach(function (p) {
              var imgUrl = p.before_url || p.after_url || '';
              var thumbStyle = 'width:48px;height:48px;object-fit:cover;border-radius:4px;background:#eee';
              var imgHtml = imgUrl
                ? '<img src="' + window.modEsc(imgUrl) + '" style="' + thumbStyle + '" loading="lazy" onerror="this.style.display=\'none\'">'
                : '<div style="' + thumbStyle + ';display:flex;align-items:center;justify-content:center;font-size:10px;color:#aaa">нема</div>';

              var st = p.status || 'uploaded';
              var badge = STATUS_BADGE[st] || 'background:#eee;color:#333';
              var canApprove = (st === 'uploaded');
              var canReject  = (st === 'uploaded' || st === 'moderated');
              var canPublish = (st === 'moderated');
              var canUnpub   = (st === 'published');

              var actions = '';
              if (canApprove) actions += '<button class="ba-approve" data-id="' + p.id + '" style="margin:1px;padding:3px 8px;font-size:11px;background:#e8f5e9;color:#2e7d32;border:1px solid #c8e6c9;border-radius:4px;cursor:pointer">✔ Схвалити</button>';
              if (canReject)  actions += '<button class="ba-reject"  data-id="' + p.id + '" style="margin:1px;padding:3px 8px;font-size:11px;background:#fce4ec;color:#b71c1c;border:1px solid #f8bbd0;border-radius:4px;cursor:pointer">✘ Відхилити</button>';
              if (canPublish) actions += '<button class="ba-publish" data-id="' + p.id + '" style="margin:1px;padding:3px 8px;font-size:11px;background:#e0f7fa;color:#006064;border:1px solid #b2ebf2;border-radius:4px;cursor:pointer">↑ Публік.</button>';
              if (canUnpub)   actions += '<button class="ba-unpub"   data-id="' + p.id + '" style="margin:1px;padding:3px 8px;font-size:11px;background:#fff3e0;color:#e65100;border:1px solid #ffe0b2;border-radius:4px;cursor:pointer">↓ Зняти</button>';

              html += '<tr>' +
                '<td style="' + TD + '">' + imgHtml + '</td>' +
                '<td style="' + TD + '">' + dash(p.master_name) + '</td>' +
                '<td style="' + TD + '">' + dash(p.client_name) + '</td>' +
                '<td style="' + TD + '">' + dash(p.category) + '</td>' +
                '<td style="' + TD + '"><span style="padding:2px 8px;border-radius:10px;font-size:11px;' + badge + '">' + window.modEsc(st) + '</span></td>' +
                '<td style="' + TD + ';text-align:center">' + (p.in_portfolio ? '★' : '·') + '</td>' +
                '<td style="' + TD + '">' + dash(p.created_at ? String(p.created_at).slice(0, 10) : null) + '</td>' +
                '<td style="' + TD + ';white-space:nowrap">' + actions + '</td>' +
                '</tr>';
            });
            html += '</tbody></table></div>';

            // пагінація
            html += '<div style="display:flex;gap:8px;margin-top:12px">';
            if (state.page > 0) html += '<button id="ba-prev" style="padding:5px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px">← Назад</button>';
            if (photos.length === state.limit) html += '<button id="ba-next" style="padding:5px 14px;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px">Вперед →</button>';
            html += '</div>';
          }
          html += '</div>';

          // ── Топ майстри ──
          if (Array.isArray(statData.top_employees) && statData.top_employees.length) {
            html += '<div class="card" style="padding:16px;margin-bottom:18px">';
            html += '<h3 style="margin:0 0 12px;font-size:15px">Топ майстри за кількістю фото в портфоліо</h3>';
            html += '<table style="' + TBL + '"><thead><tr>' +
              '<th style="' + TH + '">#</th>' +
              '<th style="' + TH + '">Майстер</th>' +
              '<th style="' + TH + ';text-align:right">Фото</th>' +
              '</tr></thead><tbody>';
            statData.top_employees.forEach(function (e, i) {
              html += '<tr>' +
                '<td style="' + TD + ';color:#888">' + (i + 1) + '</td>' +
                '<td style="' + TD + '">' + dash(e.master) + '</td>' +
                '<td style="' + TD + ';text-align:right">' + num(e.photos) + '</td>' +
                '</tr>';
            });
            html += '</tbody></table></div>';
          }

          // ── Аналітика по категоріях ──
          if (Array.isArray(statData.photos_by_category) && statData.photos_by_category.length) {
            html += '<div class="card" style="padding:16px;margin-bottom:18px">';
            html += '<h3 style="margin:0 0 12px;font-size:15px">Розподіл по категоріях</h3>';
            html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
            statData.photos_by_category.forEach(function (c) {
              html += '<div class="card" style="padding:10px 16px;text-align:center;min-width:100px">' +
                '<div style="font-size:11px;color:#888">' + window.modEsc(c.category || 'other') + '</div>' +
                '<div style="font-size:20px;font-weight:700">' + num(c.cnt) + '</div></div>';
            });
            html += '</div></div>';
          }

          // ── Згоди клієнтів ──
          html += '<div class="card" style="padding:16px;margin-bottom:18px">';
          html += '<h3 style="margin:0 0 12px;font-size:15px">Згоди клієнтів (останні 20)</h3>';
          if (!conItems.length) {
            html += window.modEmpty('Жодної згоди ще не оформлено');
          } else {
            var CON_BADGE = { active: 'color:#16a34a', expired: 'color:#e65100', revoked: 'color:#b71c1c' };
            html += '<table style="' + TBL + '"><thead><tr>' +
              '<th style="' + TH + '">Клієнт (ID)</th>' +
              '<th style="' + TH + '">Тип</th>' +
              '<th style="' + TH + '">Статус</th>' +
              '<th style="' + TH + '">Підписав</th>' +
              '<th style="' + TH + '">Дата</th>' +
              '<th style="' + TH + '">Дії</th>' +
              '</tr></thead><tbody>';
            conItems.forEach(function (c) {
              var badge = CON_BADGE[c.status] || '';
              html += '<tr>' +
                '<td style="' + TD + ';font-family:monospace;font-size:11px">' + dash(c.client_id ? String(c.client_id).slice(0, 8) + '…' : null) + '</td>' +
                '<td style="' + TD + '">' + dash(c.consent_type) + '</td>' +
                '<td style="' + TD + '"><span style="font-weight:600;' + badge + '">' + dash(c.status) + '</span></td>' +
                '<td style="' + TD + '">' + dash(c.signed_by_name) + '</td>' +
                '<td style="' + TD + '">' + dash(c.granted_at ? String(c.granted_at).slice(0, 10) : null) + '</td>' +
                '<td style="' + TD + '">' +
                  (c.status === 'active'
                    ? '<button class="ba-revoke-consent" data-id="' + c.id + '" style="padding:3px 8px;font-size:11px;background:#fce4ec;color:#b71c1c;border:1px solid #f8bbd0;border-radius:4px;cursor:pointer">Відкликати</button>'
                    : '') +
                '</td></tr>';
            });
            html += '</tbody></table>';
          }
          html += '</div>';

          root.innerHTML = html;

          // ── прив'язка подій ──
          var filterBtn = document.getElementById('ba-filter-btn');
          if (filterBtn) {
            filterBtn.addEventListener('click', function () {
              state.category    = (document.getElementById('ba-cat') || {}).value || '';
              state.status      = (document.getElementById('ba-status') || {}).value || '';
              state.in_portfolio= (document.getElementById('ba-portfolio') || {}).checked ? '1' : '';
              state.page = 0;
              render();
            });
          }
          var prevBtn = document.getElementById('ba-prev');
          if (prevBtn) prevBtn.addEventListener('click', function () { state.page--; render(); });
          var nextBtn = document.getElementById('ba-next');
          if (nextBtn) nextBtn.addEventListener('click', function () { state.page++; render(); });

          // кнопки модерації
          root.querySelectorAll('.ba-approve').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var id = this.getAttribute('data-id');
              try {
                await window.modApi('/api/portfolio/' + id + '/moderate', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) });
                render();
              } catch (e2) { alert('Помилка: ' + (e2 && e2.message ? e2.message : e2)); }
            });
          });
          root.querySelectorAll('.ba-reject').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var id = this.getAttribute('data-id');
              var reason = prompt('Причина відхилення (необов\'язково):') || '';
              try {
                await window.modApi('/api/portfolio/' + id + '/moderate', { method: 'PATCH', body: JSON.stringify({ action: 'reject', rejection_reason: reason }) });
                render();
              } catch (e2) { alert('Помилка: ' + (e2 && e2.message ? e2.message : e2)); }
            });
          });
          root.querySelectorAll('.ba-publish').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var id = this.getAttribute('data-id');
              try {
                await window.modApi('/api/portfolio/' + id + '/publish', { method: 'PATCH' });
                render();
              } catch (e2) { alert('Помилка: ' + (e2 && e2.message ? e2.message : e2)); }
            });
          });
          root.querySelectorAll('.ba-unpub').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var id = this.getAttribute('data-id');
              try {
                await window.modApi('/api/portfolio/' + id + '/unpublish', { method: 'PATCH' });
                render();
              } catch (e2) { alert('Помилка: ' + (e2 && e2.message ? e2.message : e2)); }
            });
          });
          root.querySelectorAll('.ba-revoke-consent').forEach(function (btn) {
            btn.addEventListener('click', async function () {
              var id = this.getAttribute('data-id');
              var reason = prompt('Причина відкликання згоди:') || '';
              try {
                await window.modApi('/api/portfolio/consents/' + id + '/revoke', { method: 'PATCH', body: JSON.stringify({ revoke_reason: reason }) });
                render();
              } catch (e2) { alert('Помилка: ' + (e2 && e2.message ? e2.message : e2)); }
            });
          });

        } catch (e) {
          window.modErr(root, e);
        }
      }

      render();
    }
  });
})();
