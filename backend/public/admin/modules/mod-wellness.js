/* ═══ UI-МОДУЛЬ: ВЕЛНЕС (вертикаль wellness, Phase B 18.07.2026) ═══════════
 * Сторінки: welrooms (кабінети: день, зайнятість, парний запис),
 *           welservices (які послуги вимагають кабінет).
 * Ізоляція: група grp-wellness видима ЛИШЕ business_type=wellness;
 * API /api/wellness/* існує тільки для wellness-тенантів (404 іншим).
 * Кабінети (CRUD) — існуюча сторінка «Кабінети» (rooms), повторно використана.
 * ─────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var esc = function (s) { return window.modEsc(s); };
  var API = function (p, o) { return window.modApi(p, o); };
  function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fmtT(iso) { return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }); }
  var curDay = new Date();
  var refCache = null;

  function loadRefs(force) {
    if (refCache && !force) return Promise.resolve(refCache);
    return Promise.all([
      API('/api/schedule/masters').catch(function () { return []; }),
      API('/api/admin/services').catch(function () { return []; }),
      API('/api/rooms').catch(function () { return []; }),
    ]).then(function (r) {
      refCache = {
        masters: Array.isArray(r[0]) ? r[0] : (r[0].items || r[0].masters || []),
        services: Array.isArray(r[1]) ? r[1] : (r[1].items || r[1].services || []),
        rooms: Array.isArray(r[2]) ? r[2] : (r[2].items || r[2].rooms || []),
      };
      return refCache;
    });
  }
  function opts(list, valKey, labKey, selected) {
    var h = '<option value="">—</option>';
    (list || []).forEach(function (x) {
      h += '<option value="' + x[valKey] + '"' + (String(selected) === String(x[valKey]) ? ' selected' : '') + '>' + esc(x[labKey]) + '</option>';
    });
    return h;
  }

  /* ══ КАБІНЕТИ: день ══════════════════════════════════════════════════ */
  function loadWelRooms() {
    var el = document.querySelector('#page-welrooms .ext-mod-body');
    if (!el) return;
    var day = dstr(curDay);
    el.innerHTML = '<div style="padding:30px;text-align:center;color:#9aa0a6">Завантаження…</div>';
    API('/api/wellness/rooms-day?date=' + day).then(function (r) {
      var byRoom = {};
      (r.appointments || []).forEach(function (a) { (byRoom[a.room_id] = byRoom[a.room_id] || []).push(a); });
      var h = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">' +
        '<button class="btn btn-outline btn-sm" onclick="welDay(-1)">◀</button>' +
        '<b>' + new Date(day).toLocaleDateString('uk-UA', { weekday: 'short', day: '2-digit', month: '2-digit' }) + '</b>' +
        '<button class="btn btn-outline btn-sm" onclick="welDay(1)">▶</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-primary btn-sm" onclick="welCouplesModal()"><span class="material-icons-round" style="font-size:15px">group_add</span> Парний запис</button></div>';
      if (!(r.rooms || []).length) {
        h += '<div style="padding:24px;color:#888">Немає кабінетів. Додайте їх на сторінці «Кабінети» (місткість 2 — для парних записів).</div>';
      }
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;align-items:start">';
      (r.rooms || []).forEach(function (room) {
        var appts = byRoom[room.id] || [];
        h += '<div style="background:var(--card-bg,#fff);border:1px solid var(--border,#e5e7eb);border-left:4px solid ' + (room.color || '#7c5cff') + ';border-radius:10px;padding:10px">' +
          '<div style="font-weight:700;margin-bottom:2px">' + esc(room.name) + '</div>' +
          '<div style="font-size:11px;color:#888;margin-bottom:8px">місткість: ' + (room.capacity || 1) + (appts.length ? ' · записів: ' + appts.length : ' · вільно') + '</div>';
        appts.forEach(function (a) {
          h += '<div style="font-size:12px;padding:6px 8px;border-radius:8px;background:rgba(124,92,255,.08);margin-bottom:5px">' +
            '<b>' + fmtT(a.starts_at) + '–' + fmtT(a.ends_at) + '</b> ' + esc(a.service_name || '') +
            '<div style="color:#666">' + esc(a.client_name || 'Клієнт') + ' · ' + esc(a.master_name || '') + '</div></div>';
        });
        h += '</div>';
      });
      h += '</div>';
      el.innerHTML = h;
    }).catch(function (e) { el.innerHTML = '<div style="padding:24px;color:#c00">' + esc(e.message || 'Помилка') + '</div>'; });
  }
  window.welDay = function (dir) { curDay.setDate(curDay.getDate() + dir); loadWelRooms(); };

  /* ── парний запис ── */
  window.welCouplesModal = function () {
    loadRefs().then(function (refs) {
      var half = function (n) {
        return '<div style="flex:1;min-width:220px;border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:10px">' +
          '<b style="font-size:13px">Гість ' + n + '</b>' +
          '<label style="font-size:12px;color:#888;display:block;margin-top:8px">Майстер</label><select id="wcM' + n + '" class="input">' + opts(refs.masters, 'id', 'name') + '</select>' +
          '<label style="font-size:12px;color:#888;display:block;margin-top:8px">Послуга</label><select id="wcS' + n + '" class="input">' + opts(refs.services, 'id', 'name') + '</select>' +
          '<label style="font-size:12px;color:#888;display:block;margin-top:8px">Імʼя клієнта</label><input id="wcN' + n + '" class="input" placeholder="Імʼя">' +
          '<label style="font-size:12px;color:#888;display:block;margin-top:8px">Телефон</label><input id="wcP' + n + '" class="input" placeholder="+380..."></div>';
      };
      var body = '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:150px"><label style="font-size:12px;color:#888">Дата і час</label><input id="wcDt" type="datetime-local" class="input" value="' + dstr(curDay) + 'T12:00"></div>' +
        '<div style="flex:1;min-width:150px"><label style="font-size:12px;color:#888">Кабінет (авто, якщо порожньо)</label><select id="wcRoom" class="input">' + opts(refs.rooms.filter(function (x) { return (x.capacity || 1) >= 2; }), 'id', 'name') + '</select></div></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' + half(1) + half(2) + '</div>';
      showModal('Парний запис (couples)', body, function () { return window.welCouplesCreate(); });
    });
  };
  window.welCouplesCreate = function () {
    var it = function (n) {
      return {
        master_id: document.getElementById('wcM' + n).value || null,
        service_id: document.getElementById('wcS' + n).value || null,
        client_name: document.getElementById('wcN' + n).value.trim() || null,
        client_phone: document.getElementById('wcP' + n).value.trim() || null,
      };
    };
    var payload = {
      starts_at: document.getElementById('wcDt').value,
      room_id: document.getElementById('wcRoom').value || null,
      items: [it(1), it(2)],
    };
    return API('/api/wellness/couples', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      toast('Парний запис створено (кабінет #' + r.room_id + ')');
      loadWelRooms();
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); throw e; });
  };

  /* ══ ПОСЛУГИ І КАБІНЕТИ ══════════════════════════════════════════════ */
  function loadWelServices() {
    var el = document.querySelector('#page-welservices .ext-mod-body');
    if (!el) return;
    el.innerHTML = '<div style="padding:30px;text-align:center;color:#9aa0a6">Завантаження…</div>';
    Promise.all([API('/api/wellness/service-rooms'), loadRefs()]).then(function (r) {
      var items = r[0].items || [];
      var rooms = r[1].rooms || [];
      var h = '<div style="font-size:13px;color:#888;margin-bottom:12px">Послуга з позначкою «потребує кабінет» бронюється лише коли є вільний кабінет — захист від подвійного бронювання дорогих ресурсів (пара, сауна, апарат).</div>';
      h += '<table class="table"><thead><tr><th>Послуга</th><th>Хв</th><th>Потребує кабінет</th><th>Бажаний кабінет</th></tr></thead><tbody>';
      items.forEach(function (s) {
        h += '<tr><td>' + esc(s.name) + '</td><td>' + (s.duration_min || '') + '</td>' +
          '<td><input type="checkbox" ' + (s.requires_room ? 'checked' : '') + ' onchange="welSrrToggle(' + s.service_id + ', this.checked)"></td>' +
          '<td><select class="input" style="max-width:190px" onchange="welSrrPref(' + s.service_id + ', this.value)" ' + (s.requires_room ? '' : 'disabled') + '>' +
          opts(rooms, 'id', 'name', s.preferred_room_id) + '</select></td></tr>';
      });
      h += '</tbody></table>';
      el.innerHTML = h;
    }).catch(function (e) { el.innerHTML = '<div style="padding:24px;color:#c00">' + esc(e.message || 'Помилка') + '</div>'; });
  }
  window.welSrrToggle = function (sid, on) {
    API('/api/wellness/service-rooms/' + sid, { method: 'PUT', body: JSON.stringify({ requires_room: !!on }) })
      .then(function () { loadWelServices(); }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.welSrrPref = function (sid, roomId) {
    API('/api/wellness/service-rooms/' + sid, { method: 'PUT', body: JSON.stringify({ requires_room: true, preferred_room_id: roomId || null }) })
      .then(function () { toast('Збережено'); }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ── реєстрація сторінок ── */
  window.registerModule({ page: 'welrooms', title: 'Кабінети: день', group: 'wellness', icon: 'meeting_room', loader: loadWelRooms });
  window.registerModule({ page: 'welservices', title: 'Послуги і кабінети', group: 'wellness', icon: 'design_services', loader: loadWelServices });
})();
