/* ═══════════════════════════════════════════════════════════════
   OCR накладних: фото/скріншот/PDF → рядки товарів через Gemini vision.
   Вимога Босса 04.07.2026: «для системи не повинно бути різниці,
   з якого формату витягнути дані». Дата/номер/постачальник/підсумок —
   визначаються самі, ручне введення не потрібне.

   ocrInvoice(buffer, mimeType) →
     { items:[{name,qty,price}], doc_date, doc_number, supplier, total_sum, model }
   Кидає Error з людським message при збої — /parse віддасть його оператору.
   ═══════════════════════════════════════════════════════════════ */

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; // у 2.0 нульова квота (перевірено 04.07)
const TIMEOUT_MS = 75000;
const ATTEMPTS_PER_MODEL = 3; // Google буває перевантажений (503 high load) — чекаємо і повторюємо
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROMPT = `Ти читаєш НАКЛАДНУ (видаткова/прибуткова, товарний документ, укр/рос мовою).
Це може бути: чисте фото документа, скан, PDF, АБО СКРІНШОТ ЕКРАНА, де накладна відкрита у вікні програми/браузера.
Якщо це скріншот екрана — знайди область самої накладної та читай ЛИШЕ її. Панелі, меню, кнопки, іконки, курсор — ІГНОРУЙ ПОВНІСТЮ.

Поверни ЛИШЕ валідний JSON:
{"doc_number":"номер документа (напр. 86702) або null",
 "doc_date":"дата САМОЇ накладної YYYY-MM-DD або null",
 "supplier":"продавець/постачальник або null",
 "total_sum":число_підсумкова_сума_документа_або_null,
 "items":[{"name":"назва товару ЯК У ДОКУМЕНТІ","qty":число,"price":число_або_null}]}

Правила:
- items: КОЖЕН товарний рядок таблиці. Не пропускай рядки, навіть якщо частково видно.
- qty = кількість УПАКОВОК/штук з колонки кількості (к-ть/кол-во/шт).
- price = ціна за ОДНУ одиницю. Якщо в документі лише сума рядка — подели суму на кількість.
- Підсумкові рядки (Разом/Всього/Итого/ПДВ), шапки таблиці, реквізити — НЕ товари, у items їх не клади.
- total_sum — підсумок ІЗ ДОКУМЕНТА (рядок Разом/Всього), не рахуй сам.
- Назви товарів НЕ перекладай, НЕ скорочуй.
- doc_date — дата документа (біля номера, «від ...»), НЕ сьогоднішня.`;

async function callGemini(model, base64, mimeType, apiKey) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: base64 } }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 32768,
            responseMimeType: 'application/json', // Gemini повертає чистий JSON без ```фенсів
          },
        }),
      });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = body?.error?.message || `HTTP ${r.status}`;
      const e = new Error(msg); e.status = r.status; throw e;
    }
    return body?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  } finally { clearTimeout(t); }
}

function parseJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

async function ocrInvoice(buffer, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Розпізнавання фото не налаштоване (нема ключа AI). Надішліть Excel/CSV або текст.');
  const base64 = buffer.toString('base64');
  let lastErr = null;
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const raw = await callGemini(model, base64, mimeType, apiKey);
        const data = parseJson(raw);
        const items = (Array.isArray(data.items) ? data.items : [])
          .map(it => ({
            name: String(it.name || '').trim().slice(0, 200),
            qty: Number.isFinite(Number(it.qty)) ? Number(it.qty) : null,
            price: Number.isFinite(Number(it.price)) ? Number(it.price) : null,
          }))
          .filter(it => it.name.length >= 3);
        if (!items.length) { lastErr = new Error('не знайшов товарних рядків'); break; } // повтор не допоможе — далі інша модель
        return {
          items,
          doc_date: /^\d{4}-\d{2}-\d{2}$/.test(String(data.doc_date || '')) ? data.doc_date : null,
          doc_number: data.doc_number ? String(data.doc_number).slice(0, 40) : null,
          supplier: data.supplier ? String(data.supplier).slice(0, 120) : null,
          total_sum: Number.isFinite(Number(data.total_sum)) ? Number(data.total_sum) : null,
          model,
        };
      } catch (e) {
        lastErr = e;
        console.error(`[invoice-ocr] ${model} (спроба ${attempt}): ${e.message?.slice(0, 150)}`);
        // квота/ключ — повтор тією ж моделлю безглуздий, одразу наступна
        if (e.status === 429 || e.status === 403 || /quota|api key/i.test(e.message || '')) break;
        // перевантаження Google (503 / high load / overloaded) — почекати і повторити
        if (attempt < ATTEMPTS_PER_MODEL) {
          const overloaded = e.status === 503 || /overload|high (load|demand)|currently experiencing|try again/i.test(e.message || '');
          await sleep(overloaded ? 5000 * attempt : 1500);
        }
      }
    }
  }
  const overloaded = lastErr && (lastErr.status === 503 || /overload|high (load|demand)|currently experiencing|try again/i.test(lastErr.message || ''));
  if (overloaded)
    throw new Error('ШІ-розпізнавання тимчасово перевантажене (Google). Зачекайте 1-2 хвилини і натисніть «Розібрати» ще раз — файл перевантажувати не треба.');
  throw new Error('Не вдалося розпізнати накладну (' + (lastErr?.message?.slice(0, 100) || 'помилка AI') + '). ' +
    'Спробуйте: обрізати скріншот до самої накладної, чіткіше фото без тіней, або надішліть текст/Excel.');
}

module.exports = { ocrInvoice };
