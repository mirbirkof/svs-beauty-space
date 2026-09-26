/* stock-view.js — ОДНА логіка списку для складу салону, складу магазину, акту інвентаризації салону й магазину
   (26.09, Бос: «сортування по брендах, по типу… максимально комфортно й інтуїтивно, везде одинаково»).
   Що дає кожному екрану:
   • зверху: пошук по СЛОВАХ (усі слова, будь-який порядок — як у продажу) + чипи «Тип», «Бренд», «Наявність»
     (Усі / Є в наявності / Закінчуються / Немає) з кількістю позицій біля кожного;
   • за замовчуванням — групи Тип → Бренд із заголовками «N поз. · залишок · вартість», усередині — назва по-людськи
     (StockSort: регістр/пробіли не важать, тони 1.0 < 6.04 < 10.1 < 1002);
   • клік по заголовку колонки — сортування ↑ / ↓, третій клік — назад до груп; вибір памʼятається (localStorage).
   Потрібен stock-sort.js (window.StockSort). Рядки таблиці малює сам екран (rowHtml) — його кнопки/поля не чіпаємо. */
(function () {
  'use strict';
  const S = window.StockSort;
  const esc = (v) => (v == null ? '' : String(v)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('uk-UA', { maximumFractionDigits: 2 });
  const NOBRAND = 'Без бренду';

  function injectCss() {
    if (document.getElementById('sv-css')) return;
    const st = document.createElement('style'); st.id = 'sv-css';
    st.textContent = `
.sv-bar{display:flex;flex-direction:column;gap:6px;margin:0 0 8px}
.sv-row{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.sv-row .sv-lbl{font-size:11px;color:#8a8a99;text-transform:uppercase;letter-spacing:.03em;min-width:62px}
.sv-chip{border:1px solid #dcdce6;background:#fff;border-radius:999px;padding:3px 10px;font-size:12px;line-height:18px;cursor:pointer;color:#333;white-space:nowrap;font-family:inherit}
.sv-chip:hover{border-color:var(--primary,#6c5ce7)}
.sv-chip.on{background:var(--primary,#6c5ce7);border-color:var(--primary,#6c5ce7);color:#fff}
.sv-chip .n{opacity:.6;margin-left:4px;font-size:11px}
.sv-chip.on .n{opacity:.85}
.sv-chip.zero{opacity:.45}
.sv-search{flex:1;min-width:200px;padding:7px 10px;border:1px solid #dcdce6;border-radius:9px;font-size:13px;font-family:inherit}
.sv-info{font-size:12px;color:#8a8a99}
.sv-reset{font-size:12px;color:var(--primary,#6c5ce7);cursor:pointer;text-decoration:underline;background:none;border:0;padding:0;font-family:inherit}
tr.sv-grp td{background:#f4f3fb;font-weight:700;font-size:12.5px;padding:6px 8px;border-bottom:1px solid #e6e4f3;position:static}
tr.sv-grp-t td{background:#ebe8fb;font-size:13px;text-transform:uppercase;letter-spacing:.03em}
tr.sv-grp .m{font-weight:400;color:#6b6b7b;margin-left:8px;font-size:12px;text-transform:none;letter-spacing:0}
th[data-sv-sort]{cursor:pointer;user-select:none;white-space:nowrap}
th[data-sv-sort]:hover{color:var(--primary,#6c5ce7)}
th[data-sv-sort] .sv-ar{font-size:11px;margin-left:3px;opacity:.35}
th[data-sv-sort].sv-on .sv-ar{opacity:1;color:var(--primary,#6c5ce7)}
.sv-sub{font-size:11px;color:#8a8a99;font-weight:400}`;
    document.head.appendChild(st);
  }

  // поріг «закінчується»: мін. залишок з картки → інакше одна упаковка для вагового товару (г/мл) → інакше ≤ 2 шт
  function defaultLowAt(r) {
    const m = Number(r.min_stock); if (m > 0) return m;
    const u = Number(r.unit_ml);
    if (r.price_per_gram != null && u > 1) return u;
    return 2;
  }

  function create(o) {
    injectCss();
    const key = 'svs_sv_sort_' + o.key;
    const st = { rows: [], q: '', type: '', brand: '', stock: '', sort: null };
    try { const s = JSON.parse(localStorage.getItem(key) || 'null'); if (s && s.k && o.sorts[s.k]) st.sort = { k: s.k, d: s.d === -1 ? -1 : 1 }; } catch (_) {}
    const qtyOf = o.qty || (r => Number(r.stock_qty) || 0);
    const lowAt = o.lowAt || defaultLowAt;
    const brandOf = r => r.brand_name || NOBRAND;

    // ── панель фільтрів ──
    const bar = o.mount;
    bar.classList.add('sv-bar');
    bar.innerHTML = `
      <div class="sv-row">
        <input class="sv-search" id="${esc(o.searchId || '')}" placeholder="${esc(o.searchPlaceholder || 'Пошук: назва, тон, обʼєм, бренд — слова в будь-якому порядку')}" autocomplete="off">
        ${o.extraHtml || ''}
      </div>
      ${o.stockChips === false ? '' : '<div class="sv-row"><span class="sv-lbl">Наявність</span><span class="sv-stock" style="display:contents"></span></div>'}
      <div class="sv-row"><span class="sv-lbl">Тип</span><span class="sv-types" style="display:contents"></span></div>
      <div class="sv-row"><span class="sv-lbl">Бренд</span><span class="sv-brands" style="display:contents"></span></div>
      <div class="sv-row"><span class="sv-info"></span></div>`;
    const $ = (s) => bar.querySelector(s);
    const input = $('.sv-search');
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = input.value; render(); }, 150); });
    bar.addEventListener('click', (e) => {
      const c = e.target.closest('[data-sv-f]'); if (c) {
        const f = c.dataset.svF, v = c.dataset.v;
        st[f] = (st[f] === v && v !== '') ? '' : v;
        render(); return;
      }
      if (e.target.closest('.sv-reset')) { setSort(null); }
    });

    // ── заголовки колонок ──
    function paintHeads() {
      if (!o.thead) return;
      o.thead.querySelectorAll('th[data-sv-sort]').forEach(th => {
        let ar = th.querySelector('.sv-ar');
        if (!ar) { ar = document.createElement('span'); ar.className = 'sv-ar'; th.appendChild(ar); th.title = 'Клік — сортувати ↑/↓, третій клік — назад до груп Тип → Бренд'; }
        const on = st.sort && st.sort.k === th.dataset.svSort;
        th.classList.toggle('sv-on', !!on);
        ar.textContent = on ? (st.sort.d > 0 ? '▲' : '▼') : '↕';
      });
    }
    if (o.thead) o.thead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sv-sort]'); if (!th) return;
      const k = th.dataset.svSort;
      if (!st.sort || st.sort.k !== k) setSort({ k, d: 1 });
      else if (st.sort.d === 1) setSort({ k, d: -1 });
      else setSort(null);
    });
    function setSort(s) {
      st.sort = s && o.sorts[s.k] ? s : null;
      try { st.sort ? localStorage.setItem(key, JSON.stringify(st.sort)) : localStorage.removeItem(key); } catch (_) {}
      render();
    }

    // ── фільтри ──
    function hay(r) {
      if (!r._hay) r._hay = S.norm([r.product_name, r.volume, r.sku, r.brand_name, r.type].filter(Boolean).join(' '));
      return r._hay;
    }
    function stockState(r) { const q = qtyOf(r); return q <= 0 ? 'out' : (q <= lowAt(r) ? 'low' : 'in'); }
    function pass(r, skip) {
      if (skip !== 'type' && st.type && r.type !== st.type) return false;
      if (skip !== 'brand' && st.brand && brandOf(r) !== st.brand) return false;
      if (skip !== 'stock' && st.stock) { const s = stockState(r); if (st.stock === 'in' ? s === 'out' : s !== st.stock) return false; }
      if (o.extraFilter && !o.extraFilter(r)) return false;
      if (st.q) { const h = hay(r); for (const w of S.norm(st.q).split(' ')) if (w && !h.includes(w)) return false; }
      return true;
    }
    function chips(field, list, counts, sel, allLabel) {
      return [`<button type="button" class="sv-chip${sel ? '' : ' on'}" data-sv-f="${field}" data-v="">${allLabel}</button>`]
        .concat(list.filter(v => counts[v] || sel === v).map(v => `<button type="button" class="sv-chip${sel === v ? ' on' : ''}${counts[v] ? '' : ' zero'}" data-sv-f="${field}" data-v="${esc(v)}">${esc(v)}<span class="n">${counts[v] || 0}</span></button>`)).join('');
    }
    function paintChips() {
      const tc = {}, bc = {}, sc = { in: 0, low: 0, out: 0 };
      for (const r of st.rows) {
        if (pass(r, 'type')) tc[r.type] = (tc[r.type] || 0) + 1;
        if (pass(r, 'brand')) { const b = brandOf(r); bc[b] = (bc[b] || 0) + 1; }
        if (pass(r, 'stock')) { const s = stockState(r); if (s === 'out') sc.out++; else { sc.in++; if (s === 'low') sc.low++; } } // «Є в наявності» включає і ті, що закінчуються
      }
      const types = S.TYPES.filter(x => tc[x] || st.type === x || st.rows.some(r => r.type === x));
      const allBrands = [...new Set(st.rows.map(brandOf))].sort(S.compareBrand ? (a, b) => S.compareBrand(a === NOBRAND ? '' : a, b === NOBRAND ? '' : b) : undefined);
      $('.sv-types').innerHTML = chips('type', types, tc, st.type, 'Усі');
      $('.sv-brands').innerHTML = chips('brand', allBrands, bc, st.brand, 'Усі');
      const s = $('.sv-stock');
      if (s) s.innerHTML = [['', 'Усі', null], ['in', 'Є в наявності', sc.in], ['low', 'Закінчуються', sc.low], ['out', 'Немає', sc.out]]
        .map(([v, l, n]) => `<button type="button" class="sv-chip${st.stock === v ? ' on' : ''}" data-sv-f="stock" data-v="${v}" ${v === 'low' ? 'title="Залишок не більший за мінімальний з картки товару, або ≤ 1 упаковки для товару в грамах, або ≤ 2 шт"' : ''}>${l}${n == null ? '' : `<span class="n">${n}</span>`}</button>`).join('');
    }

    // ── рендер ──
    function sortRows(list) {
      if (!st.sort) return S.sortDefault(list);
      const f = o.sorts[st.sort.k], d = st.sort.d;
      const cmp = f === 'name' ? (a, b) => S.naturalCompare(a.product_name, b.product_name) || S.naturalCompare(a.volume, b.volume)
        : (a, b) => { const x = f(a), y = f(b); const xn = x == null || Number.isNaN(x), yn = y == null || Number.isNaN(y);
            if (xn || yn) return xn === yn ? 0 : (xn ? 1 : -1) * d; return x - y; };
      return list.slice().sort((a, b) => (cmp(a, b) * d) || S.compareDefault(a, b));
    }
    function sums(list) {
      let q = 0, v = 0; for (const r of list) { q += Math.max(0, qtyOf(r)); if (o.value) v += Number(o.value(r)) || 0; }
      return `${list.length} поз. · залишок ${fmt(q)}` + (o.value && v > 0 ? ` · вартість ${fmt(Math.round(v))} ₴` : '');
    }
    // Постепенна відрисовка: 830 рядків з полями й кнопками одразу — це секунди «замерзання» сторінки
    // (заміряно в пісочниці: сортування 0.1 с, а розкладка всіх рядків — десятки секунд на навантаженій машині).
    // Показуємо перші FIRST рядків, решту дописуємо порціями при прокрутці до кінця або через more() (Tab/Enter).
    const FIRST = o.first || 150, STEP = o.step || 250;
    let pieces = [], shown = 0, io = null;
    function scrollRoot() { let el = o.tbody.parentElement; while (el && el !== document.body) { const oy = getComputedStyle(el).overflowY; if (oy === 'auto' || oy === 'scroll') return el; el = el.parentElement; } return null; }
    function moreRow() {
      return `<tr class="sv-more"><td colspan="${o.colspan}" style="text-align:center;color:#8a8a99;padding:12px">Показано ${shown} з ${pieces.length} — прокрутіть нижче або <button type="button" class="sv-reset" data-sv-more="1">показати ще</button></td></tr>`;
    }
    function more(n) {
      if (shown >= pieces.length) return false;
      const m = o.tbody.querySelector('tr.sv-more'); if (m) m.remove();
      const next = Math.min(pieces.length, shown + (n || STEP));
      o.tbody.insertAdjacentHTML('beforeend', pieces.slice(shown, next).join('') + (next < pieces.length ? '' : ''));
      shown = next;
      if (shown < pieces.length) { o.tbody.insertAdjacentHTML('beforeend', moreRow()); watch(); }
      return true;
    }
    function watch() {
      const m = o.tbody.querySelector('tr.sv-more'); if (!m || typeof IntersectionObserver === 'undefined') return;
      if (io) io.disconnect();
      io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); setTimeout(() => more(), 0); } }, { root: scrollRoot(), rootMargin: '300px' });
      io.observe(m);
    }
    o.tbody.addEventListener('click', (e) => { if (e.target.closest('[data-sv-more]')) more(); });

    function render() {
      const vis = sortRows(st.rows.filter(r => pass(r)));
      const words = S.norm(st.q).split(' ').filter(Boolean);
      const cs = o.colspan;
      pieces = [];
      if (!st.sort) {
        const gT = new Map(), gB = new Map();
        for (const r of vis) { (gT.get(r.type) || gT.set(r.type, []).get(r.type)).push(r); const kb = r.type + '|' + brandOf(r); (gB.get(kb) || gB.set(kb, []).get(kb)).push(r); }
        let lt = null, lb = null;
        for (const r of vis) {
          let h = '';
          if (r.type !== lt) { lt = r.type; lb = null; h += `<tr class="sv-grp sv-grp-t"><td colspan="${cs}">${esc(r.type)}<span class="m">${sums(gT.get(r.type))}</span></td></tr>`; }
          const kb = r.type + '|' + brandOf(r);
          if (kb !== lb) { lb = kb; h += `<tr class="sv-grp sv-grp-b"><td colspan="${cs}">${esc(brandOf(r))}<span class="m">${sums(gB.get(kb))}</span></td></tr>`; }
          pieces.push(h + o.rowHtml(r, words));
        }
      } else pieces = vis.map(r => o.rowHtml(r, words));
      if (io) io.disconnect();
      shown = Math.min(pieces.length, FIRST);
      o.tbody.innerHTML = pieces.length
        ? pieces.slice(0, shown).join('') + (shown < pieces.length ? moreRow() : '')
        : `<tr><td colspan="${cs}" style="text-align:center;color:#8a8a99;padding:22px">${st.rows.length ? 'Нічого не знайдено — змініть пошук або фільтр' : esc(o.emptyText || 'Позицій немає')}</td></tr>`;
      if (shown < pieces.length) watch();
      paintChips(); paintHeads();
      const info = $('.sv-info');
      const lbl = st.sort ? ((o.labels && o.labels[st.sort.k]) || (o.thead && o.thead.querySelector(`th[data-sv-sort="${st.sort.k}"]`) || {}).textContent) : '';
      info.innerHTML = `Знайдено <b>${vis.length}</b> з ${st.rows.length}` + (st.sort
        ? ` · сортування: ${esc(String(lbl || '').replace(/[▲▼↕]/g, '').trim())}${o.labels && o.labels[st.sort.k] ? '' : (st.sort.d > 0 ? ' ↑' : ' ↓')} · <button type="button" class="sv-reset">групувати за типом і брендом</button>`
        : ' · згруповано: тип → бренд → назва (клік по заголовку колонки — інше сортування)');
      if (o.onRender) o.onRender(vis);
      return vis;
    }
    function setRows(rows) { st.rows = rows || []; return render(); }
    return { setRows, render, setSort, more, state: st, visible: () => st.rows.filter(r => pass(r)), input };
  }

  window.StockView = { create, defaultLowAt };
})();
