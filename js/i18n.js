/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — i18n v2  UA | RU | EN
   Fixed: uses innerHTML for [data-i18n] to preserve
   line-reveal wrappers and child elements
   ═══════════════════════════════════════════════════════ */

const TRANSLATIONS = {
  ua: {
    lang_label: 'UA',
    nav_services: 'Послуги', nav_results: 'Результати',
    nav_about: 'Про нас', nav_contact: 'Контакти', nav_book: 'Записатися',

    hero_line1: 'Краса,', hero_line2: 'яка відчувається',
    hero_sub: 'Преміальний простір краси та естетики',
    hero_cta: 'Записатися',

    svc_overline: 'Послуги', svc_title: 'Індивідуальна краса у деталях',

    rit_color_title: 'Фарбування', rit_color_text: 'Блонд, балаяж, омбре. Авторська техніка Foiled Cashmere.',
    rit_care_title: 'Відновлення', rit_care_text: 'Кератин, нанопластика, ботокс. Глибока реконструкція структури.',
    rit_cut_title: 'Стрижки', rit_cut_text: 'Від класичних ліній до сучасних текстур.',
    rit_style_title: 'Зачіски', rit_style_text: 'Вечірні та весільні образи.',

    tr_overline: 'Результати', tr_title: 'Реальні перетворення', tr_before: 'До', tr_after: 'Після',
    stat_years: 'років досвіду', stat_clients: 'задоволених клієнтів', stat_raywell: 'офіційний представник',

    about_overline: 'Про нас', about_title: 'Ми не робимо зачіски. Ми створюємо відчуття.',
    about_text: 'SVS Beauty Space — це місце, де кожна деталь продумана. Від підбору техніки до індивідуального догляду. Преміальна італійська косметика Raywell. Авторські методики. Простір, створений для вас.',
    spec_overline: 'Експерти', spec_headline: 'Досвід. Чуттєвість. Майстерність.',
    spec_text: 'Наша команда — це експерти, які живуть красою та створюють її щодня.',

    book_overline: 'Запис', book_title: 'Готові до змін?',
    book_text: 'Запишіться на консультацію — разом підберемо ідеальне рішення.',
    book_cta: 'Записатися онлайн',

    contact_hours_title: 'Графік', contact_hours: 'Пн — Нд: 9:00 — 19:00',
    contact_address_title: 'Адреса',
    contact_address: 'вул. Набережна р. Стрілки, 50, Суми',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  ru: {
    lang_label: 'RU',
    nav_services: 'Услуги', nav_results: 'Результаты',
    nav_about: 'О нас', nav_contact: 'Контакты', nav_book: 'Записаться',

    hero_line1: 'Красота,', hero_line2: 'которая чувствуется',
    hero_sub: 'Премиальное пространство красоты и эстетики',
    hero_cta: 'Записаться',

    svc_overline: 'Услуги', svc_title: 'Индивидуальная красота в деталях',

    rit_color_title: 'Окрашивание', rit_color_text: 'Блонд, балаяж, омбре. Авторская техника Foiled Cashmere.',
    rit_care_title: 'Восстановление', rit_care_text: 'Кератин, нанопластика, ботокс. Глубокая реконструкция структуры.',
    rit_cut_title: 'Стрижки', rit_cut_text: 'От классических линий до современных текстур.',
    rit_style_title: 'Причёски', rit_style_text: 'Вечерние и свадебные образы.',

    tr_overline: 'Результаты', tr_title: 'Реальные преображения', tr_before: 'До', tr_after: 'После',
    stat_years: 'лет опыта', stat_clients: 'довольных клиентов', stat_raywell: 'официальный представитель',

    about_overline: 'О нас', about_title: 'Мы не делаем причёски. Мы создаём ощущение.',
    about_text: 'SVS Beauty Space — это место, где каждая деталь продумана. От подбора техники до индивидуального ухода. Премиальная итальянская косметика Raywell. Авторские методики. Пространство, созданное для вас.',
    spec_overline: 'Эксперты', spec_headline: 'Опыт. Чуткость. Мастерство.',
    spec_text: 'Наша команда — это эксперты, которые живут красотой и создают её каждый день.',

    book_overline: 'Запись', book_title: 'Готовы к переменам?',
    book_text: 'Запишитесь на консультацию — вместе подберём идеальное решение.',
    book_cta: 'Записаться онлайн',

    contact_hours_title: 'График', contact_hours: 'Пн — Вс: 9:00 — 19:00',
    contact_address_title: 'Адрес',
    contact_address: 'ул. Набережная р. Стрелки, 50, Сумы',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  en: {
    lang_label: 'EN',
    nav_services: 'Services', nav_results: 'Results',
    nav_about: 'About', nav_contact: 'Contact', nav_book: 'Book',

    hero_line1: 'Beauty', hero_line2: 'that is felt',
    hero_sub: 'A premium space of beauty and aesthetics',
    hero_cta: 'Book Now',

    svc_overline: 'Services', svc_title: 'Individual beauty in details',

    rit_color_title: 'Colouring', rit_color_text: 'Blonde, balayage, ombre. Signature Foiled Cashmere technique.',
    rit_care_title: 'Restoration', rit_care_text: 'Keratin, nanoplasty, botox. Deep structural reconstruction.',
    rit_cut_title: 'Haircuts', rit_cut_text: 'From classic lines to modern textures.',
    rit_style_title: 'Styling', rit_style_text: 'Evening and bridal looks.',

    tr_overline: 'Results', tr_title: 'Real transformations', tr_before: 'Before', tr_after: 'After',
    stat_years: 'years of experience', stat_clients: 'satisfied clients', stat_raywell: 'official representative',

    about_overline: 'About', about_title: 'We don\'t do hairstyles. We create feeling.',
    about_text: 'SVS Beauty Space is where every detail is considered. From technique selection to personalized aftercare. Premium Italian Raywell cosmetics. Signature methods. A space designed for you.',
    spec_overline: 'Experts', spec_headline: 'Experience. Sensitivity. Mastery.',
    spec_text: 'Our team are experts who live and breathe beauty every day.',

    book_overline: 'Booking', book_title: 'Ready for a change?',
    book_text: 'Book a consultation — together we\'ll find the perfect solution.',
    book_cta: 'Book online',

    contact_hours_title: 'Hours', contact_hours: 'Mon — Sun: 9 AM — 7 PM',
    contact_address_title: 'Address',
    contact_address: '50 Naberezhna r. Strilky St, Sumy',

    footer_copy: '© 2026 SVS Beauty Space',
  }
};

/* ── I18N Engine ─────────────────────────────────────── */
const I18N = {
  _lang: 'ua', _listeners: [],

  detect() {
    const s = localStorage.getItem('svs-lang');
    if (s && TRANSLATIONS[s]) return s;
    const bl = (navigator.language || '').toLowerCase();
    if (bl.startsWith('uk')) return 'ua';
    if (bl.startsWith('ru')) return 'ru';
    return 'ua';
  },

  init() { this._lang = this.detect(); this.apply(); this._updateLangBtns(); },
  get lang() { return this._lang; },

  set(lang) {
    if (!TRANSLATIONS[lang]) return;
    this._lang = lang;
    localStorage.setItem('svs-lang', lang);
    this.apply();
    this._updateLangBtns();
    this._listeners.forEach(fn => fn(lang));
  },

  t(key) { return TRANSLATIONS[this._lang]?.[key] || TRANSLATIONS.ua[key] || key; },

  apply() {
    document.documentElement.lang = this._lang === 'ua' ? 'uk' : this._lang;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const t = this.t(el.getAttribute('data-i18n'));
      if (el.tagName === 'INPUT') {
        el.placeholder = t;
      } else {
        el.textContent = t;
      }
    });
  },

  _updateLangBtns() {
    document.querySelectorAll('.nav__lang[data-lang]').forEach(btn => {
      btn.classList.toggle('nav__lang--active', btn.dataset.lang === this._lang);
      btn.setAttribute('aria-pressed', btn.dataset.lang === this._lang);
    });
  },

  onChange(fn) { this._listeners.push(fn); }
};
