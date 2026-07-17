/* ═══ UI-МОДУЛЬ: СТОМАТОЛОГІЯ (вертикаль dental, 18.07.2026) ═══════════════
 * Сторінки: dchart (одонтограма), dplans (плани лікування), dlab (лабораторія).
 * Ізоляція: група grp-dental видима лише business_type=dental; API /api/dental/*
 * існує тільки для dental-тенантів. Анамнез/згоди — існуючий модуль medical.
 * ─────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var esc = function (s) { return window.modEsc(s); };
  var API = function (p, o) { return window.modApi(p, o); };

  var T_COLORS = { healthy: '#e8f5ee', caries: '#f7c8c8', filling: '#c8d9f7', crown: '#f7ecc8', implant: '#d9c8f7',
    pulpitis: '#f7a8a8', extracted: '#e5e7eb', root: '#f0d0b0', bridge: '#f7ddc8', missing: '#f3f4f6' };
  var T_LABELS = { healthy: 'здоровий', caries: 'карієс', filling: 'пломба', crown: 'коронка', implant: 'імплант',
    pulpitis: 'пульпіт', extracted: 'видалений', root: 'корінь', bridge: 'міст', missing: 'відсутній' };
  var UPPER = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
  var LOWER = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

  var dClient = null;   // {id, name}
  var dTeeth = {};      // tooth_no → {status, note}

  /* ── спільний пошук клієнта ── */
  function clientSearchBox(cbName) {
    return '<input class="form-control" style="max-width:420px" placeholder="Імʼя або телефон клієнта…" oninput="' + cbName + '(this.value)">' +
      '<div id="dcResults" style="margin-top:8px;max-width:420px"></div>';
  }
  window.dChartSearch = function (q) {
    var box = document.getElementById('dcResults');
    if (!q || q.length < 2) { box.innerHTML = ''; return; }
    API('/api/admin/clients?limit=6&search=' + encodeURIComponent(q)).then(function (r) {
      var list = r.items || r.clients || r || [];
      box.innerHTML = list.map(function (cl) {
        return '<div style="padding:7px 10px;cursor:pointer;border-radius:8px;background:rgba(124,92,255,.06);margin-bottom:4px" onclick="dChartPick(' + cl.id + ',\'' + esc(cl.name).replace(/'/g, '') + '\')">' +
          '<b>' + esc(cl.name) + '</b> <span style="color:#888;font-size:12px">' + esc(cl.phone || '') + '</span></div>';
      }).join('') || '<div style="color:#9aa0a6;font-size:13px">Не знайдено</div>';
    }).catch(function () {});
  };

  /* ══ ОДОНТОГРАМА ═════════════════════════════════════════════════════ */
  function loadDChart() {
    var el = document.querySelector('#page-dchart .ext-mod-body');
    if (!el) return;
    el.innerHTML = '<div style="margin-bottom:14px">' + clientSearchBox('dChartSearch') + '</div><div id="dChartBody">' +
      window.modEmpty('Оберіть клієнта, щоб відкрити зубну формулу') + '</div>';
  }
  window.dChartPick = function (id, name) {
    dClient = { id: id, name: name };
    document.getElementById('dcResults').innerHTML = '';
    API('/api/dental/chart/' + id).then(function (r) {
      dTeeth = {};
      (r.teeth || []).forEach(function (t) { dTeeth[t.tooth_no] = t; });
      renderChart();
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  function toothCell(no) {
    var t = dTeeth[no] || { status: 'healthy' };
    var dead = t.status === 'extracted' || t.status === 'missing';
    return '<div onclick="dToothOpen(' + no + ')" title="' + no + ': ' + (T_LABELS[t.status] || t.status) + '" ' +
      'style="cursor:pointer;width:38px;height:46px;border-radius:8px;border:1px solid #d5d8de;display:flex;flex-direction:column;align-items:center;justify-content:center;background:' + (T_COLORS[t.status] || '#fff') + ';' + (dead ? 'opacity:.5' : '') + '">' +
      '<span style="font-size:11px;color:#888">' + no + '</span>' +
      '<span style="font-size:16px">' + (dead ? '✕' : '🦷') + '</span></div>';
  }
  function renderChart() {
    var body = document.getElementById('dChartBody');
    var h = '<div style="font-size:16px;font-weight:700;margin-bottom:10px">' + esc(dClient.name) + '</div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">' + UPPER.map(toothCell).join('') + '</div>' +
      '<div style="display:flex;gap:4px;flex-wrap:wrap">' + LOWER.map(toothCell).join('') + '</div>' +
      '<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#666">' +
      Object.keys(T_LABELS).map(function (k) {
        return '<span style="display:inline-flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:3px;background:' + T_COLORS[k] + ';border:1px solid #ccc"></span>' + T_LABELS[k] + '</span>';
      }).join('') + '</div>';
    body.innerHTML = h;
  }
  window.dToothOpen = function (no) {
    var t = dTeeth[no] || { status: 'healthy', note: '' };
    Promise.all([
      API('/api/dental/chart/' + dClient.id + '/history?tooth_no=' + no).catch(function () { return { items: [] }; }),
      API('/api/dental/files/' + dClient.id + '?tooth_no=' + no).catch(function () { return { items: [] }; }),
    ]).then(function (r) {
      var hist = r[0].items || [], files = r[1].items || [];
      var h = '<div style="display:grid;gap:10px">' +
        '<label>Стан зуба<select id="dtStatus" class="form-control">' +
        Object.keys(T_LABELS).map(function (k) { return '<option value="' + k + '"' + (t.status === k ? ' selected' : '') + '>' + T_LABELS[k] + '</option>'; }).join('') +
        '</select></label>' +
        '<label>Нотатка<input id="dtNote" class="form-control" value="' + esc(t.note || '') + '"></label>' +
        '<label>Знімок (URL)<input id="dtFile" class="form-control" placeholder="https://… (опційно)"></label></div>';
      if (files.length) {
        h += '<div style="margin-top:10px;font-size:12px"><b>Знімки:</b> ' + files.map(function (f) {
          return '<a href="' + esc(f.url || '#') + '" target="_blank">' + (f.kind === 'photo' ? '📷' : '🩻') + ' ' + new Date(f.created_at).toLocaleDateString('uk-UA') + '</a>';
        }).join(' · ') + '</div>';
      }
      if (hist.length) {
        h += '<div style="margin-top:10px;max-height:140px;overflow:auto;font-size:12px;color:#666"><b>Історія:</b>' +
          hist.map(function (x) {
            return '<div style="padding:3px 0;border-bottom:1px solid #eee">' + new Date(x.changed_at).toLocaleDateString('uk-UA') + ': ' +
              (T_LABELS[x.old_status] || x.old_status) + ' → <b>' + (T_LABELS[x.new_status] || x.new_status) + '</b>' + (x.note ? ' · ' + esc(x.note) : '') + '</div>';
          }).join('') + '</div>';
      }
      showModal('Зуб ' + no, h, function () {
        var payload = { tooth_no: no, status: document.getElementById('dtStatus').value, note: document.getElementById('dtNote').value || null };
        var fileUrl = document.getElementById('dtFile').value.trim();
        return API('/api/dental/chart/' + dClient.id + '/teeth', { method: 'POST', body: JSON.stringify(payload) })
          .then(function () {
            if (fileUrl) return API('/api/dental/files', { method: 'POST', body: JSON.stringify({ client_id: dClient.id, tooth_no: no, url: fileUrl, kind: 'xray' }) });
          })
          .then(function () { toast('Збережено'); return API('/api/dental/chart/' + dClient.id); })
          .then(function (r2) { dTeeth = {}; (r2.teeth || []).forEach(function (x) { dTeeth[x.tooth_no] = x; }); renderChart(); });
      });
    });
  };

  /* ══ ПЛАНИ ЛІКУВАННЯ ═════════════════════════════════════════════════ */
  var P_ST = { draft: 'чернетка', approved: 'затверджено', in_progress: 'в роботі', done: 'виконано', cancelled: 'скасовано' };
  function loadDPlans() {
    var el = document.querySelector('#page-dplans .ext-mod-body');
    if (!el) return;
    el.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:12px;align-items:center">' +
      '<div id="dpSearchWrap" style="flex:1">' + clientSearchBox('dPlanSearch') + '</div>' +
      '<button class="btn btn-primary btn-sm" onclick="dPlanNew()"><span class="material-icons-round" style="font-size:15px">add</span> План</button></div>' +
      '<div id="dPlansList"><div style="color:#9aa0a6;padding:20px;text-align:center">Завантаження…</div></div>';
    API('/api/dental/plans').then(function (r) { renderPlans(r.items || []); }).catch(function (e) { window.modErr(document.getElementById('dPlansList'), e); });
  }
  window.dPlanSearch = function (q) {
    if (!q || q.length < 2) { API('/api/dental/plans').then(function (r) { renderPlans(r.items || []); }); return; }
    window.dChartSearch(q); // показуємо клієнтів; вибір → фільтр планів
    window.dChartPick = function (id, name) {
      document.getElementById('dcResults').innerHTML = '';
      API('/api/dental/plans?client_id=' + id).then(function (r) { renderPlans(r.items || [], name); });
    };
  };
  function renderPlans(items, filterName) {
    var box = document.getElementById('dPlansList');
    if (!box) return;
    if (!items.length) { box.innerHTML = window.modEmpty(filterName ? 'У клієнта ' + esc(filterName) + ' немає планів' : 'Планів поки немає'); return; }
    box.innerHTML = items.map(function (p) {
      return '<div class="card" style="padding:12px 14px;margin-bottom:8px;cursor:pointer" onclick="dPlanOpen(' + p.id + ')">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><b>' + esc(p.title) + '</b> <span style="color:#888;font-size:12px">· ' + esc(p.client_name) + '</span>' +
        '<div style="font-size:12px;color:#777">' + (p.diagnosis ? esc(p.diagnosis) + ' · ' : '') + 'етапів: ' + p.stages_done + '/' + p.stages_total +
        (p.total_estimate ? ' · ₴' + Number(p.total_estimate).toLocaleString('uk-UA') : '') + '</div></div>' +
        '<span style="font-size:12px;font-weight:600;padding:3px 10px;border-radius:12px;background:rgba(124,92,255,.1)">' + (P_ST[p.status] || p.status) + '</span></div></div>';
    }).join('');
  }
  window.dPlanNew = function () {
    var stagesHtml = '<div id="dpStages"></div><button class="btn btn-sm btn-outline" onclick="dpAddStageRow()" type="button">+ етап</button>';
    showModal('Новий план лікування',
      '<div style="display:grid;gap:10px">' +
      '<input id="dpClientQ" class="form-control" placeholder="Клієнт (пошук)…" oninput="dpClientFind(this.value)"><div id="dpClientRes"></div>' +
      '<input id="dpTitle" class="form-control" placeholder="Назва (напр. Протезування 26-27)">' +
      '<input id="dpDiag" class="form-control" placeholder="Діагноз">' + stagesHtml + '</div>',
      function () {
        var cid = +document.getElementById('dpClientQ').dataset.cid;
        var title = document.getElementById('dpTitle').value.trim();
        if (!cid || !title) { toast('Оберіть клієнта і вкажіть назву', 'error'); throw new Error('validation'); }
        var stages = [];
        document.querySelectorAll('#dpStages .dp-stage').forEach(function (row) {
          var t = row.querySelector('.dps-title').value.trim();
          if (t) stages.push({ title: t, estimate: +row.querySelector('.dps-est').value || null,
            teeth: row.querySelector('.dps-teeth').value.split(',').map(function (x) { return +x.trim(); }).filter(Boolean) });
        });
        return API('/api/dental/plans', { method: 'POST', body: JSON.stringify({ client_id: cid, title: title, diagnosis: document.getElementById('dpDiag').value || null, stages: stages }) })
          .then(function () { toast('План створено'); loadDPlans(); });
      });
    window.dpAddStageRow();
  };
  window.dpAddStageRow = function () {
    var box = document.getElementById('dpStages');
    if (!box) return;
    var d = document.createElement('div');
    d.className = 'dp-stage';
    d.style.cssText = 'display:grid;grid-template-columns:3fr 1fr 1fr;gap:6px;margin-bottom:6px';
    d.innerHTML = '<input class="form-control dps-title" placeholder="Етап (напр. Лікування карієсу)">' +
      '<input class="form-control dps-teeth" placeholder="зуби: 26,27">' +
      '<input class="form-control dps-est" type="number" placeholder="₴">';
    box.appendChild(d);
  };
  window.dpClientFind = function (q) {
    var box = document.getElementById('dpClientRes');
    if (!q || q.length < 2) { box.innerHTML = ''; return; }
    API('/api/admin/clients?limit=5&search=' + encodeURIComponent(q)).then(function (r) {
      var list = r.items || r.clients || r || [];
      box.innerHTML = list.map(function (cl) {
        return '<div style="padding:5px 8px;cursor:pointer;background:rgba(124,92,255,.06);border-radius:6px;margin-bottom:3px" ' +
          'onclick="var i=document.getElementById(\'dpClientQ\');i.value=\'' + esc(cl.name).replace(/'/g, '') + '\';i.dataset.cid=' + cl.id + ';document.getElementById(\'dpClientRes\').innerHTML=\'\'">' +
          esc(cl.name) + '</div>';
      }).join('');
    }).catch(function () {});
  };
  window.dPlanOpen = function (id) {
    API('/api/dental/plans/' + id).then(function (r) {
      var p = r.item, st = r.stages || [];
      var S_ST = { pending: '⚪ очікує', scheduled: '📅 заплановано', done: '✅ виконано', skipped: '⏭ пропущено' };
      var h = '<div style="font-size:13px;color:#666;margin-bottom:8px">' + esc(p.client_name) + (p.diagnosis ? ' · ' + esc(p.diagnosis) : '') +
        ' · статус: <b>' + (P_ST[p.status] || p.status) + '</b>' + (p.total_estimate ? ' · кошторис ₴' + Number(p.total_estimate).toLocaleString('uk-UA') : '') + '</div>';
      h += st.map(function (s) {
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--border,#eee)">' +
          '<div style="flex:1"><b>' + (s.position + 1) + '. ' + esc(s.title) + '</b>' +
          (s.teeth && s.teeth.length ? ' <span style="font-size:11px;color:#888">зуби ' + s.teeth.join(', ') + '</span>' : '') +
          '<div style="font-size:11px;color:#777">' + (S_ST[s.status] || s.status) + (s.estimate ? ' · ₴' + Number(s.estimate).toLocaleString('uk-UA') : '') +
          (s.appt_starts_at ? ' · візит ' + new Date(s.appt_starts_at).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '') + '</div></div>' +
          (s.status !== 'done' ? '<button class="btn btn-sm btn-outline" onclick="dStageDone(' + s.id + ',' + id + ')">✓ виконано</button>' : '') + '</div>';
      }).join('') || window.modEmpty('Етапів немає');
      if (p.status === 'draft') h += '<div style="margin-top:12px;text-align:right"><button class="btn btn-sm btn-primary" onclick="dPlanApprove(' + id + ')">Затвердити план</button></div>';
      showModal('План: ' + esc(p.title), h);
    });
  };
  window.dStageDone = function (sid, planId) {
    API('/api/dental/stages/' + sid, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) })
      .then(function () { toast('Етап виконано'); window.dPlanOpen(planId); loadDPlans(); }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.dPlanApprove = function (id) {
    API('/api/dental/plans/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) })
      .then(function () { toast('План затверджено'); window.dPlanOpen(id); loadDPlans(); }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ══ ЛАБОРАТОРІЯ ═════════════════════════════════════════════════════ */
  var L_ST = { draft: 'чернетка', sent: '📤 відправлено', ready: '✅ готово', fitted: '🦷 приміряно', redo: '↩ переробка', closed: 'закрито' };
  var L_NEXT = { draft: ['sent'], sent: ['ready', 'redo'], ready: ['fitted', 'redo'], fitted: ['closed'], redo: ['sent'] };
  function loadDLab() {
    var el = document.querySelector('#page-dlab .ext-mod-body');
    if (!el) return;
    el.innerHTML = '<div style="display:flex;justify-content:flex-end;margin-bottom:12px">' +
      '<button class="btn btn-primary btn-sm" onclick="dLabNew()"><span class="material-icons-round" style="font-size:15px">add</span> Наряд</button></div>' +
      '<div id="dLabList"><div style="color:#9aa0a6;padding:20px;text-align:center">Завантаження…</div></div>';
    API('/api/dental/lab').then(function (r) {
      var items = r.items || [];
      var box = document.getElementById('dLabList');
      if (!items.length) { box.innerHTML = window.modEmpty('Активних нарядів немає'); return; }
      box.innerHTML = items.map(function (o) {
        var btns = (L_NEXT[o.status] || []).map(function (n) {
          return '<button class="btn btn-sm btn-outline" onclick="dLabMove(' + o.id + ',\'' + n + '\')">' + (L_ST[n] || n) + '</button>';
        }).join(' ');
        return '<div class="card" style="padding:12px 14px;margin-bottom:8px;' + (o.overdue ? 'border:1px solid #d9534f' : '') + '">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
          '<div style="flex:1"><b>' + esc(o.work_type) + '</b> <span style="color:#888;font-size:12px">· ' + esc(o.client_name) + ' · ' + esc(o.lab_name) + '</span>' +
          '<div style="font-size:12px;color:#777">' + (L_ST[o.status] || o.status) +
          (o.teeth && o.teeth.length ? ' · зуби ' + o.teeth.join(', ') : '') +
          (o.due_date ? ' · термін ' + String(o.due_date).slice(0, 10).split('-').reverse().join('.') + (o.overdue ? ' <b style="color:#d9534f">ПРОСРОЧЕНО</b>' : '') : '') +
          (o.cost ? ' · собівартість ₴' + Number(o.cost).toLocaleString('uk-UA') : '') + '</div></div>' + btns + '</div></div>';
      }).join('');
    }).catch(function (e) { window.modErr(document.getElementById('dLabList'), e); });
  }
  window.dLabMove = function (id, status) {
    API('/api/dental/lab/' + id, { method: 'PATCH', body: JSON.stringify({ status: status }) })
      .then(function () { toast(status === 'sent' ? 'Відправлено (собівартість → витрати каси)' : 'Статус оновлено'); loadDLab(); })
      .catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };
  window.dLabNew = function () {
    showModal('Новий наряд у лабораторію',
      '<div style="display:grid;gap:10px">' +
      '<input id="dlClientQ" class="form-control" placeholder="Клієнт (пошук)…" oninput="dpClientFind2(this.value)"><div id="dpClientRes2"></div>' +
      '<input id="dlLab" class="form-control" placeholder="Лабораторія / технік">' +
      '<select id="dlType" class="form-control"><option>Коронка</option><option>Протез</option><option>Вінір</option><option>Капа</option><option>Інше</option></select>' +
      '<input id="dlTeeth" class="form-control" placeholder="Зуби: 26,27">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">' +
      '<input id="dlDue" class="form-control" type="date" title="Термін">' +
      '<input id="dlCost" class="form-control" type="number" placeholder="Собівартість ₴">' +
      '<input id="dlPrice" class="form-control" type="number" placeholder="Ціна ₴"></div></div>',
      function () {
        var cid = +document.getElementById('dlClientQ').dataset.cid;
        var lab = document.getElementById('dlLab').value.trim();
        if (!cid || !lab) { toast('Оберіть клієнта і лабораторію', 'error'); throw new Error('validation'); }
        return API('/api/dental/lab', { method: 'POST', body: JSON.stringify({
          client_id: cid, lab_name: lab, work_type: document.getElementById('dlType').value,
          teeth: document.getElementById('dlTeeth').value.split(',').map(function (x) { return +x.trim(); }).filter(Boolean),
          due_date: document.getElementById('dlDue').value || null,
          cost: +document.getElementById('dlCost').value || null, price: +document.getElementById('dlPrice').value || null }) })
          .then(function () { toast('Наряд створено'); loadDLab(); });
      });
  };
  window.dpClientFind2 = function (q) {
    var box = document.getElementById('dpClientRes2');
    if (!q || q.length < 2) { box.innerHTML = ''; return; }
    API('/api/admin/clients?limit=5&search=' + encodeURIComponent(q)).then(function (r) {
      var list = r.items || r.clients || r || [];
      box.innerHTML = list.map(function (cl) {
        return '<div style="padding:5px 8px;cursor:pointer;background:rgba(124,92,255,.06);border-radius:6px;margin-bottom:3px" ' +
          'onclick="var i=document.getElementById(\'dlClientQ\');i.value=\'' + esc(cl.name).replace(/'/g, '') + '\';i.dataset.cid=' + cl.id + ';document.getElementById(\'dpClientRes2\').innerHTML=\'\'">' +
          esc(cl.name) + '</div>';
      }).join('');
    }).catch(function () {});
  };

  /* ── реєстрація ── */
  window.registerModule({ page: 'dchart', title: 'Зубна формула', group: 'dental', icon: 'dentistry', loader: loadDChart });
  window.registerModule({ page: 'dplans', title: 'Плани лікування', group: 'dental', icon: 'clinical_notes', loader: loadDPlans });
  window.registerModule({ page: 'dlab', title: 'Лабораторія', group: 'dental', icon: 'biotech', loader: loadDLab });
})();
