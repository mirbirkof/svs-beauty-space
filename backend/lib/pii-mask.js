/* lib/pii-mask.js — телефоны и email клиентов НЕ уходят во внешний ИИ (аудит 23.10, п.1).
   Перед отправкой: каждый номер/почта → метка [ТЕЛ_1] / [EMAIL_1] (одинаковое значение = одна метка).
   После ответа: метки в тексте модели возвращаются в настоящие значения — ЛОКАЛЬНО, на нашем сервере.
   Зачем обратимо: ИИ-менеджер ищет клиента «за номером» — модель видит [ТЕЛ_1], пишет его в аргумент
   инструмента, а CRM при разборе ответа подставляет настоящий номер и ищет в своей базе.
   Наружу (провайдеру) ни номер, ни почта не попадают ни в каком направлении. */

// Украинские/международные номера: +380 67 123 45 67, 380671234567, (067) 123-45-67, 0671234567.
// Требуем «0XX» оператора + 7 цифр и границы по цифрам — цены, даты, id и суммы не задеваются.
const PHONE_UA = /(?<![\d+])(?:\+?3\s?8\s?)?\(?0\d{2}\)?[\s\-.]?\d{3}[\s\-.]?\d{2}[\s\-.]?\d{2}(?!\d)/g;
// Прочие международные с явным «+»: +48 123 456 789, +1 (555) 123-4567
const PHONE_INTL = /\+\d[\d\s\-()]{8,16}\d(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function createMasker() {
  const byValue = new Map();   // нормализованное значение → метка
  const byToken = new Map();   // метка → исходный текст
  let nPhone = 0, nEmail = 0;

  function tokenFor(kind, raw) {
    const key = kind === 'TEL' ? raw.replace(/\D/g, '').replace(/^0/, '380') : raw.toLowerCase();
    if (byValue.has(key)) return byValue.get(key);
    const t = kind === 'TEL' ? `[ТЕЛ_${++nPhone}]` : `[EMAIL_${++nEmail}]`;
    // Телефон возвращаем в каноне базы (380XXXXXXXXX, миграция 200) — так поиск get_client
    // (phone ILIKE) совпадает с clients.phone независимо от того, как номер был набран.
    byValue.set(key, t); byToken.set(t, kind === 'TEL' ? key : raw);
    return t;
  }

  function mask(text) {
    if (text == null) return text;
    let s = String(text);
    s = s.replace(EMAIL, (m) => tokenFor('EMAIL', m));
    s = s.replace(PHONE_UA, (m) => tokenFor('TEL', m.trim()));
    s = s.replace(PHONE_INTL, (m) => tokenFor('TEL', m.trim()));
    return s;
  }

  function unmask(text) {
    if (text == null || !byToken.size) return text;
    return String(text).replace(/\[(?:ТЕЛ|EMAIL)_\d+\]/g, (t) => (byToken.has(t) ? byToken.get(t) : t));
  }

  return { mask, unmask, get count() { return byToken.size; } };
}

module.exports = { createMasker };
