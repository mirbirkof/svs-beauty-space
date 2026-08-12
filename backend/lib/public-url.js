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
    if (host) return `${req.protocol}://${host}`;
  }
  return null;
}

module.exports = { getPublicBase };
