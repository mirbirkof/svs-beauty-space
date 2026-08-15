/* ops/qa-login.mjs — РЕАЛЬНЫЙ вход в CRM для автотестов (15.08, по замечанию Босса).
 *
 * ПРИЧИНА: ui-explore.mjs/ui-smoke.mjs/ui-fuzz.mjs клали в localStorage
 * svs_admin_token=ADMIN_TOKEN напрямую. Админка (index.html) считает валидным входом
 * только ответ 200 от /api/users/me с этим токеном — а ADMIN_TOKEN как X-Admin-Token
 * это легаси-«владелец без пароля» (см. backend/lib/rbac.js resolveUserByToken), он
 * НЕ равен JWT сессии сотрудника, который выдаёт /api/auth/staff/login-password.
 * На части окружений (в частности там, где ADMIN_TOKEN_BOOTSTRAP_ONLY эффективно уже
 * не пропускает legacy-токен, либо контекст оказывается tenant-scoped) checkToken()
 * получает 401/403 → localStorage чистится → браузер стоит на экране логина, а все
 * «зелёные» проверки на самом деле били мимо интерфейса напрямую через api().
 *
 * Что делает этот модуль: настоящий POST /api/auth/staff/login-password (phone+password),
 * кладёт в localStorage ПРАВИЛЬНУЮ пару svs_admin_token (JWT) + svs_user (профиль) —
 * ровно то, что кладёт своя же форма логина (index.html:165).
 */
import http from 'node:http';
import https from 'node:https';

export function staffLogin(base, phone, password) {
  const url = new URL('/api/auth/staff/login-password', base);
  const body = JSON.stringify({ phone, password });
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let j;
        try { j = JSON.parse(d); } catch { return reject(new Error(`логин: не JSON (${res.statusCode}) ${d.slice(0, 160)}`)); }
        if (res.statusCode !== 200 || !j.token) {
          return reject(new Error(`логин провалился: ${res.statusCode} ${j.error || d.slice(0, 160)}`));
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('логин: таймаут')); });
    req.write(body);
    req.end();
  });
}

// Кладёт настоящую сессию сотрудника в localStorage страницы Playwright.
// Бросает исключение при неудаче — вызывающий код решает, падать или откатываться.
export async function loginIntoPage(page, base, phone, password) {
  if (!phone || !password) throw new Error('нет phone/password для реального входа (QA_FUZZ_PHONE/QA_FUZZ_PASSWORD или QA_UI_PHONE/QA_UI_PASSWORD)');
  const { token, user } = await staffLogin(base, phone, password);
  await page.goto(base + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ t, u }) => {
    localStorage.setItem('svs_admin_token', t);
    localStorage.setItem('svs_user', JSON.stringify(u));
  }, { t: token, u: user });
  // КРИТИЧНО: index.html читает localStorage только в window.addEventListener('DOMContentLoaded')
  // при загрузке страницы. Первый goto случился ДО того, как токен записан — тот бутстрап
  // уже отработал с пустым localStorage и показал экран логина. Второй goto — полноценная
  // перезагрузка (не просто смена #hash, которая была бы same-document навигацией без
  // повторного DOMContentLoaded), которая подхватывает записанный токен.
  await page.goto(base + '/admin/', { waitUntil: 'networkidle' });
  return { token, user };
}
