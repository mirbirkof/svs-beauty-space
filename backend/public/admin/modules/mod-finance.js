/* ═══ UI-МОДУЛЬ: ФІНАНСИ (P&L / Виплати ЗП / KPI співробітників) ═══════════
 * Реєструє 3 сторінки у групі «Аналітика та AI». Vanilla JS, без фреймворків.
 * Працює поверх глобальних хелперів _core.js: modApi, modEsc, modEmpty,
 * modErr, modCard. Дані тягне з /api/pnl, /api/payouts, /api/kpi.
 * Жодних git-комітів / зовнішніх викликів — лише рендер з реальних ендпоінтів.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── локальні утиліти рендеру ──────────────────────────────────────────────
  function curMonth() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  // безпечне число → рядок з пробілами-роздільниками; null/undefined → '—'
  function fmtNum(v, suffix) {
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !isFinite(v))) return '—';
    var n = Number(v);
    if (!isFinite(n)) return window.modEsc(String(v));
    var s = (Math.round(n * 100) / 100).toLocaleString('uk-UA');
    return s + (suffix || '');
  }
  function fmtMoney(v) {
    if (v === null || v === undefined || v === '') return '—';
    return fmtNum(v, ' ₴');
  }
  function fmtPct(v) {
    if (v === null || v === undefined || v === '') return '—';
    return fmtNum(v, '%');
  }
  // значення поля з кількох можливих ключів; перше визначене
  function pick() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  function tableOpen() { return '<table style="width:100%;border-collapse:collapse">'; }
  function th(label, alignRight) {
    return '<th style="padding:11px 14px;text-align:' + (alignRight ? 'right' : 'left') +
      ';font-size:12px;color:#888;border-bottom:2px solid #eee;white-space:nowrap">' +
      window.modEsc(label) + '</th>';
  }
  function td(html, alignRight) {
    return '<td style="padding:11px 14px;text-align:' + (alignRight ? 'right' : 'left') +
      ';border-bottom:1px solid #f0f0f0">' + (html == null ? '—' : html) + '</td>';
  }
  function cardsRow(html) {
    return '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px">' + html + '</div>';
  }

  /* ═══════════ 1. P&L (Звіт про прибутки та збитки) ═══════════════════════ */
  window.registerModule({
    page: 'pnl',
    title: 'Звіт P&L / Прибутки-збитки',
    group: 'analytics',
    icon: 'trending_up',
    section: '<div id="pnlCards"></div><div id="pnlBody"></div>',
    loader: async function () {
      var cards = document.getElementById('pnlCards');
      var body = document.getElementById('pnlBody');
      if (cards) cards.innerHTML = '';
      if (body) body.innerHTML = window.modEmpty('Завантаження…');
      try {
        // повний звіт за поточний місяць (totals + line_items)
        var data = await window.modApi('/api/pnl?period_type=month');
        var rep = (data && data.report) || {};
        var revenue = pick(rep.total_revenue);
        var expenses = (rep.total_cogs != null || rep.total_opex != null)
          ? Number(rep.total_cogs || 0) + Number(rep.total_opex || 0) : null;
        var profit = pick(rep.net_profit);
        var margin = pick(rep.net_margin);

        // фолбек на summary, якщо повний звіт чомусь без totals
        if (revenue == null && profit == null) {
          try {
            var sum = await window.modApi('/api/pnl/summary');
            if (sum) {
              revenue = pick(sum.revenue, revenue);
              expenses = pick(sum.expenses, expenses);
              profit = pick(sum.net_profit, profit);
              margin = pick(sum.net_margin, margin);
            }
          } catch (_e) { /* summary не критичний */ }
        }

        if (cards) {
          cards.innerHTML = cardsRow(
            window.modCard('Виручка', fmtMoney(revenue), '#1a73e8') +
            window.modCard('Витрати', fmtMoney(expenses), '#d9534f') +
            window.modCard('Чистий прибуток', fmtMoney(profit), '#2e9e5b') +
            window.modCard('Чиста маржа', fmtPct(margin), '#7b5cd6')
          );
        }

        var items = (data && Array.isArray(data.line_items)) ? data.line_items : [];
        var SECTION_LABELS = {
          revenue: 'Виручка', cogs: 'Собівартість', opex: 'Операційні витрати', other: 'Інше'
        };
        if (!items.length) { body.innerHTML = window.modEmpty('Немає статей за період'); return; }

        var html = tableOpen() + '<thead><tr>' +
          th('Стаття') + th('Розділ') + th('Сума', true) + th('Попередній період', true) +
          '</tr></thead><tbody>';
        for (var i = 0; i < items.length; i++) {
          var it = items[i] || {};
          var trendIcon = it.trend === 'up' ? ' ▲' : (it.trend === 'down' ? ' ▼' : '');
          html += '<tr>' +
            td(window.modEsc(it.label != null ? it.label : (it.category || '—'))) +
            td(window.modEsc(SECTION_LABELS[it.section] || it.section || '—')) +
            td(fmtMoney(it.amount), true) +
            td(fmtMoney(it.prev_period_amount) + trendIcon, true) +
            '</tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
      } catch (e) {
        window.modErr(body, e);
      }
    }
  });

  /* ═══════════ 2. ВИПЛАТИ ЗП (Зарплатна відомість) ═══════════════════════ */
  window.registerModule({
    page: 'payouts',
    title: 'Виплати ЗП / Відомість',
    group: 'analytics',
    icon: 'payments',
    section: '<div id="payoutsCards"></div><div id="payoutsBody"></div>',
    loader: async function () {
      var cards = document.getElementById('payoutsCards');
      var body = document.getElementById('payoutsBody');
      if (cards) cards.innerHTML = '';
      if (body) body.innerHTML = window.modEmpty('Завантаження…');
      try {
        var period = curMonth();
        var data = await window.modApi('/api/payouts/sheet?period=' + encodeURIComponent(period));
        var rows = (data && Array.isArray(data.rows)) ? data.rows : [];
        var totals = (data && data.totals) || {};

        if (cards) {
          cards.innerHTML = cardsRow(
            window.modCard('Період', window.modEsc(pick(data && data.period, period)), '#222') +
            window.modCard('Фонд ЗП', fmtMoney(pick(totals.fund)), '#1a73e8') +
            window.modCard('Виплачено', fmtMoney(pick(totals.paid)), '#2e9e5b') +
            window.modCard('До виплати', fmtMoney(pick(totals.remaining)), '#d9534f') +
            window.modCard('% від виручки', fmtPct(pick(totals.payroll_ratio)), '#7b5cd6')
          );
        }

        if (!rows.length) { body.innerHTML = window.modEmpty('Немає нарахувань за період'); return; }

        var html = tableOpen() + '<thead><tr>' +
          th('Майстер') + th('Візити', true) + th('Виручка', true) +
          th('Відсоток', true) + th('Оклад', true) + th('Бонус', true) +
          th('До нарах.', true) + th('Виплачено', true) + th('Залишок', true) + th('Статус') +
          '</tr></thead><tbody>';
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i] || {};
          var name = window.modEsc(pick(r.master_name, r.master_id != null ? ('#' + r.master_id) : null) || '—');
          if (r.estimate) name += ' <span style="font-size:11px;color:#e0a800">(оцінка)</span>';
          var bonus = Number(r.bonus || 0) + Number(r.kpi_bonus || 0);
          html += '<tr>' +
            td(name) +
            td(fmtNum(r.services_count), true) +
            td(fmtMoney(r.services_revenue), true) +
            td(fmtMoney(r.percent_part), true) +
            td(fmtMoney(r.fixed_part), true) +
            td(fmtMoney(bonus), true) +
            td('<b>' + fmtMoney(r.total) + '</b>', true) +
            td(fmtMoney(r.paid), true) +
            td(fmtMoney(r.remaining), true) +
            td(window.modEsc(r.status || '—')) +
            '</tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
      } catch (e) {
        window.modErr(body, e);
      }
    }
  });

  /* ═══════════ 3. KPI СПІВРОБІТНИКІВ (лідерборд) ═════════════════════════ */
  window.registerModule({
    page: 'kpiemp',
    title: 'KPI співробітників',
    group: 'analytics',
    icon: 'leaderboard',
    section: '<div id="kpiempCards"></div><div id="kpiempBody"></div>',
    loader: async function () {
      var cards = document.getElementById('kpiempCards');
      var body = document.getElementById('kpiempBody');
      if (cards) cards.innerHTML = '';
      if (body) body.innerHTML = window.modEmpty('Завантаження…');
      try {
        var data = await window.modApi('/api/kpi/employees');
        var emps = (data && Array.isArray(data.employees)) ? data.employees : [];
        var period = pick(data && data.period, curMonth());
        var usedLeaderboard = false;

        // фолбек на лідерборд, якщо employees порожній
        if (!emps.length) {
          try {
            var lb = await window.modApi('/api/kpi/leaderboard');
            var leaders = (lb && Array.isArray(lb.leaders)) ? lb.leaders : [];
            if (leaders.length) {
              usedLeaderboard = true;
              period = pick(lb.period, period);
              emps = leaders.map(function (l) {
                var emp = l.employee || {};
                return { id: emp.id, name: emp.name, rank: l.rank, total_score: l.value, metrics: [] };
              });
            }
          } catch (_e) { /* лідерборд не критичний */ }
        }

        // підсумкові картки
        var topName = emps.length ? pick(emps[0].name, '#' + emps[0].id) : null;
        var avgScore = null;
        var scored = emps.filter(function (e) { return e.total_score != null; });
        if (scored.length) {
          avgScore = Math.round(scored.reduce(function (a, e) { return a + Number(e.total_score); }, 0) / scored.length);
        }
        if (cards) {
          cards.innerHTML = cardsRow(
            window.modCard('Період', window.modEsc(period), '#222') +
            window.modCard('Співробітників', fmtNum(emps.length), '#1a73e8') +
            window.modCard('Лідер', topName == null ? '—' : window.modEsc(topName), '#2e9e5b') +
            window.modCard('Середній бал', avgScore == null ? '—' : fmtNum(avgScore), '#7b5cd6')
          );
        }

        if (!emps.length) { body.innerHTML = window.modEmpty('Немає даних KPI за період'); return; }

        // зібрати набір метрик-колонок (для режиму /employees)
        var metricCols = [];
        if (!usedLeaderboard) {
          var seen = {};
          for (var a = 0; a < emps.length; a++) {
            var ms = emps[a].metrics || [];
            for (var b = 0; b < ms.length; b++) {
              if (ms[b] && ms[b].code && !seen[ms[b].code]) {
                seen[ms[b].code] = true;
                metricCols.push({ code: ms[b].code, name: ms[b].name || ms[b].code });
              }
            }
          }
        }

        var html = tableOpen() + '<thead><tr>' + th('Ранг', true) + th('Майстер');
        for (var c = 0; c < metricCols.length; c++) html += th(metricCols[c].name, true);
        html += th('Загальний бал', true) + '</tr></thead><tbody>';

        for (var i = 0; i < emps.length; i++) {
          var e = emps[i] || {};
          var rank = pick(e.rank, i + 1);
          html += '<tr>' +
            td('<b>' + window.modEsc(String(rank)) + '</b>', true) +
            td(window.modEsc(pick(e.name, e.id != null ? ('#' + e.id) : null) || '—'));
          if (metricCols.length) {
            var mMap = {};
            (e.metrics || []).forEach(function (m) { if (m && m.code) mMap[m.code] = m; });
            for (var k = 0; k < metricCols.length; k++) {
              var m = mMap[metricCols[k].code];
              var cell = '—';
              if (m) {
                var actual = fmtNum(m.actual);
                cell = actual + (m.percent != null ? ' <span style="color:#888;font-size:11px">(' + fmtPct(m.percent) + ')</span>' : '');
              }
              html += td(cell, true);
            }
          }
          html += td('<b>' + (e.total_score == null ? '—' : fmtNum(e.total_score)) + '</b>', true) + '</tr>';
        }
        html += '</tbody></table>';
        body.innerHTML = html;
      } catch (e) {
        window.modErr(body, e);
      }
    }
  });


  /* ═══════════ 4. KPI ФІЛІАЛІВ (бенчмаркінг + рейтинг + план/факт) ════════ */
  window.registerModule({
    page: 'kpibranches',
    title: 'KPI філіалів',
    group: 'analytics',
    icon: 'store',
    section: [
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">',
        '<label style="font-size:13px;color:#555">Від:',
          '<input id="kpibr_from" type="date" style="margin-left:6px;padding:5px 8px;border:1px solid #ddd;border-radius:6px">',
        '</label>',
        '<label style="font-size:13px;color:#555">До:',
          '<input id="kpibr_to" type="date" style="margin-left:6px;padding:5px 8px;border:1px solid #ddd;border-radius:6px">',
        '</label>',
        '<button id="kpibr_load" style="padding:6px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">',
          'Оновити',
        '</button>',
      '</div>',
      '<div id="kpibrCards"></div>',
      '<div id="kpibrRating"></div>',
      '<div id="kpibrBench"></div>'
    ].join(''),
    loader: async function () {
      // ── вирахувати діапазон дат (поточний місяць за замовчуванням)
      var today = new Date();
      var y = today.getUTCFullYear();
      var m = String(today.getUTCMonth() + 1).padStart(2, '0');
      var defaultFrom = y + '-' + m + '-01';
      var defaultTo   = today.toISOString().slice(0, 10);

      var fromEl = document.getElementById('kpibr_from');
      var toEl   = document.getElementById('kpibr_to');
      var btn    = document.getElementById('kpibr_load');
      var cards  = document.getElementById('kpibrCards');
      var rating = document.getElementById('kpibrRating');
      var bench  = document.getElementById('kpibrBench');

      if (fromEl && !fromEl.value) fromEl.value = defaultFrom;
      if (toEl   && !toEl.value)   toEl.value   = defaultTo;

      var from = (fromEl && fromEl.value) || defaultFrom;
      var to   = (toEl   && toEl.value)   || defaultTo;

      if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', function () {
          if (cards)  cards.innerHTML  = window.modEmpty('Завантаження…');
          if (rating) rating.innerHTML = '';
          if (bench)  bench.innerHTML  = '';
          window._kpibr_load && window._kpibr_load();
        });
      }

      var qs = '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);

      // ── зберігаємо функцію перезавантаження для кнопки
      var self = this;
      window._kpibr_load = async function () {
        var fr = (document.getElementById('kpibr_from') && document.getElementById('kpibr_from').value) || defaultFrom;
        var t  = (document.getElementById('kpibr_to')   && document.getElementById('kpibr_to').value)   || defaultTo;
        var q  = '?from=' + encodeURIComponent(fr) + '&to=' + encodeURIComponent(t);
        await loadKpiBranches(q);
      };

      if (cards) cards.innerHTML = window.modEmpty('Завантаження…');

      await loadKpiBranches(qs);

      // ── внутрішня функція завантаження ──────────────────────────────────────
      async function loadKpiBranches(q) {
        var cEl = document.getElementById('kpibrCards');
        var rEl = document.getElementById('kpibrRating');
        var bEl = document.getElementById('kpibrBench');
        if (cEl) cEl.innerHTML = window.modEmpty('Завантаження…');
        try {
          var listData  = await window.modApi('/api/kpi-branches' + q);
          var benchData = null;
          var sumData   = null;
          try { benchData = await window.modApi('/api/kpi-branches/benchmark' + q); } catch (_e) { /* ok */ }
          try { sumData   = await window.modApi('/api/kpi-branches/network-summary' + q); } catch (_e) { /* ok */ }

          var branches = (listData && Array.isArray(listData.branches)) ? listData.branches : [];
          var totals   = (listData && listData.totals) || {};
          var summary  = (sumData  && sumData.summary)  || {};

          // ── KPI-картки сітки ─────────────────────────────────────────────
          if (cEl) {
            cEl.innerHTML = cardsRow(
              window.modCard('Філіалів',         fmtNum(branches.length),                          '#222') +
              window.modCard('Виручка мережі',   fmtMoney(pick(summary.total_revenue, totals.revenue)), '#1a73e8') +
              window.modCard('Всього візитів',   fmtNum(pick(summary.total_visits, totals.visits)), '#2e9e5b') +
              window.modCard('Сер. чек мережі',  fmtMoney(summary.network_avg_check),               '#7b5cd6') +
              window.modCard('Завантаженість %', fmtPct(summary.avg_occupancy),                     '#e67e22') +
              window.modCard('Лідер',
                summary.best_branch_name
                  ? (window.modEsc(summary.best_branch_name) + ' ' + fmtMoney(summary.best_branch_revenue))
                  : '—', '#16a085')
            );
          }

          // ── Рейтинг філіалів ─────────────────────────────────────────────
          if (rEl) {
            var rHtml = '<h3 style="font-size:15px;font-weight:600;margin:18px 0 10px">Рейтинг філіалів</h3>';
            if (!branches.length) {
              rHtml += window.modEmpty('Немає даних за вибраний період');
            } else {
              rHtml += tableOpen() + '<thead><tr>' +
                th('#', true) + th('Філіал') + th('Виручка', true) +
                th('Візити', true) + th('Клієнти', true) + th('Сер. чек', true) +
                th('Виконання', true) +
                '</tr></thead><tbody>';
              for (var i = 0; i < branches.length; i++) {
                var br = branches[i] || {};
                var compRate = br.completion_rate != null
                  ? '<span style="color:' + (Number(br.completion_rate) >= 80 ? '#2e9e5b' : (Number(br.completion_rate) >= 60 ? '#e0a800' : '#d9534f')) + '">' +
                    fmtPct(br.completion_rate) + '</span>'
                  : '—';
                rHtml += '<tr>' +
                  td('<b>' + window.modEsc(String(br.rank || i + 1)) + '</b>', true) +
                  td(window.modEsc(br.name || br.code || '—')) +
                  td(fmtMoney(br.revenue), true) +
                  td(fmtNum(br.visits), true) +
                  td(fmtNum(br.clients), true) +
                  td(fmtMoney(br.avg_check), true) +
                  td(compRate, true) +
                  '</tr>';
              }
              rHtml += '</tbody></table>';
            }
            rEl.innerHTML = rHtml;
          }

          // ── Бенчмаркінг (топ/сер/низ) ───────────────────────────────────
          if (bEl) {
            var bList = (benchData && Array.isArray(benchData.benchmark)) ? benchData.benchmark : [];
            var bHtml = '<h3 style="font-size:15px;font-weight:600;margin:18px 0 10px">Бенчмаркінг (порівняння)</h3>';
            if (!bList.length) {
              bHtml += window.modEmpty('Немає даних для бенчмаркінгу');
            } else {
              var TIER_COLOR = { top: '#2e9e5b', mid: '#e0a800', bottom: '#d9534f' };
              var TIER_LABEL = { top: 'Топ', mid: 'Середній', bottom: 'Відстає' };
              bHtml += tableOpen() + '<thead><tr>' +
                th('Філіал') + th('Виручка', true) + th('Сер. чек', true) +
                th('Завантаж.', true) + th('Баланс. бал', true) + th('Рівень') +
                '</tr></thead><tbody>';
              for (var j = 0; j < bList.length; j++) {
                var b = bList[j] || {};
                var tier = b.tier || 'mid';
                var tierBadge = '<span style="background:' + (TIER_COLOR[tier] || '#888') +
                  ';color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">' +
                  window.modEsc(TIER_LABEL[tier] || tier) + '</span>';
                bHtml += '<tr>' +
                  td(window.modEsc(b.name || b.code || '—')) +
                  td(fmtMoney(b.revenue), true) +
                  td(fmtMoney(b.avg_check), true) +
                  td(fmtPct(b.occupancy), true) +
                  td('<b>' + fmtNum(b.total_score) + '</b>', true) +
                  td(tierBadge) +
                  '</tr>';
              }
              bHtml += '</tbody></table>';
            }
            bEl.innerHTML = bHtml;
          }

        } catch (e) {
          if (cEl) window.modErr(cEl, e);
        }
      }
    }
  });

  /* ═══════════ 5. FIN-05 Бюджетування ═══════════════════════════════════════ */
  window.registerModule({
    page:  'budgeting',
    label: 'Бюджетування',
    icon:  'account_balance_wallet',
    group: 'analytics',

    render: function (container) {
      container.innerHTML =
        '<div id="bgt-filters" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px">' +
          '<select id="bgt-status" style="padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
            '<option value="">Усі статуси</option>' +
            '<option value="draft">Чернетка</option>' +
            '<option value="pending_approval">На затвердженні</option>' +
            '<option value="active" selected>Активний</option>' +
            '<option value="closed">Закритий</option>' +
          '</select>' +
          '<select id="bgt-type" style="padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
            '<option value="">Усі типи</option>' +
            '<option value="month">Місяць</option>' +
            '<option value="quarter">Квартал</option>' +
            '<option value="year">Рік</option>' +
          '</select>' +
          '<input id="bgt-year" type="number" placeholder="Рік" min="2020" max="2030" style="width:90px;padding:7px 10px;border:1px solid #ddd;border-radius:6px;font-size:13px">' +
          '<button id="bgt-load-btn" style="padding:7px 16px;background:#1a73e8;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">Оновити</button>' +
          '<button id="bgt-consolidated-btn" style="padding:7px 16px;background:#2e9e5b;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">Зведений звіт</button>' +
        '</div>' +
        '<div id="bgt-alerts-bar" style="margin-bottom:10px"></div>' +
        '<div id="bgt-kpi" style="margin-bottom:18px"></div>' +
        '<div id="bgt-list"></div>' +
        '<div id="bgt-planfact" style="margin-top:24px"></div>' +
        '<div id="bgt-consolidated" style="margin-top:24px"></div>';
    },

    mount: function (container) {
      var self = this;
      var listEl    = document.getElementById('bgt-list');
      var kpiEl     = document.getElementById('bgt-kpi');
      var pf        = document.getElementById('bgt-planfact');
      var consEl    = document.getElementById('bgt-consolidated');
      var alertsBar = document.getElementById('bgt-alerts-bar');

      // ── статус-бейдж ───────────────────────────────────────────
      var STATUS_COLOR = {
        draft: '#888', pending_approval: '#e0a800',
        active: '#2e9e5b', closed: '#1a73e8', archived: '#bbb'
      };
      var STATUS_LABEL = {
        draft: 'Чернетка', pending_approval: 'На затвердженні',
        active: 'Активний', closed: 'Закритий', archived: 'Архів'
      };
      function badge(status) {
        var c = STATUS_COLOR[status] || '#888';
        var l = STATUS_LABEL[status] || window.modEsc(status || '');
        return '<span style="background:' + c + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">' + l + '</span>';
      }

      // ── завантаження алертів ───────────────────────────────────
      async function loadAlerts() {
        try {
          var data = await window.modApi('/api/budgets/alerts');
          var items = (data && data.data) || [];
          if (!items.length) { alertsBar.innerHTML = ''; return; }
          var html = '<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;font-size:13px">' +
            '<b>⚠ Алерти бюджету (' + items.length + '):</b> ';
          items.slice(0, 3).forEach(function(a) {
            html += '<span style="margin-left:8px;color:' + (a.alert_type === 'critical' ? '#d9534f' : '#e0a800') + '">' +
              window.modEsc(a.category_name || '') + ' ' + fmtPct(a.actual_percent) + ' (' + a.alert_type + ')</span>';
          });
          if (items.length > 3) html += '<span style="margin-left:8px;color:#888">+' + (items.length - 3) + ' ще</span>';
          html += '</div>';
          alertsBar.innerHTML = html;
        } catch (_) { alertsBar.innerHTML = ''; }
      }

      // ── завантаження списку бюджетів ──────────────────────────
      async function loadList() {
        var status = (document.getElementById('bgt-status') || {}).value || '';
        var type   = (document.getElementById('bgt-type') || {}).value || '';
        var year   = (document.getElementById('bgt-year') || {}).value || '';
        var q = '';
        if (status) q += '&status=' + encodeURIComponent(status);
        if (type)   q += '&period_type=' + encodeURIComponent(type);
        if (year)   q += '&year=' + encodeURIComponent(year);
        if (q) q = '?' + q.slice(1);

        listEl.innerHTML = window.modEmpty('Завантаження…');
        kpiEl.innerHTML  = '';
        pf.innerHTML     = '';
        consEl.innerHTML = '';

        try {
          var data = await window.modApi('/api/budgets' + q);
          var items = (data && data.items) || [];
          await loadAlerts();

          // KPI-картки
          var total = items.length;
          var active = items.filter(function(b) { return b.status === 'active'; }).length;
          var totalRevPlan = items.reduce(function(s, b) { return s + Number(b.total_revenue_plan || 0); }, 0);
          var totalExpPlan = items.reduce(function(s, b) { return s + Number(b.total_expense_plan || 0); }, 0);
          kpiEl.innerHTML = cardsRow(
            window.modCard('Бюджетів',       fmtNum(total),                       '#222') +
            window.modCard('Активних',        fmtNum(active),                      '#2e9e5b') +
            window.modCard('Дохід (план)',    fmtMoney(totalRevPlan),              '#1a73e8') +
            window.modCard('Витрати (план)',  fmtMoney(totalExpPlan),              '#e67e22') +
            window.modCard('Профіцит (план)', fmtMoney(totalRevPlan - totalExpPlan), totalRevPlan > totalExpPlan ? '#2e9e5b' : '#d9534f')
          );

          if (!items.length) { listEl.innerHTML = window.modEmpty('Бюджети не знайдені'); return; }

          var html = '<h3 style="font-size:15px;font-weight:600;margin:0 0 10px">Список бюджетів</h3>';
          html += tableOpen() + '<thead><tr>' +
            th('Назва') + th('Тип') + th('Період') + th('Статус') +
            th('Дохід (план)', true) + th('Витрати (план)', true) + th('Дія') +
            '</tr></thead><tbody>';

          items.forEach(function(b) {
            var canSubmit  = b.status === 'draft';
            var canApprove = b.status === 'pending_approval';
            var canReject  = b.status === 'pending_approval';
            var canClose   = b.status === 'active';
            var actions = '';
            if (canSubmit)  actions += '<button onclick="window._bgtAction(' + b.id + ',\'submit\')" style="font-size:11px;padding:2px 7px;border:1px solid #e0a800;background:#fff8e1;border-radius:4px;cursor:pointer;margin:1px">На затвердження</button>';
            if (canApprove) actions += '<button onclick="window._bgtAction(' + b.id + ',\'approve\')" style="font-size:11px;padding:2px 7px;border:1px solid #2e9e5b;background:#e8f5e9;border-radius:4px;cursor:pointer;margin:1px">Затвердити</button>';
            if (canReject)  actions += '<button onclick="window._bgtAction(' + b.id + ',\'reject\')" style="font-size:11px;padding:2px 7px;border:1px solid #d9534f;background:#fdf0f0;border-radius:4px;cursor:pointer;margin:1px">Відхилити</button>';
            if (canClose)   actions += '<button onclick="window._bgtAction(' + b.id + ',\'close\')" style="font-size:11px;padding:2px 7px;border:1px solid #888;background:#f5f5f5;border-radius:4px;cursor:pointer;margin:1px">Закрити</button>';
            actions += '<button onclick="window._bgtPlanFact(' + b.id + ')" style="font-size:11px;padding:2px 7px;border:1px solid #1a73e8;background:#e8f0fe;border-radius:4px;cursor:pointer;margin:1px">План/Факт</button>';

            html += '<tr>' +
              td('<b>' + window.modEsc(b.name || '') + '</b>') +
              td(window.modEsc(b.period_type || '')) +
              td(window.modEsc((b.period_start || '').slice(0, 10)) + ' — ' + window.modEsc((b.period_end || '').slice(0, 10))) +
              td(badge(b.status)) +
              td(fmtMoney(b.total_revenue_plan), true) +
              td(fmtMoney(b.total_expense_plan), true) +
              td(actions) +
              '</tr>';
          });
          html += '</tbody></table>';
          listEl.innerHTML = html;

        } catch (e) { window.modErr(listEl, e); }
      }

      // ── план/факт для вибраного бюджету ──────────────────────
      window._bgtPlanFact = async function(budgetId) {
        pf.innerHTML = window.modEmpty('Завантаження план/факт…');
        consEl.innerHTML = '';
        try {
          var today = new Date();
          var month = today.getUTCFullYear() + '-' + String(today.getUTCMonth() + 1).padStart(2, '0') + '-01';
          var data = await window.modApi('/api/budgets/' + budgetId + '/plan-fact?month=' + month);
          var cats = (data && data.categories) || [];
          var html = '<h3 style="font-size:15px;font-weight:600;margin:0 0 10px">План/Факт — ' +
            window.modEsc((data.month || '').slice(0, 7)) + '</h3>';

          // Перемикач доходи/витрати
          html += '<div style="margin-bottom:10px">' +
            '<button id="bgt-pf-all" onclick="window._bgtFilterPF(\'all\')" style="padding:4px 12px;margin-right:4px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#1a73e8;color:#fff;font-size:12px">Усе</button>' +
            '<button id="bgt-pf-rev" onclick="window._bgtFilterPF(\'revenue\')" style="padding:4px 12px;margin-right:4px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;font-size:12px">Доходи</button>' +
            '<button id="bgt-pf-exp" onclick="window._bgtFilterPF(\'expense\')" style="padding:4px 12px;border:1px solid #ddd;border-radius:4px;cursor:pointer;background:#fff;font-size:12px">Витрати</button>' +
          '</div>';

          html += '<div id="bgt-pf-table">';
          html += tableOpen() + '<thead><tr>' +
            th('Категорія') + th('Тип') + th('План', true) + th('Факт', true) +
            th('Відхилення', true) + th('%', true) + th('Прогноз EOM', true) + th('Статус') +
            '</tr></thead><tbody>';

          cats.forEach(function(c) {
            var cat = c.category || {};
            var pctColor = c.status === 'green' ? '#2e9e5b' : (c.status === 'yellow' ? '#e0a800' : '#d9534f');
            var rowBg = c.status === 'green' ? '' : (c.status === 'yellow' ? 'background:#fffde7' : 'background:#fdf0f0');
            var devStyle = 'color:' + (c.deviation_abs >= 0 ? '#2e9e5b' : '#d9534f');
            html += '<tr style="' + rowBg + '" data-type="' + window.modEsc(cat.type || '') + '">' +
              td('<b>' + window.modEsc(cat.name || '') + '</b>') +
              td(window.modEsc(cat.type === 'revenue' ? 'Дохід' : 'Витрата')) +
              td(fmtMoney(c.plan), true) +
              td(fmtMoney(c.actual), true) +
              td('<span style="' + devStyle + '">' + fmtMoney(c.deviation_abs) + '</span>', true) +
              td('<span style="color:' + pctColor + ';font-weight:600">' + fmtPct(c.percent) + '</span>', true) +
              td(fmtMoney(c.forecast_eom), true) +
              td('<span style="color:' + pctColor + ';font-size:16px">' +
                (c.status === 'green' ? '●' : (c.status === 'yellow' ? '●' : '●')) + '</span>') +
              '</tr>';
          });
          html += '</tbody></table></div>';
          pf.innerHTML = html;

          window._bgtFilterPF = function(type) {
            var rows = document.querySelectorAll('#bgt-pf-table tr[data-type]');
            rows.forEach(function(r) {
              r.style.display = (type === 'all' || r.dataset.type === type) ? '' : 'none';
            });
          };

        } catch (e) { window.modErr(pf, e); }
      };

      // ── дії воркфлоу ─────────────────────────────────────────
      window._bgtAction = async function(id, action) {
        try {
          await window.modApi('/api/budgets/' + id + '/' + action, { method: 'POST' });
          await loadList();
        } catch (e) { alert('Помилка: ' + (e.message || e)); }
      };

      // ── зведений звіт ────────────────────────────────────────
      document.getElementById('bgt-consolidated-btn').addEventListener('click', async function() {
        pf.innerHTML = '';
        consEl.innerHTML = window.modEmpty('Завантаження…');
        try {
          var data = await window.modApi('/api/budgets/consolidated');
          var cats = (data && data.categories) || [];
          var tot  = (data && data.totals) || {};
          var html = '<h3 style="font-size:15px;font-weight:600;margin:0 0 10px">Зведений звіт — ' +
            window.modEsc((data.month || '').slice(0, 7)) +
            ' <span style="font-size:12px;color:#888;font-weight:400">(' + (data.budgets_count || 0) + ' бюджетів)</span></h3>';

          html += cardsRow(
            window.modCard('Дохід план',    fmtMoney((tot.revenue || {}).plan),    '#1a73e8') +
            window.modCard('Дохід факт',    fmtMoney((tot.revenue || {}).actual),  '#2e9e5b') +
            window.modCard('Дохід %',       fmtPct((tot.revenue  || {}).percent),  '#7b5cd6') +
            window.modCard('Витрати план',  fmtMoney((tot.expense || {}).plan),    '#e67e22') +
            window.modCard('Витрати факт',  fmtMoney((tot.expense || {}).actual),  '#d9534f') +
            window.modCard('Профіцит план', fmtMoney(tot.profit_plan),             tot.profit_plan >= 0 ? '#2e9e5b' : '#d9534f')
          );

          html += tableOpen() + '<thead><tr>' +
            th('Категорія') + th('Тип') + th('План', true) + th('Факт', true) + th('Відхилення %', true) +
            '</tr></thead><tbody>';
          cats.forEach(function(c) {
            var cat = c.category || {};
            var devColor = c.deviation_percent >= 0 ? '#2e9e5b' : '#d9534f';
            html += '<tr>' +
              td(window.modEsc(cat.name || '')) +
              td(window.modEsc(cat.type === 'revenue' ? 'Дохід' : 'Витрата')) +
              td(fmtMoney(c.plan), true) +
              td(fmtMoney(c.actual), true) +
              td('<span style="color:' + devColor + '">' + fmtPct(c.deviation_percent) + '</span>', true) +
              '</tr>';
          });
          html += '</tbody></table>';
          consEl.innerHTML = html;
        } catch (e) { window.modErr(consEl, e); }
      });

      document.getElementById('bgt-load-btn').addEventListener('click', loadList);
      loadList();
    }
  });

})();
