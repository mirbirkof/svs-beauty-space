/* Інтеграції — единая витрина подключений к внешним сервисам.
 *
 * Отдаёт КАТАЛОГ интеграций со статусом «подключено / не подключено».
 * Статус вычисляется на сервере по наличию env-переменных. ЗНАЧЕНИЯ ключей
 * НИКОГДА не отдаются наружу — только булев флаг configured.
 *
 * GET /api/integrations/status — список интеграций со статусом
 */
const express = require('express');
const { requirePerm, requirePlatform } = require('../lib/rbac');
const { isAllowed, saveIntegrationSecret } = require('../lib/integration-secrets');
const router = express.Router();

const isSet = (n) => !!(process.env[n] && String(process.env[n]).trim());
const has = (...names) => names.every(isSet);

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
    { category: 'Соцмережі та діалоги', items: [
      { key: 'instagram', name: 'Instagram (Direct + коментарі)', icon: 'photo_camera',
        desc: 'Підключити Instagram салону: вхідні Direct і коментарі падають у єдиний інбокс, AI-агент відповідає і навіть записує на процедуру замість адміна.',
        configured: has('META_APP_SECRET') && has('META_VERIFY_TOKEN'),
        needs: ['META_APP_SECRET', 'META_VERIFY_TOKEN'],
        how: 'Потрібен Instagram Professional (бізнес/творець), звʼязаний з FB-сторінкою. У Meta-застосунку платформи задати META_APP_SECRET і META_VERIFY_TOKEN, пройти App Review (instagram_manage_messages). Далі салон підключає свій акаунт у розділі «Omni → Instagram» (Page Access Token зберігається окремо для кожного салону).' },
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
        desc: 'Транзакційні листи, підтвердження пошти та email-кампанії.',
        configured: has('RESEND_API_KEY') && has('EMAIL_FROM'), needs: ['RESEND_API_KEY', 'EMAIL_FROM'],
        how: 'Зареєструватись у Resend, підтвердити домен, ключ → RESEND_API_KEY, відправник → EMAIL_FROM (напр. "SVS Beauty <noreply@ваш-домен>").' },
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
    // до кожної інтеграції додаємо per-field статус (тільки факт «задано», без значень)
    for (const grp of catalog) {
      for (const it of grp.items) {
        it.fields = (it.needs || []).map(n => ({ name: n, set: isSet(n), allowed: isAllowed(n) }));
      }
    }
    const all = catalog.flatMap(c => c.items);
    res.json({
      groups: catalog,
      summary: { total: all.length, connected: all.filter(x => x.configured).length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/integrations/configure — зберегти ключі інтеграції з UI.
// body: { values: { ENV_NAME: "значення", ... } }  (порожнє значення → очистити ключ)
// Значення пишуться в app_settings + одразу в process.env. Назовні нічого не повертаємо.
// requirePlatform: ключі з цього каталогу — платформенні (пишуться в глобальний process.env
// усього інстансу), тож редагувати їх може ЛИШЕ платформенний тенант. Інакше орендар міг би
// перезаписати MONO_TOKEN/TELEGRAM_BOT_TOKEN усієї платформи і перехопити платежі.
router.post('/configure', requirePlatform(), requirePerm('integrations.write'), async (req, res) => {
  try {
    const values = (req.body && req.body.values) || {};
    const names = Object.keys(values).filter(isAllowed);
    if (!names.length) return res.status(400).json({ error: 'no valid keys to save' });
    const userId = req.user && req.user.id ? req.user.id : null;
    const saved = [];
    for (const name of names) {
      const r = await saveIntegrationSecret(name, values[name], userId);
      saved.push(r);
    }
    res.json({ ok: true, saved }); // saved: [{name, set}] — без значень
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
