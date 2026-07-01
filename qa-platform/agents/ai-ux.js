/* AI UX Tester. Live-проверка кнопок/форм/drag&drop требует браузера (Playwright) и достижимого
   UI — это needs-manual до staging. В safe-режиме делаем СТАТИЧЕСКИЙ скан админки: парсинг всех
   <script>, поиск nav-пунктов без страницы и обработчиков без функции.
   ДОПОЛНИТЕЛЬНО: если задан cfg.stagingApi и /health отвечает — делаем РЕАЛЬНЫЕ HTTP-проверки
   страниц админки против staging БЕЗ браузера (статус 200, не пусто, content-type, битые ссылки
   на /admin/*.html и локальные скрипты/стили). Реальные баги, ноль мутаций (только GET/HEAD). */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const ADMIN_DIR = path.join(__dirname, '../../backend/public/admin');
const ADMIN = path.join(ADMIN_DIR, 'index.html');

// fetch с таймаутом 8с через AbortController (Node 22 native fetch)
async function httpGet(url, { method = 'GET' } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: ac.signal });
    let body = '';
    if (method === 'GET') { try { body = await res.text(); } catch (_) { body = ''; } }
    return { ok: true, status: res.status, ct: res.headers.get('content-type') || '', body };
  } catch (e) {
    return { ok: false, status: 0, ct: '', body: '', error: e && e.name === 'AbortError' ? 'timeout(8s)' : String(e && e.message || e) };
  } finally { clearTimeout(t); }
}

