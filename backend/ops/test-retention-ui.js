/* Перевірка вкладки «Апсейл і повернення» в реальному браузері. */
require('dotenv').config();
const { chromium } = require('playwright');
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3037';

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 160)));

  await page.goto(BASE + '/admin/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('svs_admin_token', t), process.env.ADMIN_TOKEN);
  // reload обов'язковий: TOKEN зчитується при парсингу, перехід по якорю сторінку не перезавантажує
  await page.goto(BASE + '/admin/#retention', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  const menu = await page.locator('.sidebar-item[data-page="retention"]').count();
  const kpi = await page.locator('#retKpi .kpi-card').count();
  const rows = await page.locator('#retBody tr').count();
  const norms = (await page.locator('#retNorms').textContent().catch(() => '')) || '';
  const firstRow = (await page.locator('#retBody tr').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
  await page.screenshot({ path: '/tmp/ret-1-main.png', fullPage: false });

  // друга вкладка
  await page.click('.ret-tab[data-seg="color_no_nail"]');
  await page.waitForTimeout(2500);
  const rows2 = await page.locator('#retBody tr').count();
  const head2 = (await page.locator('#retHead').innerText().catch(() => '')).replace(/\s+/g, ' ');
  await page.screenshot({ path: '/tmp/ret-2-color.png' });

  // прострочка
  await page.click('.ret-tab[data-seg="lapsed_nail"]');
  await page.waitForTimeout(2500);
  const rows3 = await page.locator('#retBody tr').count();
  await page.screenshot({ path: '/tmp/ret-3-lapsed.png' });

  // пошук
  await page.fill('#retSearch', 'ол');
  await page.waitForTimeout(600);
  const rowsSearch = await page.locator('#retBody tr').count();
  await page.fill('#retSearch', '');
  await page.waitForTimeout(400);

  // картка клієнта з мітками
  let cardTags = '';
  try {
    await page.click('.ret-tab[data-seg="color_no_nail"]');
    await page.waitForTimeout(1500);
    await page.locator('#retBody tr a').first().click();
    await page.waitForTimeout(3000);
    cardTags = (await page.locator('#ccUpsellTags').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await page.screenshot({ path: '/tmp/ret-4-card.png' });
  } catch (e) { cardTags = 'ERR ' + e.message.slice(0, 80); }

  console.log(JSON.stringify({
    menu_item: menu, kpi_cards: kpi, rows_seg1: rows - 0, rows_seg2: rows2, rows_lapsed: rows3,
    rows_after_search: rowsSearch, norms_line: norms.slice(0, 120), first_row: firstRow,
    head_seg2: head2.slice(0, 140), card_tags: cardTags.slice(0, 120), console_errors: errors.slice(0, 6),
  }, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
