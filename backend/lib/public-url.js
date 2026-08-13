'use strict';
/**
 * Единый источник ЖИВОГО публичного адреса CRM.
 *
 * Зачем: 11.08.2026 serveo (постоянный домен zvetlacrm) лёг целиком. CRM работала,
 * но все ссылки — письма сотрудникам, оплата mono (redirect/webhook), кабинет клиента,
 * короткие ссылки маркетинга — вели на мёртвый домен, потому что адрес был зашит
 * в переменной окружения. Смена адреса требовала правки .env + перезапуска прода.
 *
 * Принцип «живая правда»: файл, который ведут САМИ сторожа туннелей, важнее памяти (.env).
 * Сторож поднял канал → записал в tunnel/current-url.txt → все ссылки в системе живые
 * СРАЗУ, без перезапуска.
 *
 * Приоритет:
 *   1) tunnel/current-url.txt  — что реально работает прямо сейчас (пишут ops/*-tunnel.sh)
 *   2) PUBLIC_BASE_URL         — ручное закрепление (если задано и файла нет)
 *   3) адрес входящего запроса — последний рубеж, чтобы ссылка не оказалась пустой
 */
const fs = require('fs');
const path = require('path');

const STATE = path.join(__dirname, '..', '..', 'tunnel', 'current-url.txt');
const TTL_MS = 10_000; // читаем файл не чаще раза в 10с — ссылки строятся часто

let cache = { at: 0, url: null };

function fromFile() {
  const now = Date.now();
  if (now - cache.at < TTL_MS) return cache.url;
  let url = null;
  try {
    const raw = fs.readFileSync(STATE, 'utf8').trim();
    if (/^https?:\/\/\S+$/.test(raw)) url = raw.replace(/\/$/, '');
  } catch { /* файла нет — работаем по env */ }
  cache = { at: now, url };
  return url;
}

/**
 * @param {object} [req] express-запрос (нужен только для последнего рубежа)
 * @returns {string|null} база без хвостового слэша
 */
function getPublicBase(req) {
  const live = fromFile();
  if (live) return live;
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (req && typeof req.get === 'function') {
    const host = req.get('host');
    // Аудит 13.08: Host приходить ВІД КЛІЄНТА і його можна підмінити. Раніше з нього
    // будувалися посилання відновлення пароля, верифікації та redirect оплати — тобто
    // атакуючий міг увести їх на свій домен (host-header injection). Тепер довіряємо
    // Host лише якщо він схожий на НАШУ інфраструктуру, інакше краще null (виклик
    // сам вирішить: пропустити відправку, ніж надіслати посилання на чужий сайт).
    if (host && TRUSTED_HOST_RE.test(String(host))) return `${req.protocol}://${host}`;
    if (host) console.warn('[public-url] недовірений Host у запиті, ігнорую:', host);
  }
  return null;
}

// Свої хости: локальний прод, наш tailscale-фаннел, власні домени салону.
// Можна розширити через TRUSTED_HOSTS (кома-роздільно) без правки коду.
const TRUSTED_HOST_RE = (() => {
  const extra = (process.env.TRUSTED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const base = [
    '127\\.0\\.0\\.1(:\\d+)?', 'localhost(:\\d+)?',
    'zvetlacrm\\.[a-z0-9-]+\\.ts\\.net',
    '(www\\.)?svsbeautyworld\\.com',
    '(www\\.)?svsbeauty\\.com\\.ua',
  ].concat(extra);
  return new RegExp('^(' + base.join('|') + ')$', 'i');
})();

module.exports = { getPublicBase };