// извлечь локальные ссылки/ассеты из HTML: /admin/*.html и локальные .js/.css.
// Шаблонные (${...} или конкатенация '+ +') и внешние (http, //, data:, #, tel:, mailto:, sms:) — пропускаем.
function extractLocalRefs(html) {
  const refs = new Set();
  const re = /(?:href|src)\s*=\s*"([^"]+)"/gi; let m;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    if (raw.includes('${') || raw.includes("'+") || raw.includes('+"')) continue; // JS-генерируемое
    if (/^(https?:)?\/\//i.test(raw)) continue; // абсолютные/протокол-относительные
    if (/^(data:|tel:|mailto:|sms:|javascript:|#)/i.test(raw)) continue;
    const clean = raw.split('#')[0].split('?')[0];
    if (!clean || clean === '/') continue;
    const isAdminHtml = /^\/admin\/[a-z0-9._/-]+\.html$/i.test(clean);
    const isLocalAsset = /^\/[a-z0-9._/-]+\.(?:js|css)$/i.test(clean);
    if (isAdminHtml || isLocalAsset) refs.add(clean);
  }
  return [...refs];
}

const ERROR_MARKERS = [
  'Cannot GET', 'Cannot POST', 'ReferenceError', 'is not defined',
  'Internal Server Error', 'Application Error', '502 Bad Gateway', '503 Service',
];

async function liveHttpAudit(base, out) {
  const { bugs, scenarios, coverage } = out;
  scenarios.push('ux:live-http');
  const origin = base.replace(/\/+$/, '');

  // список html-файлов берём С ДИСКА, проверяем по HTTP против staging
  let files = [];
  try { files = fs.readdirSync(ADMIN_DIR).filter((f) => f.endsWith('.html')); } catch (_) { files = []; }

  const checkedRefs = new Map(); // url -> status (кэш, чтобы не дёргать общие ассеты 28 раз)
  async function refStatus(pathname) {
    if (checkedRefs.has(pathname)) return checkedRefs.get(pathname);
    const r = await httpGet(origin + pathname, { method: 'GET' });
    const st = r.ok ? r.status : 0;
    checkedRefs.set(pathname, st);
    return st;
  }

  let pagesOk = 0, ctOk = 0, refsOk = 0;
  const pageTotal = files.length;

  for (const file of files) {
    const url = `${origin}/admin/${file}`;
    scenarios.push(`ux:page:${file}`);
    const r = await httpGet(url, { method: 'GET' });

    // а) страница отвечает 200 и не пустая
    if (!r.ok) {
      bugs.push({ severity: 'high', module: 'ux', role: 'ux',
        title: `Страница админки недоступна: /admin/${file}`, scenario: `GET ${url}`,
        expected: 'HTTP 200 с HTML', actual: `сеть/таймаут: ${r.error}`, stillBroken: true });
      continue;
    }
    if (r.status !== 200) {
      bugs.push({ severity: r.status >= 500 ? 'critical' : 'high', module: 'ux', role: 'ux',
        title: `Страница админки отдаёт ${r.status}: /admin/${file}`, scenario: `GET ${url}`,
        expected: 'HTTP 200', actual: `HTTP ${r.status}`, stillBroken: true });
      continue;
    }
    if (!r.body || r.body.trim().length < 50) {
      bugs.push({ severity: 'high', module: 'ux', role: 'ux',
        title: `Пустой ответ страницы: /admin/${file}`, scenario: `GET ${url}`,
        expected: 'непустой HTML', actual: `${r.body ? r.body.trim().length : 0} байт`, stillBroken: true });
      continue;
    }
    pagesOk++;
    coverage.push(['ux', `page-200:${file}`, true]);

    // б) content-type для .html — text/html
    if (/text\/html/i.test(r.ct)) ctOk++;
    else bugs.push({ severity: 'low', module: 'ux', role: 'ux',
      title: `Неверный content-type страницы: /admin/${file}`, scenario: `GET ${url}`,
      expected: 'text/html', actual: r.ct || '(пусто)', stillBroken: true });

    // в) базовая целостность: есть <script>, нет маркеров ошибки рендера
    const hasScript = /<script[\s>]/i.test(r.body);
    const marker = ERROR_MARKERS.find((mk) => r.body.includes(mk));
    if (!hasScript) bugs.push({ severity: 'low', module: 'ux', role: 'ux',
      title: `Страница без <script> (подозрение на битый рендер): /admin/${file}`, scenario: `целостность ${file}`,
      expected: '<script> присутствует', actual: 'нет ни одного <script>', stillBroken: true });
    if (marker) bugs.push({ severity: 'high', module: 'ux', role: 'ux',
      title: `Маркер ошибки в HTML страницы: /admin/${file}`, scenario: `целостность ${file}`,
      expected: 'нет маркеров ошибки рендера', actual: `найдено: "${marker}"`, stillBroken: true });

    // г) битые ссылки: /admin/*.html и локальные .js/.css → должны быть 200
    const refs = extractLocalRefs(r.body);
    for (const ref of refs) {
      const st = await refStatus(ref);
      if (st === 200) { refsOk++; continue; }
      bugs.push({ severity: st === 404 ? 'high' : 'medium', module: 'ux', role: 'ux',
        title: `Битая ссылка на /admin/${file}: ${ref} (${st || 'сеть/таймаут'})`,
        scenario: `ссылка ${ref} со страницы ${file}`,
        expected: 'ресурс отвечает 200', actual: st ? `HTTP ${st}` : 'нет ответа', stillBroken: true });
    }
  }

  coverage.push(['ux', 'live-pages-200', pageTotal > 0 && pagesOk === pageTotal]);
  coverage.push(['ux', 'live-content-type-ok', pagesOk > 0 && ctOk === pagesOk]);
  coverage.push(['ux', 'no-broken-links', [...checkedRefs.values()].every((s) => s === 200)]);
}

module.exports = {
  name: 'ai-ux', role: 'ux',
  async run({ regression } = {}) {
    const bugs = [], scenarios = [], coverage = [];
    let html = '';
    try { html = fs.readFileSync(ADMIN, 'utf8'); } catch (_) {
      return { scenarios: ['ux:admin-missing'], bugs: [{ severity: 'low', module: 'ux', role: 'ux', title: 'admin/index.html не найден', needsManual: true, manualReason: 'нет доступа к файлу админки' }], coverage: [] };
    }

    // 1) Все <script> синтаксически валидны (ловит JS-ошибки, ломающие интерфейс)
    scenarios.push('ux:js-syntax');
    let badScripts = 0;
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) { const code = m[1]; if (!code.trim()) continue; try { new Function(code); } catch (_) { badScripts++; } }
    if (badScripts > 0) bugs.push({ severity: 'critical', module: 'ux', role: 'ux',
      title: 'JS-ошибка в админке (битый <script> ломает интерфейс)', scenario: 'парсинг всех script-блоков',
      expected: '0 ошибок', actual: `${badScripts} битых блоков`, stillBroken: true });
    coverage.push(['ux', 'js-syntax-clean', badScripts === 0]);

    // 2) Nav-пункты go('X') без соответствующей страницы page-X (мёртвая кнопка меню)
    scenarios.push('ux:dead-nav');
    const pages = new Set([...html.matchAll(/id="page-([a-z0-9_-]+)"/gi)].map((x) => x[1]));
    const navs = [...html.matchAll(/go\('([a-z0-9_-]+)'\)/gi)].map((x) => x[1]);
    const dead = [...new Set(navs)].filter((n) => !pages.has(n) && n !== 'embed');
    if (dead.length) bugs.push({ severity: 'high', module: 'ux', role: 'ux',
      title: `Пункты меню без страницы (мёртвые кнопки): ${dead.join(', ')}`, scenario: "go('X') без page-X",
      expected: 'у каждого пункта есть страница', actual: `мёртвые: ${dead.join(', ')}`, stillBroken: true });
    coverage.push(['ux', 'no-dead-nav', dead.length === 0]);

    // 3) РЕАЛЬНЫЕ HTTP-проверки против staging (без браузера), если задан stagingApi и /health жив
    let liveDone = false;
    if (cfg.stagingApi) {
      const base = cfg.stagingApi.replace(/\/+$/, '');
      const health = await httpGet(base + '/health', { method: 'GET' });
      if (health.ok && health.status === 200) {
        await liveHttpAudit(base, { bugs, scenarios, coverage });
        liveDone = true;
      } else {
        scenarios.push('ux:live-http-skip');
        bugs.push({ severity: 'low', module: 'ux', role: 'ux',
          title: 'Staging /health недоступен — HTTP-проверки страниц не выполнены',
          scenario: `GET ${base}/health`, expected: 'HTTP 200',
          actual: health.ok ? `HTTP ${health.status}` : (health.error || 'нет ответа'),
          needsManual: true, manualReason: 'staging задан, но /health не отвечает 200' });
      }
    }

    // 4) Live-UI (клики, формы, drag&drop, адаптив, HAR) — честно требует браузера (Playwright).
    //    HTTP-проверяемое (статусы/ссылки/целостность) уже проверено реально выше.
    if (!regression && !cfg.allowDestructive) {
      bugs.push({ severity: 'low', module: 'ux', role: 'ux',
        title: 'Live-UI тесты (клики/формы/drag&drop/адаптив) не выполнены',
        needsManual: true,
        manualReason: liveDone
          ? 'HTTP-проверки страниц/ссылок/целостности выполнены против staging. Живые клики/формы/drag&drop требуют Playwright.'
          : 'Требует Playwright и достижимого UI-таргета (staging). Статический скан JS+nav выполнен.' });
    }
    return { scenarios, bugs, coverage };
  },
};
