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
    var h = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
      '<span style="font-size:16px;font-weight:700">' + esc(dClient.name) + '</span>' +
      '<button class="btn btn-outline btn-sm" onclick="dForm043Print()"><span class="material-icons-round" style="font-size:15px">print</span> Форма 043/о</button></div>' +
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
      h += '<div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">' +
        '<button class="btn btn-sm btn-outline" onclick="dPlanPresent(' + id + ')"><span class="material-icons-round" style="font-size:15px">present_to_all</span> Презентація для пацієнта</button>' +
        (p.status === 'draft' ? '<button class="btn btn-sm btn-primary" onclick="dPlanApprove(' + id + ')">Затвердити план</button>' : '') + '</div>';
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

  /* ══ RECALL: «жоден пацієнт не загублений» (Phase C, 18.07) ══════════════ */
  var RECALL_REASON = { open_plan: 'Незакінчений план', recall_due: 'Давно не був', noshow: 'Неявка без перезапису' };
  function loadDRecall() {
    var el = document.querySelector('#page-drecall .ext-mod-body');
    if (!el) return;
    el.innerHTML = '<div style="padding:30px;text-align:center;color:#9aa0a6">Завантаження…</div>';
    API('/api/dental/recall').then(function (r) {
      var items = r.items || [];
      var h = '<div style="font-size:13px;color:#888;margin-bottom:12px">Пацієнти, що потребують уваги (без майбутнього запису): незакінчені плани, davno не були (' + (r.months || 6) + ' міс+), неявки. Оброблені ховаються на 90 днів, відкладені — до дати.</div>';
      if (!items.length) h += '<div style="padding:24px;color:#37d39a;font-weight:600">Черга порожня — жоден пацієнт не загублений ✓</div>';
      h += items.map(function (it) {
        var reasons = (it.reasons || []).map(function (x) {
          return '<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:rgba(124,92,255,.12);margin-right:4px">' +
            esc(RECALL_REASON[x.reason] || x.reason) + (x.detail ? ': ' + esc(x.detail) : '') + '</span>';
        }).join('');
        var mainReason = (it.reasons && it.reasons[0] && it.reasons[0].reason) || 'recall_due';
        return '<div style="background:var(--card-bg,#fff);border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:180px"><b>' + esc(it.name || 'Пацієнт') + '</b>' +
          '<div style="font-size:12px;color:#888">' + esc(it.phone || '') + (it.last_action ? ' · остання дія: ' + esc(it.last_action) : '') + '</div>' +
          '<div style="margin-top:4px">' + reasons + '</div></div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn btn-outline btn-sm" onclick="dRecallAct(' + it.client_id + ',\'' + mainReason + '\',\'contacted\')">Подзвонили</button>' +
          '<button class="btn btn-outline btn-sm" onclick="dRecallAct(' + it.client_id + ',\'' + mainReason + '\',\'snoozed\')">Відкласти 30 дн</button>' +
          '<button class="btn btn-primary btn-sm" onclick="dRecallAct(' + it.client_id + ',\'' + mainReason + '\',\'booked\')">Записаний</button>' +
          '</div></div>';
      }).join('');
      el.innerHTML = h;
    }).catch(function (e) { window.modErr(el, e); });
  }
  window.dRecallAct = function (clientId, reason, action) {
    API('/api/dental/recall/' + clientId + '/action', { method: 'POST', body: JSON.stringify({ reason: reason, action: action }) })
      .then(function () { toast('Готово'); loadDRecall(); })
      .catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };


  /* ══ ФОРМА 043/о — друк (структура за офіційним бланком наказу МОЗ № 110;
     позначення наказу: С=карієс, Р=пульпіт, РІ=пломба, А=відсутній, Cd=коронка,
     R=корінь, і=імплантація). Поля, яких немає в CRM (стать, адреса, прикус,
     індекси ГІ/РМА, шкала Віта) — порожні рядки для ручного заповнення. ══ */
  window.dForm043Print = function () {
    if (!dClient) { toast('Оберіть клієнта', 'error'); return; }
    API('/api/dental/form043/' + dClient.id).then(function (r) {
      var c = r.client || {}, teeth = {};
      (r.teeth || []).forEach(function (t) { teeth[t.tooth_no] = t.mark; });
      // Зубна формула бланка: 2 ряди по 16 (Зигмонді). Верх: FDI 18..11 | 21..28. Низ: 48..41 | 31..38.
      function row(fdis) {
        return '<tr>' + fdis.map(function (n) { return '<td>' + (teeth[n] || '&nbsp;') + '</td>'; }).join('') + '</tr>';
      }
      var UP = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
      var DN = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];
      var posRow = '<tr class="pos">' + [8,7,6,5,4,3,2,1,1,2,3,4,5,6,7,8].map(function (n) { return '<td>' + n + '</td>'; }).join('') + '</tr>';
      var med = r.medical || {};
      function lst(v) { return Array.isArray(v) ? v.join(', ') : (v || ''); }
      var perenes = [lst(med.chronic_conditions), lst(med.allergies) && ('Алергії: ' + lst(med.allergies)), lst(med.current_medications) && ('Ліки: ' + lst(med.current_medications))].filter(Boolean).join('; ');
      var planObsl = '', planLik = '';
      (r.plans || []).forEach(function (pp) {
        planLik += '<b>' + pp.title + '</b>' + (pp.diagnosis ? ' (' + pp.diagnosis + ')' : '') + '<br>' +
          (pp.stages || []).map(function (st) { return (st.position + 1) + '. ' + st.title + (st.teeth && st.teeth.length ? ' [зуби ' + st.teeth.join(',') + ']' : ''); }).join('<br>') + '<br>';
      });
      var diary = (r.diary || []).slice().reverse().map(function (d) {
        return '<tr><td style="white-space:nowrap">' + new Date(d.starts_at).toLocaleDateString('uk-UA') + '</td><td>' +
          (d.service_name || '') + (d.master_name ? ' · лікар: ' + d.master_name : '') + (d.notes ? '<br>' + d.notes : '') + '</td></tr>';
      }).join('');
      var diag = (r.plans && r.plans[0] && r.plans[0].diagnosis) || '';
      var esc2 = function (x) { return String(x == null ? '' : x).replace(/</g, '&lt;'); };
      var html = '<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><title>Форма 043/о — ' + esc2(c.name) + '</title><style>' +
        'body{font-family:"Times New Roman",serif;font-size:13px;margin:28px;color:#000}' +
        'h2{text-align:center;font-size:15px;margin:4px 0}.small{font-size:11px;color:#333}' +
        '.fld{border-bottom:1px solid #000;min-height:16px;display:inline-block;min-width:180px}' +
        'table.tf{border-collapse:collapse;margin:6px 0}table.tf td{border:1px solid #000;width:26px;height:22px;text-align:center;font-size:12px}' +
        'table.tf tr.pos td{border:none;font-size:10px;color:#555;height:12px}' +
        'table.diary{border-collapse:collapse;width:100%}table.diary td,table.diary th{border:1px solid #000;padding:4px 6px;vertical-align:top;font-size:12px;text-align:left}' +
        'p{margin:7px 0}@media print{button{display:none}}</style></head><body>' +
        '<div class="small">Найменування закладу: ' + esc2(r.clinic) + '</div>' +
        '<h2>МЕДИЧНА КАРТА СТОМАТОЛОГІЧНОГО ХВОРОГО<br><span class="small">(форма № 043/о, наказ МОЗ України № 110 від 14.02.2012)</span></h2>' +
        '<p>1. Прізвище, імʼя, по батькові: <b>' + esc2(c.name) + '</b></p>' +
        '<p>2. Стать: <span class="fld"></span> &nbsp; 3. Дата народження: <b>' + (c.birthday ? new Date(c.birthday).toLocaleDateString('uk-UA') : '<span class="fld" style="min-width:90px"></span>') + '</b></p>' +
        '<p>4. Місце проживання, телефон: <b>' + esc2(c.phone || '') + '</b> <span class="fld"></span></p>' +
        '<p>5. Діагноз: <b>' + esc2(diag) + '</b><span class="fld"></span></p>' +
        '<p>6. Скарги: <span class="fld" style="min-width:70%"></span></p>' +
        '<p>7. Перенесені та супутні захворювання: <b>' + esc2(perenes) + '</b><span class="fld"></span></p>' +
        '<p>8. Розвиток теперішнього захворювання: <span class="fld" style="min-width:60%"></span></p>' +
        '<p>9. Дані обʼєктивного дослідження, зовнішній огляд. Зубна формула (позначення: С‒карієс, Р‒пульпіт, Pt‒періодонтит, РІ‒пломба, А‒відсутній, Cd‒коронка, R‒корінь, і‒імплантація):</p>' +
        '<table class="tf">' + posRow + row(UP) + row(DN) + posRow.replace('class="pos"','class="pos"') + '</table>' +
        '<p>10. Прикус: <span class="fld"></span> &nbsp; 11. Стан гігієни, слизової, ясен. Індекси ГІ, РМА: <span class="fld"></span></p>' +
        '<p>12. Дані рентгенівських, лабораторних досліджень: <span class="fld" style="min-width:60%"></span></p>' +
        '<p>13. Колір за шкалою «Віта»: <span class="fld" style="min-width:80px"></span> &nbsp; 14-15. Навчання/контроль гігієни: <span class="fld"></span></p>' +
        '<h2 style="margin-top:14px">План обстеження / План лікування</h2>' +
        '<table class="diary"><tr><th style="width:50%">План обстеження</th><th>План лікування</th></tr>' +
        '<tr><td>' + (planObsl || '&nbsp;') + '</td><td>' + (planLik || '&nbsp;') + '</td></tr></table>' +
        '<h2 style="margin-top:14px">Щоденник лікаря</h2>' +
        '<table class="diary"><tr><th style="width:110px">Дата</th><th>Анамнез, статус, діагноз, лікування та рекомендації</th></tr>' + (diary || '<tr><td>&nbsp;</td><td>&nbsp;</td></tr>') + '</table>' +
        '<p style="margin-top:18px">Лікар: <span class="fld"></span> &nbsp; Завідувач відділення: <span class="fld"></span> &nbsp; Дата: ' + new Date().toLocaleDateString('uk-UA') + '</p>' +
        '<button onclick="window.print()" style="margin-top:10px;padding:8px 18px">Друк</button></body></html>';
      var w = window.open('', '_blank');
      if (!w) { toast('Дозвольте спливаючі вікна для друку', 'error'); return; }
      w.document.write(html); w.document.close();
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  /* ── Презентація плану лікування для пацієнта (чистий друк без кухні) ── */
  window.dPlanPresent = function (id) {
    API('/api/dental/plans/' + id).then(function (r) {
      var p = r.item, st = r.stages || [];
      var esc2 = function (x) { return String(x == null ? '' : x).replace(/</g, '&lt;'); };
      var total = 0;
      var rows = st.map(function (s, idx) {
        total += Number(s.estimate) || 0;
        return '<tr><td>' + (idx + 1) + '</td><td>' + esc2(s.title) +
          (s.teeth && s.teeth.length ? ' <span style="color:#666;font-size:12px">(зуби ' + s.teeth.join(', ') + ')</span>' : '') + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' + (s.estimate ? Number(s.estimate).toLocaleString('uk-UA') + ' грн' : '—') + '</td></tr>';
      }).join('');
      var html = '<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"><title>План лікування — ' + esc2(p.client_name) + '</title><style>' +
        'body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:40px;color:#1a1a2e;max-width:720px}' +
        'h1{font-size:22px;margin-bottom:4px}.sub{color:#666;font-size:14px;margin-bottom:22px}' +
        'table{border-collapse:collapse;width:100%;margin:14px 0}td,th{border-bottom:1px solid #e2e2ea;padding:10px 8px;text-align:left;font-size:14px}' +
        'th{color:#666;font-size:12px;text-transform:uppercase}.total{font-size:18px;font-weight:700;text-align:right;margin-top:8px}' +
        '.sign{margin-top:44px;display:flex;justify-content:space-between;font-size:13px;color:#444}@media print{button{display:none}}</style></head><body>' +
        '<h1>План лікування: ' + esc2(p.title) + '</h1>' +
        '<div class="sub">Пацієнт: <b>' + esc2(p.client_name) + '</b>' + (p.diagnosis ? ' · Діагноз: ' + esc2(p.diagnosis) : '') + ' · ' + new Date().toLocaleDateString('uk-UA') + '</div>' +
        '<table><tr><th style="width:36px">№</th><th>Етап</th><th style="text-align:right">Вартість</th></tr>' + rows + '</table>' +
        '<div class="total">Разом: ' + total.toLocaleString('uk-UA') + ' грн</div>' +
        '<div class="sign"><span>Пацієнт: ______________________</span><span>Лікар: ______________________</span></div>' +
        '<button onclick="window.print()" style="margin-top:24px;padding:8px 18px">Друк</button></body></html>';
      var w = window.open('', '_blank');
      if (!w) { toast('Дозвольте спливаючі вікна', 'error'); return; }
      w.document.write(html); w.document.close();
    }).catch(function (e) { toast(e.message || 'Помилка', 'error'); });
  };

  window.registerModule({ page: 'drecall', title: 'Recall-черга', group: 'dental', icon: 'notification_important', loader: loadDRecall });
  window.registerModule({ page: 'dchart', title: 'Зубна формула', group: 'dental', icon: 'dentistry', loader: loadDChart });
  window.registerModule({ page: 'dplans', title: 'Плани лікування', group: 'dental', icon: 'clinical_notes', loader: loadDPlans });
  window.registerModule({ page: 'dlab', title: 'Лабораторія', group: 'dental', icon: 'biotech', loader: loadDLab });
})();
