/* ───────────────────────────────────────────────────────────────
   Единая нормализация телефона под ФОРМАТ ХРАНЕНИЯ в clients.phone.
   Канон базы (проверено на живых данных: 5171/5176 записей) = '380XXXXXXXXX'
   БЕЗ ведущего '+'. Любой ввод человека приводим к этому виду, чтобы
   не плодить второй формат и не создавать дубли клиентов (аудит #31).

   Возвращает:
   - канон '380XXXXXXXXX' (12 цифр) для валидного украинского номера
   - null, если телефон пустой
   - нераспознанный (иностранный/другая длина) — как есть, только без
     пробелов/скобок/дефисов; '+' сохраняем, чтобы НЕ калечить номер (#107)
   ─────────────────────────────────────────────────────────────── */
// Достраивает украинский номер до канонических 12 цифр (380XXXXXXXXX).
// 0XXXXXXXXX / XXXXXXXXX / 80XXXXXXXXX → 380XXXXXXXXX. Иностранные — цифры как есть.
function toCanonDigits(p) {
  if (p == null) return null;
  const d = String(p).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 12 && d.startsWith('380')) return d;
  if (d.length === 11 && d.startsWith('80')) return '3' + d;
  if (d.length === 10 && d.startsWith('0')) return '38' + d;
  if (d.length === 9) return '380' + d;
  return d;
}

// ФОРМАТ ХРАНЕНИЯ (не трогаем — канон без '+', матчинг по цифрам, аудит #31).
function normalizePhoneDb(p) {
  if (p == null) return null;
  const d = String(p).replace(/\D/g, '');
  if (!d) return null;
  const c = toCanonDigits(p);
  if (c && (c.length === 12 && c.startsWith('380'))) return c;   // достроенный украинский
  return String(p).trim().replace(/[\s()\-.]/g, '').replace(/^\+/, ''); // прочее — без разделителей и без '+'
}

// ФОРМАТ ПОКАЗА (бот, админка, экспорт): всегда полный, с '+'. '+380XXXXXXXXX'.
function fmtPhoneFull(p) {
  const c = toCanonDigits(p);
  return c ? '+' + c : '—';
}

module.exports = { normalizePhoneDb, fmtPhoneFull, toCanonDigits };
