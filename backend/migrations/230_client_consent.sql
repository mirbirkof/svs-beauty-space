-- 230: згода на обробку ПД (GDPR Art.6/7, Закон України «Про захист персональних даних»).
-- Аудит v2 (юрист): не було механізму фіксації згоди клієнта на обробку ПД.
-- Додаємо поля: коли і через який канал отримано згоду. Для онлайн-каналів (бот/сайт)
-- згода фіксується автоматично при записі (клієнт приймає оферту/політику). Для офлайн —
-- адмін відмічає вручну. Відсутність згоди не блокує роботу (легітимний інтерес для існуючих),
-- але дає юридичну базу й можливість аудиту хто/коли погодився.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS consent_given_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_source text; -- 'bot' | 'site' | 'admin' | 'offer'

COMMENT ON COLUMN public.clients.consent_given_at IS 'Коли клієнт погодився на обробку ПД (GDPR/ЗУ про ЗПД)';
COMMENT ON COLUMN public.clients.consent_source IS 'Канал згоди: bot/site/admin/offer';
