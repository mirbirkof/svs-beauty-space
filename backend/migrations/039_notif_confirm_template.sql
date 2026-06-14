-- 039: COM-04 — системный шаблон подтверждения записи.
INSERT INTO notification_templates(key, channel, lang, category, body, is_system, variables) VALUES
  ('appt_confirm','any','uk','transactional',
   '✅ <b>Запис підтверджено</b>\n{{date}} о {{time}}{{#if master}} у майстра <b>{{master}}</b>{{/if}}{{#if service}} ({{service}}){{/if}}.\n\nЧекаємо на вас! Якщо потрібно перенести — напишіть нам.',
   TRUE,'["date","time","master","service"]'::jsonb)
ON CONFLICT DO NOTHING;
