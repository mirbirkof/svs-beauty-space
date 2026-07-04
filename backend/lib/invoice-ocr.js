/* ═══════════════════════════════════════════════════════════════
   OCR накладних: фото/скріншот/PDF → рядки товарів через Gemini vision.
   Вимога Босса 04.07.2026: «для системи не повинно бути різниці,
   з якого формату витягнути дані».

   ocrInvoice(buffer, mimeType) → { items:[{name, qty, price}], doc_date|null }
   Кидає Error з людським message при збої — /parse віддасть його оператору.
   ═══════════════════════════════════════════════════════════════ */

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']; // основна → запасна (у 2.0 нульова квота — перевірено 04.07)
const TIMEOUT_MS = 60000;

const PROMPT = `Це фото/скан накладної (документ постачання товарів салону краси, українською або російською).
Витягни ВСІ рядки товарів. Поверни ЛИШЕ валідний JSON без пояснень і без markdown:
{"doc_date":"YYYY-MM-DD або null якщо дати нема",
 "items":[{"name":"назва товару як в документі","qty":число_кількість_упаковок,"price":число_ціна_за_одиницю_або_null}]}
Правила:
- qty = кількість УПАКОВОК/штук з колонки кількості (не сума, не вага).
- price = ціна за ОДНУ одиницю (не сума рядка). Якщо є лише сума рядка — подели суму на кількість.
- Ігноруй підсумкові рядки (Разом, Всього, ПДВ), шапки таблиць, реквізити.
- Назви НЕ перекладай і НЕ скорочуй.
- doc_date — дата САМОЇ накладної з документа (не сьогодні).`;

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
          generationConfig: { temperature: 0, maxOutputTokens: 8192 },
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
  // від першої { до останньої }
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
      if (!items.length) throw new Error('не знайшов товарних рядків');
      const doc_date = /^\d{4}-\d{2}-\d{2}$/.test(String(data.doc_date || '')) ? data.doc_date : null;
      return { items, doc_date, model };
    } catch (e) {
      lastErr = e;
      console.error(`[invoice-ocr] ${model}: ${e.message?.slice(0, 150)}`);
      // 429/квота/недоступність → пробуємо наступну модель; інші помилки теж (одна спроба на модель)
    }
  }
  throw new Error('Не вдалося розпізнати фото накладної (' + (lastErr?.message?.slice(0, 100) || 'помилка AI') + '). Спробуйте чіткіше фото або надішліть текст/Excel.');
}

module.exports = { ocrInvoice };
