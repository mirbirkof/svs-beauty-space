// Єдиний порядок складу/інвентаризації (26.09, crm-sort-2609). Код порівняння живе в
// public/admin/assets/stock-sort.js — той самий файл підвантажують екрани, тож сервер і браузер сортують однаково.
const S = require('../public/admin/assets/stock-sort.js');

// Рядки складу/акту → тип (attrs.type або визначений за назвою/категорією) + порядок за замовчуванням
// (Тип → Бренд → назва натурально → обʼєм). attrs назовні не віддаємо — екрану потрібен лише тип.
function prepareStockRows(rows) {
  for (const r of rows) {
    r.type = S.detectType({ name: r.product_name, category_id: r.category_id, price_per_gram: r.price_per_gram, volume: r.volume, attrs: r.attrs });
    delete r.attrs;
  }
  return S.sortDefault(rows);
}

// Пошук «по словах» (як у продажу): кожне слово — AND, % і _ екрановані. Повертає SQL-умову й доповнює vals.
function wordsWhere(q, vals, hayExpr) {
  let sql = '';
  const words = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  for (const w of words) {
    vals.push('%' + w.replace(/(\d),(\d)/g, '$1.$2').replace(/[\\%_]/g, m => '\\' + m) + '%');
    sql += ` AND (${hayExpr}) ILIKE $${vals.length}`;
  }
  return sql;
}

module.exports = { ...S, prepareStockRows, wordsWhere };
