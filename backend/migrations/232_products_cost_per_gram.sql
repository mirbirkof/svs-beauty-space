-- 232: собівартість матеріалу за грам (паралель до price_per_gram — ціна продажу за грам).
-- Заявка власника (заметка #145): для фарб/окисників собівартість рахується за грам, а
-- поля не було (був лише wholesale за упаковку). БЕЗПЕЧНО: колонка nullable, не використовується
-- поки не задана; розрахунок маржі бере cost_per_gram лише для товарів, що продаються за грам.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS cost_per_gram numeric;
COMMENT ON COLUMN public.products.cost_per_gram IS 'Собівартість матеріалу за грам/мл (для фарб/окисників). Для маржі гам-товарів: qty_used × cost_per_gram.';
