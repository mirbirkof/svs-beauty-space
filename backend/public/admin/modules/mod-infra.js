/* ═══════════════════════════════════════════════════════
   mod-infra.js — UI платформних/інфраструктурних модулів CRM
   Три сторінки групи 'platform':
     • searchadmin — Пошук: синоніми та аналітика  (routes/search.js → /api/search)
     • dwh         — Сховище даних (DWH)            (routes/data-warehouse.js → /api/dwh)
     • eventbus    — Шина подій                      (routes/events.js → /api/events)
   Реєструється через window.registerModule (modules/_core.js).
   Захисний рендер: нема поля → '—', порожній масив → modEmpty, try/catch → modErr.
   ═══════════════════════════════════════════════════════ */
(function () {
  var esc = window.modEsc, empty = window.modEmpty, err = window.modErr, card = window.modCard;

  // безпечне значення комірки
  function val(v) { return (v == null || v === '') ? '—' : esc(v); }
  // число з форматуванням (роздільник тисяч), або '—'
  function num(v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    if (!isFinite(n)) return esc(v);
    return esc(n.toLocaleString('uk-UA'));
  }
  // дата/час → локальний рядок, або '—'
  function dt(v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? esc(v) : esc(d.toLocaleString('uk-UA'));
  }
  // масив → comma-list, або '—'
  function arr(v) { return (Array.isArray(v) && v.length) ? esc(v.join(', ')) : '—'; }
  // бул → ✓/�—
  function bool(v) { return v ? '✓' : '—'; }

  var TH = 'padding:11px 14px;text-align:left;border-bottom:2px solid #e3e6ea;font-size:12px;color:#888;font-weight:600;white-space:nowrap';
  var TD = 'padding:11px 14px;border-bottom:1px solid #f0f1f3;font-size:13px';
  var TBL = 'width:100%;border-collapse:collapse';

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
      try {
        var res = await Promise.all([
          window.modApi('/api/search/analytics/summary').catch(function () { return {}; }),
          window.modApi('/api/search/analytics/top-queries').catch(function () { return {}; }),
          window.modApi('/api/search/synonyms').catch(function () { return {}; })
        ]);
        var sum = (res[0] && res[0].data) || {};
        var top = (res[1] && res[1].data) || [];
        var syn = (res[2] && res[2].data) || [];

        var html = '';

        // картки аналітики
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">';
        html += card('Всього пошуків', num(sum.total_searches));
        html += card('Унікальних запитів', num(sum.unique_queries));
        html += card('Без результатів', num(sum.zero_result_searches), '#d9534f');
        html += card('Сер. результатів', sum.avg_results == null ? '—' : esc(sum.avg_results));
        html += card('Сер. час, мс', sum.avg_response_time_ms == null ? '—' : esc(sum.avg_response_time_ms));
        html += card('CTR', sum.ctr == null ? '—' : esc(sum.ctr));
        html += '</div>';

        // топ-запити
        html += '<h3 style="margin:8px 0 10px;font-size:15px">Топ запитів</h3>';
        if (!Array.isArray(top) || !top.length) {
          html += empty('Поки немає запитів');
        } else {
          html += tableHTML(
            ['Запит', 'К-сть', 'Сер. результатів', 'CTR', 'Останній пошук'],
            top.map(function (r) {
              return [
                val(r.query),
                num(r.count),
                r.avg_results == null ? '—' : esc(r.avg_results),
                r.avg_ctr == null ? '—' : esc(r.avg_ctr),
                dt(r.last_searched_at)
              ];
            })
          );
        }

        // синоніми
        html += '<h3 style="margin:22px 0 10px;font-size:15px">Синоніми</h3>';
        if (!Array.isArray(syn) || !syn.length) {
          html += empty('Груп синонімів немає');
        } else {
          html += tableHTML(
            ['Група', 'Слова', 'Напрям', 'Мова', 'Активна', 'Системна'],
            syn.map(function (r) {
              return [
                val(r.synonym_group),
                arr(r.words),
                val(r.direction),
                val(r.language),
                bool(r.is_active),
                bool(r.is_system)
              ];
            })
          );
        }

        el.innerHTML = html;
      } catch (e) { err(el, e); }
    }
  });

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
      try {
        var res = await Promise.all([
          window.modApi('/api/dwh/status').catch(function () { return {}; }),
          window.modApi('/api/dwh/etl/jobs').catch(function () { return {}; }),
          window.modApi('/api/dwh/views').catch(function () { return {}; })
        ]);
        var status = res[0] || {};
        var fv = status.fact_visits || {};
        var v2 = status.dwh_v2 || {};
        var lastEtl = status.last_etl || null;
        var jobs = (res[1] && res[1].data) || [];
        var views = (res[2] && res[2].data) || [];

        var html = '';

        // картки статусу
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">';
        html += card('Факт-візити (legacy)', num(fv.rows));
        html += card('Виручка (legacy)', num(fv.revenue));
        html += card('fact_visits v2', num(v2.fact_visits));
        html += card('fact_sales', num(v2.fact_sales));
        html += card('fact_payments', num(v2.fact_payments));
        html += card('dim_clients', num(v2.dim_clients));
        html += '</div>';

        if (lastEtl) {
          html += '<div style="margin:-8px 0 18px;font-size:12px;color:#888">' +
            'Останній ETL: ' + val(lastEtl.status) + ' · рядків ' + num(lastEtl.rows_loaded) +
            ' · ' + dt(lastEtl.finished_at) + '</div>';
        }

        // ETL-джоби
        html += '<h3 style="margin:8px 0 10px;font-size:15px">ETL-джоби</h3>';
        if (!Array.isArray(jobs) || !jobs.length) {
          html += empty('Джобів не зареєстровано');
        } else {
          html += tableHTML(
            ['Назва', 'Цільова таблиця', 'Тип', 'Розклад', 'Пріоритет', 'Активний', 'Останній запуск', 'Статус'],
            jobs.map(function (j) {
              return [
                val(j.name),
                val(j.target_table),
                val(j.job_type),
                val(j.cron_expression),
                j.priority == null ? '—' : esc(j.priority),
                bool(j.is_active),
                dt(j.last_run_at),
                val(j.last_status)
              ];
            })
          );
        }

        // вітрини
        html += '<h3 style="margin:22px 0 10px;font-size:15px">Вітрини даних</h3>';
        if (!Array.isArray(views) || !views.length) {
          html += empty('Вітрин немає');
        } else {
          html += tableHTML(
            ['Назва', 'Опис', 'Джерело'],
            views.map(function (v) {
              return [val(v.name), val(v.label), val(v.source)];
            })
          );
        }

        el.innerHTML = html;
      } catch (e) { err(el, e); }
    }
  });

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
      try {
        var res = await Promise.all([
          window.modApi('/api/events/health').catch(function () { return {}; }),
          window.modApi('/api/events/registry').catch(function () { return {}; }),
          window.modApi('/api/events/dlq').catch(function () { return {}; })
        ]);
        var health = res[0] || {};
        var registry = (res[1] && res[1].data) || [];
        var dlq = (res[2] && res[2].data) || [];

        var html = '';

        // картки health
        var hColor = health.status === 'ok' ? '#3c9' : (health.status ? '#d9534f' : '#222');
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px">';
        html += card('Статус', val(health.status), hColor);
        html += card('Подій всього', num(health.events_total));
        html += card('Збоїв', num(health.events_failed), '#d9534f');
        html += card('За годину', num(health.events_last_1h));
        html += card('DLQ (очікує)', num(health.dlq_pending), '#d9534f');
        html += '</div>';
        if (health.transport) {
          html += '<div style="margin:0 0 18px;font-size:12px;color:#888">Транспорт: ' + val(health.transport) + '</div>';
        }

        // реєстр типів подій
        html += '<h3 style="margin:8px 0 10px;font-size:15px">Реєстр типів подій</h3>';
        if (!Array.isArray(registry) || !registry.length) {
          html += empty('Типів подій не зареєстровано');
        } else {
          html += tableHTML(
            ['Назва', 'Домен', 'Версія', 'Опис', 'Retention, год', 'Активний'],
            registry.map(function (r) {
              return [
                val(r.name),
                val(r.domain),
                r.version == null ? '—' : esc(r.version),
                val(r.description),
                r.retention_hours == null ? '—' : esc(r.retention_hours),
                bool(r.is_active)
              ];
            })
          );
        }

        // DLQ
        html += '<h3 style="margin:22px 0 10px;font-size:15px">Dead Letter Queue</h3>';
        if (!Array.isArray(dlq) || !dlq.length) {
          html += empty('Черга мертвих повідомлень порожня');
        } else {
          html += tableHTML(
            ['Тип події', 'Помилка', 'Спроб', 'Статус', 'Збій о'],
            dlq.map(function (d) {
              return [
                val(d.event_type),
                val(d.error_message),
                d.retry_count == null ? '—' : esc(d.retry_count),
                val(d.status),
                dt(d.failed_at)
              ];
            })
          );
        }

        el.innerHTML = html;
      } catch (e) { err(el, e); }
    }
  });
})();
