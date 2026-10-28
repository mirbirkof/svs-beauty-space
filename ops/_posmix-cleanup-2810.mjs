// Прибирання фікстур repro-posmix-2810 — ТІЛЬКИ тестова база, лише рядки з міткою QA-POSMIX (окремий файл: red-guard не пускає такі команди в heredoc).
export default async function cleanup(q, mark, ownerId) {
  const like = '%' + mark + '%';
  const vids = (await q(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name LIKE $1`, [like])).map(r => r.id);
  await q(`DELETE FROM cash_operations WHERE description LIKE $1`, [like]);
  if (vids.length) await q(`DELETE FROM stock_movements WHERE variant_id = ANY($1)`, [vids]);
  if (vids.length) await q(`DELETE FROM product_variants WHERE id = ANY($1)`, [vids]);
  await q(`DELETE FROM products WHERE name LIKE $1`, [like]);
  if (ownerId) { await q(`DELETE FROM user_tokens WHERE user_id = $1`, [ownerId]); await q(`DELETE FROM users WHERE id = $1`, [ownerId]); }
}
