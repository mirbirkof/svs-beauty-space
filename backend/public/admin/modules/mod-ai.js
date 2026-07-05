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
      var data = await window.modApi('/api/ai/sales/analytics');
      var f = (data && data.offers_funnel) || {};
      var op = (data && data.cross_sell_opportunity) || {};
      if (cards) cards.innerHTML =
        card('Конверсія пропозицій', ratePct(f.conversion_rate), '#1a73e8') +
        card('Додаткова виручка', money(f.additional_revenue), '#188038') +
        card('ROI', f.roi == null ? '—' : (Number(f.roi) * 100).toFixed(0) + '%', '#9334e6') +
        card('Потенціал крос-селу', money(op.potential_revenue), '#e37400');

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
      if (cards) cards.innerHTML =
        card('Оцінка салону', d.branch_score == null ? '—' : d.branch_score, '#1a73e8') +
        card('NPS', num(d.nps), '#188038') +
        card('CSAT', num(d.csat), '#9334e6') +
        card('Sentiment', d.sentiment_avg == null ? '—' : d.sentiment_avg, '#e37400') +
        card('Активні алерти', num(d.active_alerts_count), '#d93025') +
        card('Критичні алерти', num(d.critical_alerts_count), '#d93025');

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
      if (cards) cards.innerHTML =
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

  var TABS = [
    { key: 'sales',   label: 'Продажі та повернення', icon: 'sell',      load: loadSales,
      hint: 'Допродажі, крос-сел і win-back: конверсія пропозицій, додаткова виручка, кандидати на повернення.' },
    { key: 'quality', label: 'Контроль якості',       icon: 'verified',  load: loadQuality,
      hint: 'Оцінка салону і майстрів: NPS, CSAT, сентимент відгуків, алерти якості.' },
    { key: 'reco',    label: 'Рекомендації',          icon: 'recommend', load: loadReco,
      hint: 'Підказки супутніх послуг клієнтам: покази, кліки, конверсія, додаткова виручка. Метрики накопичуються по мірі показів.' }
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
        return '<div id="aic-pane-' + t.key + '" style="display:none">' +
          '<div style="background:#f0f4ff;border:1px solid #d8e0ff;border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.55;color:#33415c">' + esc(t.hint) + '</div>' +
          (t.key === 'sales'
            ? '<div id="aisales-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px"></div>' +
              '<h3 style="margin:8px 0 10px;font-size:15px;font-weight:700">Кандидати на повернення (win-back)</h3>' +
              '<div id="aisales-winback" class="card" style="padding:0;overflow:auto"></div>'
            : t.key === 'quality'
            ? '<div id="aiquality-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px"></div>' +
              '<h3 style="margin:8px 0 10px;font-size:15px;font-weight:700">Скоринг якості</h3>' +
              '<div id="aiquality-scores" class="card" style="padding:0;overflow:auto"></div>'
            : '<div id="aireco-cards" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px"></div>' +
              '<h3 style="margin:8px 0 10px;font-size:15px;font-weight:700">Популярні послуги</h3>' +
              '<div id="aireco-popular" class="card" style="padding:0;overflow:auto"></div>') +
          '</div>';
      }).join(''),
    loader: async function () {
      loaded = {};
      switchTab('sales', true);
    }
  });
})();
