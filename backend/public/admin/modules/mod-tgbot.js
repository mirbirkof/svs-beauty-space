/* ═══ UI-модуль: ТГ-бот запису (SaaS, самопідключення) ══════════════════════
 * Сторінка групи «Платформа»: салон вставляє токен свого бота від BotFather —
 * система сама перевіряє токен і реєструє вебхук. Одна кнопка «Підключити».
 * API: GET/POST/DELETE /api/bot-connect
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  var esc = window.modEsc, empty = window.modEmpty, errEl = window.modErr;

  window.registerModule({
    page: 'tgbot',
    title: 'ТГ-бот запису',
    group: 'platform',
    icon: 'smart_toy',
    section:
      '<div style="background:#f0f4ff;border:1px solid #d8e0ff;border-radius:12px;padding:14px 16px;margin-bottom:16px;font-size:13.5px;line-height:1.6;color:#33415c">' +
        '<b>Свій Telegram-бот для онлайн-запису.</b> Клієнти записуються, підтверджують візити та отримують нагадування через бота ВАШОГО салону.<br>' +
        'Як підключити: 1) відкрийте <b>@BotFather</b> у Telegram → <b>/newbot</b> → дайте імʼя (2 хвилини); ' +
        '2) скопіюйте токен (виглядає як <code>123456789:AAF3k...</code>); 3) вставте його нижче і натисніть «Підключити». Все інше зробимо самі.' +
      '</div>' +
      '<div id="tgbot-status" class="card" style="padding:18px;margin-bottom:16px">' + empty('Завантаження…') + '</div>' +
      '<div class="card" style="padding:18px">' +
        '<h3 style="margin:0 0 12px;font-size:15px;font-weight:700">Підключення бота</h3>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
          '<input id="tgbot-token" type="password" placeholder="Токен від BotFather" autocomplete="off" ' +
            'style="flex:1;min-width:260px;padding:9px 12px;border:1px solid #ddd;border-radius:8px;font-size:13.5px">' +
          '<button id="tgbot-connect" style="padding:9px 22px;background:#1a73e8;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13.5px;font-weight:600">Підключити</button>' +
        '</div>' +
        '<div id="tgbot-msg" style="margin-top:10px;font-size:13px"></div>' +
      '</div>',
    loader: async function () {
      var stEl = document.getElementById('tgbot-status');
      var msgEl = document.getElementById('tgbot-msg');
      var btn = document.getElementById('tgbot-connect');
      var inp = document.getElementById('tgbot-token');

      async function refresh() {
        if (stEl) stEl.innerHTML = empty('Завантаження…');
        try {
          var s = await window.modApi('/api/bot-connect');
          if (s && s.error) throw new Error(s.error);
          if (!s.connected) {
            stEl.innerHTML =
              '<div style="display:flex;align-items:center;gap:10px">' +
                '<span class="material-icons-round" style="color:#d9534f">link_off</span>' +
                '<div><b>Бот не підключено.</b><div style="font-size:12.5px;color:#888">Онлайн-запис через Telegram неактивна — підключіть бота нижче.</div></div>' +
              '</div>';
            return;
          }
          var own = s.source === 'own';
          stEl.innerHTML =
            '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
              '<span class="material-icons-round" style="color:#2e9e5b;font-size:28px">check_circle</span>' +
              '<div style="flex:1;min-width:220px">' +
                '<b>Підключено: @' + esc(s.bot_username || '—') + '</b>' +
                '<div style="font-size:12.5px;color:#888">' +
                  (own ? 'Власний бот салону' : 'Бот платформи (за замовчуванням)') +
                  (s.connected_at ? ' · з ' + new Date(s.connected_at).toLocaleDateString('uk-UA') : '') +
                '</div>' +
              '</div>' +
              '<a href="https://t.me/' + esc(s.bot_username || '') + '" target="_blank" style="padding:7px 14px;border:1px solid #1a73e8;color:#1a73e8;border-radius:8px;font-size:12.5px;text-decoration:none">Відкрити бота</a>' +
              (own ? '<button id="tgbot-disconnect" style="padding:7px 14px;border:1px solid #d9534f;color:#d9534f;background:#fff;border-radius:8px;cursor:pointer;font-size:12.5px">Відключити</button>' : '') +
            '</div>';
          var dbtn = document.getElementById('tgbot-disconnect');
          if (dbtn) dbtn.addEventListener('click', async function () {
            if (!confirm('Відключити бота? Онлайн-запис через Telegram перестане працювати.')) return;
            dbtn.disabled = true;
            try {
              var r = await window.modApi('/api/bot-connect', { method: 'DELETE' });
              if (r && r.error) throw new Error(r.error);
              await refresh();
            } catch (e) { alert('Помилка: ' + e.message); dbtn.disabled = false; }
          });
        } catch (e) { errEl(stEl, e); }
      }

      if (btn && !btn._bound) {
        btn._bound = true;
        btn.addEventListener('click', async function () {
          var token = (inp && inp.value || '').trim();
          if (!token) { msgEl.innerHTML = '<span style="color:#d9534f">Вставте токен від BotFather.</span>'; return; }
          btn.disabled = true; btn.textContent = 'Підключаю…';
          msgEl.innerHTML = '<span style="color:#888">Перевіряю токен і реєструю вебхук…</span>';
          try {
            var r = await window.modApi('/api/bot-connect', { method: 'POST', body: JSON.stringify({ token: token }) });
            if (r && r.error) throw new Error(r.error);
            msgEl.innerHTML = '<span style="color:#2e9e5b"><b>Готово!</b> Бот @' + esc(r.bot_username) + ' підключено — онлайн-запис уже працює через нього.</span>';
            if (inp) inp.value = '';
            await refresh();
          } catch (e) {
            msgEl.innerHTML = '<span style="color:#d9534f">' + esc(e.message || 'Помилка підключення') + '</span>';
          } finally {
            btn.disabled = false; btn.textContent = 'Підключити';
          }
        });
      }

      await refresh();
    }
  });
})();
