-- Розширення 210: товар у ПОШТУЧНІЙ одиниці (г / мл / шт / ампула / порція)
-- завжди продається за одиницю: price_per_gram = ціна варіанта (вона і є ціна за 1 од.).
-- Причина: 210 покривав лише 'г' → «мл» і «ампула» лишались з «—» у візиті (04.07.2026).
-- Упаковки ('100ml', 'стандарт', 'тон X.Y') НЕ чіпаємо — там ціна за пляшку/шт у продаж.

-- 1) Бекфіл існуючих
UPDATE products p SET price_per_gram = v.price, updated_at = NOW()
  FROM product_variants v
 WHERE v.product_id = p.id
   AND lower(trim(v.volume)) IN ('г','мл','шт','ампула','порція','g','ml')
   AND p.price_per_gram IS NULL AND v.price > 0;

-- 2) Тригер (заміна 210): будь-яка поштучна одиниця проставляє ставку
CREATE OR REPLACE FUNCTION trg_gram_variant_ppg() RETURNS trigger AS $$
BEGIN
  IF lower(trim(NEW.volume)) IN ('г','мл','шт','ампула','порція','g','ml') AND NEW.price > 0 THEN
    UPDATE products SET price_per_gram = NEW.price, updated_at = NOW()
     WHERE id = NEW.product_id AND price_per_gram IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
-- тригер gram_variant_ppg з 210 вже висить на цій функції — перевизначення достатньо
