/* ═══ UI-МОДУЛЬ: Маркетинг ═══════════════════════════════════
 * Реєструє сторінки групи «Аналітика та AI»:
 *   • mktcenter — Маркетинг-центр (routes/marketing-center.js)
 *   • forms     — Конструктор форм (routes/forms.js)
 *   • refmkt    — Реферальний маркетинг (routes/referral-marketing.js) MKT-05
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
    group: 'analytics',
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
    group: 'analytics',
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
    group: 'analytics',
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
})();
