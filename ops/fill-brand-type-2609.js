#!/usr/bin/env node
/* ops/fill-brand-type-2609.js — порядок у даних складу (26.09, Бос: «сортування по брендах, по типу»).
   Без цього групування «Тип → Бренд» на складі — мішанина: 342 активні товари без бренду, тип не задано ніде.

   ЩО РОБИТЬ (ТІЛЬКИ ЗАПОВНЮЄ ПОРОЖНЄ, нічого не переписує):
   1) products.brand_id — лише де він NULL, і лише при ВПЕВНЕНОМУ збігу:
      a) у назві стоїть імʼя рівно ОДНОГО бренду з довідника (raywell/райвел, envie/енві, extremo, invidia, matrix, l'oreal);
      b) або товар належить до серії (socolor, eterna, na golovy…), яка серед УЖЕ розмічених товарів належить ОДНОМУ бренду
         (одностайно; голоси «Інше» не рахуються, якщо є справжній бренд; мінімум 2 розмічені приклади).
      Серії без доказів у даних (sync/synk, medavita, hadat…) — НЕ чіпаємо, друкуємо список «на перевірку».
   (позначка attrs.brand_src='auto-2609' — бренд поставив скрипт; такі товари не є доказом для серій при повторі)
   2) products.attrs.type — тип для людей (Фарба, Окисник, Шампунь…) там, де attrs.type ще порожній.
      Визначення — та сама функція, що й на екранах (public/admin/assets/stock-sort.js → detectType).
      Категорії магазину (category_id, їх читає вітрина) НЕ змінюються.
   Режими: --dry (за замовчуванням, тільки читає) | --apply (одна транзакція, advisory-lock, бекап JSON, audit_log).
   БД: DATABASE_URL з backend/.env або DB_URL=... (пісочниця). TENANT=... (за замовчуванням основний салон). */
