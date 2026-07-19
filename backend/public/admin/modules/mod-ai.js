/* ═══ UI-модуль: AI-центр (одна сторінка групи "Аналітика та AI") ═══════════
 * Об'єднує колишні 3 сторінки (aisales / aiquality / aireco) у вкладки,
 * щоб не плодити пункти меню. Дані тягне з:
 *   /api/ai/sales/analytics            + /api/ai/sales/winback/candidates
 *   /api/ai/quality/dashboard          + /api/ai/quality/scores
 *   /api/ai/recommendations/analytics  + /api/ai/recommendations/popular
 * Захисний рендер: відсутнє поле → '—', порожній масив → modEmpty(...).
 * Кожен loader у try/catch з modErr. Вкладки вантажаться ліниво (раз). */
(function () {
  var esc = window.modEsc, empty = window.modEmpty, errEl = window.modErr, card = window.modCard;

  function val(x) { return (x == null || x === '') ? '—' : x; }
  function money(x) {
    if (x == null || isNaN(Number(x))) return '—';
    return Math.round(Number(x)).toLocaleString('uk-UA') + ' грн';
  }
  function ratePct(x) {
    if (x == null || isNaN(Number(x))) return '—';
    return Math.round(Number(x) * 1000) / 10 + '%';
  }
  function num(x) { return (x == null || isNaN(Number(x))) ? '—' : Number(x); }
  function dateShort(x) {
    if (!x) return '—';
    try { return new Date(x).toLocaleDateString('uk-UA'); } catch (e) { return esc(x); }
  }

  var TBL = 'width:100%;border-collapse:collapse';
  var TH = 'padding:11px 14px;text-align:left;border-bottom:2px solid #eee;font-size:12px;color:#888;font-weight:600';
  var TD = 'padding:11px 14px;border-bottom:1px solid #f2f2f2;font-size:13px';

  function table(headers, rowsHtml) {
    var head = headers.map(function (h) { return '<th style="' + TH + '">' + esc(h) + '</th>'; }).join('');
    return '<table style="' + TBL + '"><thead><tr>' + head + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
  }

  /* ── вкладка 1: AI Продажі ── */
  async function loadSales() {
    var cards = document.getElementById('aisales-cards');
    var wb = document.getElementById('aisales-winback');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (wb) wb.innerHTML = empty('Завантаження…');
    try {
      // ФАКТ-ФІКС 17.07: раніше картки читали offers_funnel/cross_sell_opportunity,
      // яких API НЕ повертає → всюди «—». Тепер — реальні поля з /sales/analytics.
      var data = await window.modApi('/api/ai/sales/analytics');
      var o = (data && data.overall) || {};
      if (cards) cards.innerHTML =
        card('Візитів за ' + ((data && data.window_days) || 180) + ' дн.', num(o.visits), '#1a73e8') +
        card('Середній чек', money(o.avg_check), '#188038') +
        card('Мультипослуги в чеку', o.multi_service_pct == null ? '—' : o.multi_service_pct + '%', '#9334e6') +
        card('Виручка', money(o.revenue), '#e37400');
      var bm = document.getElementById('aisales-bymaster');
      var masters = (data && data.by_master) || [];
      if (bm) bm.innerHTML = masters.length ? table(
        ['Майстер', 'Візитів', 'Середній чек', 'Мультипослуги'],
        masters.map(function (m) {
          return '<tr><td style="' + TD + '">' + esc(val(m.name)) + '</td>' +
            '<td style="' + TD + '">' + num(m.visits) + '</td>' +
            '<td style="' + TD + '">' + money(m.avg_check) + '</td>' +
            '<td style="' + TD + '">' + (m.multi_service_pct == null ? '—' : m.multi_service_pct + '%') + '</td></tr>';
        }).join('')) : empty('Немає даних по майстрах');

      var cand = await window.modApi('/api/ai/sales/winback/candidates');
      var list = (cand && cand.candidates) || [];
      if (!list.length) { if (wb) wb.innerHTML = empty('Кандидатів на повернення немає'); return; }
      var rows = list.map(function (c) {
        return '<tr>' +
          '<td style="' + TD + '">' + esc(val(c.name)) + '</td>' +
          '<td style="' + TD + '">' + esc(val(c.channel)) + '</td>' +
          '<td style="' + TD + '">' + num(c.days_since) + '</td>' +
          '<td style="' + TD + '">' + num(c.visits) + '</td>' +
          '<td style="' + TD + '">' + num(c.avg_interval_days) + '</td>' +
          '<td style="' + TD + '">' + dateShort(c.last_visit) + '</td>' +
        '</tr>';
      }).join('');
      if (wb) wb.innerHTML = table(
        ['Клієнт', 'Канал', 'Днів без візиту', 'Візитів', 'Середній інтервал (дн.)', 'Останній візит'], rows);
    } catch (e) { errEl(cards, e); if (wb) wb.innerHTML = ''; }
  }

  /* ── вкладка 2: AI Контроль якості ── */
  async function loadQuality() {
    var cards = document.getElementById('aiquality-cards');
    var sc = document.getElementById('aiquality-scores');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (sc) sc.innerHTML = empty('Завантаження…');
    try {
      var d = await window.modApi('/api/ai/quality/dashboard') || {};
      // ФАКТ-ФІКС 17.07: NPS/CSAT/sentiment без опитувань завжди null → картки-пустишки.
      // Показуємо їх лише коли Є дані, а базово — реальні операційні метрики.
      var qc = card('Оцінка салону', d.branch_score == null ? '—' : d.branch_score, '#1a73e8') +
        card('Повторні візити', d.repeat_visit_rate == null ? '—' : d.repeat_visit_rate + '%', '#188038') +
        card('Скасування', d.cancel_rate == null ? '—' : d.cancel_rate + '%', '#e37400') +
        card('Неявки', d.no_show_rate == null ? '—' : d.no_show_rate + '%', '#9334e6');
      if (d.nps != null) qc += card('NPS', num(d.nps), '#188038');
      if (d.csat != null) qc += card('CSAT', num(d.csat), '#9334e6');
      if (Number(d.active_alerts_count)) qc += card('Активні алерти', num(d.active_alerts_count), '#d93025');
      if (Number(d.critical_alerts_count)) qc += card('Критичні алерти', num(d.critical_alerts_count), '#d93025');
      if (cards) cards.innerHTML = qc;

      var res = await window.modApi('/api/ai/quality/scores');
      var items = (res && res.items) || [];
      if (!items.length) { if (sc) sc.innerHTML = empty('Дані скорингу відсутні'); return; }
      var rows = items.map(function (i) {
        var trend = i.trend_delta != null ? i.trend_delta : i.trend;
        return '<tr>' +
          '<td style="' + TD + '">' + esc(val(i.entity_name != null ? i.entity_name : i.entity_id)) + '</td>' +
          '<td style="' + TD + '">' + esc(val(i.entity_type)) + '</td>' +
          '<td style="' + TD + ';font-weight:700">' + num(i.overall_score) + '</td>' +
          '<td style="' + TD + '">' + esc(val(trend)) + '</td>' +
        '</tr>';
      }).join('');
      if (sc) sc.innerHTML = table(['Сутність', 'Тип', 'Оцінка', 'Тренд'], rows);
    } catch (e) { errEl(cards, e); if (sc) sc.innerHTML = ''; }
  }

  /* ── вкладка 3: AI Рекомендації ── */
  async function loadReco() {
    var cards = document.getElementById('aireco-cards');
    var pop = document.getElementById('aireco-popular');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (pop) pop.innerHTML = empty('Завантаження…');
    try {
      var a = await window.modApi('/api/ai/recommendations/analytics') || {};
      // ФАКТ-ФІКС 17.07: без показів рекомендацій картки з нулями виглядали як «чушь» —
      // пояснюємо чесно, коли модуль ще не почав збирати дані.
      if (!Number(a.total_impressions)) {
        if (cards) cards.innerHTML = '<div class="card" style="padding:14px 16px;font-size:13px;color:#555;line-height:1.55">🤖 Модуль рекомендацій ще не показував підказки клієнтам — метрики (покази, кліки, конверсія) почнуть накопичуватись, щойно бот або каса запропонують супутні послуги. Нижче — реальний топ послуг за записами.</div>';
      } else if (cards) cards.innerHTML =
        card('Покази', num(a.total_impressions), '#1a73e8') +
        card('CTR', ratePct(a.ctr), '#188038') +
        card('Конверсія', ratePct(a.conversion_rate), '#9334e6') +
        card('Дод. виручка', money(a.incremental_revenue), '#e37400') +
        card('Покриття каталогу', a.coverage == null ? '—' : Math.round(Number(a.coverage) * 100) + '%', '#1a73e8');

      var res = await window.modApi('/api/ai/recommendations/popular');
      var items = (res && res.items) || [];
      if (!items.length) { if (pop) pop.innerHTML = empty('Популярних послуг поки немає'); return; }
      var rows = items.map(function (i) {
        return '<tr>' +
          '<td style="' + TD + '">' + esc(val(i.item_name)) + '</td>' +
          '<td style="' + TD + '">' + esc(val(i.category)) + '</td>' +
          '<td style="' + TD + '">' + money(i.price) + '</td>' +
          '<td style="' + TD + '">' + num(i.bookings_count) + '</td>' +
          '<td style="' + TD + '">' + num(i.popularity_score) + '</td>' +
        '</tr>';
      }).join('');
      if (pop) pop.innerHTML = table(['Послуга', 'Категорія', 'Ціна', 'Записів', 'Популярність'], rows);
    } catch (e) { errEl(cards, e); if (pop) pop.innerHTML = ''; }
  }

  /* ── вкладка 4: Прогностика (AI-04) — churn, прогноз виручки, аномалії, інсайти ── */
  async function loadForecast() {
    var cards = document.getElementById('aian-cards');
    var churn = document.getElementById('aian-churn');
    var ins = document.getElementById('aian-insights');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (churn) churn.innerHTML = empty('Завантаження…');
    if (ins) ins.innerHTML = empty('Завантаження…');
    try {
      var s = await window.modApi('/api/ai/analytics/summary') || {};
      var ch = s.churn || {};
      if (cards) cards.innerHTML =
        card('Ризик відтоку: високий', num(ch.high_risk), '#d93025') +
        card('Ризик відтоку: середній', num(ch.medium_risk), '#e37400') +
        card('Прогноз виручки 30 дн.', money(s.revenue_30d), '#188038') +
        card('Відкриті аномалії', num(s.open_anomalies), '#9334e6');

      var c = await window.modApi('/api/ai/analytics/predictions/churn?limit=15');
      var list = (c && c.items) || [];
      if (churn) {
        if (!list.length) churn.innerHTML = empty('Клієнтів із ризиком відтоку не виявлено');
        else churn.innerHTML = table(['Клієнт', 'Ризик', 'Звичний ритм (дн.)', 'Днів без візиту'],
          list.map(function (x) {
            return '<tr>' +
              '<td style="' + TD + '">' + esc(val(x.name != null ? x.name : ('#' + x.client_id))) + '</td>' +
              '<td style="' + TD + ';font-weight:700">' + esc(val(x.risk)) + '</td>' +
              '<td style="' + TD + '">' + num(x.cadence_days) + '</td>' +
              '<td style="' + TD + '">' + num(x.days_since) + '</td>' +
            '</tr>';
          }).join(''));
      }

      var iv = await window.modApi('/api/ai/analytics/insights');
      var items = (iv && (iv.items || iv.insights)) || (Array.isArray(iv) ? iv : []);
      if (ins) {
        if (!items.length) ins.innerHTML = empty('Інсайтів поки немає — натисніть «Сканувати»');
        else ins.innerHTML = items.map(function (x) {
          var sev = String(x.severity || '').toLowerCase();
          var col = sev === 'critical' || sev === 'high' ? '#d93025' : sev === 'medium' ? '#e37400' : '#1a73e8';
          return '<div style="border-left:4px solid ' + col + ';background:#fff;border-radius:8px;padding:10px 14px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.06)">' +
            '<div style="font-weight:700;font-size:13.5px">' + esc(val(x.title)) + '</div>' +
            (x.action ? '<div style="font-size:12.5px;color:#555;margin-top:4px">' + esc(x.action) + '</div>' : '') +
          '</div>';
        }).join('');
      }
    } catch (e) { errEl(cards, e); if (churn) churn.innerHTML = ''; if (ins) ins.innerHTML = ''; }
  }
  window._aicScanAnalytics = async function () {
    var btn = document.getElementById('aian-scan');
    if (btn) { btn.disabled = true; btn.textContent = 'Сканую…'; }
    try {
      await window.modApi('/api/ai/analytics/anomalies/scan', { method: 'POST', body: JSON.stringify({ days: 30 }) });
      await window.modApi('/api/ai/analytics/insights/scan', { method: 'POST', body: JSON.stringify({}) });
      loadForecast();
    } catch (e) { alert('Сканування не вдалось: ' + (e && e.message || e)); }
    if (btn) { btn.disabled = false; btn.textContent = 'Сканувати аномалії та інсайти'; }
  };
  window._aicAsk = async function () {
    var inp = document.getElementById('aian-q'), out = document.getElementById('aian-answer');
    var q = inp && inp.value.trim();
    if (!q) return;
    if (out) out.innerHTML = empty('Думаю…');
    try {
      var r = await window.modApi('/api/ai/analytics/ask', { method: 'POST', body: JSON.stringify({ question: q }) });
      if (out) out.innerHTML = '<div class="card" style="padding:14px;font-size:13.5px;line-height:1.6">' + esc(val(r && r.answer)) + '</div>';
    } catch (e) { if (out) out.innerHTML = empty('Не вдалось відповісти: ' + (e && e.message || e)); }
  };

  /* ── вкладка 5: AI-ресепшен (AI-01) — діалоги, інтенти, handoff ── */
  async function loadReception() {
    var cards = document.getElementById('airec-cards');
    var conv = document.getElementById('airec-conv');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (conv) conv.innerHTML = empty('Завантаження…');
    try {
      var a = await window.modApi('/api/ai/receptionist/analytics') || {};
      var cfg = await window.modApi('/api/ai/receptionist/config').catch(function () { return null; });
      var llm = cfg && cfg.llm_available;
      if (cards) cards.innerHTML =
        card('Діалогів', num(a.total_conversations), '#1a73e8') +
        card('Закрито AI', a.ai_handled_percent == null ? '—' : Math.round(Number(a.ai_handled_percent)) + '%', '#188038') +
        card('Передано людині', num(a.handoff_count != null ? a.handoff_count : a.handoffs), '#e37400') +
        card('LLM', llm == null ? '—' : (llm ? 'підключено' : 'вимкнено'), llm ? '#188038' : '#d93025');

      var r = await window.modApi('/api/ai/receptionist/conversations?limit=15');
      var list = (r && r.conversations) || [];
      if (conv) {
        if (!list.length) conv.innerHTML = empty('Діалогів поки немає. Ресепшен вмикається підключенням каналу (бот/віджет).');
        else conv.innerHTML = table(['#', 'Канал', 'Статус', 'Повідомлень', 'Останнє'],
          list.map(function (x) {
            return '<tr>' +
              '<td style="' + TD + '">' + num(x.id) + '</td>' +
              '<td style="' + TD + '">' + esc(val(x.channel)) + '</td>' +
              '<td style="' + TD + '">' + esc(val(x.status)) + '</td>' +
              '<td style="' + TD + '">' + num(x.messages_count) + '</td>' +
              '<td style="' + TD + ';max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(val(x.last_message)) + '</td>' +
            '</tr>';
          }).join(''));
      }
    } catch (e) { errEl(cards, e); if (conv) conv.innerHTML = ''; }
  }

  /* ── вкладка 6: Відео-студія (VID-01) — готовність рушія + бібліотека роликів ── */
  async function loadVideo() {
    var cards = document.getElementById('aivid-cards');
    var lib = document.getElementById('aivid-lib');
    if (cards) cards.innerHTML = empty('Завантаження…');
    if (lib) lib.innerHTML = empty('Завантаження…');
    try {
      var r = await window.modApi('/api/ai/video/readiness').catch(function () { return null; });
      // readiness повертає storyboard/frames/video (можливості) + paid_key_configured.
      // Поля .version немає — раніше через це показувало «недоступний» хоч рушій працює (Босс 19.07).
      var montageOk = !!(r && (r.video || r.frames || r.storyboard));
      var paidKey = !!(r && r.paid_key_configured);
      if (cards) cards.innerHTML =
        card('Сценарій + підписи', r && r.storyboard ? 'працює' : '—', r && r.storyboard ? '#188038' : '#d93025') +
        card('Рушій монтажу', montageOk ? 'готовий' : 'недоступний', montageOk ? '#188038' : '#d93025') +
        card('Відео-рендер (Google AI)', paidKey ? 'підключено' : 'потрібен платний ключ', paidKey ? '#188038' : '#9334e6');

      var l = await window.modApi('/api/ai/video/library');
      var items = (l && l.items) || [];
      if (lib) {
        if (!items.length) lib.innerHTML = empty('Бібліотека порожня. Ролики зʼявляться тут після генерації (storyboard → кадри → монтаж).');
        else lib.innerHTML = table(['Назва', 'Тривалість', 'Створено'],
          items.map(function (x) {
            return '<tr>' +
              '<td style="' + TD + '">' + esc(val(x.title)) + '</td>' +
              '<td style="' + TD + '">' + (x.duration_sec != null ? x.duration_sec + ' с' : '—') + '</td>' +
              '<td style="' + TD + '">' + dateShort(x.created_at) + '</td>' +
            '</tr>';
          }).join(''));
      }
    } catch (e) { errEl(cards, e); if (lib) lib.innerHTML = ''; }
  }

  var TABS = [
    { key: 'sales',   label: 'Продажі та повернення', icon: 'sell',      load: loadSales,
      hint: 'Допродажі, крос-сел і win-back: конверсія пропозицій, додаткова виручка, кандидати на повернення.' },
    { key: 'quality', label: 'Контроль якості',       icon: 'verified',  load: loadQuality,
      hint: 'Оцінка салону і майстрів: NPS, CSAT, сентимент відгуків, алерти якості.' },
    { key: 'reco',    label: 'Рекомендації',          icon: 'recommend', load: loadReco,
      hint: 'Підказки супутніх послуг клієнтам: покази, кліки, конверсія, додаткова виручка. Метрики накопичуються по мірі показів.' },
    { key: 'forecast', label: 'Прогностика',          icon: 'insights',  load: loadForecast,
      hint: 'Прогнози AI: хто з клієнтів на межі відтоку, очікувана виручка, аномалії в метриках та інсайти. Можна поставити питання своїми словами.' },
    { key: 'reception', label: 'AI-ресепшен',         icon: 'support_agent', load: loadReception,
      hint: 'Авто-відповіді клієнтам: скільки діалогів закрив AI, скільки передав адміністратору.' },
    { key: 'video',   label: 'Відео-студія',          icon: 'movie',     load: loadVideo,
      hint: 'Генерація промо-роликів для соцмереж: сценарій → кадри → монтаж. Тут — готовність рушія та бібліотека готових відео.' }
  ];
  var loaded = {};

  function tabBtnStyle(active) {
    return 'display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13.5px;border:1px solid ' +
      (active ? '#1a73e8;background:#1a73e8;color:#fff;font-weight:600' : '#ddd;background:#fff;color:#444');
  }

  function switchTab(key, force) {
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      var pane = document.getElementById('aic-pane-' + t.key);
      var btn = document.getElementById('aic-tab-' + t.key);
      var on = t.key === key;
      if (pane) pane.style.display = on ? 'block' : 'none';
      if (btn) btn.setAttribute('style', tabBtnStyle(on));
      if (on && (!loaded[t.key] || force)) { loaded[t.key] = true; t.load(); }
    }
  }
  window._aicTab = switchTab;

  window.registerModule({
    page: 'aicenter',
    title: 'AI-центр',
    group: 'analytics',
    icon: 'auto_awesome',
    section:
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
      TABS.map(function (t) {
        return '<button id="aic-tab-' + t.key + '" onclick="_aicTab(\'' + t.key + '\')" style="' + tabBtnStyle(t.key === 'sales') + '">' +
          '<span class="material-icons-round" style="font-size:17px">' + t.icon + '</span>' + esc(t.label) + '</button>';
      }).join('') +
      '</div>' +
      TABS.map(function (t) {
        var CARDS = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px';
        var H3 = 'margin:8px 0 10px;font-size:15px;font-weight:700';
        var BOX = 'padding:0;overflow:auto';
        var PANES = {
          sales:
            '<div id="aisales-cards" style="' + CARDS + '"></div>' +
            '<h3 style="' + H3 + '">По майстрах</h3>' +
            '<div id="aisales-bymaster" class="card" style="' + BOX + ';margin-bottom:18px"></div>' +
            '<h3 style="' + H3 + '">Кандидати на повернення (win-back)</h3>' +
            '<div id="aisales-winback" class="card" style="' + BOX + '"></div>',
          quality:
            '<div id="aiquality-cards" style="' + CARDS + '"></div>' +
            '<h3 style="' + H3 + '">Скоринг якості</h3>' +
            '<div id="aiquality-scores" class="card" style="' + BOX + '"></div>',
          reco:
            '<div id="aireco-cards" style="' + CARDS + '"></div>' +
            '<h3 style="' + H3 + '">Популярні послуги</h3>' +
            '<div id="aireco-popular" class="card" style="' + BOX + '"></div>',
          forecast:
            '<div id="aian-cards" style="' + CARDS + '"></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">' +
              '<button id="aian-scan" onclick="_aicScanAnalytics()" style="' /* tabBtnStyle нижче недоступний тут */ + 'padding:8px 16px;border-radius:8px;border:1px solid #1a73e8;background:#fff;color:#1a73e8;cursor:pointer;font-size:13px">Сканувати аномалії та інсайти</button>' +
              '<input id="aian-q" placeholder="Питання до AI: наприклад, чому впала виручка минулого тижня?" style="flex:1;min-width:260px;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px" onkeydown="if(event.key===\'Enter\')_aicAsk()">' +
              '<button onclick="_aicAsk()" style="padding:8px 16px;border-radius:8px;border:1px solid #1a73e8;background:#1a73e8;color:#fff;cursor:pointer;font-size:13px">Запитати</button>' +
            '</div>' +
            '<div id="aian-answer" style="margin-bottom:14px"></div>' +
            '<h3 style="' + H3 + '">Клієнти з ризиком відтоку</h3>' +
            '<div id="aian-churn" class="card" style="' + BOX + ';margin-bottom:18px"></div>' +
            '<h3 style="' + H3 + '">Інсайти</h3>' +
            '<div id="aian-insights"></div>',
          reception:
            '<div id="airec-cards" style="' + CARDS + '"></div>' +
            '<h3 style="' + H3 + '">Останні діалоги</h3>' +
            '<div id="airec-conv" class="card" style="' + BOX + '"></div>',
          video:
            '<div id="aivid-cards" style="' + CARDS + '"></div>' +
            '<div style="margin:14px 0"><button onclick="if(window.parent&&window.parent.openEmbed){window.parent.openEmbed(\'/admin/video-studio.html\',\'movie AI Відеостудія\')}else{location.href=\'/admin/video-studio.html\'}" style="display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border:none;border-radius:10px;background:#7c5cff;color:#fff;font-size:14px;font-weight:600;cursor:pointer"><span class="material-icons-round" style="font-size:18px">movie</span> Відкрити повну студію (створити ролик)</button></div>' +
            '<h3 style="' + H3 + '">Бібліотека роликів</h3>' +
            '<div id="aivid-lib" class="card" style="' + BOX + '"></div>'
        };
        return '<div id="aic-pane-' + t.key + '" style="display:none">' +
          '<div style="background:#f0f4ff;border:1px solid #d8e0ff;border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.55;color:#33415c">' + esc(t.hint) + '</div>' +
          (PANES[t.key] || '') +
          '</div>';
      }).join(''),
    loader: async function () {
      loaded = {};
      switchTab('sales', true);
    }
  });
})();
