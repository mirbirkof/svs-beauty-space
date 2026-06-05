/* ═══════════════════════════════════════════════════════
   SVS Booking Widget — модалка з верифікацією через Telegram
   Підключити на index.html: <script src="js/booking-widget.js"></script>
   Викликати: window.SVSBooking.open() — або клік по [data-svs-book]
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Backend URL — поміняти на свій домен після переїзду з туннелю
  const API = window.SVS_BOOKING_API || 'https://d513acbd6ad3a4.lhr.life';

  const html = `
    <div id="svs-book-modal" class="svs-book-modal" hidden>
      <div class="svs-book-backdrop" data-close></div>
      <div class="svs-book-dialog" role="dialog" aria-modal="true">
        <button class="svs-book-close" data-close aria-label="Закрити">×</button>
        <div class="svs-book-step" data-step="form">
          <h3>Запис до салону</h3>
          <p class="svs-book-sub">Заповніть форму. Підтвердження через Telegram-бот — захист від фейкових записів.</p>
          <label>Ім'я
            <input type="text" id="svs-book-name" placeholder="Як до вас звертатись?" autocomplete="given-name" required>
          </label>
          <label>Послуга
            <input type="text" id="svs-book-service" placeholder="Наприклад: манікюр, фарбування" required>
          </label>
          <label>Дата і час
            <input type="datetime-local" id="svs-book-date" required>
          </label>
          <label>Коментар (необов'язково)
            <textarea id="svs-book-note" rows="2" placeholder="Побажання, алергії, інше"></textarea>
          </label>
          <button class="svs-book-submit" data-action="init">Підтвердити через Telegram</button>
          <p class="svs-book-hint">Натиснувши кнопку, ви перейдете до бота <b>@Svs_beautybot</b> для підтвердження номера. Без Telegram запис не зберігається.</p>
        </div>
        <div class="svs-book-step" data-step="wait" hidden>
          <h3>Очікуємо підтвердження…</h3>
          <div class="svs-book-spinner"></div>
          <p>У боті натисніть <b>«📱 Поділитись номером»</b>. Після підтвердження ця сторінка оновиться автоматично.</p>
          <a class="svs-book-tg-link" id="svs-book-link" target="_blank" rel="noopener">Відкрити бота повторно</a>
        </div>
        <div class="svs-book-step" data-step="done" hidden>
          <h3>✓ Запис підтверджено</h3>
          <p>Ми чекаємо вас у салоні. До зустрічі!</p>
          <button class="svs-book-submit" data-close>Закрити</button>
        </div>
        <div class="svs-book-step" data-step="error" hidden>
          <h3>Не вдалось зберегти</h3>
          <p id="svs-book-err">Спробуйте ще раз або зателефонуйте: <a href="tel:+380991283375">+380 99 128 33 75</a></p>
          <button class="svs-book-submit" data-action="reset">Спробувати знову</button>
        </div>
      </div>
    </div>`;

  let root, currentToken, pollTimer;

  function $(s, r) { return (r || root).querySelector(s); }
  function show(step) {
    root.querySelectorAll('.svs-book-step').forEach(el => el.hidden = el.dataset.step !== step);
  }
  function open() {
    if (!root) mount();
    root.hidden = false;
    show('form');
    document.body.style.overflow = 'hidden';
  }
  function close() {
    if (!root) return;
    root.hidden = true;
    document.body.style.overflow = '';
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    currentToken = null;
  }
  async function init() {
    const name = $('#svs-book-name').value.trim();
    const service = $('#svs-book-service').value.trim();
    const date = $('#svs-book-date').value;
    const note = $('#svs-book-note').value.trim();
    if (!name || !service || !date) { alert('Заповніть ім\'я, послугу та дату'); return; }

    const from = new Date(date).toISOString();
    const to = new Date(new Date(date).getTime() + 60 * 60 * 1000).toISOString();

    try {
      const r = await fetch(API + '/api/booking/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: 'desc:' + service,
          employee_id: 'auto',
          date_from: from,
          date_to: to,
          client_name: name,
          note,
        }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'init failed');
      currentToken = data.token;
      $('#svs-book-link').href = data.deep_link;
      window.open(data.deep_link, '_blank', 'noopener');
      show('wait');
      startPolling();
    } catch (e) {
      $('#svs-book-err').textContent = 'Помилка: ' + e.message;
      show('error');
    }
  }
  function startPolling() {
    let tries = 0;
    pollTimer = setInterval(async () => {
      if (++tries > 180) { clearInterval(pollTimer); show('error'); $('#svs-book-err').textContent = 'Час очікування вичерпано. Спробуйте ще раз.'; return; }
      try {
        const r = await fetch(API + '/api/booking/status/' + currentToken);
        if (!r.ok) return;
        const data = await r.json();
        if (data.status === 'confirmed') { clearInterval(pollTimer); show('done'); }
        else if (data.status === 'failed') { clearInterval(pollTimer); $('#svs-book-err').textContent = 'CRM: ' + (data.error || 'невідома помилка'); show('error'); }
      } catch {}
    }, 2000);
  }
  function reset() { show('form'); }

  function mount() {
    const div = document.createElement('div');
    div.innerHTML = html;
    root = div.firstElementChild;
    document.body.appendChild(root);
    root.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.close !== undefined) close();
      if (t.dataset.action === 'init') init();
      if (t.dataset.action === 'reset') reset();
    });
    // подтянуть на любые кнопки записи
    document.querySelectorAll('[data-svs-book], a[href*="bookon.ua"]').forEach(a => {
      a.addEventListener('click', (e) => { e.preventDefault(); open(); });
    });
  }

  document.addEventListener('DOMContentLoaded', mount);
  window.SVSBooking = { open, close };
})();
