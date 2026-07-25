-- 280: звʼязок імпортованого реєстру BeautyPro (salon_stock) з живим складом
-- (product_variants). Аудит 25.07: реєстри жили окремо, тому 315 продажів BP
-- (106 395 ₴) не списували склад. Це перший крок механізму міграції з інших CRM
-- (рішення Боса 25.07): імпортовані дані мусять вбудовуватись у живу CRM, а не
-- лежати мертвим довідником.
-- Правило вибору при кількох варіантах одного товару (26 позицій-дублів):
-- беремо варіант з НАЙБІЛЬШИМ живим залишком (він і є робочим), нічия — менший id.

ALTER TABLE salon_stock ADD COLUMN IF NOT EXISTS variant_id INT REFERENCES product_variants(id);

UPDATE salon_stock ss
   SET variant_id = pick.vid
  FROM (
    SELECT ss2.id AS sid,
           (SELECT pv.id
              FROM products p
              JOIN product_variants pv ON pv.product_id = p.id
             WHERE lower(trim(p.name)) = lower(trim(ss2.name))
             ORDER BY COALESCE(pv.stock_qty, 0) DESC, pv.id ASC
             LIMIT 1) AS vid
      FROM salon_stock ss2
  ) pick
 WHERE pick.sid = ss.id AND pick.vid IS NOT NULL AND ss.variant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_salon_stock_variant ON salon_stock(variant_id);