const path = require('path');
const fs = require('fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));
const S = require(path.join(BACKEND, 'lib', 'stock-sort.js'));

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DB_URL || process.env.DATABASE_URL;
const TENANT = process.env.TENANT || '00000000-0000-0000-0000-000000000001';
const BACKUP = process.env.FILL_BACKUP || path.join(__dirname, '_fill_brand_type_backup_2609.json');
const REPORT = process.env.FILL_REPORT || '/tmp/fill-brand-type-2609-report.json';

// написання бренду в назвах (латиниця + як пишуть адміни кирилицею). Ключ = brands.id
const BRAND_ALIASES = {
  raywell: ['raywell', 'райвел', 'рейвел'],
  envie: ['envie', 'енві', 'енви'],
  extremo: ['extremo', 'екстремо'],
  invidia: ['invidia', 'інвідія'],
  matrix: ['matrix', 'матрікс', 'матрикс'],
  loreal: ["l'oreal", 'loreal', "l'oréal", 'лореаль'],
};
// серії: бренд визначається НЕ тут, а доказами з уже розмічених товарів
const SERIES = [
  ['socolor', /\bsocolor\b/], ['color sync / sync', /\b(color sync|sync|synk)\b/], ['eterna', /\beterna\b/],
  ['na golovy', /\bna golovy\b|\bgolovy\b/], ['medavita', /medavita|медавіт/], ['hadat', /hadat|хадат/],
  ['brae', /\bbrae\b/], ['chromactive', /chromactive|хромактив/], ['mr scrubber', /mr scrubber/],
  ['dr.sorbie', /sorbie/], ['blcom / blocom', /\bbl(o)?com\b/], ['chromatics', /chromatics/], ['inoa', /\binoa/],
  ['lipure', /lipure/], ['soboost', /soboost/], ['prodige', /prodige/], ['revitalize', /revitalize/],
  ['sos express', /\bsos\b/], ['snail slime', /sna[il]l slime/], ['milk protein', /milk protein/],
  ['hidra', /\bhidra\b|гідра/], ['daily shine', /daily shine/], ['molecular bond repair', /molecular bond repair/],
  ['flakes control', /flakes control/], ['boma', /\bboma\b|\bбома\b/], ['bioplex', /bioplex|біоплекс/],
  ['orro/oro argan', /\bor?ro argan\b/], ['keratin miracle', /keratin miracle/], ['filler', /\bfiller\b|філлер/],
  ['кактус', /кактус/], ['x16–x19', /^\s*[xх]1\d\b/], ['demi cult', /demi cult/], ['huile', /huile/],
  ['nutra-plex', /nutra-?plex/], ['hairchitecture', /hairchitecture/], ['rosil', /rosil/], ['nutrisub', /nutrisub/],
];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasAlias = (name, a) => new RegExp('(^|[^a-zа-яіїєґ])' + esc(a) + '($|[^a-zа-яіїєґ])', 'i').test(name);

async function main() {
  if (!DB_URL) throw new Error('нет DATABASE_URL');
  const db = new Client({ connectionString: DB_URL, ssl: /localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false } });
  await db.connect();
  const host = (() => { try { return new URL(DB_URL).host; } catch (_) { return '?'; } })();
  console.log(`БД: ${host} · тенант ${TENANT} · режим: ${APPLY ? 'APPLY (запис)' : 'DRY (тільки читання)'}`);
  try {
    await db.query('BEGIN');
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fill-brand-type-2609'))`);
    const brands = (await db.query(`SELECT id, name FROM brands`)).rows;
    const brandName = Object.fromEntries(brands.map(b => [b.id, b.name]));
    const prods = (await db.query(
      `SELECT p.id, p.name, p.brand_id, p.category_id, p.price_per_gram, p.attrs,
              (SELECT v.volume FROM product_variants v WHERE v.product_id = p.id AND v.active IS NOT FALSE ORDER BY v.id LIMIT 1) AS volume
         FROM products p WHERE p.tenant_id = $1 AND p.active IS NOT FALSE ORDER BY p.id FOR UPDATE OF p`, [TENANT])).rows;
    const n = (s) => S.norm(s);

    // ── докази по серіях з уже розмічених товарів ──
    const evidence = {};
    for (const [key, re] of SERIES) {
      const votes = {};
      // доказ — лише бренди, поставлені ЛЮДЬМИ: заповнені цим скриптом (attrs.brand_src) не рахуються,
      // інакше повторний запуск роздуває власні здогадки (перевірено в пісочниці: +37 «Matrix» для sync із 2 авто-міток)
      for (const p of prods) if (p.brand_id && !(p.attrs && p.attrs.brand_src) && re.test(n(p.name))) votes[p.brand_id] = (votes[p.brand_id] || 0) + 1;
      const real = Object.entries(votes).filter(([b]) => b !== 'inshe');
      const pool = real.length ? real : Object.entries(votes);
      const total = pool.reduce((s, [, c]) => s + c, 0);
      const brand = pool.length === 1 && total >= 2 ? pool[0][0] : null;
      evidence[key] = { votes, brand, why: brand ? `серед розмічених: ${JSON.stringify(votes)}` : (Object.keys(votes).length ? `розмічені розходяться: ${JSON.stringify(votes)}` : 'жодного розміченого прикладу') };
    }

    const brandSet = [], review = [], typeSet = [];
    for (const p of prods) {
      const nm = n(p.name);
      if (!p.brand_id) {
        const byName = Object.entries(BRAND_ALIASES).filter(([id, al]) => brandName[id] && al.some(a => hasAlias(nm, a))).map(([id]) => id);
        const ser = SERIES.filter(([, re]) => re.test(nm)).map(([k]) => k);
        const serBrands = [...new Set(ser.map(k => evidence[k].brand).filter(Boolean))];
        let pick = null, why = '';
        if (byName.length === 1 && (!serBrands.length || (serBrands.length === 1 && serBrands[0] === byName[0]))) { pick = byName[0]; why = 'бренд у назві'; }
        else if (!byName.length && serBrands.length === 1 && ser.every(k => !evidence[k].brand || evidence[k].brand === serBrands[0])) {
          pick = serBrands[0]; why = `серія «${ser.join(', ')}»: ${evidence[ser.find(k => evidence[k].brand)].why}`;
        }
        if (pick) brandSet.push({ id: p.id, name: p.name, brand_id: pick, why });
        else review.push({ id: p.id, name: p.name, category_id: p.category_id,
          why: byName.length > 1 ? `у назві кілька брендів: ${byName.join(', ')}` : ser.length ? ser.map(k => `«${k}»: ${evidence[k].why}`).join('; ') : 'бренд у назві не вказано, серію не впізнано' });
      }
      const has = p.attrs && typeof p.attrs === 'object' && p.attrs.type;
      if (!has) typeSet.push({ id: p.id, name: p.name, type: S.detectType({ ...p, attrs: null }) });
    }

    // ── звіт ──
    const byBrand = {}; for (const x of brandSet) byBrand[x.brand_id] = (byBrand[x.brand_id] || 0) + 1;
    const byType = {}; for (const x of typeSet) byType[x.type] = (byType[x.type] || 0) + 1;
    const noBrand = prods.filter(p => !p.brand_id).length;
    console.log(`\nАктивних товарів: ${prods.length}; без бренду: ${noBrand}`);
    console.log(`БРЕНД заповню: ${brandSet.length} → ${JSON.stringify(byBrand)}; на перевірку (не чіпаю): ${review.length}`);
    console.log('Докази серій:'); for (const [k, e] of Object.entries(evidence)) if (Object.keys(e.votes).length || brandSet.some(x => x.why.includes(k)) || review.some(r => r.why.includes(`«${k}»`))) console.log(`  ${k}: ${e.brand ? '→ ' + brandName[e.brand] : '—'} (${e.why})`);
    console.log(`ТИП заповню: ${typeSet.length} → ${JSON.stringify(byType)}`);
    const reviewGroups = {}; for (const r of review) (reviewGroups[r.why] = reviewGroups[r.why] || []).push(r.name);
    console.log('\nНА ПЕРЕВІРКУ (бренд не ставлю):');
    for (const [why, names] of Object.entries(reviewGroups).sort((a, b) => b[1].length - a[1].length)) console.log(`  [${names.length}] ${why}: ${names.slice(0, 6).join(' | ')}${names.length > 6 ? ' …' : ''}`);
    fs.writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), host, brandSet, review, typeSet, evidence }, null, 1));
    console.log(`\nПовний звіт: ${REPORT}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('DRY: нічого не записано. Для запису: --apply'); return; }

    // ── бекап + запис ──
    const ids = [...new Set([...brandSet.map(x => x.id), ...typeSet.map(x => x.id)])];
    const before = (await db.query(`SELECT id, name, brand_id, category_id, attrs FROM products WHERE id = ANY($1::text[])`, [ids])).rows;
    fs.writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), host, tenant: TENANT, rows: before }, null, 1));
    console.log(`Бекап ${before.length} рядків → ${BACKUP}`);
    let nb = 0, nt = 0;
    // brand_src — позначка «бренд поставив скрипт, не людина» (для перевірки й щоб не бути доказом при повторі)
    for (const x of brandSet) nb += (await db.query(
      `UPDATE products SET brand_id = $2, attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('brand_src', 'auto-2609'), updated_at = NOW()
        WHERE id = $1 AND brand_id IS NULL`, [x.id, x.brand_id])).rowCount;
    for (const x of typeSet) nt += (await db.query(
      `UPDATE products SET attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('type', $2::text)
        WHERE id = $1 AND COALESCE(attrs->>'type', '') = ''`, [x.id, x.type])).rowCount;
    if (nb !== brandSet.length || nt !== typeSet.length) throw new Error(`розбіжність: бренд ${nb}/${brandSet.length}, тип ${nt}/${typeSet.length} — ROLLBACK`);
    await db.query(
      `INSERT INTO audit_log (user_id, user_label, action, entity, entity_id, meta, tenant_id)
       VALUES (NULL, 'ops/fill-brand-type-2609', 'stock.fill_brand_type', 'product', NULL, $1, $2)`,
      [JSON.stringify({ brand_filled: nb, type_filled: nt, by_brand: byBrand, by_type: byType, review: review.length, backup: path.basename(BACKUP),
        brands: brandSet.map(x => [x.id, x.brand_id]) }), TENANT]);
    await db.query('COMMIT');
    console.log(`APPLY OK: бренд заповнено ${nb}, тип ${nt}. Категорії й наявні бренди не змінені.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('ПОМИЛКА:', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}
main();
