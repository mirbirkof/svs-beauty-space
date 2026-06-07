/* ═══════════════════════════════════════════════════════
   SVS Booking Widget v2 — Conversational UI
   Чат-стиль: один крок за раз, кнопки, анімації
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const API = window.SVS_BOOKING_API || 'https://svs-booking-api.onrender.com';

  const html = `
    <div id="svs-book-modal" class="svs-book-modal" hidden>
      <div class="svs-book-backdrop" data-close></div>
      <div class="svs-book-dialog" role="dialog" aria-modal="true">
        <button class="svs-book-close" data-close aria-label="Закрити">×</button>

        <!-- Progress dots -->
        <div class="svs-book-progress">
          <span class="svs-dot active"></span>
          <span class="svs-dot"></span>
          <span class="svs-dot"></span>
          <span class="svs-dot"></span>
          <span class="svs-dot"></span>
        </div>

        <!-- Chat area -->
        <div class="svs-book-chat" id="svs-chat">
          <!-- Messages will be appended here -->
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
    _idemKey: null,
    _rawSlots: [],
    _slotAvailableMasters: [],
    step: 0,
  };

  const $ = (s, r) => (r || root).querySelector(s);
  const $$ = (s, r) => Array.from((r || root).querySelectorAll(s));

  // ── Progress dots ──────────────────────────────────────
  function updateProgress(step) {
    state.step = step;
    $$('.svs-dot').forEach((d, i) => {
      d.classList.toggle('active', i === step);
      d.classList.toggle('done', i < step);
    });
  }

  // ── Chat message helpers ───────────────────────────────
  function chatEl() { return $('#svs-chat'); }

  function addMessage(text, type = 'bot') {
    const chat = chatEl();
    const msg = document.createElement('div');
    msg.className = `svs-msg svs-msg-${type} svs-msg-enter`;
    msg.innerHTML = text;
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
    requestAnimationFrame(() => msg.classList.remove('svs-msg-enter'));
    return msg;
  }

  function addButtons(buttons, className = '') {
    const chat = chatEl();
    const wrap = document.createElement('div');
    wrap.className = `svs-btn-group svs-msg-enter ${className}`;
    wrap.innerHTML = buttons.map(b =>
      `<button class="svs-chat-btn ${b.cls || ''}" ${b.data}>${b.icon ? '<span class="svs-btn-icon">' + b.icon + '</span>' : ''}${b.label}${b.sub ? '<span class="svs-btn-sub">' + b.sub + '</span>' : ''}</button>`
    ).join('');
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    requestAnimationFrame(() => wrap.classList.remove('svs-msg-enter'));
    return wrap;
  }

  function addInput(fields) {
    const chat = chatEl();
    const wrap = document.createElement('div');
    wrap.className = 'svs-input-group svs-msg-enter';
    wrap.innerHTML = fields;
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    requestAnimationFrame(() => wrap.classList.remove('svs-msg-enter'));
    return wrap;
  }

  function clearChat() {
    const chat = chatEl();
    if (chat) chat.innerHTML = '';
  }

  function addUserChoice(text) {
    addMessage(text, 'user');
  }

  function addLoading() {
    const chat = chatEl();
    const msg = document.createElement('div');
    msg.className = 'svs-msg svs-msg-bot svs-msg-loading';
    msg.innerHTML = '<span class="svs-typing"><i></i><i></i><i></i></span>';
    chat.appendChild(msg);
    chat.scrollTop = chat.scrollHeight;
    return msg;
  }

  function removeLoading() {
    const el = $('.svs-msg-loading');
    if (el) el.remove();
  }

  // ── Open / Close ───────────────────────────────────────
  function open() {
    if (!root) mount();
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    _submitting = false;
    state.service = state.master = state.date = state.slot = null;
    state._idemKey = null;
    clearChat();
    updateProgress(0);
    startConversation();
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    document.body.style.overflow = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentToken = null;
  }

  async function apiFetch(path) {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── Step 0: Greeting + Categories ─────────────────────
  async function startConversation() {
    addMessage('Привіт! 👋 Що хочеш зробити?');

    const loader = addLoading();
    try {
      const list = await apiFetch('/api/booking/services');
      state.services = Array.isArray(list) ? list : [];
    } catch (e) {
      removeLoading();
      addMessage('Не вдалось завантажити послуги 😕 Спробуй пізніше або зателефонуй: <a href="tel:+380632407847">+38 063 240 7847</a>');
      return;
    }
    removeLoading();

    // Show categories as big buttons
    const cats = categorizeServices();
    const catBtns = [];
    if (cats.hair.length) catBtns.push({ icon: '💇', label: 'Перукарська', sub: cats.hair.length + ' послуг', data: 'data-cat="hair"' });
    if (cats.nails.length) catBtns.push({ icon: '💅', label: 'Нігтьовий сервіс', sub: cats.nails.length + ' послуг', data: 'data-cat="nails"' });
    if (cats.face.length) catBtns.push({ icon: '✨', label: 'Візаж та лешмейк', sub: cats.face.length + ' послуг', data: 'data-cat="face"' });
    if (cats.massage.length) catBtns.push({ icon: '💆', label: 'Масаж', sub: cats.massage.length + ' послуг', data: 'data-cat="massage"' });
    if (cats.other.length) catBtns.push({ icon: '🔮', label: 'Інше', sub: cats.other.length + ' послуг', data: 'data-cat="other"' });

    addButtons(catBtns, 'svs-cats');

    // Also add search option
    addButtons([{ icon: '🔍', label: 'Знайти по назві', data: 'data-action="search"', cls: 'svs-btn-outline' }]);
  }

  // ── Categorize services (same logic as before) ────────
  function categorizeServices() {
    const buckets = { hair: [], nails: [], face: [], massage: [], other: [] };
    const RX_NAILS = /(манік|маник|педик|нігт|ногт|гель[\-\s]?лак|шелак|шеллак|nail|френч|втирк|укріпленн|зняття|дизайн)/i;
    const RX_FACE = /(бров|брів|вій|ресн|лешм|lash|депіл|депил|шугар|віск|воск|макіяж|макияж|обличч|лиц|пілінг|пилинг|чист(ка|ку|ою)|перманент|татуаж|мікроблейд|microblad|перм|premium\s*\d?\s*d|hollywood|класика|контуринг|консультац)/i;
    const RX_HAIR = /(волос|стрижк|стриж|фарб|мелір|мелир|тон(ування|ирование|уванн)|укладк|blow|hair|омбре|балаяж|шатуш|ламін|ламин|ботокс|кератин|нанопласт|боярдо|боярдеї|освітленн|осветлен|колорування|колорирование|біовирівн|біозавив|вихід з чорного|накрутк|вкладанн|чубчик|голови та вкладан|миття голови|зачіск|холодне відновленн|biomimetic|довжина)/i;
    const RX_MASSAGE = /(масаж|massage|sculpt|lymphat|лімфодрен|лимфодрен|bdsm|booty|body|detox|aponeuros|face[\s\-]?lift|alginate|ліфтинг.?масаж|глибокотканин|архітектурн.{0,12}ліфтинг)/i;

    const CAT_HAIR = new Set(['88de9f81-ba4e-ec40-2721-6e895218a30b','88de9f81-ba4e-ec40-2721-6e890940ef12','88de9f81-ba4e-ec40-2721-6e89464791b2','88de9f81-ba4e-ca1e-2721-6e8915aaac8e','88deba75-de0a-5172-500e-323d51507ece','88deba75-ddf9-9eaa-57ac-e23d1325ae90','88deba75-de29-4fcd-57ac-e23d7b0da276','88deba75-dde8-ecf0-783f-1287064f794a','88de9f81-ba4f-3ae7-2721-6e891864f1eb','88de9f81-ba4f-3ae7-2721-6e89242af004']);
    const CAT_NAILS = new Set(['88de9f81-ba86-ef50-2721-6e891d076fb3','88deba75-de18-9c79-57ac-e23d3877784d','88deba75-de39-fda4-500e-323d0962e307','88de9f81-ba86-ef50-2721-6e8940dd1cbc','88de9f81-ba86-ef50-2721-6e896814c8cf']);
    const CAT_FACE = new Set(['88deba75-de48-4b92-57ac-e23d0ef4a3f1','88deba75-de67-48b4-500e-323d315989c2','88de9f81-ba12-e930-2721-6e8900c1746f','88deba75-de77-fa8f-57ac-e23d54c5a8fc','88deba75-de58-fbf4-57ac-e23d46888bbe']);

    state.services.forEach(s => {
      if (s.widget_category && buckets[s.widget_category]) { buckets[s.widget_category].push(s); return; }
      const cid = typeof s.category === 'string' ? s.category : (s.category && s.category.id ? s.category.id : null);
      if (cid && CAT_HAIR.has(cid)) { buckets.hair.push(s); return; }
      if (cid && CAT_NAILS.has(cid)) { buckets.nails.push(s); return; }
      if (cid && CAT_FACE.has(cid)) { buckets.face.push(s); return; }
      const n = s.name || '';
      if (RX_MASSAGE.test(n)) buckets.massage.push(s);
      else if (RX_NAILS.test(n)) buckets.nails.push(s);
      else if (RX_FACE.test(n)) buckets.face.push(s);
      else if (RX_HAIR.test(n)) buckets.hair.push(s);
      else buckets.other.push(s);
    });
    return buckets;
  }

  // ── Step 1: Show services in category ─────────────────
  function showCategoryServices(catKey) {
    const cats = categorizeServices();
    const items = cats[catKey] || [];
    const catNames = { hair: '💇 Перукарська', nails: '💅 Нігті', face: '✨ Візаж', massage: '💆 Масаж', other: '🔮 Інше' };

    addUserChoice(catNames[catKey] || catKey);
    updateProgress(1);

    if (!items.length) {
      addMessage('Тут поки порожньо. Спробуй іншу категорію.');
      return;
    }

    addMessage('Обирай послугу:');
    const btns = items.slice(0, 30).map(s => {
      const price = s.price ? Object.values(s.price)[0] : null;
      const meta = `${s.duration || '?'} хв${price ? ' · ' + price + ' грн' : ''}`;
      return { label: s.name, sub: meta, data: `data-svc="${s.id}"`, cls: 'svs-btn-service' };
    });
    addButtons(btns, 'svs-services-list');
  }

  // ── Search mode ────────────────────────────────────────
  function showSearch() {
    addUserChoice('🔍 Пошук');
    const wrap = addInput(`
      <div class="svs-search-wrap">
        <input type="text" id="svs-search-input" placeholder="Назва послуги…" autocomplete="off">
        <div id="svs-search-results" class="svs-search-results"></div>
      </div>
    `);
    const input = wrap.querySelector('#svs-search-input');
    const results = wrap.querySelector('#svs-search-results');
    input.focus();
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      const found = state.services.filter(s => s.name.toLowerCase().includes(q)).slice(0, 15);
      if (!found.length) { results.innerHTML = '<div class="svs-search-empty">Нічого не знайдено</div>'; return; }
      results.innerHTML = found.map(s => {
        const price = s.price ? Object.values(s.price)[0] : null;
        return `<button class="svs-chat-btn svs-btn-service" data-svc="${s.id}">${s.name}<span class="svs-btn-sub">${s.duration || '?'} хв${price ? ' · ' + price + ' грн' : ''}</span></button>`;
      }).join('');
    });
  }

  // ── Step 2: Pick service → ask when ───────────────────
  async function pickService(svcId) {
    state.service = state.services.find(s => s.id === svcId);
    if (!state.service) return;
    state.master = null; state.date = null; state.slot = null;

    const price = state.service.price ? Object.values(state.service.price)[0] : null;
    addUserChoice(state.service.name);
    updateProgress(2);

    addMessage(`<b>${state.service.name}</b><br><span class="svs-meta">${state.service.duration || '?'} хв${price ? ' · ' + price + ' грн' : ''}</span><br><br>Коли зручно?`);

    // Quick date buttons
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const dayAfter = new Date(today); dayAfter.setDate(today.getDate() + 2);

    const fmtDate = d => d.toISOString().slice(0, 10);
    const dayNames = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
    const fmtLabel = d => `${d.getDate()}.${String(d.getMonth()+1).padStart(2,'0')} (${dayNames[d.getDay()]})`;

    addButtons([
      { icon: '📅', label: 'Сьогодні', sub: fmtLabel(today), data: `data-qdate="${fmtDate(today)}"` },
      { icon: '📅', label: 'Завтра', sub: fmtLabel(tomorrow), data: `data-qdate="${fmtDate(tomorrow)}"` },
      { icon: '📅', label: 'Післязавтра', sub: fmtLabel(dayAfter), data: `data-qdate="${fmtDate(dayAfter)}"` },
      { icon: '📋', label: 'Всі вільні дні', data: 'data-action="allDates"', cls: 'svs-btn-outline' },
    ]);

    // Load masters in background
    loadMastersBg(svcId);
  }

  async function loadMastersBg(svcId) {
    try {
      const list = await apiFetch('/api/booking/masters?service_id=' + encodeURIComponent(svcId));
      const all = Array.isArray(list) ? list : [];
      const filtered = all.filter(m => Array.isArray(m.services) && m.services.some(x => x.id === svcId));
      state.masters = filtered.length ? filtered : all;
    } catch { state.masters = []; }
  }

  // ── Step 2b: Show all available dates ─────────────────
  async function showAllDates() {
    addUserChoice('Всі вільні дні');
    const loader = addLoading();
    try {
      const url = `/api/booking/availability?service_id=${encodeURIComponent(state.service.id)}&days=14&format=v2`;
      const resp = await apiFetch(url);
      const days = resp && Array.isArray(resp.days) ? resp.days : (Array.isArray(resp) ? resp : []);
      const noSchedule = resp && resp.noSchedule === true;
      removeLoading();

      if (noSchedule) {
        addMessage('Графік ще не складено на найближчі 2 тижні 😕<br>Зателефонуй: <a href="tel:+380632407847">+38 063 240 7847</a>');
        return;
      }

      const freeDays = days.filter(d => d.count > 0);
      if (!freeDays.length) {
        addMessage('На найближчі 2 тижні немає вільних місць 😕<br>Спробуй зателефонувати: <a href="tel:+380632407847">+38 063 240 7847</a>');
        return;
      }

      addMessage('Ось вільні дні:');
      const mn = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
      const wd = ['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];
      const btns = freeDays.map(d => {
        const [y, m, dd] = d.date.split('-').map(Number);
        const date = new Date(y, m - 1, dd);
        return {
          icon: '🟢',
          label: `${dd} ${mn[m-1]} (${wd[date.getDay()]})`,
          sub: `${d.count} вікон${d.first ? ' · ' + d.first + '–' + d.last : ''}`,
          data: `data-date="${d.date}"`
        };
      });
      addButtons(btns, 'svs-dates-list');
    } catch (e) {
      removeLoading();
      addMessage('Помилка завантаження: ' + e.message);
    }
  }

  // ── Quick date check ──────────────────────────────────
  async function pickQuickDate(dateStr) {
    const mn = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
    const [y, m, d] = dateStr.split('-').map(Number);
    addUserChoice(`${d} ${mn[m-1]}`);
    state.date = dateStr;
    updateProgress(3);
    await loadSlots();
  }

  async function pickDate(dateStr) {
    const mn = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
    const [y, m, d] = dateStr.split('-').map(Number);
    addUserChoice(`${d} ${mn[m-1]}`);
    state.date = dateStr;
    updateProgress(3);
    await loadSlots();
  }

  // ── Step 3: Load time slots ───────────────────────────
  async function loadSlots() {
    const loader = addLoading();
    try {
      const url = `/api/booking/slots?service_id=${encodeURIComponent(state.service.id)}&date=${state.date}`;
      const data = await apiFetch(url);
      removeLoading();

      let slots = [];
      if (Array.isArray(data)) slots = data;
      else if (data && Array.isArray(data.free_time)) slots = data.free_time;
      else if (data && Array.isArray(data.slots)) slots = data.slots;
      else if (data && typeof data === 'object') {
        const arr = Object.values(data).find(v => Array.isArray(v));
        if (arr) slots = arr;
      }
      state._rawSlots = slots;

      if (!slots.length) {
        addMessage('На цю дату вже все зайнято 😕 Обери іншу:');
        addButtons([{ icon: '📋', label: 'Інші дні', data: 'data-action="allDates"' }]);
        return;
      }

      addMessage('О котрій годині?');
      const btns = slots.slice(0, 30).map((s, i) => {
        const from = s.from || s.start || s.time || s;
        const label = typeof from === 'string' ? from.slice(11, 16) || from : String(from);
        return { label, data: `data-slot="${i}"`, cls: 'svs-btn-time' };
      });
      addButtons(btns, 'svs-times-grid');
    } catch (e) {
      removeLoading();
      addMessage('Помилка: ' + e.message);
    }
  }

  // ── Step 4: Pick slot → ask who ───────────────────────
  function pickSlot(idx) {
    state.slot = state._rawSlots[idx];
    const from = state.slot.from || state.slot.start || state.slot.time || state.slot;
    const label = typeof from === 'string' ? from.slice(11, 16) || from : String(from);
    addUserChoice(label);
    updateProgress(4);

    // Filter masters available at this slot
    const slotEmployees = Array.isArray(state.slot.employees) ? state.slot.employees : [];
    const available = (state.masters || []).filter(m => slotEmployees.includes(m.id));
    const list = available.length ? available : (state.masters || []);
    state._slotAvailableMasters = list;

    if (!list.length) {
      // No master selection needed — go straight to confirm
      state.master = null;
      showConfirmStep();
      return;
    }

    addMessage('До кого записатись?');
    const btns = [];
    if (list.length > 1) {
      btns.push({ icon: '🎲', label: 'Будь-хто вільний', sub: 'Підберемо першого', data: 'data-mst="__any__"', cls: 'svs-btn-any' });
    }
    list.forEach(m => {
      btns.push({ icon: '👤', label: m.name, data: `data-mst="${m.id}"` });
    });
    addButtons(btns, 'svs-masters-list');
  }

  // ── Step 5: Pick master → confirm ─────────────────────
  function pickMaster(mstId) {
    if (mstId === '__any__') {
      const pool = state._slotAvailableMasters || state.masters || [];
      state.master = pool[0];
      addUserChoice('🎲 Будь-хто');
    } else {
      state.master = (state.masters || []).find(m => m.id === mstId);
      addUserChoice(state.master ? state.master.name : '?');
    }
    if (!state.master) return;
    showConfirmStep();
  }

  // ── Final step: name + phone + confirm ────────────────
  function showConfirmStep() {
    const slotFrom = state.slot.from || state.slot.start || state.slot.time || state.slot;
    const timeLabel = typeof slotFrom === 'string' ? slotFrom.slice(11, 16) : '';
    const price = state.service.price ? Object.values(state.service.price)[0] : null;

    const summary = `<div class="svs-summary">
      <div class="svs-summary-row"><span>Послуга:</span> <b>${state.service.name}</b></div>
      ${state.master ? `<div class="svs-summary-row"><span>Майстер:</span> <b>${state.master.name}</b></div>` : ''}
      <div class="svs-summary-row"><span>Коли:</span> <b>${state.date} · ${timeLabel}</b></div>
      ${price ? `<div class="svs-summary-row"><span>Ціна:</span> <b>${price} грн</b></div>` : ''}
      <div class="svs-summary-row"><span>Тривалість:</span> <b>~${state.service.duration || '?'} хв</b></div>
    </div>`;

    addMessage(`Майже все! Перевір:<br>${summary}`);

    addInput(`
      <div class="svs-confirm-form">
        <input type="text" id="svs-name" placeholder="Твоє імʼя" autocomplete="name">
        <input type="tel" id="svs-phone" placeholder="+380 __ ___ ____" autocomplete="tel">
        <button class="svs-chat-btn svs-btn-confirm" data-action="confirm">✓ Записатись</button>
        <p class="svs-hint">Натискаючи — погоджуєшся на запис у CRM салону</p>
      </div>
    `);

    const nameInput = $('#svs-name');
    if (nameInput) nameInput.focus();
  }

  // ── Confirm booking ───────────────────────────────────
  let _submitting = false;
  async function confirm() {
    if (_submitting) return;
    state.name = ($('#svs-name').value || '').trim();
    const phoneRaw = ($('#svs-phone').value || '').trim();
    const phone = normalizePhone(phoneRaw);
    if (!state.name) { shakeInput('#svs-name'); return; }
    if (!phone) { shakeInput('#svs-phone'); return; }

    _submitting = true;
    const btn = $('[data-action="confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Записуємо…'; }

    const from = state.slot.from || state.slot.start || state.slot;
    const dur = state.service.duration || 60;
    const fromIso = toUaIso(typeof from === 'string' ? from : new Date(from));
    const toIso = toUaIso(new Date(new Date(fromIso).getTime() + dur * 60000));

    if (!state._idemKey) {
      state._idemKey = (crypto.randomUUID && crypto.randomUUID()) ||
        (Date.now().toString(36) + Math.random().toString(36).slice(2));
    }

    // 1) Direct CRM booking
    try {
      const r = await fetch(API + '/api/booking/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          name: state.name,
          service_id: state.service.id,
          service_name: state.service.name,
          employee_id: state.master ? state.master.id : null,
          master_name: state.master ? state.master.name : null,
          date_from: fromIso,
          date_to: toIso,
          idempotency_key: state._idemKey,
        }),
      });
      const data = await r.json();
      if (r.ok && data.ok) {
        showSuccess(data.cancel_token);
        return;
      }
      throw new Error(data.error || 'CRM error');
    } catch (e) {
      console.warn('[svs-book] direct failed, fallback to TG:', e.message);
    }

    // 2) Fallback: Telegram confirmation
    try {
      const r = await fetch(API + '/api/booking/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: state.service.id,
          employee_id: state.master ? state.master.id : null,
          date_from: fromIso,
          date_to: toIso,
          client_name: state.name,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'init failed');
      currentToken = data.token;

      addMessage('Залишився один крок — підтвердження в Telegram 📲');
      addButtons([{ icon: '📲', label: 'Відкрити Telegram', data: `data-deeplink="${data.deep_link}"`, cls: 'svs-btn-tg' }]);
      poll();
    } catch (e) {
      addMessage('Не вдалось 😕 ' + e.message + '<br><a href="tel:+380632407847">Зателефонувати</a>');
      _submitting = false;
    }
  }

  function showSuccess(cancelToken) {
    const slotFrom = state.slot.from || state.slot.start || state.slot.time || state.slot;
    const timeLabel = typeof slotFrom === 'string' ? slotFrom.slice(11, 16) : '';

    let msg = `<div class="svs-success">
      <div class="svs-success-icon">✓</div>
      <div class="svs-success-title">Записано!</div>
      <div class="svs-success-detail">
        <b>${state.service.name}</b><br>
        ${state.master ? state.master.name + ' · ' : ''}${state.date} · ${timeLabel}
      </div>`;
    if (cancelToken) {
      msg += `<a class="svs-manage-link" href="?booking=${cancelToken}">✏ Перенести або скасувати</a>
        <p class="svs-hint">Збережи це посилання</p>`;
    }
    msg += `</div>`;
    addMessage(msg);
    addButtons([{ label: 'Закрити', data: 'data-close', cls: 'svs-btn-outline' }]);
  }

  function shakeInput(sel) {
    const el = $(sel);
    if (!el) return;
    el.classList.add('svs-shake');
    el.focus();
    setTimeout(() => el.classList.remove('svs-shake'), 500);
  }

  // ── Poll for Telegram confirmation ────────────────────
  function poll() {
    let tries = 0;
    pollTimer = setInterval(async () => {
      if (++tries > 180) {
        clearInterval(pollTimer);
        addMessage('Час вичерпано. Спробуй ще раз.');
        _submitting = false;
        return;
      }
      try {
        const r = await fetch(API + '/api/booking/status/' + currentToken);
        if (!r.ok) return;
        const data = await r.json();
        if (data.status === 'confirmed') {
          clearInterval(pollTimer);
          showSuccess();
        } else if (data.status === 'failed') {
          clearInterval(pollTimer);
          addMessage('Не вдалось: ' + (data.error || 'невідома помилка'));
          _submitting = false;
        }
      } catch {}
    }, 2000);
  }

  // ── Helpers ────────────────────────────────────────────
  function normalizePhone(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    if (d.length === 10 && d.startsWith('0')) return '+380' + d.slice(1);
    if (d.length === 12 && d.startsWith('380')) return '+' + d;
    if (d.length >= 11 && d.length <= 15) return '+' + d;
    return null;
  }

  function toUaIso(date) {
    const d = new Date(date);
    const offMin = -d.getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offMin) % 60).padStart(2, '0');
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${hh}:${mm}`;
  }

  // ── Mount + Event delegation ──────────────────────────
  function mount() {
    const div = document.createElement('div');
    div.innerHTML = html;
    root = div.firstElementChild;
    document.body.appendChild(root);

    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close],[data-action],[data-cat],[data-svc],[data-mst],[data-date],[data-qdate],[data-slot],[data-deeplink]');
      if (!t) return;
      // Prevent double-tap
      if (t.classList.contains('svs-btn-used')) return;

      // Mark parent group as "answered"
      const group = t.closest('.svs-btn-group, .svs-input-group');

      if (t.dataset.close !== undefined) return close();
      if (t.dataset.cat) { disableGroup(group); showCategoryServices(t.dataset.cat); return; }
      if (t.dataset.svc) { disableGroup(group); pickService(t.dataset.svc); return; }
      if (t.dataset.qdate) { disableGroup(group); pickQuickDate(t.dataset.qdate); return; }
      if (t.dataset.date) { disableGroup(group); pickDate(t.dataset.date); return; }
      if (t.dataset.slot != null) { disableGroup(group); pickSlot(Number(t.dataset.slot)); return; }
      if (t.dataset.mst) { disableGroup(group); pickMaster(t.dataset.mst); return; }
      if (t.dataset.action === 'search') { disableGroup(group); showSearch(); return; }
      if (t.dataset.action === 'allDates') { disableGroup(group); showAllDates(); return; }
      if (t.dataset.action === 'confirm') { confirm(); return; }
      if (t.dataset.deeplink) { window.open(t.dataset.deeplink, '_blank'); return; }
    });

    // Open triggers
    document.querySelectorAll('[data-svs-book], a[href*="bookon.ua"]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); open(); });
    });
  }

  function disableGroup(group) {
    if (!group) return;
    group.classList.add('svs-answered');
  }

  // ── Manage booking (same as before) ───────────────────
  async function handleManageUrl() {
    const params = new URLSearchParams(location.search);
    const token = params.get('booking');
    if (!token) return;
    if (!root) mount();
    root.hidden = false;
    document.body.style.overflow = 'hidden';

    clearChat();
    const loader = addLoading();
    try {
      const r = await fetch(API + '/api/booking/info/' + encodeURIComponent(token));
      const info = await r.json();
      removeLoading();
      if (!r.ok) { addMessage('Запис не знайдено 😕'); return; }
      if (info.status === 'used') {
        addMessage(`Запис вже ${info.used_action === 'cancel' ? 'скасовано' : 'перенесено'}.`);
        return;
      }
      const startLocal = new Date(info.start_at).toLocaleString('uk-UA', {
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'
      });
      addMessage(`<div class="svs-summary">
        <div class="svs-summary-row"><span>Послуга:</span> <b>${info.service_name || '—'}</b></div>
        <div class="svs-summary-row"><span>Майстер:</span> <b>${info.master_name || '—'}</b></div>
        <div class="svs-summary-row"><span>Коли:</span> <b>${startLocal}</b></div>
      </div>`);
      addButtons([
        { icon: '✖', label: 'Скасувати', data: `data-action="cancelBooking" data-token="${token}"`, cls: 'svs-btn-danger' },
        { icon: '↻', label: 'Перенести', data: `data-action="reschedule" data-token="${token}"`, cls: 'svs-btn-outline' },
      ]);
    } catch (e) {
      removeLoading();
      addMessage('Помилка: ' + e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount();
    handleManageUrl();
  });
  window.SVSBooking = { open, close };
})();
