/* SVS Beauty CRM — плавающая кнопка "Заметки" обратной связи.
   Автономный виджет: подключается одной строкой на любой странице админки
     <script src="/admin/assets/notes-widget.js"></script>
   Кнопка фиксирована в правом нижнем углу, не сбивается при прокрутке.
   Владелец/сотрудник оставляет заметку что поправить в CRM — система
   запоминает с какой страницы. Невыполненные "горят", выполненные уходят
   во вкладку "Виконані" с зелёной галочкой. */
(function () {
  'use strict';
  if (window.__svsNotesWidget) return;            // защита от двойного подключения
  window.__svsNotesWidget = true;

  var TOKEN = localStorage.getItem('svs_admin_token') || '';
  if (!TOKEN) return;                              // не залогинен — кнопку не показываем
  var API = location.origin;

  function api(path, opts) {
    opts = opts || {};
    return fetch(API + '/api/notes' + path, {
      method: opts.method || 'GET',
      headers: { 'X-Admin-Token': localStorage.getItem('svs_admin_token') || TOKEN, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function curPage() {
    var path = location.pathname + (location.hash || '');
    var label = document.title || '';
    // если на странице есть заголовок раздела — берём его как подсказку
    var h = document.querySelector('.topbar h2, h1, h2');
    if (h && h.textContent.trim()) label = h.textContent.trim();
    return { page_path: path, page_label: label };
  }

  function fmtDate(s) {
    if (!s) return '';
    try {
      var d = new Date(s);
      return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // ── стили ────────────────────────────────────────────
  var css = document.createElement('style');
  css.textContent = [
    '#svsNotesFab{position:fixed;right:22px;bottom:22px;z-index:99998;width:58px;height:58px;border-radius:50%;',
    'background:linear-gradient(135deg,#7c5cff,#5b8def);color:#fff;border:none;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.32);',
    'display:flex;align-items:center;justify-content:center;transition:transform .15s ease,box-shadow .15s ease}',
    '#svsNotesFab:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 10px 28px rgba(0,0,0,.4)}',
    '#svsNotesFab svg{width:26px;height:26px;fill:#fff}',
    '#svsNotesBadge{position:absolute;top:-4px;right:-4px;min-width:22px;height:22px;padding:0 5px;border-radius:11px;',
    'background:#ff4d4f;color:#fff;font:700 12px/22px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;',
    'display:none;animation:svsPulse 1.6s ease-in-out infinite}',
    '@keyframes svsPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}',
    '#svsNotesPanel{position:fixed;right:22px;bottom:92px;z-index:99999;width:380px;max-width:calc(100vw - 32px);',
    'max-height:74vh;background:#1b1d24;color:#e9eaf0;border:1px solid #2c2f3a;border-radius:16px;overflow:hidden;',
    'box-shadow:0 18px 50px rgba(0,0,0,.5);display:none;flex-direction:column;font-family:Inter,system-ui,sans-serif}',
    '#svsNotesPanel.open{display:flex}',
    '.svsN-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #2c2f3a}',
    '.svsN-head b{font-size:15px}',
    '.svsN-x{background:none;border:none;color:#9aa0b4;font-size:22px;cursor:pointer;line-height:1}',
    '.svsN-tabs{display:flex;gap:6px;padding:10px 12px 0}',
    '.svsN-tab{flex:1;padding:8px;border:none;border-radius:9px;background:#23262f;color:#9aa0b4;cursor:pointer;font:600 13px Inter,sans-serif}',
    '.svsN-tab.active{background:#7c5cff;color:#fff}',
    '.svsN-tab .cnt{display:inline-block;min-width:18px;margin-left:4px;padding:0 5px;border-radius:9px;background:rgba(255,255,255,.18);font-size:11px}',
    '.svsN-add{padding:12px}',
    '.svsN-add textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;background:#23262f;border:1px solid #343845;',
    'border-radius:10px;color:#e9eaf0;padding:10px;font:14px Inter,sans-serif;outline:none}',
    '.svsN-add textarea:focus{border-color:#7c5cff}',
    '.svsN-page{font-size:11px;color:#8f95a8;margin:6px 2px 8px;display:flex;align-items:center;gap:5px}',
    '.svsN-add button{width:100%;padding:10px;border:none;border-radius:10px;background:#7c5cff;color:#fff;font:600 14px Inter,sans-serif;cursor:pointer}',
    '.svsN-add button:disabled{opacity:.5;cursor:default}',
    '.svsN-list{overflow-y:auto;padding:4px 12px 14px;flex:1}',
    '.svsN-item{background:#23262f;border-radius:11px;padding:11px 12px;margin-top:8px;border-left:3px solid #ff9f43}',
    '.svsN-item.done{border-left-color:#2ecc71;opacity:.72}',
    '.svsN-item .txt{font-size:14px;white-space:pre-wrap;word-break:break-word}',
    '.svsN-item.done .txt{text-decoration:line-through;color:#9aa0b4}',
    '.svsN-meta{font-size:11px;color:#8f95a8;margin-top:7px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.svsN-meta a{color:#8aa9ff;text-decoration:none}',
    '.svsN-acts{display:flex;gap:6px;margin-top:9px}',
    '.svsN-acts button{flex:0 0 auto;padding:6px 10px;border:none;border-radius:8px;cursor:pointer;font:600 12px Inter,sans-serif}',
    '.svsN-done{background:#2ecc71;color:#08311a}',
    '.svsN-reopen{background:#3a3f4d;color:#cdd2e0}',
    '.svsN-del{background:transparent;color:#ff6b6b;border:1px solid #4a2f33!important}',
    '.svsN-empty{text-align:center;color:#7b8094;font-size:13px;padding:26px 10px}',
  ].join('');
  document.head.appendChild(css);

  // ── разметка ─────────────────────────────────────────
  var fab = document.createElement('button');
  fab.id = 'svsNotesFab';
  fab.title = 'Заметки до CRM';
  fab.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H5a2 2 0 0 1-2-2V5z"/><path fill="#7c5cff" d="M6.5 7.5h11v1.6h-11zM6.5 10.6h8v1.6h-8z"/></svg>' +
    '<span id="svsNotesBadge">0</span>';

  var panel = document.createElement('div');
  panel.id = 'svsNotesPanel';
  panel.innerHTML =
    '<div class="svsN-head"><b>Заметки до CRM</b><button class="svsN-x" id="svsNX">&times;</button></div>' +
    '<div class="svsN-add">' +
      '<textarea id="svsNText" placeholder="Що поправити в CRM? Опишіть проблему…"></textarea>' +
      '<div class="svsN-page" id="svsNPage"></div>' +
      '<button id="svsNAdd">Додати заметку</button>' +
    '</div>' +
    '<div class="svsN-tabs">' +
      '<button class="svsN-tab active" data-tab="open">Активні<span class="cnt" id="svsNCntOpen">0</span></button>' +
      '<button class="svsN-tab" data-tab="done">Виконані<span class="cnt" id="svsNCntDone">0</span></button>' +
    '</div>' +
    '<div class="svsN-list" id="svsNList"></div>';

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  var state = { tab: 'open', notes: [], loaded: false };

  function setBadge(n) {
    var b = document.getElementById('svsNotesBadge');
    if (n > 0) { b.style.display = 'block'; b.textContent = n > 99 ? '99+' : n; }
    else b.style.display = 'none';
  }

  function render() {
    var list = document.getElementById('svsNList');
    var open = state.notes.filter(function (n) { return n.status === 'open'; });
    var done = state.notes.filter(function (n) { return n.status === 'done'; });
    document.getElementById('svsNCntOpen').textContent = open.length;
    document.getElementById('svsNCntDone').textContent = done.length;
    setBadge(open.length);
    var arr = state.tab === 'open' ? open : done;
    if (!arr.length) {
      list.innerHTML = '<div class="svsN-empty">' +
        (state.tab === 'open' ? 'Активних заметок немає 👍' : 'Виконаних поки немає') + '</div>';
      return;
    }
    list.innerHTML = arr.map(function (n) {
      var pageLink = n.page_path
        ? '<a href="' + esc(n.page_path) + '" title="' + esc(n.page_label || '') + '">📍 ' + esc(n.page_label || n.page_path) + '</a>'
        : '';
      var who = n.created_by_name ? esc(n.created_by_name) : '';
      var meta = '<div class="svsN-meta">' + pageLink +
        '<span>' + (who ? who + ' · ' : '') + fmtDate(n.created_at) + '</span>' +
        (n.status === 'done' && n.done_at ? '<span style="color:#2ecc71">✓ ' + fmtDate(n.done_at) + (n.done_by_name ? ' · ' + esc(n.done_by_name) : '') + '</span>' : '') +
        '</div>';
      var acts = n.status === 'open'
        ? '<div class="svsN-acts"><button class="svsN-done" data-done="' + n.id + '">✓ Виконано</button>' +
          '<button class="svsN-del" data-del="' + n.id + '">Видалити</button></div>'
        : '<div class="svsN-acts"><button class="svsN-reopen" data-reopen="' + n.id + '">↩ Повернути</button>' +
          '<button class="svsN-del" data-del="' + n.id + '">Видалити</button></div>';
      return '<div class="svsN-item ' + (n.status === 'done' ? 'done' : '') + '">' +
        '<div class="txt">' + esc(n.body) + '</div>' + meta + acts + '</div>';
    }).join('');
  }

  function load() {
    return api('/?status=all').then(function (res) {
      state.notes = (res && res.notes) || [];
      state.loaded = true;
      render();
    }).catch(function () {});
  }

  // лёгкий опрос счётчика даже когда панель закрыта (только счётчик)
  function refreshBadge() {
    api('/?status=open').then(function (res) {
      if (res && typeof res.open_count === 'number') setBadge(res.open_count);
    }).catch(function () {});
  }

  // ── события ──────────────────────────────────────────
  fab.addEventListener('click', function () {
    var p = document.getElementById('svsNotesPanel');
    var willOpen = !p.classList.contains('open');
    p.classList.toggle('open');
    if (willOpen) {
      var cp = curPage();
      document.getElementById('svsNPage').innerHTML = '📍 Сторінка: <b>' + esc(cp.page_label || cp.page_path) + '</b>';
      load();
      document.getElementById('svsNText').focus();
    }
  });

  document.getElementById('svsNX').addEventListener('click', function () {
    document.getElementById('svsNotesPanel').classList.remove('open');
  });

  panel.querySelectorAll('.svsN-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      panel.querySelectorAll('.svsN-tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      state.tab = t.dataset.tab;
      render();
    });
  });

  document.getElementById('svsNAdd').addEventListener('click', function () {
    var ta = document.getElementById('svsNText');
    var body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Додаю…';
    var cp = curPage();
    api('/', { method: 'POST', body: { body: body, page_path: cp.page_path, page_label: cp.page_label } })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Додати заметку';
        if (res && res.ok) { ta.value = ''; state.tab = 'open'; panel.querySelectorAll('.svsN-tab').forEach(function (x){x.classList.toggle('active', x.dataset.tab==='open');}); load(); }
        else alert('Не вдалося зберегти: ' + ((res && res.message) || (res && res.error) || 'помилка'));
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Додати заметку'; });
  });

  // делегирование кнопок в списке
  document.getElementById('svsNList').addEventListener('click', function (e) {
    var done = e.target.closest('[data-done]');
    var reopen = e.target.closest('[data-reopen]');
    var del = e.target.closest('[data-del]');
    if (done) { api('/' + done.dataset.done, { method: 'PATCH', body: { status: 'done' } }).then(load); }
    else if (reopen) { api('/' + reopen.dataset.reopen, { method: 'PATCH', body: { status: 'open' } }).then(load); }
    else if (del) {
      if (!confirm('Видалити заметку?')) return;
      api('/' + del.dataset.del, { method: 'DELETE' }).then(load);
    }
  });

  // старт: подтянуть счётчик горящих
  refreshBadge();
})();
