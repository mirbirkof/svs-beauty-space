-- Товар, що ведеться в грамах (variant.volume='г'), ЗАВЖДИ продається за грам:
-- price_per_gram = роздрібна ціна варіанта (вона і є ціною за грам).
-- Причина: позиції з накладних/ручного створення лишались без ставки → «—» у візиті (04.07.2026).

-- 1) Бекфіл існуючих
UPDATE products p SET price_per_gram = v.price, updated_at = NOW()
  FROM product_variants v
 WHERE v.product_id = p.id AND v.volume = 'г'
   AND p.price_per_gram IS NULL AND v.price > 0;

-- 2) Тригер: нові/змінені грамові варіанти самі проставляють ставку товару
CREATE OR REPLACE FUNCTION trg_gram_variant_ppg() RETURNS trigger AS $$
BEGIN
  IF NEW.volume = 'г' AND NEW.price > 0 THEN
    UPDATE products SET price_per_gram = NEW.price, updated_at = NOW()
     WHERE id = NEW.product_id AND price_per_gram IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gram_variant_ppg ON product_variants;
CREATE TRIGGER gram_variant_ppg
  AFTER INSERT OR UPDATE OF volume, price ON product_variants
  FOR EACH ROW EXECUTE FUNCTION trg_gram_variant_ppg();
