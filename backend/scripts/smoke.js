/* Смоук-тест прода. Гоняется СРАЗУ после деплоя на Render.
   Отвечает на один вопрос: «прод живой или я только что его уронил?».
   Только чтение, без авторизации — бьёт по публичным ручкам.

   Запуск:  node scripts/smoke.js
   Цель:    SMOKE_URL=https://svs-shop-api.onrender.com node scripts/smoke.js */

const BASE = process.env.SMOKE_URL || 'https://svs-shop-api.onrender.com';
const TIMEOUT = 15000;

async function hit(path, { expect = 200, allow = [], want } = {}) {
  const url = BASE + path;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'svs-smoke/1' } });
    const okCode = r.status === expect || allow.includes(r.status);
    let body = '';
    try { body = await r.text(); } catch {}
    const okBody = !want || body.includes(want);
    return { path, status: r.status, okCode, okBody, body: body.slice(0, 200) };
  } catch (e) {
    return { path, status: 0, okCode: false, okBody: false, err: e.name === 'AbortError' ? 'timeout ' + TIMEOUT + 'ms' : e.message };
  } finally { clearTimeout(t); }
}

(async () => {
  const out = [];
  let fails = 0;
  const ok = (m) => out.push('  [+] ' + m);
  const bad = (m) => { out.push('  [-] ' + m); fails++; };

  out.push('━━ СМОУК ПРОДА: ' + BASE + ' ━━');

  // 1. health — сердце живо + какой код реально задеплоен
  const h = await hit('/health', { want: '"ok":true' });
  if (h.okCode && h.okBody) {
    let rev = '?';
    try { rev = JSON.parse(h.body).rev || '?'; } catch {}
    ok(`/health отвечает, задеплоен код: ${rev}`);
  } else bad(`/health не отвечает как надо: ${h.status} ${h.err || h.body}`);

  // 2. админка отдаётся (301 редирект на index или 200) — не 500/404
  const adm = await hit('/admin', { allow: [200, 301, 302, 304] });
  adm.okCode ? ok(`админка отдаётся (${adm.status})`) : bad(`админка битая: ${adm.status} ${adm.err || ''}`);

  // 3. публичный слот-движок отвечает (400 без параметров — ок, 500 — нет)
  const slots = await hit('/api/booking/slots', { expect: 200, allow: [400, 401, 422] });
  slots.okCode ? ok(`слот-движок жив (${slots.status})`) : bad(`слот-движок упал: ${slots.status} ${slots.err || ''}`);

  // 4. каталог услуг публичный (запись клиента зависит от него)
  const cat = await hit('/api/booking/services', { allow: [200, 304, 400, 401] });
  cat.okCode ? ok(`каталог услуг отвечает (${cat.status})`) : bad(`каталог услуг упал: ${cat.status} ${cat.err || ''}`);

  out.push('─'.repeat(42));
  out.push(fails === 0
    ? '  ИТОГ: [+] прод живой, деплой прошёл чисто'
    : `  ИТОГ: [-] прод сломан после деплоя: ${fails} — откатывай/чини`);
  console.log(out.join('\n'));
  process.exit(fails === 0 ? 0 : 1);
})();
