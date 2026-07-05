/* ═══════════════════════════════════════════════════════
   mod-infra.js — UI платформних/інфраструктурних модулів CRM
   Три сторінки групи 'platform' (перероблено 05.07, нотатки #134-136):
     • searchadmin — Пошук: синоніми та аналітика  (routes/search.js → /api/search)
       + додавання/вимкнення/видалення синонімів, перевірка пошуку, zero-results
     • dwh         — Сховище даних (DWH)            (routes/data-warehouse.js → /api/dwh)
       + запуск ETL (всі/окремий джоб), вкл/викл джобів, свіжість таблиць
     • eventbus    — Шина подій                      (routes/events.js → /api/events)
       + жива стрічка останніх подій, тестова подія, DLQ-дії
   ═══════════════════════════════════════════════════════ */
(function () {
  var esc = window.modEsc, empty = window.modEmpty, err = window.modErr, card = window.modCard;

  function val(v) { return (v == null || v === '') ? '—' : esc(v); }
  function num(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return esc(v);
    return esc(n.toLocaleString('uk-UA'));
  }
  function dt(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? esc(v) : esc(d.toLocaleString('uk-UA'));
  }
  function arr(v) { return (Array.isArray(v) && v.length) ? esc(v.join(', ')) : '—'; }
  function bool(v) { return v ? '✓' : '—'; }
  function hint(html) {
    return '<div style="background:#f0f4ff;border:1px solid #d8e0ff;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:13.5px;line-height:1.6;color:#33415c">' + html + '</div>';
  }
  function aerr(e) { alert('Помилка: ' + ((e && e.message) || e)); }

  var TH = 'padding:11px 14px;text-align:left;border-bottom:2px solid #e3e6ea;font-size:12px;color:#888;font-weight:600;white-space:nowrap';
  var TD = 'padding:11px 14px;border-bottom:1px solid #f0f1f3;font-size:13px';
  var TBL = 'width:100%;border-collapse:collapse';
  var BTN = 'padding:6px 14px;border-radius:7px;cursor:pointer;font-size:12.5px;border:1px solid ';
  var BTNP = BTN + '#1a73e8;background:#1a73e8;color:#fff';
  var BTNO = BTN + '#ccc;background:#fff;color:#444';
  var BTND = BTN + '#d9534f;background:#fff;color:#d9534f';
  var INP = 'padding:7px 10px;border:1px solid #ddd;border-radius:7px;font-size:13px';

  function tableHTML(headers, rows) {
    var h = '<table style="' + TBL + '"><thead><tr>';
    for (var i = 0; i < headers.length; i++) h += '<th style="' + TH + '">' + headers[i] + '</th>';
    h += '</tr></thead><tbody>';
    for (var r = 0; r < rows.length; r++) {
      h += '<tr>';
      for (var c = 0; c < rows[r].length; c++) h += '<td style="' + TD + '">' + rows[r][c] + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  /* ═══════════════ 1. ПОШУК: синоніми та аналітика ═══════════════ */
  window.registerModule({
    page: 'searchadmin',
    title: 'Пошук: синоніми та аналітика',
    group: 'platform',
    icon: 'search',
    section: '<div id="searchadmin-body">' + empty('Завантаження…') + '</div>',
    loader: async function () {
      var el = document.getElementById('searchadmin-body');
      if (!el) return;
      el.innerHTML = empty('Завантаження…');
      window._saReload = load;
      await load();

      async function load() {
        try {
          var res = await Promise.all([
            window.modApi('/api/search/analytics/summary').catch(function () { return {}; }),
            window.modApi('/api/search/analytics/top-queries').catch(function () { return {}; }),
            window.modApi('/api/search/synonyms').catch(function () { return {}; }),
            window.modApi('/api/search/analytics/zero-results').catch(function () { return {}; })
          ]);
          var sum = (res[0] && res[0].data) || res[0] || {};
          var top = (res[1] && res[1].data) || [];
          var syn = (res[2] && res[2].data) || [];
          var zero = (res[3] && res[3].data) || [];

          var html = hint('<b>Що це.</b> Тут живе глобальний пошук CRM (верхній рядок пошуку). ' +
            '<b>Синоніми</b> вчать його розуміти різні слова як одне («манік» = «манікюр») — додайте групу нижче, і пошук одразу почне її використовувати. ' +
            '<b>Аналітика</b> показує, що шукають співробітники і де пошук не знаходить нічого (це підказка, яких синонімів бракує).');

          // перевірка пошуку
          html += '<div class="card" style="padding:14px 16px;margin-bottom:16px">' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
              '<b style="font-size:13.5px">Перевірити пошук:</b>' +
              '<input id="sa-testq" style="' + INP + ';min-width:220px" placeholder="напр. манікюр або імʼя клієнта">' +
              '<button style="' + BTNP + '" onclick="_saTest()">Шукати</button>' +
              '<span id="sa-testres" style="font-size:12.5px;color:#666"></span>' +
            '</div></div>';

          // картки аналітики
          html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">';
          html += card('Всього пошуків (30 дн)', num(sum.total_searches));
          html += card('Унікальних запитів', num(sum.unique_queries));
          html += card('Без результатів', num(sum.zero_result_searches), '#d9534f');
          html += card('Груп синонімів', num(Array.isArray(syn) ? syn.length : null));
          html += '</div>';

          // форма додавання синонімів
          html += '<div class="card" style="padding:14px 16px;margin-bottom:16px">' +
            '<b style="font-size:13.5px">Додати групу синонімів</b>' +
            '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">' +
              '<input id="sa-group" style="' + INP + ';width:160px" placeholder="Назва групи">' +
              '<input id="sa-words" style="' + INP + ';flex:1;min-width:240px" placeholder="Слова через кому: манікюр, манік, нігті">' +
              '<button style="' + BTNP + '" onclick="_saAddSyn()">Додати</button>' +
            '</div></div>';

          // синоніми з діями
          html += '<h3 style="margin:8px 0 10px;font-size:15px">Синоніми</h3>';
          if (!Array.isArray(syn) || !syn.length) {
            html += empty('Груп синонімів немає — додайте першу вище');
          } else {
            html += tableHTML(
              ['Група', 'Слова', 'Активна', 'Дії'],
              syn.map(function (r) {
                var actions = r.is_system
                  ? '<span style="font-size:11.5px;color:#999">системна</span>'
                  : '<button style="' + BTNO + '" onclick="_saToggleSyn(' + Number(r.id) + ',' + (r.is_active ? 'false' : 'true') + ')">' + (r.is_active ? 'Вимкнути' : 'Увімкнути') + '</button> ' +
                    '<button style="' + BTND + '" onclick="_saDelSyn(' + Number(r.id) + ')">Видалити</button>';
                return [val(r.synonym_group), arr(r.words), bool(r.is_active), actions];
              })
            );
          }

          // топ-запити
          html += '<h3 style="margin:22px 0 10px;font-size:15px">Топ запитів (30 дн)</h3>';
          if (!Array.isArray(top) || !top.length) {
            html += empty('Поки немає запитів — статистика зʼявиться по мірі користування пошуком');
          } else {
            html += tableHTML(
              ['Запит', 'К-сть', 'Сер. результатів', 'Останній пошук'],
              top.map(function (r) {
                return [val(r.query), num(r.count), r.avg_results == null ? '—' : esc(r.avg_results), dt(r.last_searched_at)];
              })
            );
          }

          // без результатів
          html += '<h3 style="margin:22px 0 10px;font-size:15px">Запити без результатів <span style="font-size:12px;color:#888;font-weight:400">— кандидати на синоніми</span></h3>';
          if (!Array.isArray(zero) || !zero.length) {
            html += empty('Немає — все, що шукали, знаходилось');
          } else {
            html += tableHTML(['Запит', 'К-сть'], zero.map(function (r) { return [val(r.query), num(r.count)]; }));
          }

          el.innerHTML = html;
        } catch (e) { err(el, e); }
      }
    }
  });

  window._saTest = async function () {
    var q = (document.getElementById('sa-testq') || {}).value || '';
    var out = document.getElementById('sa-testres');
    if (!q.trim()) return;
    if (out) out.textContent = 'Шукаю…';
    try {
      var r = await window.modApi('/api/search?q=' + encodeURIComponent(q.trim()) + '&limit=5');
      var total = 0, parts = [];
      var groups = (r && r.groups) || {};
      Object.keys(groups).forEach(function (k) {
        var n = (groups[k] && (groups[k].total != null ? groups[k].total : (groups[k].results || []).length)) || 0;
        total += Number(n) || 0;
        if (n) parts.push(k + ': ' + n);
      });
      if (out) out.textContent = total ? ('Знайдено ' + total + ' (' + parts.join(', ') + ')') : 'Нічого не знайдено';
    } catch (e) { if (out) out.textContent = 'Помилка: ' + e.message; }
  };
  window._saAddSyn = async function () {
    var g = (document.getElementById('sa-group') || {}).value || '';
    var w = (document.getElementById('sa-words') || {}).value || '';
    var words = w.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!g.trim() || words.length < 2) { alert('Вкажіть назву групи і мінімум 2 слова через кому.'); return; }
    try {
      var r = await window.modApi('/api/search/synonyms', { method: 'POST', body: JSON.stringify({ synonym_group: g.trim(), words: words }) });
      if (r && r.error) throw new Error(r.error);
      window._saReload && window._saReload();
    } catch (e) { aerr(e); }
  };
  window._saToggleSyn = async function (id, active) {
    try {
      var r = await window.modApi('/api/search/synonyms/' + id, { method: 'PUT', body: JSON.stringify({ is_active: active }) });
      if (r && r.error) throw new Error(r.error);
      window._saReload && window._saReload();
    } catch (e) { aerr(e); }
  };
  window._saDelSyn = async function (id) {
    if (!confirm('Видалити групу синонімів?')) return;
    try {
      var r = await window.modApi('/api/search/synonyms/' + id, { method: 'DELETE' });
      if (r && r.error) throw new Error(r.error);
      window._saReload && window._saReload();
    } catch (e) { aerr(e); }
  };

  /* ═══════════════ 2. СХОВИЩЕ ДАНИХ (DWH) ═══════════════ */
  window.registerModule({
    page: 'dwh',
    title: 'Сховище даних (DWH)',
    group: 'platform',
    icon: 'storage',
    section: '<div id="dwh-body">' + empty('Завантаження…') + '</div>',
    loader: async function () {
      var el = document.getElementById('dwh-body');
      if (!el) return;
      el.innerHTML = empty('Завантаження…');
      window._dwhReload = load;
      await load();

      async function load() {
        try {
          var res = await Promise.all([
            window.modApi('/api/dwh/status').catch(function () { return {}; }),
            window.modApi('/api/dwh/etl/jobs').catch(function () { return {}; }),
            window.modApi('/api/dwh/freshness').catch(function () { return {}; })
          ]);
          var status = res[0] || {};
          var v2 = status.dwh_v2 || {};
          var jobs = (res[1] && res[1].data) || [];
          var fresh = (res[2] && res[2].data) || [];

          var html = hint('<b>Що це.</b> Сховище даних — «швидка копія» бізнес-даних для важкої аналітики: ' +
            'факти візитів, продажів, оплат і зарплат перекладаються в окремі таблиці, щоб звіти і BI-конструктор літали та не навантажували робочу базу. ' +
            'Наповнюється кнопкою <b>«Запустити всі ETL»</b> (або окремим джобом). Якщо цифри нижче нульові — просто запустіть ETL.');

          html += '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap">' +
            '<button style="' + BTNP + '" onclick="_dwhRunAll(this)">▶ Запустити всі ETL</button>' +
            '<span id="dwh-runmsg" style="font-size:12.5px;color:#666"></span>' +
          '</div>';

          html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">';
          html += card('Факт-візити', num(v2.fact_visits));
          html += card('Факт-продажі', num(v2.fact_sales));
          html += card('Факт-оплати', num(v2.fact_payments));
          html += card('Клієнти (вимір)', num(v2.dim_clients));
          html += '</div>';

          if (status.last_etl) {
            html += '<div style="margin:-8px 0 18px;font-size:12px;color:#888">Останній ETL: ' +
              val(status.last_etl.status) + ' · рядків ' + num(status.last_etl.rows_loaded) + ' · ' + dt(status.last_etl.finished_at) + '</div>';
          }

          html += '<h3 style="margin:8px 0 10px;font-size:15px">ETL-джоби</h3>';
          if (!Array.isArray(jobs) || !jobs.length) {
            html += empty('Джобів не зареєстровано');
          } else {
            html += tableHTML(
              ['Назва', 'Цільова таблиця', 'Активний', 'Останній запуск', 'Статус', 'Дії'],
              jobs.map(function (j) {
                var actions = '<button style="' + BTNO + '" onclick="_dwhRunJob(' + Number(j.id) + ',this)">▶ Запустити</button> ' +
                  '<button style="' + BTNO + '" onclick="_dwhToggleJob(' + Number(j.id) + ')">' + (j.is_active ? 'Вимкнути' : 'Увімкнути') + '</button>';
                return [val(j.name), '<code>' + val(j.target_table) + '</code>', bool(j.is_active), dt(j.last_run_at), val(j.last_status), actions];
              })
            );
          }

          html += '<h3 style="margin:22px 0 10px;font-size:15px">Свіжість даних</h3>';
          if (!Array.isArray(fresh) || !fresh.length) {
            html += empty('Немає даних — запустіть ETL');
          } else {
            var FC = { fresh: '#2e9e5b', aging: '#e0a800', stale: '#d9534f', static: '#888' };
            var FL = { fresh: 'свіжі', aging: 'старіють', stale: 'застарілі', static: 'статичні' };
            html += tableHTML(
              ['Таблиця', 'Рядків', 'Оновлено', 'Стан'],
              fresh.map(function (f) {
                var s = f.freshness_status || 'static';
                return ['<code>' + val(f.table_name || f.name) + '</code>', num(f.rows_count),
                  dt(f.last_updated),
                  '<span style="color:' + (FC[s] || '#888') + ';font-weight:600">' + (FL[s] || esc(s)) + '</span>'];
              })
            );
          }

          el.innerHTML = html;
        } catch (e) { err(el, e); }
      }
    }
  });

  window._dwhRunAll = async function (btn) {
    var msg = document.getElementById('dwh-runmsg');
    if (btn) { btn.disabled = true; btn.textContent = 'Виконується…'; }
    if (msg) msg.textContent = 'ETL запущено, наповнюю таблиці…';
    try {
      var r = await window.modApi('/api/dwh/etl/run-all', { method: 'POST', body: '{}' });
      if (r && r.error) throw new Error(r.error);
      if (msg) msg.textContent = 'Готово. Оновлюю сторінку…';
      setTimeout(function () { window._dwhReload && window._dwhReload(); }, 2500);
    } catch (e) {
      if (msg) msg.textContent = '';
      if (btn) { btn.disabled = false; btn.textContent = '▶ Запустити всі ETL'; }
      aerr(e);
    }
  };
  window._dwhRunJob = async function (id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      var r = await window.modApi('/api/dwh/etl/jobs/' + id + '/run', { method: 'POST', body: '{}' });
      if (r && r.error) throw new Error(r.error);
      setTimeout(function () { window._dwhReload && window._dwhReload(); }, 1500);
    } catch (e) { aerr(e); if (btn) { btn.disabled = false; btn.textContent = '▶ Запустити'; } }
  };
  window._dwhToggleJob = async function (id) {
    try {
      var r = await window.modApi('/api/dwh/etl/jobs/' + id + '/toggle', { method: 'POST', body: '{}' });
      if (r && r.error) throw new Error(r.error);
      window._dwhReload && window._dwhReload();
    } catch (e) { aerr(e); }
  };

  /* ═══════════════ 3. ШИНА ПОДІЙ ═══════════════ */
  window.registerModule({
    page: 'eventbus',
    title: 'Шина подій',
    group: 'platform',
    icon: 'hub',
    section: '<div id="eventbus-body">' + empty('Завантаження…') + '</div>',
    loader: async function () {
      var el = document.getElementById('eventbus-body');
      if (!el) return;
      el.innerHTML = empty('Завантаження…');
      window._ebReload = load;
      await load();

      async function load() {
        try {
          var res = await Promise.all([
            window.modApi('/api/events/health').catch(function () { return {}; }),
            window.modApi('/api/events?limit=30').catch(function () { return {}; }),
            window.modApi('/api/events/types').catch(function () { return {}; }),
            window.modApi('/api/events/dlq').catch(function () { return null; })
          ]);
          var health = res[0] || {};
          var feed = (res[1] && res[1].events) || [];
          var types = (res[2] && res[2].data) || [];
          if (!Array.isArray(types)) types = [];
          var dlq = (res[3] && res[3].data) || [];

          var html = hint('<b>Що це.</b> Шина подій — «чорна скринька» CRM: кожна важлива дія (запис завершено, повідомлення прийшло) ' +
            'публікується як подія, і на неї реагують інші модулі (сегменти, тригери, аналітика). ' +
            'Нижче — жива стрічка того, що відбувається в системі. <b>DLQ</b> — події, які не вдалося обробити (їх можна повторити).');

          var hColor = health.status === 'ok' ? '#2e9e5b' : (health.status ? '#d9534f' : '#222');
          html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">';
          html += card('Статус', val(health.status), hColor);
          html += card('Подій всього', num(health.events_total));
          html += card('За годину', num(health.events_last_1h));
          html += card('Збоїв', num(health.events_failed), '#d9534f');
          html += card('DLQ (очікує)', num(health.dlq_pending), '#d9534f');
          html += '</div>';

          html += '<div style="display:flex;gap:10px;align-items:center;margin:6px 0 18px;flex-wrap:wrap">' +
            '<button style="' + BTNO + '" onclick="_ebTest(this)">Надіслати тестову подію</button>' +
            '<button style="' + BTNO + '" onclick="_ebReload()">Оновити стрічку</button>' +
          '</div>';

          // жива стрічка
          html += '<h3 style="margin:8px 0 10px;font-size:15px">Останні події</h3>';
          if (!Array.isArray(feed) || !feed.length) {
            html += empty('Подій ще немає — натисніть «Надіслати тестову подію»');
          } else {
            var SC = { processed: '#2e9e5b', handled: '#2e9e5b', pending: '#e0a800', failed: '#d9534f', 'new': '#888' };
            html += tableHTML(
              ['Час', 'Подія', 'Обʼєкт', 'Статус', 'Деталі'],
              feed.map(function (e2) {
                var p = '';
                try { p = e2.payload ? JSON.stringify(e2.payload).slice(0, 80) : ''; } catch (_x) { /* ok */ }
                var st = String(e2.status || '—');
                return [dt(e2.created_at),
                  '<b>' + val(e2.event_type) + '</b>',
                  val(e2.entity_type) + (e2.entity_id ? ' #' + esc(e2.entity_id) : ''),
                  '<span style="color:' + (SC[st] || '#555') + ';font-weight:600">' + esc(st) + '</span>' + (e2.error ? '<div style="font-size:11px;color:#d9534f">' + esc(String(e2.error).slice(0, 60)) + '</div>' : ''),
                  '<span style="font-size:11.5px;color:#888">' + esc(p) + '</span>'];
              })
            );
          }

          // типи подій
          html += '<h3 style="margin:22px 0 10px;font-size:15px">Типи подій (зведення)</h3>';
          if (!types.length) {
            html += empty('Типів подій ще не зафіксовано');
          } else {
            html += tableHTML(
              ['Тип', 'Всього', 'За 24 год', 'Збоїв', 'Остання'],
              types.map(function (t2) {
                return ['<b>' + val(t2.event_type || t2.name) + '</b>', num(t2.total), num(t2.last_24h), num(t2.failed), dt(t2.last_seen)];
              })
            );
          }

          // DLQ з діями
          html += '<h3 style="margin:22px 0 10px;font-size:15px">Dead Letter Queue</h3>';
          if (!Array.isArray(dlq) || !dlq.length) {
            html += empty('Черга мертвих повідомлень порожня — збоїв немає');
          } else {
            html += tableHTML(
              ['Тип події', 'Помилка', 'Спроб', 'Статус', 'Дії'],
              dlq.map(function (d) {
                var actions = d.status === 'pending'
                  ? '<button style="' + BTNO + '" onclick="_ebDlq(' + Number(d.id) + ',\'reprocess\')">Повторити</button> ' +
                    '<button style="' + BTND + '" onclick="_ebDlq(' + Number(d.id) + ',\'discard\')">Відкинути</button>'
                  : '—';
                return [val(d.event_type), val(String(d.error_message || '').slice(0, 60)), num(d.retry_count), val(d.status), actions];
              })
            );
          }

          el.innerHTML = html;
        } catch (e) { err(el, e); }
      }
    }
  });

  window._ebTest = async function (btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Надсилаю…'; }
    try {
      var r = await window.modApi('/api/events/test', { method: 'POST', body: '{}' });
      if (r && r.error) throw new Error(r.error);
      setTimeout(function () { window._ebReload && window._ebReload(); }, 800);
    } catch (e) { aerr(e); }
    if (btn) { btn.disabled = false; btn.textContent = 'Надіслати тестову подію'; }
  };
  window._ebDlq = async function (id, action) {
    try {
      var r = await window.modApi('/api/events/dlq/' + id + '/' + action, { method: 'POST', body: '{}' });
      if (r && r.error) throw new Error(r.error);
      window._ebReload && window._ebReload();
    } catch (e) { aerr(e); }
  };
})();
