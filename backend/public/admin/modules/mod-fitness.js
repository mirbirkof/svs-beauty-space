/* ═══ UI-МОДУЛЬ: ФІТНЕС (вертикаль fitness, 18.07.2026) ═══════════════════
 * Сторінки: fitschedule (розклад занять на тиждень), fitcheckin (чек-ін).
 * Ізоляція: група меню grp-fitness видима ЛИШЕ business_type=fitness
 * (applyEntitlements + pre-hide за localStorage). API /api/fitness/* існує
 * тільки для fitness-тенантів (404 іншим). Абонементи — існуюча сторінка
 * «Продажі → Абонементи» (модуль subscriptions, повторно використаний).
 * ─────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var esc = function (s) { return window.modEsc(s); };
  var API = function (p, o) { return window.modApi(p, o); };

  /* ── дати (локальні, без UTC-зсувів) ── */
  function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function weekStart(d) { var x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); x.setHours(0, 0, 0, 0); return x; }
  function fmtT(iso) { return new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }); }
  var DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
  var curMonday = weekStart(new Date());
  var refCache = null; // {types, masters, rooms}

  function loadRefs(force) {
    if (refCache && !force) return Promise.resolve(refCache);
    return Promise.all([
      API('/api/fitness/class-types').catch(function () { return { items: [] }; }),
      API('/api/schedule/masters').catch(function () { return []; }),
      API('/api/rooms').catch(function () { return []; }),
    ]).then(function (r) {
      refCache = {
        types: (r[0].items || []).filter(function (t) { return t.active !== false; }),
        masters: Array.isArray(r[1]) ? r[1] : (r[1].items || r[1].masters || []),
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

  /* ══ РОЗКЛАД ЗАНЯТЬ ══════════════════════════════════════════════════ */
  function loadFitSchedule() {
    var el = document.querySelector('#page-fitschedule .ext-mod-body');
    if (!el) return;
    var from = dstr(curMonday);
    var end = new Date(curMonday); end.setDate(end.getDate() + 6);
    var to = dstr(end);
    el.innerHTML = '<div style="padding:30px;text-align:center;color:#9aa0a6">Завантаження…</div>';
    Promise.all([API('/api/fitness/classes?from=' + from + '&to=' + to), loadRefs()]).then(function (r) {
      var items = r[0].items || [];
      var byDay = {};
      items.forEach(function (c) { var k = dstr(new Date(c.starts_at)); (byDay[k] = byDay[k] || []).push(c); });
      var h = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">' +
        '<button class="btn btn-outline btn-sm" onclick="fitWeek(-1)">◀</button>' +
        '<b>' + from.slice(8, 10) + '.' + from.slice(5, 7) + ' – ' + to.slice(8, 10) + '.' + to.slice(5, 7) + '</b>' +
        '<button class="btn btn-outline btn-sm" onclick="fitWeek(1)">▶</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-outline btn-sm" onclick="fitTypesModal()"><span class="material-icons-round" style="font-size:15px">category</span> Типи занять</button>' +
        '<button class="btn btn-outline btn-sm" onclick="fitTemplatesModal()"><span class="material-icons-round" style="font-size:15px">event_repeat</span> Шаблон тижня</button>' +
        '<button class="btn btn-primary btn-sm" onclick="fitClassModal()"><span class="material-icons-round" style="font-size:15px">add</span> Заняття</button></div>';
      h += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:start">';
      for (var i = 0; i < 7; i++) {
        var day = new Date(curMonday); day.setDate(day.getDate() + i);
        var k = dstr(day);
        var today = k === dstr(new Date());
        h += '<div style="background:var(--card-bg,#fff);border:1px solid ' + (today ? '#7c5cff' : 'var(--border,#e5e7eb)') + ';border-radius:10px;min-height:120px;padding:8px">' +
          '<div style="font-size:12px;font-weight:700;color:' + (today ? '#7c5cff' : '#888') + ';margin-bottom:6px">' + DAYS[i] + ' ' + k.slice(8, 10) + '.' + k.slice(5, 7) + '</div>';
        (byDay[k] || []).forEach(function (c) {
          var full = c.booked >= c.capacity;
          var cls = c.status === 'cancelled';
          h += '<div onclick="fitOpenClass(' + c.id + ')" style="cursor:pointer;border-left:3px solid ' + (c.color || '#7c5cff') + ';background:' + (cls ? '#f3f4f6' : 'rgba(124,92,255,.06)') + ';border-radius:6px;padding:6px 8px;margin-bottom:6px;' + (cls ? 'opacity:.55;text-decoration:line-through' : '') + '">' +
            '<div style="font-size:12px;font-weight:600">' + fmtT(c.starts_at) + ' ' + esc(c.type_name) + '</div>' +
            '<div style="font-size:11px;color:#777">' + esc(c.trainer_name || '') + (c.room_name ? ' · ' + esc(c.room_name) : '') + '</div>' +
            '<div style="font-size:11px;font-weight:600;color:' + (full ? '#d9534f' : '#1a9c6b') + '">' + c.booked + '/' + c.capacity +
            (c.waitlist ? ' <span style="color:#e8a13c">+' + c.waitlist + ' в черзі</span>' : '') + '</div></div>';
        });
        h += '</div>';
      }
      h += '</div>';
      el.innerHTML = h;
    }).catch(function (e) { window.modErr(el, e); });
  }
  window.fitWeek = function (dir) { curMonday.setDate(curMonday.getDate() + dir * 7); loadFitSchedule(); };

  /* ── створення/редагування заняття ── */
  window.fitClassModal = function () {
    loadRefs().then(function (refs) {
      showModal('Нове заняття',
        '<div style="display:grid;gap:10px">' +
        '<label>Тип заняття<select id="fcType" class="form-control">' + opts(refs.types, 'id', 'name') + '</select></label>' +
        '<label>Дата і час<input id="fcStart" type="datetime-local" class="form-control"></label>' +
        '<label>Тренер<select id="fcTrainer" class="form-control">' + opts(refs.masters, 'id', 'name') + '</select></label>' +
        '<label>Зал<select id="fcRoom" class="form-control">' + opts(refs.rooms, 'id', 'name') + '</select></label>' +
        '<label>Місць (порожньо = за типом)<input id="fcCap" type="number" min="1" class="form-control"></label></div>',
        function () {
          var tid = document.getElementById('fcType').value, st = document.getElementById('fcStart').value;
          if (!tid || !st) { toast('Оберіть тип і час', 'error'); throw new Error('validation'); }
          return API('/api/fitness/classes', { method: 'POST', body: JSON.stringify({
            class_type_id: +tid, starts_at: st,
            trainer_id: document.getElementById('fcTrainer').value || null,
            room_id: document.getElementById('fcRoom').value || null,
            capacity: document.getElementById('fcCap').value || null }) })
            .then(function () { toast('Заняття створено'); loadFitSchedule(); });
        });
    });
  };

  /* ── картка заняття: склад, відмітки, запис клієнта ── */
  window.fitOpenClass = function (id) {
    API('/api/fitness/classes/' + id).then(function (r) {
      var c = r.item, bs = r.bookings || [];
      var live = bs.filter(function (b) { return ['booked', 'attended', 'noshow'].includes(b.status); });
      var wait = bs.filter(function (b) { return b.status === 'waitlist'; });
      var h = '<div style="margin-bottom:10px;font-size:13px;color:#666">' +
        new Date(c.starts_at).toLocaleString('uk-UA', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
        ' · ' + esc(c.trainer_name || 'без тренера') + (c.room_name ? ' · ' + esc(c.room_name) : '') +
        ' · місць: ' + c.capacity + '</div>';
      h += '<div style="display:flex;gap:6px;margin-bottom:12px">' +
        '<input id="fbSearch" class="form-control" placeholder="Пошук клієнта (імʼя/телефон)" style="flex:1" oninput="fitClientSearch(this.value,' + id + ')">' +
        '</div><div id="fbResults"></div>';
      function row(b) {
        var st = { booked: '🟢 записаний', attended: '✅ прийшов', noshow: '❌ не прийшов', waitlist: '⏳ черга №' + (b.waitlist_pos || '') }[b.status] || b.status;
        return '<div style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border,#eee)">' +
          '<div style="flex:1"><b>' + esc(b.client_name) + '</b> <span style="color:#888;font-size:12px">' + esc(b.client_phone || '') + '</span><div style="font-size:11px;color:#777">' + st + '</div></div>' +
          (b.status === 'booked' || b.status === 'waitlist'
            ? '<button class="btn btn-sm btn-outline" title="Прийшов" onclick="fitAttend(' + b.id + ',' + id + ',false)">✓</button>' +
              '<button class="btn btn-sm btn-outline" title="Не прийшов" onclick="fitNoshow(' + b.id + ',' + id + ')">✗</button>' +
              '<button class="btn btn-sm btn-outline" title="Скасувати запис" onclick="fitCancelBooking(' + b.id + ',' + id + ')">🗑</button>'
            : '') + '</div>';
      }
      h += '<div style="max-height:280px;overflow:auto">';
      if (!live.length && !wait.length) h += window.modEmpty('Поки нікого не записано');
      live.forEach(function (b) { h += row(b); });
      if (wait.length) { h += '<div style="margin-top:8px;font-size:12px;font-weight:700;color:#e8a13c">Лист очікування</div>'; wait.forEach(function (b) { h += row(b); }); }
      h += '</div>';
      if (c.status === 'scheduled') {
        h += '<div style="margin-top:12px;text-align:right"><button class="btn btn-sm btn-outline" style="color:#d9534f" onclick="fitCancelClass(' + id + ')">Скасувати заняття</button></div>';
      }
      showModal(esc(c.type_name) + ' — склад', h);
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  window.fitClientSearch = function (q, classId) {
    var box = document.getElementById('fbResults');
    if (!box) return;
    if (!q || q.length < 2) { box.innerHTML = ''; return; }
    API('/api/admin/clients?limit=6&search=' + encodeURIComponent(q)).then(function (r) {
      var list = r.items || r.clients || r || [];
      box.innerHTML = list.map(function (cl) {
        return '<div style="padding:6px 8px;cursor:pointer;border-radius:6px;background:rgba(124,92,255,.06);margin-bottom:4px" ' +
          'onclick="fitBook(' + classId + ',' + cl.id + ')"><b>' + esc(cl.name) + '</b> <span style="color:#888;font-size:12px">' + esc(cl.phone || '') + '</span></div>';
      }).join('') || '<div style="color:#9aa0a6;font-size:12px;padding:4px">Не знайдено</div>';
    }).catch(function () {});
  };

  window.fitBook = function (classId, clientId) {
    API('/api/fitness/classes/' + classId + '/book', { method: 'POST', body: JSON.stringify({ client_id: clientId }) })
      .then(function (r) {
        toast(r.waitlist ? 'Місць немає — клієнта додано в лист очікування' : 'Клієнта записано');
        window.fitOpenClass(classId); loadFitSchedule();
      }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.fitAttend = function (bookingId, classId, force) {
    API('/api/fitness/bookings/' + bookingId + '/attend', { method: 'POST', body: JSON.stringify(force ? { allow_without_membership: true } : {}) })
      .then(function (r) {
        toast(r.consumed ? 'Відмічено. Залишок візитів: ' + (r.consumed.balance === null ? '∞' : r.consumed.balance) : 'Відмічено (без абонемента)');
        window.fitOpenClass(classId);
      })
      .catch(function (e) {
        if (String(e.message || '').indexOf('абонемент') >= 0 || String(e.error || '') === 'no-valid-membership') {
          if (confirm('У клієнта немає дійсного абонемента. Відмітити відвідування без списання (разова оплата через касу)?')) window.fitAttend(bookingId, classId, true);
        } else toast(e.message || 'Помилка', 'error');
      });
  };
  window.fitNoshow = function (bookingId, classId) {
    API('/api/fitness/bookings/' + bookingId + '/noshow', { method: 'POST' }).then(function () { window.fitOpenClass(classId); }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.fitCancelBooking = function (bookingId, classId) {
    API('/api/fitness/bookings/' + bookingId + '/cancel', { method: 'POST' }).then(function (r) {
      toast(r.promoted ? 'Скасовано. З черги піднято наступного клієнта і надіслано сповіщення' : 'Запис скасовано');
      window.fitOpenClass(classId); loadFitSchedule();
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.fitCancelClass = function (id) {
    if (!confirm('Скасувати заняття? Всі записані отримають сповіщення.')) return;
    API('/api/fitness/classes/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) })
      .then(function () { document.getElementById('genModal')?.remove(); toast('Заняття скасовано, клієнтів сповіщено'); loadFitSchedule(); })
      .catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ── типи занять ── */
  window.fitTypesModal = function () {
    loadRefs(true).then(function (refs) {
      var h = refs.types.map(function (t) {
        return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border,#eee)">' +
          '<span style="width:12px;height:12px;border-radius:3px;background:' + esc(t.color || '#7c5cff') + '"></span>' +
          '<b style="flex:1">' + esc(t.name) + '</b><span style="font-size:12px;color:#888">' + t.duration_min + ' хв · ' + t.default_capacity + ' місць</span></div>';
      }).join('') || window.modEmpty('Додайте перший тип заняття');
      h += '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:6px;margin-top:12px">' +
        '<input id="ftName" class="form-control" placeholder="Назва (Йога…)">' +
        '<input id="ftDur" class="form-control" type="number" placeholder="хв" value="60">' +
        '<input id="ftCap" class="form-control" type="number" placeholder="місць" value="10"></div>';
      showModal('Типи занять', h, function () {
        var n = document.getElementById('ftName').value.trim();
        if (!n) { toast('Вкажіть назву', 'error'); throw new Error('validation'); }
        return API('/api/fitness/class-types', { method: 'POST', body: JSON.stringify({
          name: n, duration_min: +document.getElementById('ftDur').value || 60,
          default_capacity: +document.getElementById('ftCap').value || 10 }) })
          .then(function () { toast('Тип додано'); refCache = null; });
      });
    });
  };

  /* ── шаблон тижня + генератор ── */
  window.fitTemplatesModal = function () {
    Promise.all([API('/api/fitness/templates'), loadRefs()]).then(function (r) {
      var tpls = r[0].items || [], refs = r[1];
      var h = tpls.map(function (t) {
        return '<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border,#eee);font-size:13px">' +
          '<b style="width:30px">' + DAYS[t.day_of_week] + '</b><span style="width:48px">' + String(t.time_start).slice(0, 5) + '</span>' +
          '<span style="flex:1">' + esc(t.type_name) + '</span><span style="color:#888;font-size:12px">' + esc(t.trainer_name || '') + '</span>' +
          '<button class="btn btn-sm btn-outline" onclick="fitTplDel(' + t.id + ')">🗑</button></div>';
      }).join('') || window.modEmpty('Шаблон порожній');
      h += '<div style="display:grid;grid-template-columns:1fr 1fr 2fr 2fr;gap:6px;margin-top:12px">' +
        '<select id="ftpDay" class="form-control">' + DAYS.map(function (d, i) { return '<option value="' + i + '">' + d + '</option>'; }).join('') + '</select>' +
        '<input id="ftpTime" class="form-control" type="time" value="18:00">' +
        '<select id="ftpType" class="form-control">' + opts(refs.types, 'id', 'name') + '</select>' +
        '<select id="ftpTrainer" class="form-control">' + opts(refs.masters, 'id', 'name') + '</select></div>' +
        '<div style="margin-top:14px;display:flex;gap:8px;align-items:center;border-top:1px solid var(--border,#eee);padding-top:10px">' +
        '<span style="font-size:13px">Згенерувати заняття на</span>' +
        '<select id="ftpWeeks" class="form-control" style="width:90px"><option value="1">1 тижд.</option><option value="2">2 тижн.</option><option value="4" selected>4 тижн.</option></select>' +
        '<button class="btn btn-primary btn-sm" onclick="fitGenerate()">Згенерувати</button></div>';
      showModal('Шаблон тижня', h, function () {
        var ty = document.getElementById('ftpType').value;
        if (!ty) { toast('Оберіть тип', 'error'); throw new Error('validation'); }
        return API('/api/fitness/templates', { method: 'POST', body: JSON.stringify({
          day_of_week: +document.getElementById('ftpDay').value, time_start: document.getElementById('ftpTime').value,
          class_type_id: +ty, trainer_id: document.getElementById('ftpTrainer').value || null }) })
          .then(function () { toast('Додано в шаблон'); });
      });
    });
  };
  window.fitTplDel = function (id) {
    API('/api/fitness/templates/' + id, { method: 'DELETE' }).then(function () { document.getElementById('genModal')?.remove(); window.fitTemplatesModal(); });
  };
  window.fitGenerate = function () {
    var w = +document.getElementById('ftpWeeks').value || 4;
    API('/api/fitness/templates/generate', { method: 'POST', body: JSON.stringify({ weeks: w, from: dstr(curMonday) }) })
      .then(function (r) { toast('Створено занять: ' + r.created + (r.skipped ? ' (пропущено існуючих: ' + r.skipped + ')' : '')); document.getElementById('genModal')?.remove(); loadFitSchedule(); })
      .catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ══ ЧЕК-ІН ══════════════════════════════════════════════════════════ */
  var checkinClient = null;
  function loadFitCheckin() {
    var el = document.querySelector('#page-fitcheckin .ext-mod-body');
    if (!el) return;
    checkinClient = null;
    el.innerHTML = '<div style="max-width:560px">' +
      '<input id="fciSearch" class="form-control" style="font-size:16px;padding:12px" placeholder="Імʼя або телефон клієнта…" oninput="fitCiSearch(this.value)">' +
      '<div id="fciResults" style="margin-top:8px"></div><div id="fciCard" style="margin-top:14px"></div></div>';
  }
  window.fitCiSearch = function (q) {
    var box = document.getElementById('fciResults');
    if (!q || q.length < 2) { box.innerHTML = ''; return; }
    API('/api/admin/clients?limit=6&search=' + encodeURIComponent(q)).then(function (r) {
      var list = r.items || r.clients || r || [];
      box.innerHTML = list.map(function (cl) {
        return '<div style="padding:8px 10px;cursor:pointer;border-radius:8px;background:rgba(124,92,255,.06);margin-bottom:5px" onclick="fitCiPick(' + cl.id + ',\'' + esc(cl.name).replace(/'/g, '') + '\')">' +
          '<b>' + esc(cl.name) + '</b> <span style="color:#888;font-size:12px">' + esc(cl.phone || '') + '</span></div>';
      }).join('') || '<div style="color:#9aa0a6;font-size:13px">Не знайдено</div>';
    }).catch(function () {});
  };
  window.fitCiPick = function (id, name) {
    checkinClient = { id: id, name: name };
    document.getElementById('fciResults').innerHTML = '';
    var card = document.getElementById('fciCard');
    card.innerHTML = '<div style="color:#9aa0a6">Перевірка абонемента…</div>';
    API('/api/fitness/checkin/status/' + id).then(function (r) {
      var s = r.subscription;
      var ok = r.allowed;
      var reasonTxt = { no_membership: 'Немає абонемента', expired: 'Абонемент прострочено', frozen: 'Абонемент заморожено', no_visits: 'Візити вичерпано' }[r.reason] || '';
      var h = '<div class="card" style="padding:18px;border:2px solid ' + (ok ? '#1a9c6b' : '#d9534f') + ';border-radius:12px">' +
        '<div style="font-size:18px;font-weight:700;margin-bottom:6px">' + esc(name) + '</div>' +
        (s ? '<div style="font-size:13px;color:#666">' + esc(s.plan_name || 'Абонемент') + ' · ' +
          (s.plan_type === 'time' ? 'безліміт' : 'візитів: ' + (s.visits_remaining ?? '—')) +
          (s.expires_at ? ' · до ' + String(s.expires_at).slice(0, 10).split('-').reverse().join('.') : '') + '</div>' : '') +
        '<div style="font-size:15px;font-weight:700;color:' + (ok ? '#1a9c6b' : '#d9534f') + ';margin:8px 0">' + (ok ? '✅ Допуск дозволено' : '⛔ ' + reasonTxt) + '</div>' +
        (ok ? '<label style="font-size:13px;display:block;margin-bottom:10px"><input type="checkbox" id="fciConsume"' + (s && s.plan_type === 'visits' ? ' checked' : '') + '> списати візит (просто зал, без заняття)</label>' +
          '<button class="btn btn-primary" style="width:100%;padding:12px;font-size:16px" onclick="fitCiGo()">Чек-ін</button>'
        : '<button class="btn btn-outline" style="width:100%" onclick="go(\'subscriptions\')">Оформити/продовжити абонемент</button>') +
        '</div>';
      if (r.recent && r.recent.length) {
        h += '<div style="margin-top:12px;font-size:12px;color:#888"><b>Останні візити:</b> ' +
          r.recent.slice(0, 5).map(function (c) { return new Date(c.at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + (c.denied ? ' (відмова)' : ''); }).join(' · ') + '</div>';
      }
      card.innerHTML = h;
    }).catch(function (e) { window.modErr(card, e); });
  };
  window.fitCiGo = function () {
    if (!checkinClient) return;
    API('/api/fitness/checkin', { method: 'POST', body: JSON.stringify({ client_id: checkinClient.id, consume_visit: !!document.getElementById('fciConsume')?.checked }) })
      .then(function (r) {
        if (r.allowed) { toast('Чек-ін: ' + r.client.name + (r.consumed ? ' · залишок візитів: ' + r.consumed.balance : '')); window.fitCiPick(checkinClient.id, checkinClient.name); }
        else toast(r.message || 'Відмова', 'error');
      }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ── реєстрація сторінок ── */
  window.registerModule({ page: 'fitschedule', title: 'Розклад занять', group: 'fitness', icon: 'fitness_center', loader: loadFitSchedule });
  window.registerModule({ page: 'fitcheckin', title: 'Чек-ін', group: 'fitness', icon: 'how_to_reg', loader: loadFitCheckin });
})();
