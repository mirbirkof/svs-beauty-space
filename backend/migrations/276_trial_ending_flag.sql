-- 276: флаг «предупреждение о конце триала отправлено» (Phase A SaaS-фундамента, 18.07.2026).
-- Раньше триал заканчивался МОЛЧА: ни одного сигнала владельцу до past_due.
-- Тик notifyTrialEnding (billing.js) шлёт предупреждение за 3 дня — ровно один раз на подписку.
ALTER TABLE subscriptions_saas ADD COLUMN IF NOT EXISTS trial_ending_notified_at TIMESTAMPTZ;
