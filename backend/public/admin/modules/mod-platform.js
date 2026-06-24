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

})();
