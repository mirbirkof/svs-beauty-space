/* Інтеграції — единая витрина подключений к внешним сервисам.
 *
 * Отдаёт КАТАЛОГ интеграций со статусом «подключено / не подключено».
 * Статус вычисляется на сервере по наличию env-переменных. ЗНАЧЕНИЯ ключей
 * НИКОГДА не отдаются наружу — только булев флаг configured.
 *
 * GET /api/integrations/status — список интеграций со статусом
 */
const express = require('express');
const { requirePerm } = require('../lib/rbac');
const router = express.Router();

const has = (...names) => names.every(n => !!(process.env[n] && String(process.env[n]).trim()));

// Каталог. needs — какие env нужны (для подсказки админу, без значений).
function buildCatalog() {
  return [
    { category: 'Платежі', items: [
      { key: 'mono', name: 'Mono еквайринг', icon: 'credit_card',
        desc: 'Приём онлайн-оплат и предоплат за записи через monobank.',
        configured: has('MONO_TOKEN'), needs: ['MONO_TOKEN'],
        how: 'Получить токен в кабинете monobank → Acquiring і POS, вставить в переменную MONO_TOKEN.' },
      { key: 'liqpay', name: 'LiqPay (Приват24)', icon: 'account_balance',
        desc: 'Альтернативний прийом оплат картами для продажу CRM іншим салонам.',
        configured: has('LIQPAY_PUBLIC_KEY','LIQPAY_PRIVATE_KEY'), needs: ['LIQPAY_PUBLIC_KEY','LIQPAY_PRIVATE_KEY'],
        how: 'Зареєструвати магазин у LiqPay → отримати public/private ключі.' },
    ]},
    { category: 'Маркетинг і присутність', items: [
      { key: 'google_business', name: 'Google Business Profile', icon: 'travel_explore',
        desc: 'Картка салону в Google Maps/Пошуку: пости, відгуки, метрики видимості.',
        configured: has('GOOGLE_BUSINESS_TOKEN'), needs: ['GOOGLE_BUSINESS_TOKEN'],
        how: 'Підключити Google-акаунт салону, отримати OAuth-токен, вставити в GOOGLE_BUSINESS_TOKEN.' },
    ]},
    { category: 'Сповіщення клієнтам', items: [
      { key: 'telegram', name: 'Telegram-сповіщення', icon: 'send',
        desc: 'Сповіщення про записи, нагадування й кампанії у Telegram.',
        configured: has('TELEGRAM_BOT_TOKEN') || has('TELEGRAM_NOTIFY_TOKEN'),
        needs: ['TELEGRAM_BOT_TOKEN'],
        how: 'Створити бота через @BotFather, токен → TELEGRAM_BOT_TOKEN.' },
      { key: 'sms', name: 'SMS (Twilio)', icon: 'sms',
        desc: 'SMS-нагадування та підтвердження записів.',
        configured: has('TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN'), needs: ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM'],
        how: 'Створити акаунт Twilio, узяти SID/Token/номер відправника.' },
      { key: 'email', name: 'Email-розсилки (Resend)', icon: 'mail',
        desc: 'Транзакційні листи та email-кампанії.',
        configured: has('RESEND_API_KEY'), needs: ['RESEND_API_KEY'],
        how: 'Зареєструватись у Resend, підтвердити домен, ключ → RESEND_API_KEY.' },
    ]},
    { category: 'Логістика', items: [
      { key: 'novaposhta', name: 'Нова Пошта', icon: 'local_shipping',
        desc: 'Створення ТТН і трекінг відправлень товарів магазину.',
        configured: has('NOVAPOSHTA_API_KEY'), needs: ['NOVAPOSHTA_API_KEY'],
        how: 'Кабінет Нової Пошти → API → згенерувати ключ → NOVAPOSHTA_API_KEY.' },
    ]},
    { category: 'Синхронізація і AI', items: [
      { key: 'beautypro', name: 'BeautyPro синхро', icon: 'sync',
        desc: 'Імпорт записів/клієнтів зі старої CRM BeautyPro.',
        configured: has('BEAUTYPRO_ID_KEY','BEAUTYPRO_SECRET_KEY'),
        needs: ['BEAUTYPRO_ID_KEY','BEAUTYPRO_SECRET_KEY','BEAUTYPRO_DATABASE_CODE'],
        how: 'Запросити ключі доступу до API BeautyPro у підтримки сервісу.' },
      { key: 'gemini', name: 'AI-движок (Gemini)', icon: 'auto_awesome',
        desc: 'AI-аналітика, рекомендації, аналіз дзвінків і контроль якості.',
        configured: has('GEMINI_API_KEY'), needs: ['GEMINI_API_KEY'],
        how: 'Отримати ключ у Google AI Studio → GEMINI_API_KEY.' },
    ]},
  ];
}

router.get('/status', requirePerm('integrations.read'), (req, res) => {
  try {
    const catalog = buildCatalog();
    const all = catalog.flatMap(c => c.items);
    res.json({
      groups: catalog,
      summary: { total: all.length, connected: all.filter(x => x.configured).length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
