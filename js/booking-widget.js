/* ═══════════════════════════════════════════════════════
   SVS Booking Widget — 4 кроки: послуга → майстер → дата → час
   Дані з BeautyPro CRM. Підтвердження через Telegram-бот.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = window.SVS_BOOKING_API || 'https://3fa4d9f6a16609.lhr.life';
  const FALLBACK_TUNNEL_FILE = '/tunnel-url.txt'; // якщо туннель оновився

  const html = `
    <div id="svs-book-modal" class="svs-book-modal" hidden>
      <div class="svs-book-backdrop" data-close></div>
      <div class="svs-book-dialog" role="dialog" aria-modal="true">
        <button class="svs-book-close" data-close aria-label="Закрити">×</button>

        <!-- step indicator -->
        <div class="svs-book-steps">
          <span data-pin="service" class="active">1. Послуга</span>
          <span data-pin="date">2. Дата</span>
          <span data-pin="time">3. Час</span>
          <span data-pin="master">4. Майстер</span>
        </div>

        <!-- Step 1: service -->
        <div class="svs-book-step" data-step="service">
          <h3>Оберіть послугу</h3>
          <div class="svs-book-search">
            <input type="text" id="svs-search" placeholder="Пошук послуги…">
          </div>
          <div id="svs-services" class="svs-book-list">
            <div class="svs-book-loading">Завантаження…</div>
          </div>
        </div>

        <!-- Step 2: master -->
        <div class="svs-book-step" data-step="master" hidden>
          <button class="svs-book-back" data-goto="service">← Послуга</button>
          <h3>Оберіть майстра</h3>
          <p class="svs-book-sub" id="svs-svc-summary"></p>
          <div id="svs-masters" class="svs-book-list">
            <div class="svs-book-loading">Завантаження…</div>
          </div>
        </div>

        <!-- Step 3: date (calendar grid with availability) -->
        <div class="svs-book-step" data-step="date" hidden>
          <button class="svs-book-back" data-goto="master">← Майстер</button>
          <h3>Оберіть дату</h3>
          <p class="svs-book-sub" id="svs-mst-summary"></p>
          <div id="svs-calendar" class="svs-book-calendar">
            <div class="svs-book-loading">Шукаю вільні дні…</div>
          </div>
          <p class="svs-book-hint">Сірі дні — повністю зайняті</p>
        </div>

        <!-- Step 4: time -->
        <div class="svs-book-step" data-step="time" hidden>
          <button class="svs-book-back" data-goto="date">← Дата</button>
          <h3>Вільний час</h3>
          <p class="svs-book-sub" id="svs-date-summary"></p>
          <div id="svs-slots" class="svs-book-slots">
            <div class="svs-book-loading">Завантаження…</div>
          </div>
          <div class="svs-book-name-block">
            <label>Ваше імʼя
              <input type="text" id="svs-name" placeholder="Як до вас звертатись?">
            </label>
            <label>Телефон
              <input type="tel" id="svs-phone" placeholder="+380XXXXXXXXX" autocomplete="tel">
            </label>
            <button class="svs-book-submit" data-action="confirm" disabled>Записатись</button>
            <p class="svs-book-hint">Натискаючи кнопку, ви погоджуєтесь на запис у CRM салону</p>
          </div>
        </div>

        <!-- waiting -->
        <div class="svs-book-step" data-step="wait" hidden>
          <h3>Очікуємо підтвердження…</h3>
          <div class="svs-book-spinner"></div>
          <p>У боті натисніть <b>«📱 Поділитись номером»</b>. Сторінка оновиться автоматично.</p>
          <a class="svs-book-tg-link" id="svs-link" target="_blank" rel="noopener">Відкрити бота повторно</a>
        </div>
        <div class="svs-book-step" data-step="done" hidden>
          <h3>✓ Запис підтверджено</h3>
          <p id="svs-done-summary"></p>
          <p>Чекаємо вас у салоні!</p>
          <button class="svs-book-submit" data-close>Закрити</button>
        </div>
        <div class="svs-book-step" data-step="error" hidden>
          <h3>Не вдалось зберегти</h3>
          <p id="svs-err">Спробуйте ще раз або зателефонуйте: <a href="tel:+380991283375">+380 99 128 33 75</a></p>
          <button class="svs-book-submit" data-action="reset">Спробувати знову</button>
        </div>
      </div>
    </div>`;

  let root, pollTimer, currentToken;
  const state = {
    services: [],
    masters: [],
    service: null,
    master: null,
    date: null,
    slot: null,
    name: '',
  };

  const $ = (s, r) => (r || root).querySelector(s);
  const $$ = (s, r) => Array.from((r || root).querySelectorAll(s));

  function show(step) {
    $$('.svs-book-step').forEach(el => el.hidden = el.dataset.step !== step);
    $$('.svs-book-steps span').forEach(s => {
      const map = { service: 0, date: 1, time: 2, master: 3 };
      const cur = map[step];
      const my = map[s.dataset.pin];
      s.classList.toggle('active', my === cur);
      s.classList.toggle('done', my != null && cur != null && my < cur);
    });
  }

  function open() {
    if (!root) mount();
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    // Скидаємо стан попередньої сесії запису
    _submitting = false;
    state.service = state.master = state.date = state.slot = null;
    const btn = $('button[data-action="confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Записатись'; }
    show('service');
    loadServices();
  }
  function close() {
    if (!root) return;
    root.hidden = true;
    document.body.style.overflow = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentToken = null;
  }

  async function api(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── Step 1: services ───────────────────────────────────
  async function loadServices() {
    try {
      const list = await api('/api/booking/services');
      state.services = Array.isArray(list) ? list : [];
      renderServices('');
    } catch (e) {
      $('#svs-services').innerHTML = `<div class="svs-book-err">Не вдалося завантажити: ${e.message}</div>`;
    }
  }
  function renderServices(filter) {
    const f = (filter || '').toLowerCase();
    const items = state.services.filter(s => !f || s.name.toLowerCase().includes(f));
    if (!items.length) { $('#svs-services').innerHTML = '<div class="svs-book-empty">Нічого не знайдено</div>'; return; }

    const renderCard = s => {
      const price = s.price ? Object.values(s.price)[0] : null;
      return `<button class="svs-book-card" data-svc="${s.id}">
        <div class="svs-book-card-title">${s.name}</div>
        <div class="svs-book-card-meta">${s.duration || '?'} хв${price ? ' · ' + price + ' грн' : ''}</div>
      </button>`;
    };

    // Якщо йде пошук — плоский список (до 50)
    if (f) {
      $('#svs-services').innerHTML = items.slice(0, 50).map(renderCard).join('');
      return;
    }

    // Без пошуку — 3 фіксовані категорії
    // Розподіл по ключових словах в назві (BeautyPro повертає тільки category id)
    const buckets = {
      hair:    { title: 'Перукарські послуги', items: [] },
      nails:   { title: 'Ногтьовий сервіс',    items: [] },
      face:    { title: 'Візаж та лешмейк',    items: [] },
      massage: { title: 'Масаж та body sculpt', items: [] },
      other:   { title: 'Інші послуги',        items: [] },
    };
    const RX_NAILS = /(манік|маник|педик|нігт|ногт|гель[\-\s]?лак|шелак|шеллак|nail|френч|втирк|укріпленн|зняття|дизайн)/i;
    const RX_FACE  = /(бров|брів|вій|ресн|лешм|lash|депіл|депил|шугар|віск|воск|макіяж|макияж|обличч|лиц|пілінг|пилинг|чист(ка|ку|ою)|перманент|татуаж|мікроблейд|microblad|перм|premium\s*\d?\s*d|hollywood|класика|контуринг|консультац)/i;
    const RX_HAIR  = /(волос|стрижк|стриж|фарб|мелір|мелир|тон(ування|ирование|уванн)|укладк|blow|hair|омбре|балаяж|шатуш|ламін|ламин|ботокс|кератин|нанопласт|боярдо|боярдеї|освітленн|осветлен|колорування|колорирование|біовирівн|біозавив|вихід з чорного|накрутк|вкладанн|чубчик|голови та вкладан|миття голови|зачіск|холодне відновленн|biomimetic|довжина)/i;
    const RX_MASSAGE = /(масаж|massage|sculpt|lymphat|лімфодрен|лимфодрен|bdsm|booty|body|detox|aponeuros|face[\s\-]?lift|alginate|ліфтинг.?масаж|глибокотканин|архітектурн.{0,12}ліфтинг)/i;

    // Жорсткий маппінг по GUID категорії з BeautyPro (06.06)
    const CAT_HAIR = new Set([
      '88de9f81-ba4e-ec40-2721-6e895218a30b','88de9f81-ba4e-ec40-2721-6e890940ef12',
      '88de9f81-ba4e-ec40-2721-6e89464791b2','88de9f81-ba4e-ca1e-2721-6e8915aaac8e',
      '88deba75-de0a-5172-500e-323d51507ece','88deba75-ddf9-9eaa-57ac-e23d1325ae90',
      '88deba75-de29-4fcd-57ac-e23d7b0da276','88deba75-dde8-ecf0-783f-1287064f794a',
      '88de9f81-ba4f-3ae7-2721-6e891864f1eb','88de9f81-ba4f-3ae7-2721-6e89242af004',
    ]);
    const CAT_NAILS = new Set([
      '88de9f81-ba86-ef50-2721-6e891d076fb3','88deba75-de18-9c79-57ac-e23d3877784d',
      '88deba75-de39-fda4-500e-323d0962e307','88de9f81-ba86-ef50-2721-6e8940dd1cbc',
      '88de9f81-ba86-ef50-2721-6e896814c8cf',
    ]);
    const CAT_FACE = new Set([
      '88deba75-de48-4b92-57ac-e23d0ef4a3f1','88deba75-de67-48b4-500e-323d315989c2',
      '88de9f81-ba12-e930-2721-6e8900c1746f','88deba75-de77-fa8f-57ac-e23d54c5a8fc',
      '88deba75-de58-fbf4-57ac-e23d46888bbe',
    ]);
    items.forEach(s => {
      // 1) Primary — від сервера (за позицією мастера: Стилист/Визажист/Мастер маникюра)
      if (s.widget_category && buckets[s.widget_category]) {
        buckets[s.widget_category].items.push(s);
        return;
      }
      // 2) Fallback — старий GUID-маппінг по категоріях BeautyPro
      const cid = typeof s.category === 'string' ? s.category : (s.category && s.category.id ? s.category.id : null);
      if (cid && CAT_HAIR.has(cid))  { buckets.hair.items.push(s);  return; }
      if (cid && CAT_NAILS.has(cid)) { buckets.nails.items.push(s); return; }
      if (cid && CAT_FACE.has(cid))  { buckets.face.items.push(s);  return; }
      // 3) Fallback 2 — regex по назві
      const n = s.name || '';
      if (RX_MASSAGE.test(n))    buckets.massage.items.push(s);
      else if (RX_NAILS.test(n)) buckets.nails.items.push(s);
      else if (RX_FACE.test(n))  buckets.face.items.push(s);
      else if (RX_HAIR.test(n))  buckets.hair.items.push(s);
      else                       buckets.other.items.push(s);
    });

    const order = ['hair','nails','face','massage','other'];
    const visible = order.filter(k => buckets[k].items.length);
    $('#svs-services').innerHTML = visible.map((k, idx) => `
      <details class="svs-book-cat" ${idx === 0 ? 'open' : ''}>
        <summary class="svs-book-cat-title">${buckets[k].title} <span class="svs-book-cat-count">${buckets[k].items.length}</span></summary>
        <div class="svs-book-cat-list">${buckets[k].items.map(renderCard).join('')}</div>
      </details>
    `).join('');
  }

  // ── Step 2: date (calendar of ALL masters availability) ─
  async function pickService(svcId) {
    state.service = state.services.find(s => s.id === svcId);
    if (!state.service) return;
    state.master = null; state.date = null; state.slot = null;
    $('#svs-svc-summary').textContent = `${state.service.name} · ${state.service.duration} хв`;
    show('date');
    loadAvailability();
    loadMastersBg(svcId); // у фоні: щоб знати імʼя для останнього кроку
  }
  async function loadMastersBg(svcId) {
    try {
      const list = await api('/api/booking/masters?service_id=' + encodeURIComponent(svcId));
      const all = Array.isArray(list) ? list : [];
      const filtered = all.filter(m => Array.isArray(m.services) && m.services.some(x => x.id === svcId));
      state.masters = filtered.length ? filtered : all;
    } catch { state.masters = []; }
  }
  async function loadAvailability() {
    $('#svs-calendar').innerHTML = '<div class="svs-book-loading">Шукаю вільні дні…</div>';
    try {
      const url = `/api/booking/availability?service_id=${encodeURIComponent(state.service.id)}&days=14&format=v2`;
      const resp = await api(url);
      const days = resp && Array.isArray(resp.days) ? resp.days : (Array.isArray(resp) ? resp : []);
      const noSchedule = resp && resp.noSchedule === true;
      renderCalendar(days, noSchedule);
    } catch (e) {
      $('#svs-calendar').innerHTML = `<div class="svs-book-err">Не вдалося завантажити: ${e.message}</div>`;
    }
  }
  function renderCalendar(days, noSchedule) {
    if (noSchedule) {
      $('#svs-calendar').innerHTML = `
        <div class="svs-book-fallback">
          <div class="svs-book-fallback-icon">📞</div>
          <div class="svs-book-fallback-title">Графік на найближчі 2 тижні ще не складено</div>
          <div class="svs-book-fallback-text">Майстри ще не виставили зміни. Щоб записатись — будь ласка, зателефонуйте або напишіть:</div>
          <a class="svs-book-fallback-btn" href="tel:+380632407847">📞 +38 063 240 7847</a>
          <a class="svs-book-fallback-btn alt" href="https://t.me/Svsf1rstbot" target="_blank">💬 Написати в Telegram</a>
        </div>`;
      return;
    }
    // Показуємо ТІЛЬКИ дні з вільними вікнами — занятих не відображаємо
    const freeDays = days.filter(d => d.count > 0);
    if (!freeDays.length) {
      $('#svs-calendar').innerHTML = '<div class="svs-book-empty">На найближчі 2 тижні вільних днів немає. Зателефонуйте салону.</div>';
      return;
    }
    const wd = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
    const mn = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
    $('#svs-calendar').innerHTML = freeDays.map(d => {
      const [y, m, dd] = d.date.split('-').map(Number);
      const date = new Date(y, m - 1, dd);
      const dayLabel = `${dd} ${mn[m - 1]}`;
      const wdLabel = wd[date.getDay()];
      const slotsLabel = `🟢 ${d.count} вікон${d.first ? ' · ' + d.first + '-' + d.last : ''}`;
      return `<button class="svs-book-day free" data-date="${d.date}">
        <div class="svs-book-day-top"><b>${dayLabel}</b> <span>${wdLabel}</span></div>
        <div class="svs-book-day-bot">${slotsLabel}</div>
      </button>`;
    }).join('');
  }
  function pickDate(dateStr) {
    state.date = dateStr;
    loadSlots();
  }

  // ── Step 3: slots (з усіма майстрами) ─────────────────
  async function loadSlots() {
    if (!state.date) { alert('Оберіть дату'); return; }
    $('#svs-date-summary').textContent = `${state.service.name} · ${state.date}`;
    show('time');
    $('#svs-slots').innerHTML = '<div class="svs-book-loading">Шукаю вільний час…</div>';
    try {
      const url = `/api/booking/slots?service_id=${encodeURIComponent(state.service.id)}&date=${state.date}`;
      const data = await api(url);
      renderSlots(data);
    } catch (e) {
      $('#svs-slots').innerHTML = `<div class="svs-book-err">Помилка: ${e.message}</div>`;
    }
  }
  function renderSlots(data) {
    // BeautyPro повертає масив { from, to } або {free_time:[...]}
    let slots = [];
    if (Array.isArray(data)) slots = data;
    else if (data && Array.isArray(data.free_time)) slots = data.free_time;
    else if (data && Array.isArray(data.slots)) slots = data.slots;
    else if (data && typeof data === 'object') {
      // пробуем найти первый массив внутри
      const arr = Object.values(data).find(v => Array.isArray(v));
      if (arr) slots = arr;
    }
    if (!slots.length) {
      $('#svs-slots').innerHTML = '<div class="svs-book-empty">На цю дату вільного часу немає. Оберіть іншу.</div>';
      return;
    }
    $('#svs-slots').innerHTML = slots.slice(0, 40).map((s, i) => {
      const from = s.from || s.start || s.time || s;
      const label = typeof from === 'string' ? from.slice(11, 16) || from : String(from);
      return `<button class="svs-book-slot" data-slot="${i}">${label}</button>`;
    }).join('');
    state._rawSlots = slots;
  }

  function pickSlot(idx) {
    state.slot = state._rawSlots[idx];
    $$('.svs-book-slot').forEach(b => b.classList.toggle('chosen', b.dataset.slot === String(idx)));
    // Step 4: вибір майстра серед тих, хто вільний у цей слот
    const slotEmployees = Array.isArray(state.slot.employees) ? state.slot.employees : [];
    const available = (state.masters || []).filter(m => slotEmployees.includes(m.id));
    const list = available.length ? available : (state.masters || []);
    const slotLabel = state.slot.time || (state.slot.from || '').slice(11, 16);
    $('#svs-mst-summary').textContent = `${state.service.name} · ${state.date} · ${slotLabel}`;
    state._slotAvailableMasters = list;  // для опції "Будь-який вільний"
    if (!list.length) {
      $('#svs-masters').innerHTML = '<div class="svs-book-empty">На цей час майстрів немає. Оберіть інший час.</div>';
    } else {
      // Кнопка "Будь-який вільний майстер" зверху списку - підставляє першого вільного
      const anyMasterCard = list.length > 1 ? `
        <button class="svs-book-card svs-book-card-any" data-mst="__any__">
          <div class="svs-book-card-title">🎲 Будь-який вільний майстер</div>
          <div class="svs-book-card-meta">Підберемо першого вільного на цей час</div>
        </button>` : '';
      $('#svs-masters').innerHTML = anyMasterCard + list.map(m => `
        <button class="svs-book-card" data-mst="${m.id}">
          <div class="svs-book-card-title">${m.name}</div>
        </button>`).join('');
    }
    show('master');
    $('button[data-action="confirm"]').disabled = true;
  }
  function pickMaster(mstId) {
    if (mstId === '__any__') {
      // "Будь-який вільний майстер" - беремо першого з доступних на цей слот
      const pool = state._slotAvailableMasters || state.masters || [];
      state.master = pool[0];
      if (!state.master) return;
      $$('.svs-book-card[data-mst]').forEach(b => b.classList.toggle('chosen', b.dataset.mst === '__any__'));
    } else {
      state.master = (state.masters || []).find(m => m.id === mstId);
      if (!state.master) return;
      $$('.svs-book-card[data-mst]').forEach(b => b.classList.toggle('chosen', b.dataset.mst === mstId));
    }
    $('button[data-action="confirm"]').disabled = false;
  }

  // ── Helpers: нормалізація телефону (UA) і таймзони ────
  function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    // UA: 0XXXXXXXXX (10 цифр) → +380XXXXXXXXX
    if (d.length === 10 && d.startsWith('0')) return '+380' + d.slice(1);
    // UA: 380XXXXXXXXX (12 цифр) → +380XXXXXXXXX
    if (d.length === 12 && d.startsWith('380')) return '+' + d;
    // Інтернаціонал: 11-15 цифр з кодом країни → "+"+d
    if (d.length >= 11 && d.length <= 15) return '+' + d;
    return null;
  }
  // ISO з явною UA-зоною (+03:00 літо / +02:00 зима) — щоб дата не зʼїхала
  function toUaIso(date) {
    const d = new Date(date);
    const offMin = -d.getTimezoneOffset(); // браузер клієнта вже у його зоні
    const sign = offMin >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offMin) % 60).padStart(2, '0');
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
  }

  // ── Confirm: пряма запис у CRM (з fallback на Telegram) ─
  let _submitting = false;
  async function confirm() {
    if (_submitting) return; // bug-fix #1: захист від подвійного кліку
    state.name = ($('#svs-name').value || '').trim();
    const phoneRaw = ($('#svs-phone').value || '').trim();
    const phone = normalizePhone(phoneRaw); // bug-fix #2: нормалізація
    if (!state.name) { alert('Введіть імʼя'); return; }
    if (!phone) { alert('Введіть коректний телефон (наприклад 0991234567)'); return; }
    if (!state.slot) { alert('Оберіть час'); return; }

    _submitting = true;
    const btn = $('button[data-action="confirm"]');
    if (btn) { btn.disabled = true; btn.dataset._origText = btn.textContent; btn.textContent = 'Записуємо…'; }

    const from = state.slot.from || state.slot.start || state.slot;
    const dur = state.service.duration || 60;
    // bug-fix #3: ISO з зоною клієнта замість UTC
    const fromIso = toUaIso(typeof from === 'string' ? from : new Date(from));
    const toIso = toUaIso(new Date(new Date(fromIso).getTime() + dur * 60000));

    const restoreBtn = () => {
      _submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset._origText || 'Записатись'; }
    };

    // 1) Спроба прямого запису у CRM
    // idempotency_key — UUID-подібний рядок; зберігаємо у state щоб retry використав той самий
    if (!state._idemKey) {
      state._idemKey = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2));
    }
    try {
      const r = await fetch(API + '/api/booking/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          name: state.name,
          service_id: state.service.id,
          service_name: state.service.name,
          employee_id: state.master.id,
          master_name: state.master.name,
          date_from: fromIso,
          date_to: toIso,
          idempotency_key: state._idemKey,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        const slotLabel = (typeof from === 'string' ? from.slice(11, 16) : '');
        const when = `${state.date}${slotLabel ? ' · ' + slotLabel : ''}`;
        $('#svs-done-summary').innerHTML =
          `<b>${state.service.name}</b><br>` +
          `${state.master.name} · ${when}` +
          (data.cancel_token
            ? `<div class="svs-book-manage">
                 <a class="svs-book-manage-link" href="?booking=${data.cancel_token}" target="_blank">
                   ✏ Перенести або скасувати
                 </a>
                 <div class="svs-book-manage-hint">Збережіть це посилання — без нього доведеться телефонувати в салон</div>
               </div>`
            : '');
        show('done');
        return; // _submitting лишається true до закриття — захист від повторної відправки
      }
      throw new Error(data.error || 'CRM error');
    } catch (e) {
      console.warn('[svs-book] direct failed, fallback to TG:', e.message);
    }

    // 2) Fallback: підтвердження через Telegram
    try {
      const r = await fetch(API + '/api/booking/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: state.service.id,
          employee_id: state.master.id,
          date_from: fromIso,
          date_to: toIso,
          client_name: state.name,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'init failed');
      currentToken = data.token;
      // bug-fix #4: НЕ window.open() після await (блокують моб. браузери) — показуємо клікабельне посилання
      $('#svs-link').href = data.deep_link;
      $('#svs-link').textContent = '👉 Відкрити бота для підтвердження';
      show('wait');
      poll();
    } catch (e) {
      $('#svs-err').textContent = 'Помилка: ' + e.message;
      show('error');
      restoreBtn();
    }
  }
  function poll() {
    let tries = 0;
    pollTimer = setInterval(async () => {
      if (++tries > 180) {
        clearInterval(pollTimer);
        $('#svs-err').textContent = 'Час очікування вичерпано. Спробуйте ще раз.';
        show('error');
        return;
      }
      try {
        const r = await fetch(API + '/api/booking/status/' + currentToken);
        if (!r.ok) return;
        const data = await r.json();
        if (data.status === 'confirmed') {
          clearInterval(pollTimer);
          $('#svs-done-summary').textContent = `${state.service.name} · ${state.master.name} · ${state.date}`;
          show('done');
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          $('#svs-err').textContent = 'CRM: ' + (data.error || 'невідома помилка');
          show('error');
        }
      } catch {}
    }, 2000);
  }

  function reset() {
    state.service = state.master = state.date = state.slot = null;
    show('service');
  }

  function mount() {
    const div = document.createElement('div');
    div.innerHTML = html;
    root = div.firstElementChild;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close],[data-action],[data-goto],[data-svc],[data-mst],[data-slot]');
      if (!t) return;
      if (t.dataset.close !== undefined) return close();
      if (t.dataset.goto) return show(t.dataset.goto);
      if (t.dataset.svc) return pickService(t.dataset.svc);
      if (t.dataset.mst) return pickMaster(t.dataset.mst);
      if (t.dataset.date) return pickDate(t.dataset.date);
      if (t.dataset.slot != null) return pickSlot(Number(t.dataset.slot));
      if (t.dataset.action === 'loadSlots') return loadSlots();
      if (t.dataset.action === 'confirm') return confirm();
      if (t.dataset.action === 'reset') return reset();
    });
    root.addEventListener('input', (e) => {
      if (e.target.id === 'svs-search') renderServices(e.target.value);
    });
    document.querySelectorAll('[data-svs-book], a[href*="bookon.ua"]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); open(); });
    });
  }

  // ── Manage booking screen (?booking=TOKEN) ───────────────
  async function handleManageUrl() {
    const params = new URLSearchParams(location.search);
    const token = params.get('booking');
    if (!token) return;
    if (!root) mount();

    // Окремий екран замість стандартного флоу
    const dialog = root.querySelector('.svs-book-dialog');
    if (!dialog) return;
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    dialog.innerHTML = `
      <button class="svs-book-close" data-close aria-label="Закрити">×</button>
      <h3>Ваш запис</h3>
      <div id="svs-manage-body"><div class="svs-book-loading">Завантаження…</div></div>
    `;
    // Закрытие
    dialog.querySelector('[data-close]').addEventListener('click', () => {
      root.hidden = true;
      document.body.style.overflow = '';
      history.replaceState(null, '', location.pathname);
    });

    const body = dialog.querySelector('#svs-manage-body');
    try {
      const r = await fetch(API + '/api/booking/info/' + encodeURIComponent(token));
      const info = await r.json();
      if (!r.ok) {
        body.innerHTML = `<div class="svs-book-err">${info.error || 'Запис не знайдено'}</div>`;
        return;
      }
      if (info.status === 'used') {
        body.innerHTML = `<div class="svs-book-empty">Запис вже ${info.used_action === 'cancel' ? 'скасовано' : 'перенесено'}.</div>`;
        return;
      }
      const startLocal = new Date(info.start_at).toLocaleString('uk-UA', {
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
      });
      body.innerHTML = `
        <div class="svs-book-info-row"><span>Послуга:</span> <b>${info.service_name || '—'}</b></div>
        <div class="svs-book-info-row"><span>Майстер:</span> <b>${info.master_name || '—'}</b></div>
        <div class="svs-book-info-row"><span>Коли:</span> <b>${startLocal}</b></div>
        <div class="svs-book-manage-actions">
          <button class="svs-book-submit" id="svs-do-cancel" style="background:#c1361d">✖ Скасувати</button>
          <button class="svs-book-submit alt" id="svs-do-reschedule">↻ Перенести</button>
        </div>
        <p class="svs-book-hint">Скасування/перенос можливі не пізніше ніж за 2 години до запису</p>
      `;
      dialog.querySelector('#svs-do-cancel').addEventListener('click', async () => {
        if (!confirm('Точно скасувати запис?')) return;
        const cr = await fetch(API + '/api/booking/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const cd = await cr.json();
        if (cr.ok) {
          body.innerHTML = `<div class="svs-book-empty">✓ Запис скасовано. Чекаємо вас наступного разу.</div>`;
        } else {
          alert(cd.error || 'Не вдалося скасувати');
        }
      });
      dialog.querySelector('#svs-do-reschedule').addEventListener('click', () => {
        // Перенос: закриваємо манаге, відкриваємо звичайний флоу на ту ж послугу
        // (повний UX-flow перенесення — Спринт 3+)
        alert('Перенос: відкривається звичайний віджет, оберіть нову дату. Старий запис скасується автоматично після нової.');
        root.hidden = true;
        history.replaceState(null, '', location.pathname);
        window.SVSBooking.open();
      });
    } catch (e) {
      body.innerHTML = `<div class="svs-book-err">Помилка: ${e.message}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount();
    handleManageUrl();
  });
  window.SVSBooking = { open, close };
})();
