/* ═══ МОДУЛІ ПЛАТФОРМИ (SaaS) ════════════════════════════════
 * UI-плагін для адмінки CRM. Реєструє три сторінки групи 'platform':
 *   • saasplans — тарифні плани (routes/plans.js → /api/v2)
 *   • licenses  — ліцензії та модулі (routes/licenses.js → /api/licenses)
 *   • featflags — feature flags (routes/feature-flags.js → /api/v2)
 * Захисний рендер: '—' для пустих полів, modEmpty/modErr на помилках,
 * graceful-fallback з admin- на tenant-ендпоінти при 401/403.
 * ───────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var E = window.modEsc;

  // безпечне число / прочерк
  function num(v) { return (v == null || v === '') ? '—' : v; }
  // ціна UAH з рядка плану (monthly/yearly)
  function price(v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    return Number(v).toLocaleString('uk-UA') + ' ₴';
  }
  // ліміт: <0 = безліміт
  function lim(v) {
    if (v == null || v === '') return '—';
    return Number(v) < 0 ? '∞' : E(v);
  }
  function bool(v) { return v ? 'так' : '—'; }
  // короткий ISO-датум
  function dt(v) {
    if (!v) return '—';
    try { return new Date(v).toLocaleDateString('uk-UA'); } catch (_e) { return E(v); }
  }
  // бейдж статусу
  function badge(txt, color) {
    return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;' +
      'background:' + (color || '#eee') + '22;color:' + (color || '#666') + '">' + E(txt) + '</span>';
  }
  function statusColor(s) {
    s = String(s || '').toLowerCase();
    if (s === 'active' || s === 'published' || s === 'available') return '#28a745';
    if (s === 'trial' || s === 'in_progress' || s === 'grace_period') return '#f0ad4e';
    if (s === 'draft' || s === 'planned' || s === 'paused' || s === 'pending') return '#6c757d';
    if (s === 'archived' || s === 'expired' || s === 'revoked' || s === 'rolled_back') return '#d9534f';
    return '#888';
  }

  // обгортка таблиці у стилі адмінки
  function table(headers, rowsHtml) {
    var th = headers.map(function (h) {
      return '<th style="padding:11px 14px;text-align:left;border-bottom:2px solid #eee;' +
        'font-size:12px;color:#888;font-weight:600;text-transform:uppercase">' + E(h) + '</th>';
    }).join('');
    return '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' + th + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
  }
  function td(html) {
    return '<td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;font-size:14px">' +
      (html == null ? '—' : html) + '</td>';
  }

  // graceful API: пробуємо admin-шлях, при 401/403/404 — fallback
  function tryApi(primary, fallback) {
    return window.modApi(primary).catch(function (e) {
      if (!fallback) throw e;
      return window.modApi(fallback);
    });
  }

  /* ════════════════════════════════════════════════════════════
     1. ТАРИФНІ ПЛАНИ  /api/v2/admin/plans → fallback /api/v2/public/plans
  ════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'saasplans',
    title: 'Тарифні плани',
    group: 'platform',
    icon: 'workspace_premium',
    section: '<div id="saasplans-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
             '<div id="saasplans-table"></div>',
    loader: async function () {
      var cards = document.getElementById('saasplans-cards');
      var tbl = document.getElementById('saasplans-table');
      if (tbl) tbl.innerHTML = window.modEmpty('Завантаження…');
      try {
        var data = await tryApi('/api/v2/admin/plans', '/api/v2/public/plans');
        var rows = (data && data.rows) || [];
        if (!rows.length) {
          if (cards) cards.innerHTML = '';
          if (tbl) tbl.innerHTML = window.modEmpty('Планів поки немає');
          return;
        }
        // картки-зведення
        if (cards) {
          var published = rows.filter(function (p) { return String(p.status) === 'published'; }).length;
          var publicCnt = rows.filter(function (p) { return p.is_public; }).length;
          cards.innerHTML =
            window.modCard('Усього планів', rows.length, '#222') +
            window.modCard('Опубліковано', published, '#28a745') +
            window.modCard('Публічні', publicCnt, '#007bff');
        }
        // ціна може бути у plan.prices.monthly (public) або plan.price_monthly_uah (admin)
        function pm(p) { return p.prices ? p.prices.monthly : p.price_monthly_uah; }
        function py(p) { return p.prices ? p.prices.yearly : p.price_yearly_uah; }
        var body = rows.map(function (p) {
          return '<tr>' +
            td('<b>' + E(p.name || '—') + '</b>' +
               (p.is_popular ? ' ' + badge('популярний', '#f0ad4e') : '')) +
            td('<code>' + E(p.slug || '—') + '</code>') +
            td(num(p.tier)) +
            td(price(pm(p))) +
            td(price(py(p))) +
            td(num(p.trial_days != null ? p.trial_days + ' дн.' : null)) +
            td(p.features_count != null ? E(p.features_count) : '—') +
            td(p.limits_count != null ? E(p.limits_count) : '—') +
            td(p.status ? badge(p.status, statusColor(p.status)) : '—') +
            '</tr>';
        }).join('');
        if (tbl) tbl.innerHTML = table(
          ['Назва', 'Slug', 'Tier', 'Місяць', 'Рік', 'Trial', 'Фічі', 'Ліміти', 'Статус'], body);
      } catch (e) {
        if (cards) cards.innerHTML = '';
        window.modErr(tbl, e);
      }
    }
  });

  /* ════════════════════════════════════════════════════════════
     2. ЛІЦЕНЗІЇ ТА МОДУЛІ
        каталог  /api/licenses/catalog
        видані   /api/licenses/admin/all → fallback /api/licenses/my
  ════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'licenses',
    title: 'Ліцензії та модулі',
    group: 'platform',
    icon: 'key',
    section: '<div id="lic-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
             '<h3 style="margin:18px 0 8px;font-size:16px">Каталог модулів</h3>' +
             '<div id="lic-catalog"></div>' +
             '<h3 style="margin:22px 0 8px;font-size:16px">Видані ліцензії</h3>' +
             '<div id="lic-issued"></div>',
    loader: async function () {
      var cards = document.getElementById('lic-cards');
      var cat = document.getElementById('lic-catalog');
      var iss = document.getElementById('lic-issued');
      if (cat) cat.innerHTML = window.modEmpty('Завантаження…');
      if (iss) iss.innerHTML = window.modEmpty('Завантаження…');

      // каталог модулів
      try {
        var cdata = await window.modApi('/api/licenses/catalog');
        var crows = (cdata && cdata.rows) || [];
        if (cards) {
          cards.innerHTML = window.modCard('Модулів у каталозі', (cdata && cdata.count) != null ? cdata.count : crows.length, '#222');
        }
        if (!crows.length) {
          if (cat) cat.innerHTML = window.modEmpty('Каталог порожній');
        } else {
          var cbody = crows.map(function (m) {
            return '<tr>' +
              td('<b>' + E(m.name || '—') + '</b>') +
              td('<code>' + E(m.code || '—') + '</code>') +
              td(num(m.category)) +
              td(price(m.price_monthly_uah)) +
              td(price(m.price_yearly_uah)) +
              td(num(m.trial_days != null ? m.trial_days + ' дн.' : null)) +
              td(m.status ? badge(m.status, statusColor(m.status)) : '—') +
              td(m.tenant_license_status ? badge(m.tenant_license_status, statusColor(m.tenant_license_status)) : '—') +
              '</tr>';
          }).join('');
          if (cat) cat.innerHTML = table(
            ['Модуль', 'Код', 'Категорія', 'Місяць', 'Рік', 'Trial', 'Статус', 'Моя ліцензія'], cbody);
        }
      } catch (e) {
        if (cards) cards.innerHTML = '';
        window.modErr(cat, e);
      }

      // видані ліцензії (admin → fallback my)
      try {
        var ldata = await tryApi('/api/licenses/admin/all', '/api/licenses/my');
        var lrows = (ldata && ldata.rows) || [];
        if (!lrows.length) {
          if (iss) iss.innerHTML = window.modEmpty('Виданих ліцензій немає');
          return;
        }
        var lbody = lrows.map(function (l) {
          return '<tr>' +
            td('<b>' + E(l.module_name || l.code || '—') + '</b>') +
            td(l.tenant_id ? '<code>' + E(String(l.tenant_id).slice(0, 8)) + '…</code>' : '—') +
            td(l.license_type ? badge(l.license_type, statusColor(l.license_type)) : '—') +
            td(l.status ? badge(l.status, statusColor(l.status)) : '—') +
            td(dt(l.activated_at)) +
            td(dt(l.expires_at)) +
            td(l.trial_days_left != null ? E(l.trial_days_left) + ' дн.' : '—') +
            '</tr>';
        }).join('');
        if (iss) iss.innerHTML = table(
          ['Модуль', 'Тенант', 'Тип', 'Статус', 'Активовано', 'Завершення', 'Trial left'], lbody);
      } catch (e2) {
        window.modErr(iss, e2);
      }
    }
  });

  /* ════════════════════════════════════════════════════════════
     3. FEATURE FLAGS
        флаги         /api/v2/admin/flags
        kill-switches /api/v2/admin/kill-switches
  ════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'featflags',
    title: 'Feature Flags',
    group: 'platform',
    icon: 'flag',
    section: '<div id="ff-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
             '<div id="ff-kill"></div>' +
             '<h3 style="margin:18px 0 8px;font-size:16px">Усі флаги</h3>' +
             '<div id="ff-table"></div>',
    loader: async function () {
      var cards = document.getElementById('ff-cards');
      var kill = document.getElementById('ff-kill');
      var tbl = document.getElementById('ff-table');
      if (tbl) tbl.innerHTML = window.modEmpty('Завантаження…');

      // kill-switch dashboard (необов'язковий — не валимо сторінку)
      var killCount = 0;
      try {
        var kdata = await window.modApi('/api/v2/admin/kill-switches');
        var krows = (kdata && kdata.rows) || [];
        killCount = (kdata && kdata.total) != null ? kdata.total : krows.length;
        if (kill) {
          if (krows.length) {
            var kbody = krows.map(function (f) {
              return '<tr>' +
                td('<b>' + E(f.key || '—') + '</b>') +
                td(num(f.name)) +
                td(num(f.module_code)) +
                td(num(f.kill_switch_reason)) +
                td(dt(f.kill_switch_at)) +
                '</tr>';
            }).join('');
            kill.innerHTML = '<h3 style="margin:0 0 8px;font-size:16px;color:#d9534f">Активні kill-switch</h3>' +
              table(['Ключ', 'Назва', 'Модуль', 'Причина', 'Коли'], kbody);
          } else {
            kill.innerHTML = '';
          }
        }
      } catch (_ke) {
        if (kill) kill.innerHTML = '';
      }

      // таблиця флагів
      try {
        var data = await window.modApi('/api/v2/admin/flags');
        var rows = (data && data.rows) || [];
        if (cards) {
          var enabledCnt = rows.filter(function (f) { return f.default_enabled; }).length;
          cards.innerHTML =
            window.modCard('Усього флагів', rows.length, '#222') +
            window.modCard('Default ON', enabledCnt, '#28a745') +
            window.modCard('Kill-switch', killCount, killCount ? '#d9534f' : '#888');
        }
        if (!rows.length) {
          if (tbl) tbl.innerHTML = window.modEmpty('Флагів поки немає');
          return;
        }
        var body = rows.map(function (f) {
          return '<tr>' +
            td('<code>' + E(f.key || '—') + '</code>') +
            td(num(f.name)) +
            td(num(f.flag_type)) +
            td(num(f.module_code)) +
            td(f.status ? badge(f.status, statusColor(f.status)) : '—') +
            td(bool(f.default_enabled)) +
            td(f.kill_switch ? badge('KILL', '#d9534f') : '—') +
            '</tr>';
        }).join('');
        if (tbl) tbl.innerHTML = table(
          ['Ключ', 'Назва', 'Тип', 'Модуль', 'Статус', 'Default', 'Kill'], body);
      } catch (e) {
        if (cards) cards.innerHTML = '';
        window.modErr(tbl, e);
      }
    }
  });

  /* ════════════════════════════════════════════════════════════
     4. КАБІНЕТИ ТА ЗАЛИ  (SAL-03 Rooms)
        дашборд   /api/rooms/dashboard
        список    /api/rooms
        аналітика /api/rooms/:id/analytics
        матриця   /api/rooms/availability (query: branch_id, date)
  ════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'rooms',
    title: 'Кабінети та зали',
    group: 'platform',
    icon: 'meeting_room',
    section:
      '<div id="rooms-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
      '<div style="display:flex;gap:12px;margin-bottom:14px;align-items:center">' +
        '<select id="rooms-filter-type" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<option value="">Всі типи</option>' +
          '<option value="cabinet">Кабінет</option>' +
          '<option value="hall">Зал</option>' +
          '<option value="vip">VIP</option>' +
          '<option value="training">Навчальний</option>' +
        '</select>' +
        '<select id="rooms-filter-status" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<option value="">Всі статуси</option>' +
          '<option value="active">Активний</option>' +
          '<option value="inactive">Неактивний</option>' +
          '<option value="maintenance">Технічне обслуговування</option>' +
        '</select>' +
        '<button id="rooms-apply-filter" style="padding:6px 14px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Застосувати</button>' +
      '</div>' +
      '<div id="rooms-table"></div>' +
      '<h3 style="margin:22px 0 10px;font-size:15px">Матриця доступності — сьогодні</h3>' +
      '<div id="rooms-availability"></div>',
    loader: async function () {
      var cards = document.getElementById('rooms-cards');
      var tbl   = document.getElementById('rooms-table');
      var avail = document.getElementById('rooms-availability');
      var fType   = document.getElementById('rooms-filter-type');
      var fStatus = document.getElementById('rooms-filter-status');
      var btnF    = document.getElementById('rooms-apply-filter');

      if (tbl)   tbl.innerHTML   = window.modEmpty('Завантаження…');
      if (avail) avail.innerHTML = window.modEmpty('Завантаження…');

      // ── Допоміжні функції ──────────────────────────────────────────────
      function statusColor(s) {
        s = String(s || '').toLowerCase();
        if (s === 'active' || s === 'available' || s === 'free' || s === 'working') return '#28a745';
        if (s === 'maintenance' || s === 'blocked' || s === 'break') return '#f0ad4e';
        if (s === 'inactive' || s === 'occupied' || s === 'booked')  return '#d9534f';
        if (s === 'booked') return '#d9534f';
        return '#888';
      }
      function badge(txt, color) {
        return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;' +
          'background:' + (color || '#eee') + '22;color:' + (color || '#666') + '">' + E(txt) + '</span>';
      }
      function typeLabel(t) {
        var map = { cabinet:'Кабінет', hall:'Зал', vip:'VIP', training:'Навчальний' };
        return map[t] || E(t || '—');
      }

      // ── Дашборд / KPI-картки ───────────────────────────────────────────
      try {
        var dash = await window.modApi('/api/rooms/dashboard');
        if (cards) {
          cards.innerHTML =
            window.modCard('Всього кімнат', (dash && dash.total_rooms != null) ? dash.total_rooms : '—', '#222') +
            window.modCard('Активних',      (dash && dash.active != null)      ? dash.active      : '—', '#28a745') +
            window.modCard('На обслуговуванні', (dash && dash.maintenance != null) ? dash.maintenance : '—', '#f0ad4e') +
            window.modCard('Сер. завантаженість', (dash && dash.avg_occupancy != null)
              ? (Number(dash.avg_occupancy).toFixed(1) + '%') : '—', '#007bff');
        }
      } catch (e) {
        if (cards) cards.innerHTML = '';
      }

      // ── Рендер таблиці кімнат ─────────────────────────────────────────
      async function loadRooms() {
        if (tbl) tbl.innerHTML = window.modEmpty('Завантаження…');
        try {
          var q = '/api/rooms?limit=100';
          var tv = fType   && fType.value   ? fType.value   : '';
          var sv = fStatus && fStatus.value ? fStatus.value : '';
          if (tv) q += '&room_type=' + encodeURIComponent(tv);
          if (sv) q += '&status='    + encodeURIComponent(sv);
          var data = await window.modApi(q);
          var rows = (data && data.items) || (Array.isArray(data) ? data : []);
          if (!rows.length) {
            if (tbl) tbl.innerHTML = window.modEmpty('Кімнат не знайдено');
            return;
          }
          var TH = 'padding:10px 13px;text-align:left;border-bottom:2px solid #eee;font-size:12px;color:#888;font-weight:600';
          var TD = 'padding:10px 13px;border-bottom:1px solid #f0f0f0;font-size:13px';
          var head = ['Назва','Тип','Поверх','Місткість','Статус','Заван.',
                      'Філіал','Суміс. послуги'].map(function(h){
            return '<th style="' + TH + '">' + E(h) + '</th>';
          }).join('');
          var body = rows.map(function (r) {
            var cap  = (r.capacity != null) ? E(r.capacity) : '—';
            var occ  = (r.occupancy_percent != null) ? (Number(r.occupancy_percent).toFixed(1) + '%') : '—';
            var comp = Array.isArray(r.compatible_service_types) && r.compatible_service_types.length
              ? E(r.compatible_service_types.join(', ')) : '—';
            var branch = r.branch ? (E(r.branch.name || r.branch_id) ) : (r.branch_id ? E(String(r.branch_id).slice(0,8)+'…') : '—');
            return '<tr>' +
              '<td style="' + TD + '"><b>' + E(r.name || '—') + '</b></td>' +
              '<td style="' + TD + '">' + typeLabel(r.room_type) + '</td>' +
              '<td style="' + TD + '">' + (r.floor != null ? E(r.floor) : '—') + '</td>' +
              '<td style="' + TD + '">' + cap + '</td>' +
              '<td style="' + TD + '">' + badge(r.status || '—', statusColor(r.status)) + '</td>' +
              '<td style="' + TD + '">' + occ + '</td>' +
              '<td style="' + TD + '">' + branch + '</td>' +
              '<td style="' + TD + '">' + comp + '</td>' +
              '</tr>';
          }).join('');
          if (tbl) tbl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
        } catch (e) {
          window.modErr(tbl, e);
        }
      }
      await loadRooms();
      if (btnF) btnF.addEventListener('click', loadRooms);

      // ── Матриця доступності ───────────────────────────────────────────
      try {
        var today = new Date().toISOString().slice(0, 10);
        var mat = await window.modApi('/api/rooms/availability?date=' + today);
        var mrooms = (mat && mat.rooms) || [];
        if (!mrooms.length) {
          if (avail) avail.innerHTML = window.modEmpty('Дані відсутні');
        } else {
          var html = '<div style="overflow:auto">';
          html += '<table style="width:100%;border-collapse:collapse;font-size:12px">';
          html += '<thead><tr><th style="padding:8px;border-bottom:2px solid #eee;text-align:left;white-space:nowrap">Кімната</th>';
          // Зберемо всі можливі часові слоти з першої кімнати
          var allSlots = (mrooms[0] && Array.isArray(mrooms[0].slots)) ? mrooms[0].slots.map(function(s){return s.from;}) : [];
          allSlots.forEach(function(t) {
            html += '<th style="padding:4px 6px;border-bottom:2px solid #eee;text-align:center;white-space:nowrap;font-size:11px">' + E(t) + '</th>';
          });
          html += '</tr></thead><tbody>';
          mrooms.forEach(function (rm) {
            html += '<tr><td style="padding:8px;border-bottom:1px solid #f0f0f0;font-weight:600;white-space:nowrap">' +
              E(rm.name || rm.id) + '<br><span style="font-size:11px;color:#888">' +
              (rm.occupancy_percent != null ? Number(rm.occupancy_percent).toFixed(1)+'%' : '—') + '</span></td>';
            var slotMap = {};
            if (Array.isArray(rm.slots)) rm.slots.forEach(function(s){ slotMap[s.from] = s; });
            allSlots.forEach(function(t) {
              var sl = slotMap[t];
              var bg = '#e8f5e9', color='#2e7d32', title='вільно';
              if (sl) {
                if (sl.status === 'booked')  { bg='#ffebee'; color='#c62828'; title='зайнято'; }
                if (sl.status === 'blocked') { bg='#fff8e1'; color='#f57f17'; title='заблоковано'; }
                if (sl.status === 'break')   { bg='#f5f5f5'; color='#9e9e9e'; title='перерва'; }
              }
              html += '<td style="padding:4px;border-bottom:1px solid #f0f0f0;text-align:center" title="' + title + '">' +
                '<div style="background:' + bg + ';color:' + color + ';border-radius:3px;padding:2px 4px;font-size:10px">' +
                (sl ? (sl.status === 'free' ? '✓' : sl.status === 'booked' ? '●' : sl.status === 'blocked' ? '✕' : '○') : '?') +
                '</div></td>';
            });
            html += '</tr>';
          });
          html += '</tbody></table></div>';
          html += '<div style="margin-top:8px;font-size:11px;color:#888">' +
            '<span style="background:#e8f5e929;color:#2e7d32;padding:2px 8px;border-radius:3px;margin-right:6px">✓ вільно</span>' +
            '<span style="background:#ffebee29;color:#c62828;padding:2px 8px;border-radius:3px;margin-right:6px">● зайнято</span>' +
            '<span style="background:#fff8e129;color:#f57f17;padding:2px 8px;border-radius:3px;margin-right:6px">✕ заблоковано</span>' +
            '<span style="background:#f5f5f529;color:#9e9e9e;padding:2px 8px;border-radius:3px">○ перерва</span>' +
          '</div>';
          if (avail) avail.innerHTML = html;
        }
      } catch (e) {
        window.modErr(avail, e);
      }
    }
  });

  /* ════════════════════════════════════════════════════════════
     5. МЕДИЧНІ КАРТИ  (SAL-10 Medical Cards)
        cards     /api/medical/cards/:client_id
        tests     /api/medical/allergy-tests
        consents  /api/medical/consents
        formulas  /api/medical/formulas
        search    /api/medical/formulas/search
  ════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'medcards',
    title: 'Медичні карти',
    group: 'platform',
    icon: 'medical_information',
    section:
      '<div id="mc-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
      '<div style="display:flex;gap:10px;margin-bottom:16px;align-items:center">' +
        '<input id="mc-client-id" type="text" placeholder="ID клієнта (для пошуку карти)" ' +
          'style="padding:7px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:240px">' +
        '<button id="mc-search-btn" style="padding:7px 16px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Знайти карту</button>' +
      '</div>' +
      '<div id="mc-card-detail" style="margin-bottom:20px"></div>' +
      '<div style="display:flex;gap:10px;margin-bottom:8px;align-items:center">' +
        '<input id="mc-shade-search" type="text" placeholder="Пошук формул: відтінок/бренд" ' +
          'style="padding:7px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:280px">' +
        '<button id="mc-shade-btn" style="padding:7px 16px;background:#6c757d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Шукати</button>' +
      '</div>' +
      '<div id="mc-formula-search-result" style="margin-bottom:18px"></div>' +
      '<h3 style="margin:16px 0 8px;font-size:15px">Останні тести на алергію</h3>' +
      '<div id="mc-tests"></div>' +
      '<h3 style="margin:18px 0 8px;font-size:15px">Активні інформовані згоди</h3>' +
      '<div id="mc-consents"></div>' +
      '<h3 style="margin:18px 0 8px;font-size:15px">Останні формули фарбування</h3>' +
      '<div id="mc-formulas"></div>',

    loader: async function () {
      var cardsEl   = document.getElementById('mc-cards');
      var searchBtn = document.getElementById('mc-search-btn');
      var clientInp = document.getElementById('mc-client-id');
      var cardDetail= document.getElementById('mc-card-detail');
      var shadeInp  = document.getElementById('mc-shade-search');
      var shadeBtn  = document.getElementById('mc-shade-btn');
      var fSearchEl = document.getElementById('mc-formula-search-result');
      var testsEl   = document.getElementById('mc-tests');
      var consentsEl= document.getElementById('mc-consents');
      var formulasEl= document.getElementById('mc-formulas');

      var TH = 'padding:9px 12px;text-align:left;border-bottom:2px solid #eee;font-size:12px;color:#888;font-weight:600';
      var TD = 'padding:9px 12px;border-bottom:1px solid #f0f0f0;font-size:13px';

      function severityColor(s) {
        if (s === 'anaphylaxis' || s === 'severe') return '#d9534f';
        if (s === 'moderate') return '#f0ad4e';
        if (s === 'mild') return '#5bc0de';
        return '#888';
      }
      function resultColor(r) {
        if (r === 'negative') return '#28a745';
        if (r === 'strong_reaction') return '#d9534f';
        if (r === 'mild_reaction') return '#f0ad4e';
        return '#888';
      }
      function localBadge(txt, color) {
        return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;' +
          'background:' + (color || '#eee') + '22;color:' + (color || '#666') + '">' + E(txt) + '</span>';
      }
      function localDt(v) {
        if (!v) return '—';
        try { return new Date(v).toLocaleDateString('uk-UA'); } catch (_) { return E(v); }
      }

      // ── KPI-картки: агрегати з тестів і згод ─────────────────
      var totalTests = 0, expiredTests = 0, totalConsents = 0, totalFormulas = 0;
      var kpiLoaded = 0;
      function maybeRenderKpi() {
        kpiLoaded++;
        if (kpiLoaded < 3) return;
        if (cardsEl) cardsEl.innerHTML =
          window.modCard('Тестів на алергію', totalTests, '#222') +
          window.modCard('Прострочених тестів', expiredTests, expiredTests ? '#d9534f' : '#888') +
          window.modCard('Активних згод', totalConsents, '#28a745') +
          window.modCard('Формул фарбування', totalFormulas, '#007bff');
      }

      // ── Тести ────────────────────────────────────────────────
      if (testsEl) testsEl.innerHTML = window.modEmpty('Завантаження…');
      window.modApi('/api/medical/allergy-tests?limit=30').then(function (d) {
        totalTests = (d && d.total) != null ? d.total : 0;
        expiredTests = 0;
        var rows = (d && d.items) || [];
        var now = new Date();
        rows.forEach(function (t) {
          if (t.valid_until && new Date(t.valid_until) < now) expiredTests++;
        });
        maybeRenderKpi();
        if (!rows.length) { if (testsEl) testsEl.innerHTML = window.modEmpty('Тестів немає'); return; }
        var heads = ['<th style="'+TH+'">Клієнт</th><th style="'+TH+'">Продукт</th>' +
          '<th style="'+TH+'">Зона</th><th style="'+TH+'">Результат</th>' +
          '<th style="'+TH+'">Дійсний до</th><th style="'+TH+'">Нанесено</th>'];
        var body = rows.map(function (t) {
          var isExp = t.valid_until && new Date(t.valid_until) < now;
          return '<tr style="' + (isExp ? 'opacity:0.6' : '') + '">' +
            '<td style="'+TD+'">' + E(t.client_id || '—') + '</td>' +
            '<td style="'+TD+'"><b>' + E(t.product_name || '—') + '</b>' +
              (t.product_brand ? ' <span style="color:#888;font-size:12px">(' + E(t.product_brand) + ')</span>' : '') + '</td>' +
            '<td style="'+TD+'">' + E(t.application_zone || '—') + '</td>' +
            '<td style="'+TD+'">' + localBadge(t.final_result || 'pending', resultColor(t.final_result)) + '</td>' +
            '<td style="'+TD+'">' + (isExp
              ? '<span style="color:#d9534f">' + localDt(t.valid_until) + ' ⚠</span>'
              : localDt(t.valid_until)) + '</td>' +
            '<td style="'+TD+'">' + localDt(t.applied_at) + '</td>' +
            '</tr>';
        }).join('');
        if (testsEl) testsEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' + heads.join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { maybeRenderKpi(); window.modErr(testsEl, e); });

      // ── Активні згоди ─────────────────────────────────────────
      if (consentsEl) consentsEl.innerHTML = window.modEmpty('Завантаження…');
      window.modApi('/api/medical/consents?status=active&limit=30').then(function (d) {
        totalConsents = (d && d.total) != null ? d.total : 0;
        maybeRenderKpi();
        var rows = (d && d.items) || [];
        if (!rows.length) { if (consentsEl) consentsEl.innerHTML = window.modEmpty('Активних згод немає'); return; }
        var heads = ['<th style="'+TH+'">Клієнт</th><th style="'+TH+'">Процедура</th>' +
          '<th style="'+TH+'">Тип</th><th style="'+TH+'">Підписано</th>' +
          '<th style="'+TH+'">Дійсна до</th><th style="'+TH+'">Статус</th>'];
        var body = rows.map(function (c) {
          return '<tr>' +
            '<td style="'+TD+'">' + E(c.client_id || '—') + '</td>' +
            '<td style="'+TD+'"><b>' + E(c.procedure_name || '—') + '</b></td>' +
            '<td style="'+TD+'">' + E(c.consent_type || '—') + '</td>' +
            '<td style="'+TD+'">' + localDt(c.signed_at) + '</td>' +
            '<td style="'+TD+'">' + (c.valid_until ? localDt(c.valid_until) : 'безстрокова') + '</td>' +
            '<td style="'+TD+'">' + localBadge(c.status || '—', c.status === 'active' ? '#28a745' : '#888') + '</td>' +
            '</tr>';
        }).join('');
        if (consentsEl) consentsEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' + heads.join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { maybeRenderKpi(); window.modErr(consentsEl, e); });

      // ── Останні формули фарбування ────────────────────────────
      if (formulasEl) formulasEl.innerHTML = window.modEmpty('Завантаження…');
      window.modApi('/api/medical/formulas?limit=20').then(function (d) {
        totalFormulas = (d && d.total) != null ? d.total : 0;
        maybeRenderKpi();
        var rows = (d && d.items) || [];
        if (!rows.length) { if (formulasEl) formulasEl.innerHTML = window.modEmpty('Формул немає'); return; }
        var heads = ['<th style="'+TH+'">Клієнт</th><th style="'+TH+'">Майстер</th>' +
          '<th style="'+TH+'">Дата</th><th style="'+TH+'">Зони / бренди</th>' +
          '<th style="'+TH+'">Оцінка майстра</th><th style="'+TH+'">Оцінка клієнта</th>'];
        var body = rows.map(function (f) {
          var zones = Array.isArray(f.zones) ? f.zones : [];
          var zoneStr = zones.slice(0, 2).map(function (z) {
            return E((z.zone || '') + (z.brand ? ':' + z.brand : '') + (z.shade ? '/' + z.shade : ''));
          }).join(', ') + (zones.length > 2 ? '…' : '');
          return '<tr>' +
            '<td style="'+TD+'">' + E(f.client_id || '—') + '</td>' +
            '<td style="'+TD+'">' + E(f.employee_name || f.employee_id || '—') + '</td>' +
            '<td style="'+TD+'">' + localDt(f.formula_date) + '</td>' +
            '<td style="'+TD+'" title="' + E(JSON.stringify(zones)) + '">' + (zoneStr || '—') + '</td>' +
            '<td style="'+TD+'">' + (f.result_rating != null ? '★'.repeat(Number(f.result_rating)) : '—') + '</td>' +
            '<td style="'+TD+'">' + (f.client_rating != null ? '★'.repeat(Number(f.client_rating)) : '—') + '</td>' +
            '</tr>';
        }).join('');
        if (formulasEl) formulasEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' + heads.join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { window.modErr(formulasEl, e); });

      // ── Пошук карти клієнта ───────────────────────────────────
      function loadClientCard() {
        var cid = clientInp ? clientInp.value.trim() : '';
        if (!cid) return;
        if (cardDetail) cardDetail.innerHTML = window.modEmpty('Завантаження…');
        window.modApi('/api/medical/cards/' + encodeURIComponent(cid)).then(function (d) {
          var card = d && d.card;
          if (!card) { if (cardDetail) cardDetail.innerHTML = window.modEmpty('Карту не знайдено'); return; }
          var allergies = (card.allergies || []);
          var contraind = (card.contraindications || []);
          var meds      = (card.current_medications || []);
          var allergyHtml = allergies.length
            ? allergies.map(function (a) {
                return '<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:10px;' +
                  'background:' + severityColor(a.severity) + '22;color:' + severityColor(a.severity) + ';font-size:12px">' +
                  E(a.allergen || '?') + (a.severity ? ' (' + E(a.severity) + ')' : '') + '</span>';
              }).join('')
            : '<span style="color:#28a745;font-size:13px">Алергій не виявлено</span>';
          var contrHtml = contraind.filter(function (c) { return c.active !== false; }).length
            ? contraind.filter(function (c) { return c.active !== false; }).map(function (c) {
                return '<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:10px;' +
                  'background:#d9534f22;color:#d9534f;font-size:12px">' + E(c.condition || '?') + '</span>';
              }).join('')
            : '<span style="color:#28a745;font-size:13px">Протипоказань немає</span>';
          var medsHtml = meds.length
            ? meds.map(function (m) {
                return '<span style="display:inline-block;margin:2px 4px;padding:3px 10px;border-radius:10px;' +
                  'background:#007bff22;color:#007bff;font-size:12px">' +
                  E(m.name || '?') + (m.dosage ? ' ' + E(m.dosage) : '') + '</span>';
              }).join('')
            : '<span style="color:#888;font-size:13px">Немає</span>';
          var html = '<div style="border:1px solid #eee;border-radius:8px;padding:16px;background:#fafafa">' +
            '<div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:12px">' +
              '<div><b style="font-size:12px;color:#888">Клієнт ID</b><br>' + E(card.client_id) + '</div>' +
              '<div><b style="font-size:12px;color:#888">Фототип шкіри</b><br>' + (card.skin_phototype ? E('Тип ' + card.skin_phototype) : '—') + '</div>' +
              '<div><b style="font-size:12px;color:#888">Тип шкіри</b><br>' + E(card.skin_type || '—') + '</div>' +
              '<div><b style="font-size:12px;color:#888">Стан волосся</b><br>' + E(card.hair_condition || '—') + '</div>' +
              '<div><b style="font-size:12px;color:#888">Група крові</b><br>' + E(card.blood_type || '—') + '</div>' +
              '<div><b style="font-size:12px;color:#888">Статус карти</b><br>' +
                localBadge(card.status || '—', card.status === 'active' ? '#28a745' : card.status === 'needs_update' ? '#f0ad4e' : '#888') + '</div>' +
              '<div><b style="font-size:12px;color:#888">Оновлено</b><br>' + localDt(card.last_reviewed_at) + '</div>' +
            '</div>' +
            '<div style="margin-bottom:10px"><b style="font-size:13px">Алергії</b><br>' + allergyHtml + '</div>' +
            '<div style="margin-bottom:10px"><b style="font-size:13px">Протипоказання</b><br>' + contrHtml + '</div>' +
            '<div style="margin-bottom:10px"><b style="font-size:13px">Поточні ліки</b><br>' + medsHtml + '</div>' +
            (card.emergency_contact_name
              ? '<div style="font-size:12px;color:#888">Екстрений контакт: ' +
                  E(card.emergency_contact_name) +
                  (card.emergency_contact_phone ? ' — ' + E(card.emergency_contact_phone) : '') + '</div>'
              : '') +
            '<div style="margin-top:10px;font-size:12px;color:#888">Формул фарбування: <b>' +
              E(d.formulas_count != null ? d.formulas_count : '—') + '</b>' +
              (d.active_consents && d.active_consents.length
                ? ' | Активних згод: <b>' + E(d.active_consents.length) + '</b>' : '') +
            '</div>' +
          '</div>';
          if (cardDetail) cardDetail.innerHTML = html;
        }).catch(function (e) { window.modErr(cardDetail, e); });
      }
      if (searchBtn) searchBtn.addEventListener('click', loadClientCard);
      if (clientInp) clientInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadClientCard(); });

      // ── Пошук формул за відтінком / брендом ──────────────────
      function searchFormulas() {
        var q = shadeInp ? shadeInp.value.trim() : '';
        if (!q) return;
        if (fSearchEl) fSearchEl.innerHTML = window.modEmpty('Пошук…');
        window.modApi('/api/medical/formulas/search?shade=' + encodeURIComponent(q) +
          '&brand=' + encodeURIComponent(q) + '&limit=30').then(function (d) {
          var rows = (d && d.items) || [];
          if (!rows.length) { if (fSearchEl) fSearchEl.innerHTML = window.modEmpty('Нічого не знайдено'); return; }
          var heads = ['<th style="'+TH+'">Клієнт</th><th style="'+TH+'">Майстер</th>' +
            '<th style="'+TH+'">Дата</th><th style="'+TH+'">Формула</th>'];
          var body = rows.map(function (f) {
            var zones = Array.isArray(f.zones) ? f.zones : [];
            var zStr = zones.map(function (z) {
              return E([z.zone, z.brand, z.shade, z.oxidant_pct].filter(Boolean).join(' '));
            }).join(' | ');
            return '<tr>' +
              '<td style="'+TD+'">' + E(f.client_name || f.client_id || '—') + '</td>' +
              '<td style="'+TD+'">' + E(f.employee_name || '—') + '</td>' +
              '<td style="'+TD+'">' + localDt(f.formula_date) + '</td>' +
              '<td style="'+TD+'">' + (zStr || '—') + '</td>' +
              '</tr>';
          }).join('');
          if (fSearchEl) fSearchEl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' + heads.join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
        }).catch(function (e) { window.modErr(fSearchEl, e); });
      }
      if (shadeBtn) shadeBtn.addEventListener('click', searchFormulas);
      if (shadeInp) shadeInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') searchFormulas(); });
    }
  });

  /* ════ SAL-08 Procedure Materials UI ══════════════════════════════
     Маршрути: /api/material-norms, /api/material-norms/consumption/*,
               /api/material-norms/reports/profitability
  ════════════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'matconsume',
    title: 'Матеріали процедур',
    group: 'platform',
    icon: 'science',
    section:
      '<div id="mcon-kpi" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">' +
        '<label style="font-size:13px;color:#555">Від: <input id="mcon-dfrom" type="date" style="padding:5px 8px;border:1px solid #ddd;border-radius:5px;font-size:13px"></label>' +
        '<label style="font-size:13px;color:#555">До: <input id="mcon-dto" type="date" style="padding:5px 8px;border:1px solid #ddd;border-radius:5px;font-size:13px"></label>' +
        '<select id="mcon-groupby" style="padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px">' +
          '<option value="product">По матеріалу</option>' +
          '<option value="service">По послузі</option>' +
          '<option value="employee">По майстру</option>' +
        '</select>' +
        '<button id="mcon-apply" style="padding:6px 16px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Застосувати</button>' +
      '</div>' +
      '<h3 style="font-size:14px;margin:0 0 8px;font-weight:600">Звіт розходу матеріалів</h3>' +
      '<div id="mcon-report" style="margin-bottom:20px"></div>' +
      '<h3 style="font-size:14px;margin:16px 0 8px;font-weight:600">Прогноз — що закінчується (14 днів)</h3>' +
      '<div id="mcon-forecast" style="margin-bottom:20px"></div>' +
      '<h3 style="font-size:14px;margin:16px 0 8px;font-weight:600">Маржинальність послуг</h3>' +
      '<div id="mcon-profit" style="margin-bottom:20px"></div>' +
      '<h3 style="font-size:14px;margin:16px 0 8px;font-weight:600">Нормативні карти</h3>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">' +
        '<input id="mcon-search" type="text" placeholder="Пошук карти…" style="padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px;width:220px">' +
        '<select id="mcon-status" style="padding:6px 10px;border:1px solid #ddd;border-radius:5px;font-size:13px">' +
          '<option value="">Усі статуси</option>' +
          '<option value="active">Активні</option>' +
          '<option value="draft">Чернетки</option>' +
          '<option value="archived">Архів</option>' +
        '</select>' +
        '<button id="mcon-norm-search" style="padding:6px 14px;background:#6c757d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Знайти</button>' +
      '</div>' +
      '<div id="mcon-norms"></div>',

    loader: async function () {
      var TH = 'padding:8px 12px;text-align:left;border-bottom:2px solid #eee;font-size:12px;color:#888;font-weight:600';
      var TD = 'padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:13px';

      var kpiEl     = document.getElementById('mcon-kpi');
      var reportEl  = document.getElementById('mcon-report');
      var forecastEl= document.getElementById('mcon-forecast');
      var profitEl  = document.getElementById('mcon-profit');
      var normsEl   = document.getElementById('mcon-norms');
      var dfromEl   = document.getElementById('mcon-dfrom');
      var dtoEl     = document.getElementById('mcon-dto');
      var groupbyEl = document.getElementById('mcon-groupby');
      var applyBtn  = document.getElementById('mcon-apply');
      var searchEl  = document.getElementById('mcon-search');
      var statusEl  = document.getElementById('mcon-status');
      var normSrchBtn = document.getElementById('mcon-norm-search');

      // Дефолтный диапазон — текущий месяц
      var now = new Date();
      var y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
      if (dfromEl) dfromEl.value = y + '-' + m + '-01';
      if (dtoEl) dtoEl.value = y + '-' + m + '-' + String(now.getDate()).padStart(2, '0');

      // deviation color: green <10%, yellow 10-20%, red >20%
      function devColor(pct) {
        var v = Math.abs(Number(pct) || 0);
        if (v < 10) return '#28a745';
        if (v < 20) return '#f0ad4e';
        return '#d9534f';
      }
      function devBadge(pct) {
        if (pct == null) return '—';
        var sign = Number(pct) >= 0 ? '+' : '';
        return '<span style="color:' + devColor(pct) + ';font-weight:600">' + sign + Number(pct).toFixed(1) + '%</span>';
      }
      function statusBadge(s) {
        var colors = { active: '#28a745', draft: '#6c757d', archived: '#888' };
        return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;' +
          'background:' + (colors[s] || '#888') + '22;color:' + (colors[s] || '#888') + '">' + E(s || '—') + '</span>';
      }
      function eur(v) { return v != null ? Number(v).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }

      // ── KPI (кількість норм) ──────────────────────────────────────
      window.modApi('/api/material-norms?limit=1').then(function (d) {
        var total = (d && d.total) != null ? d.total : 0;
        return window.modApi('/api/material-norms?status=active&limit=1').then(function (a) {
          var active = (a && a.total) != null ? a.total : 0;
          if (kpiEl) kpiEl.innerHTML =
            window.modCard('Всього нормативних карт', total, '#222') +
            window.modCard('Активних карт', active, '#28a745') +
            window.modCard('Чернеток', total - active, active === total ? '#888' : '#f0ad4e');
        });
      }).catch(function () {});

      // ── Звіт розходу ─────────────────────────────────────────────
      function loadReport() {
        if (reportEl) reportEl.innerHTML = window.modEmpty('Завантаження…');
        var gb = groupbyEl ? groupbyEl.value : 'product';
        var params = 'group_by=' + gb;
        if (dfromEl && dfromEl.value) params += '&date_from=' + dfromEl.value;
        if (dtoEl && dtoEl.value) params += '&date_to=' + dtoEl.value;
        window.modApi('/api/material-norms/consumption/report?' + params).then(function (d) {
          var rows = (d && d.rows) || [];
          if (!rows.length) { if (reportEl) reportEl.innerHTML = window.modEmpty('Даних за вибраний період немає'); return; }
          var heads = '<th style="'+TH+'">Групування</th>' +
            '<th style="'+TH+'">Норма</th>' +
            '<th style="'+TH+'">Факт</th>' +
            '<th style="'+TH+'">Відхилення</th>' +
            '<th style="'+TH+'">Собівартість</th>';
          var body = rows.map(function (r) {
            return '<tr>' +
              '<td style="'+TD+'"><b>' + E(r.group_key || '—') + '</b></td>' +
              '<td style="'+TD+'">' + E(Number(r.norm_total).toFixed(2)) + '</td>' +
              '<td style="'+TD+'">' + E(Number(r.actual_total).toFixed(2)) + '</td>' +
              '<td style="'+TD+'">' + devBadge(r.deviation_pct) + '</td>' +
              '<td style="'+TD+'">₴ ' + eur(r.cost) + '</td>' +
              '</tr>';
          }).join('');
          var total = (d.totals && d.totals.cost != null) ? '₴ ' + eur(d.totals.cost) : '';
          var foot = total ? '<tfoot><tr>' +
            '<td colspan="4" style="'+TD+';font-weight:700">Разом</td>' +
            '<td style="'+TD+';font-weight:700">' + total + '</td>' +
            '</tr></tfoot>' : '';
          if (reportEl) reportEl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' + heads + '</tr></thead><tbody>' + body + '</tbody>' + foot + '</table></div>';
        }).catch(function (e) { window.modErr(reportEl, e); });
      }
      loadReport();
      if (applyBtn) applyBtn.addEventListener('click', loadReport);

      // ── Прогноз ──────────────────────────────────────────────────
      if (forecastEl) forecastEl.innerHTML = window.modEmpty('Завантаження…');
      window.modApi('/api/material-norms/consumption/forecast?days_ahead=14').then(function (d) {
        var items = (d && d.items) || [];
        // відфільтрувати тільки критичні (менше 14 днів до вичерпання)
        var critical = items.filter(function (i) { return i.days_until_empty != null && i.days_until_empty <= 14; });
        var display = critical.length ? critical : items.slice(0, 10);
        if (!display.length) {
          if (forecastEl) forecastEl.innerHTML = window.modEmpty('Запасів вистачає, критичних матеріалів немає');
          return;
        }
        var heads = '<th style="'+TH+'">Матеріал</th>' +
          '<th style="'+TH+'">Залишок (шт)</th>' +
          '<th style="'+TH+'">Прогноз 14 днів</th>' +
          '<th style="'+TH+'">Залишилось днів</th>';
        var body = display.map(function (i) {
          var days = i.days_until_empty;
          var daysColor = days == null ? '#888' : days <= 3 ? '#d9534f' : days <= 7 ? '#f0ad4e' : '#28a745';
          return '<tr>' +
            '<td style="'+TD+'"><b>' + E(i.product_name || '—') + '</b></td>' +
            '<td style="'+TD+'">' + E(i.stock_qty != null ? Number(i.stock_qty).toFixed(0) : '—') + '</td>' +
            '<td style="'+TD+'">' + E(i.forecast_qty != null ? Number(i.forecast_qty).toFixed(2) : '—') + '</td>' +
            '<td style="'+TD+';color:' + daysColor + ';font-weight:600">' +
              (days != null ? days + ' дн.' : '∞') + '</td>' +
            '</tr>';
        }).join('');
        if (forecastEl) forecastEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' + heads + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { window.modErr(forecastEl, e); });

      // ── Маржинальність послуг ──────────────────────────────────
      if (profitEl) profitEl.innerHTML = window.modEmpty('Завантаження…');
      window.modApi('/api/material-norms/reports/profitability').then(function (d) {
        var items = (d && d.items) || [];
        if (!items.length) { if (profitEl) profitEl.innerHTML = window.modEmpty('Нормативних карт немає'); return; }
        var heads = '<th style="'+TH+'">Послуга</th>' +
          '<th style="'+TH+'">Ціна</th>' +
          '<th style="'+TH+'">Собівартість</th>' +
          '<th style="'+TH+'">Маржа</th>';
        var body = items.map(function (r) {
          var mPct = r.margin_pct != null ? Number(r.margin_pct) : null;
          var mColor = mPct == null ? '#888' : mPct < 30 ? '#d9534f' : mPct < 50 ? '#f0ad4e' : '#28a745';
          return '<tr>' +
            '<td style="'+TD+'"><b>' + E(r.service || '—') + '</b></td>' +
            '<td style="'+TD+'">₴ ' + eur(r.revenue) + '</td>' +
            '<td style="'+TD+'">₴ ' + eur(r.cost) + '</td>' +
            '<td style="'+TD+';color:' + mColor + ';font-weight:600">' +
              (mPct != null ? mPct.toFixed(1) + '%' : '—') + '</td>' +
            '</tr>';
        }).join('');
        if (profitEl) profitEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' + heads + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { window.modErr(profitEl, e); });

      // ── Нормативні карти ──────────────────────────────────────
      function loadNorms() {
        if (normsEl) normsEl.innerHTML = window.modEmpty('Завантаження…');
        var params = 'limit=50';
        if (searchEl && searchEl.value) params += '&search=' + encodeURIComponent(searchEl.value);
        if (statusEl && statusEl.value) params += '&status=' + encodeURIComponent(statusEl.value);
        window.modApi('/api/material-norms?' + params).then(function (d) {
          var items = (d && d.items) || [];
          if (!items.length) { if (normsEl) normsEl.innerHTML = window.modEmpty('Карт не знайдено'); return; }
          var heads = '<th style="'+TH+'">Назва</th>' +
            '<th style="'+TH+'">Послуга</th>' +
            '<th style="'+TH+'">Варіант</th>' +
            '<th style="'+TH+'">Матеріалів</th>' +
            '<th style="'+TH+'">Статус</th>' +
            '<th style="'+TH+'">Оновлено</th>';
          var body = items.map(function (n) {
            return '<tr>' +
              '<td style="'+TD+'"><b>' + E(n.name || '—') + '</b></td>' +
              '<td style="'+TD+'">' + E(n.service_name || '—') + '</td>' +
              '<td style="'+TD+'">' + E(n.service_variant || '—') + '</td>' +
              '<td style="'+TD+';text-align:center">' + E(n.materials_count != null ? n.materials_count : '—') + '</td>' +
              '<td style="'+TD+'">' + statusBadge(n.status) + '</td>' +
              '<td style="'+TD+';color:#888;font-size:12px">' + (n.updated_at ? new Date(n.updated_at).toLocaleDateString('uk-UA') : '—') + '</td>' +
              '</tr>';
          }).join('');
          if (normsEl) normsEl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' + heads + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
            ((d.total > 50) ? '<p style="font-size:12px;color:#888;margin:6px 0">Показано 50 з ' + d.total + '</p>' : '');
        }).catch(function (e) { window.modErr(normsEl, e); });
      }
      loadNorms();
      if (normSrchBtn) normSrchBtn.addEventListener('click', loadNorms);
      if (searchEl) searchEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') loadNorms(); });
    }
  });


  /* ════ SAL-05 Shifts UI ═══════════════════════════════════════════════
     Маршрути: /api/shifts, /api/shifts/templates, /api/shifts/swaps,
               /api/shifts/timesheet, /api/shifts/generate, /api/shifts/publish
  ════════════════════════════════════════════════════════════════════════ */
  window.registerModule({
    page: 'shifts',
    title: 'Графік змін',
    group: 'platform',
    icon: 'schedule',
    section:
      '<div id="sh-kpi" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>' +

      '<h3 style="font-size:15px;margin:0 0 8px;font-weight:600">Шаблони ротацій</h3>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">' +
        '<select id="sh-tpl-branch" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<option value="">Всі філіали</option>' +
        '</select>' +
        '<select id="sh-tpl-active" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<option value="true">Активні</option>' +
          '<option value="">Всі</option>' +
        '</select>' +
        '<button id="sh-tpl-load" style="padding:6px 14px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Оновити</button>' +
      '</div>' +
      '<div id="sh-templates" style="margin-bottom:20px"></div>' +

      '<h3 style="font-size:15px;margin:16px 0 8px;font-weight:600">Зміни сьогодні (статус публікації)</h3>' +
      '<div id="sh-today" style="margin-bottom:20px"></div>' +

      '<h3 style="font-size:15px;margin:16px 0 8px;font-weight:600">Заявки на обмін</h3>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">' +
        '<select id="sh-swap-status" style="padding:6px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<option value="pending">Pending</option>' +
          '<option value="accepted">Accepted</option>' +
          '<option value="approved">Approved</option>' +
          '<option value="">Всі</option>' +
        '</select>' +
        '<button id="sh-swap-load" style="padding:6px 14px;background:#007bff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Оновити</button>' +
      '</div>' +
      '<div id="sh-swaps" style="margin-bottom:20px"></div>' +

      '<h3 style="font-size:15px;margin:16px 0 8px;font-weight:600">Табель поточного місяця</h3>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">' +
        '<input id="sh-ts-empid" type="text" placeholder="ID або ім\'я майстра (пошук)" ' +
          'style="padding:6px 12px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:200px">' +
        '<button id="sh-ts-load" style="padding:6px 14px;background:#6c757d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">Показати табель</button>' +
      '</div>' +
      '<div id="sh-timesheet"></div>',

    loader: async function () {
      var TH = 'padding:9px 13px;text-align:left;border-bottom:2px solid #eee;font-size:12px;color:#888;font-weight:600;text-transform:uppercase';
      var TD = 'padding:9px 13px;border-bottom:1px solid #f0f0f0;font-size:13px';

      var kpiEl    = document.getElementById('sh-kpi');
      var tplEl    = document.getElementById('sh-templates');
      var todayEl  = document.getElementById('sh-today');
      var swapsEl  = document.getElementById('sh-swaps');
      var tsEl     = document.getElementById('sh-timesheet');
      var tplBranchSel = document.getElementById('sh-tpl-branch');
      var tplActiveSel = document.getElementById('sh-tpl-active');
      var tplBtn   = document.getElementById('sh-tpl-load');
      var swapStatusSel = document.getElementById('sh-swap-status');
      var swapBtn  = document.getElementById('sh-swap-load');
      var tsEmpInp = document.getElementById('sh-ts-empid');
      var tsBtn    = document.getElementById('sh-ts-load');

      function localDt(v) {
        if (!v) return '—';
        try { return new Date(v).toLocaleDateString('uk-UA'); } catch (_) { return E(v); }
      }
      function localBadge(txt, color) {
        return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;' +
          'background:' + (color || '#eee') + '22;color:' + (color || '#666') + '">' + E(txt) + '</span>';
      }
      function shiftStatusColor(s) {
        s = String(s || '').toLowerCase();
        if (s === 'published' || s === 'completed') return '#28a745';
        if (s === 'in_progress' || s === 'confirmed') return '#007bff';
        if (s === 'planned') return '#6c757d';
        if (s === 'cancelled') return '#d9534f';
        return '#888';
      }
      function swapColor(s) {
        if (s === 'approved' || s === 'completed') return '#28a745';
        if (s === 'accepted') return '#007bff';
        if (s === 'pending') return '#f0ad4e';
        if (s === 'rejected' || s === 'cancelled') return '#d9534f';
        return '#888';
      }
      function typeLabel(t) {
        var map = { morning: 'Ранкова', evening: 'Вечірня', full: 'Повна', split: 'Розділена', night: 'Нічна' };
        return map[t] || E(t || '—');
      }

      // ── KPI: templates count + pending swaps + today's overloaded ──
      var kpiDone = 0;
      var kpiTpl = 0, kpiSwap = 0, kpiShifts = 0, kpiPublished = 0;
      function renderKpi() {
        kpiDone++;
        if (kpiDone < 3) return;
        if (kpiEl) kpiEl.innerHTML =
          window.modCard('Активних шаблонів', kpiTpl, '#222') +
          window.modCard('Pending-обмінів', kpiSwap, kpiSwap ? '#f0ad4e' : '#888') +
          window.modCard('Змін сьогодні', kpiShifts, '#007bff') +
          window.modCard('Опубліковано', kpiPublished, '#28a745');
      }

      // templates count
      window.modApi('/api/shifts/templates?active=true&limit=1').then(function (d) {
        kpiTpl = (d && d.total) != null ? d.total : ((d && Array.isArray(d.items)) ? d.items.length : 0);
        renderKpi();
      }).catch(function () { renderKpi(); });

      // pending swaps count
      window.modApi('/api/shifts/swaps?status=pending&limit=1').then(function (d) {
        kpiSwap = (d && d.total) != null ? d.total : ((d && Array.isArray(d.items)) ? d.items.length : 0);
        renderKpi();
      }).catch(function () { renderKpi(); });

      // today's shifts
      var todayStr = new Date().toISOString().slice(0, 10);
      window.modApi('/api/shifts?date_from=' + todayStr + '&date_to=' + todayStr + '&limit=200').then(function (d) {
        var items = (d && d.items) || [];
        kpiShifts = items.length;
        kpiPublished = items.filter(function (s) { return s.status === 'published' || s.status === 'completed' || s.status === 'in_progress'; }).length;
        renderKpi();
        // render today grid
        if (!items.length) {
          if (todayEl) todayEl.innerHTML = window.modEmpty('Змін на сьогодні не заплановано');
          return;
        }
        var body = items.map(function (s) {
          return '<tr>' +
            '<td style="' + TD + '"><b>' + E(s.employee_name || s.employee_id || '—') + '</b></td>' +
            '<td style="' + TD + '">' + typeLabel(s.shift_type) + '</td>' +
            '<td style="' + TD + '">' + E(s.start_time || '—') + ' – ' + E(s.end_time || '—') + '</td>' +
            '<td style="' + TD + '">' + E(s.planned_hours != null ? Number(s.planned_hours).toFixed(1) + ' год' : '—') + '</td>' +
            '<td style="' + TD + '">' + localBadge(s.status || '—', shiftStatusColor(s.status)) + '</td>' +
            '<td style="' + TD + ';color:#888;font-size:12px">' + E(s.branch_name || s.branch_id || '—') + '</td>' +
            '</tr>';
        }).join('');
        if (todayEl) todayEl.innerHTML =
          '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
          '<thead><tr>' +
            '<th style="' + TH + '">Майстер</th>' +
            '<th style="' + TH + '">Тип</th>' +
            '<th style="' + TH + '">Час</th>' +
            '<th style="' + TH + '">Год (план)</th>' +
            '<th style="' + TH + '">Статус</th>' +
            '<th style="' + TH + '">Філіал</th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div>';
      }).catch(function (e) { renderKpi(); window.modErr(todayEl, e); });

      // ── Шаблони ───────────────────────────────────────────────────
      function loadTemplates() {
        if (tplEl) tplEl.innerHTML = window.modEmpty('Завантаження…');
        var q = '/api/shifts/templates?limit=100';
        var av = tplActiveSel ? tplActiveSel.value : 'true';
        var br = tplBranchSel ? tplBranchSel.value : '';
        if (av) q += '&active=' + encodeURIComponent(av);
        if (br) q += '&branch_id=' + encodeURIComponent(br);
        window.modApi(q).then(function (d) {
          var items = (d && d.items) || (Array.isArray(d) ? d : []);
          if (!items.length) {
            if (tplEl) tplEl.innerHTML = window.modEmpty('Шаблонів не знайдено');
            return;
          }
          var body = items.map(function (t) {
            var days = Array.isArray(t.weekdays) ? t.weekdays.map(function (d) {
              return ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'][d] || d;
            }).join(', ') : E(t.weekdays || '—');
            return '<tr>' +
              '<td style="' + TD + '"><b>' + E(t.name || '—') + '</b></td>' +
              '<td style="' + TD + '">' + typeLabel(t.shift_type) + '</td>' +
              '<td style="' + TD + '">' + E(t.start_time || '—') + ' – ' + E(t.end_time || '—') + '</td>' +
              '<td style="' + TD + '">' + days + '</td>' +
              '<td style="' + TD + '">' + E(t.rotation_pattern || '—') + '</td>' +
              '<td style="' + TD + '">' + E(t.min_staff != null ? t.min_staff + ' ос.' : '—') + '</td>' +
              '<td style="' + TD + '">' + localBadge(t.active ? 'active' : 'inactive', t.active ? '#28a745' : '#888') + '</td>' +
              '</tr>';
          }).join('');
          if (tplEl) tplEl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' +
              '<th style="' + TH + '">Назва</th>' +
              '<th style="' + TH + '">Тип зміни</th>' +
              '<th style="' + TH + '">Час</th>' +
              '<th style="' + TH + '">Дні тижня</th>' +
              '<th style="' + TH + '">Ротація</th>' +
              '<th style="' + TH + '">Мін. персонал</th>' +
              '<th style="' + TH + '">Статус</th>' +
            '</tr></thead><tbody>' + body + '</tbody></table></div>';
        }).catch(function (e) { window.modErr(tplEl, e); });
      }
      loadTemplates();
      if (tplBtn) tplBtn.addEventListener('click', loadTemplates);

      // ── Заявки на обмін ───────────────────────────────────────────
      function loadSwaps() {
        if (swapsEl) swapsEl.innerHTML = window.modEmpty('Завантаження…');
        var q = '/api/shifts/swaps?limit=50';
        var sv = swapStatusSel ? swapStatusSel.value : 'pending';
        if (sv) q += '&status=' + encodeURIComponent(sv);
        window.modApi(q).then(function (d) {
          var items = (d && d.items) || (Array.isArray(d) ? d : []);
          if (!items.length) {
            if (swapsEl) swapsEl.innerHTML = window.modEmpty('Заявок на обмін немає');
            return;
          }
          var body = items.map(function (sw) {
            return '<tr>' +
              '<td style="' + TD + '"><b>' + E(sw.requester_name || sw.requester_id || '—') + '</b></td>' +
              '<td style="' + TD + '">' + E(sw.acceptor_name  || sw.acceptor_id  || '—') + '</td>' +
              '<td style="' + TD + '">' + localDt(sw.shift_date || sw.created_at) + '</td>' +
              '<td style="' + TD + '">' + localBadge(sw.status || '—', swapColor(sw.status)) + '</td>' +
              '<td style="' + TD + ';color:#888;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis">' + E(sw.reason || '—') + '</td>' +
              '<td style="' + TD + ';color:#888;font-size:12px">' + (sw.approved_at ? '✔ ' + localDt(sw.approved_at) : (sw.accepted_at ? '⏳ ' + localDt(sw.accepted_at) : '—')) + '</td>' +
              '</tr>';
          }).join('');
          if (swapsEl) swapsEl.innerHTML =
            '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">' +
            '<thead><tr>' +
              '<th style="' + TH + '">Ініціатор</th>' +
              '<th style="' + TH + '">Адресат</th>' +
              '<th style="' + TH + '">Дата</th>' +
              '<th style="' + TH + '">Статус</th>' +
              '<th style="' + TH + '">Причина</th>' +
              '<th style="' + TH + '">Підтверджено</th>' +
            '</tr></thead><tbody>' + body + '</tbody></table></div>' +
            ((d && d.total > 50) ? '<p style="font-size:12px;color:#888;margin:6px 0">Показано 50 з ' + d.total + '</p>' : '');
        }).catch(function (e) { window.modErr(swapsEl, e); });
      }
      loadSwaps();
      if (swapBtn) swapBtn.addEventListener('click', loadSwaps);

      // ── Табель поточного місяця ────────────────────────────────────
      function loadTimesheet() {
        var empId = tsEmpInp ? tsEmpInp.value.trim() : '';
        if (tsEl) tsEl.innerHTML = window.modEmpty('Завантаження…');
        var now2 = new Date();
        var month = now2.getFullYear() + '-' + String(now2.getMonth() + 1).padStart(2, '0');
        var q = '/api/shifts/timesheet?month=' + month;
        if (empId) q += '&employee_id=' + encodeURIComponent(empId);
        window.modApi(q).then(function (d) {
          // Response може бути масивом (кілька майстрів) або одним об'єктом
          var entries = Array.isArray(d) ? d : (d && d.items ? d.items : (d && d.employee ? [d] : []));
          if (!entries.length) {
            if (tsEl) tsEl.innerHTML = window.modEmpty('Табель порожній (немає даних за ' + month + ')');
            return;
          }
          var html = '';
          entries.forEach(function (entry) {
            var emp = entry.employee || {};
            var days = Array.isArray(entry.days) ? entry.days : [];
            var tot  = entry.totals || {};
            html += '<div style="margin-bottom:16px;border:1px solid #eee;border-radius:8px;padding:14px">';
            html += '<div style="font-weight:600;font-size:15px;margin-bottom:10px">' +
              E(emp.name || emp.full_name || entry.employee_id || 'Майстер') +
              (emp.position ? ' <span style="font-size:12px;color:#888;font-weight:400">– ' + E(emp.position) + '</span>' : '') +
              '</div>';
            if (days.length) {
              html += '<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:12px">';
              html += '<thead><tr>' +
                '<th style="' + TH + ';font-size:11px">Дата</th>' +
                '<th style="' + TH + ';font-size:11px">Тип</th>' +
                '<th style="' + TH + ';font-size:11px">Год план</th>' +
                '<th style="' + TH + ';font-size:11px">Год факт</th>' +
                '<th style="' + TH + ';font-size:11px">Переробка</th>' +
                '<th style="' + TH + ';font-size:11px">Статус</th>' +
                '</tr></thead><tbody>';
              days.forEach(function (day) {
                var sc = shiftStatusColor(day.status);
                html += '<tr>' +
                  '<td style="' + TD + ';font-size:12px">' + E(day.date || '—') + '</td>' +
                  '<td style="' + TD + ';font-size:12px">' + typeLabel(day.shift_type || day.day_type) + '</td>' +
                  '<td style="' + TD + ';font-size:12px;text-align:center">' + (day.planned_hours != null ? Number(day.planned_hours).toFixed(1) : '—') + '</td>' +
                  '<td style="' + TD + ';font-size:12px;text-align:center">' + (day.actual_hours  != null ? Number(day.actual_hours).toFixed(1)  : '—') + '</td>' +
                  '<td style="' + TD + ';font-size:12px;text-align:center;color:' + (day.overtime != null && Number(day.overtime) > 0 ? '#d9534f' : '#888') + '">' +
                    (day.overtime != null ? (Number(day.overtime) > 0 ? '+' + Number(day.overtime).toFixed(1) : '—') : '—') + '</td>' +
                  '<td style="' + TD + ';font-size:12px">' + localBadge(day.status || '—', sc) + '</td>' +
                  '</tr>';
              });
              html += '</tbody></table></div>';
            }
            // Підсумок
            html += '<div style="margin-top:10px;display:flex;gap:20px;flex-wrap:wrap;font-size:13px">' +
              (tot.plan_hours   != null ? '<span><b>' + Number(tot.plan_hours).toFixed(1)   + '</b> год план</span>'  : '') +
              (tot.actual_hours != null ? '<span><b>' + Number(tot.actual_hours).toFixed(1) + '</b> год факт</span>'  : '') +
              (tot.overtime     != null ? '<span style="color:' + (Number(tot.overtime) > 0 ? '#d9534f' : '#888') + '"><b>' +
                (Number(tot.overtime) > 0 ? '+' : '') + Number(tot.overtime).toFixed(1) + '</b> переробка</span>' : '') +
              (tot.late_count   != null ? '<span style="color:#f0ad4e"><b>' + tot.late_count   + '</b> запізнень</span>'   : '') +
              (tot.absent_count != null ? '<span style="color:#d9534f"><b>' + tot.absent_count + '</b> прогулів</span>'    : '') +
              '</div>';
            html += '</div>';
          });
          if (tsEl) tsEl.innerHTML = html;
        }).catch(function (e) { window.modErr(tsEl, e); });
      }
      // Автозавантаження табеля без ID (загальний)
      loadTimesheet();
      if (tsBtn) tsBtn.addEventListener('click', loadTimesheet);
      if (tsEmpInp) tsEmpInp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') loadTimesheet(); });
    }
  });

})();
