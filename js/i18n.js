/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — i18n v2  UA | RU | EN
   Fixed: uses innerHTML for [data-i18n] to preserve
   line-reveal wrappers and child elements
   ═══════════════════════════════════════════════════════ */

const TRANSLATIONS = {
  ua: {
    lang_label: 'UA',
    nav_services: 'Послуги', nav_shop: 'Магазин', nav_results: 'Результати',
    nav_about: 'Про нас', nav_contact: 'Контакти', nav_book: 'Записатися',

    hero_line1: 'Краса,', hero_line2: 'яка відчувається',
    hero_sub: 'Преміальний простір краси та естетики',
    hero_cta: 'Записатися', hero_shop: 'Магазин',

    svc_overline: 'Послуги', svc_title: 'Індивідуальна краса у деталях',

    rit_color_title: 'Фарбування', rit_color_text: 'Блонд, балаяж, омбре. Авторська техніка Foiled Cashmere.',
    rit_care_title: 'Відновлення', rit_care_text: 'Біовирівнювання, ботокс, реконструкція. Глибоке відновлення здоров\'я волосся.',
    rit_cut_title: 'Стрижки', rit_cut_text: 'Від класичних ліній до сучасних текстур.',
    rit_style_title: 'Зачіски', rit_style_text: 'Вечірні та весільні образи.',

    tr_overline: 'Результати', tr_title: 'Реальні перетворення', tr_before: 'До', tr_after: 'Після',
    stat_years: 'років досвіду', stat_clients: 'задоволених клієнтів',

    about_overline: 'Про нас', about_title: 'Ми не робимо зачіски. Ми створюємо відчуття.',
    about_text: 'SVS Beauty Space — це місце, де кожна деталь продумана. Від підбору техніки до індивідуального догляду. Преміальна косметика світових брендів. Авторські методики. Простір, створений для вас.',
    spec_overline: 'Експерти', spec_headline: 'Досвід. Чуттєвість. Майстерність.',
    spec_text: 'Наша команда — це експерти, які живуть красою та створюють її щодня.',

    book_overline: 'Запис', book_title: 'Готові до змін?',
    book_text: 'Запишіться на консультацію — разом підберемо ідеальне рішення.',
    book_cta: 'Записатися онлайн',

    contact_hint: 'Натисни щоб зв\u2019язатись',
    contact_hours_title: 'Графік', contact_hours: 'Пн — Нд: 8:00 — 19:00',
    contact_address_title: 'Адреса',
    contact_address: '1-ша Набережна р. Стрілка, 50, Суми',
    contact_directions: 'Прокласти маршрут',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  ru: {
    lang_label: 'RU',
    nav_services: 'Услуги', nav_shop: 'Магазин', nav_results: 'Результаты',
    nav_about: 'О нас', nav_contact: 'Контакты', nav_book: 'Записаться',

    hero_line1: 'Красота,', hero_line2: 'которая чувствуется',
    hero_sub: 'Премиальное пространство красоты и эстетики',
    hero_cta: 'Записаться', hero_shop: 'Магазин',

    svc_overline: 'Услуги', svc_title: 'Индивидуальная красота в деталях',

    rit_color_title: 'Окрашивание', rit_color_text: 'Блонд, балаяж, омбре. Авторская техника Foiled Cashmere.',
    rit_care_title: 'Восстановление', rit_care_text: 'Биовыравнивание, ботокс, реконструкция. Глубокое восстановление здоровья волос.',
    rit_cut_title: 'Стрижки', rit_cut_text: 'От классических линий до современных текстур.',
    rit_style_title: 'Причёски', rit_style_text: 'Вечерние и свадебные образы.',

    tr_overline: 'Результаты', tr_title: 'Реальные преображения', tr_before: 'До', tr_after: 'После',
    stat_years: 'лет опыта', stat_clients: 'довольных клиентов',

    about_overline: 'О нас', about_title: 'Мы не делаем причёски. Мы создаём ощущение.',
    about_text: 'SVS Beauty Space — это место, где каждая деталь продумана. От подбора техники до индивидуального ухода. Премиальная косметика мировых брендов. Авторские методики. Пространство, созданное для вас.',
    spec_overline: 'Эксперты', spec_headline: 'Опыт. Чуткость. Мастерство.',
    spec_text: 'Наша команда — это эксперты, которые живут красотой и создают её каждый день.',

    book_overline: 'Запись', book_title: 'Готовы к переменам?',
    book_text: 'Запишитесь на консультацию — вместе подберём идеальное решение.',
    book_cta: 'Записаться онлайн',

    contact_hint: 'Нажми чтобы связаться',
    contact_hours_title: 'График', contact_hours: 'Пн — Вс: 8:00 — 19:00',
    contact_address_title: 'Адрес',
    contact_address: '1-я Набережная р. Стрелка, 50, Сумы',
    contact_directions: 'Проложить маршрут',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  en: {
    lang_label: 'EN',
    nav_services: 'Services', nav_shop: 'Shop', nav_results: 'Results',
    nav_about: 'About', nav_contact: 'Contact', nav_book: 'Book',

    hero_line1: 'Beauty', hero_line2: 'that is felt',
    hero_sub: 'A premium space of beauty and aesthetics',
    hero_cta: 'Book Now', hero_shop: 'Shop',

    svc_overline: 'Services', svc_title: 'Individual beauty in details',

    rit_color_title: 'Colouring', rit_color_text: 'Blonde, balayage, ombre. Signature Foiled Cashmere technique.',
    rit_care_title: 'Restoration', rit_care_text: 'Bio-straightening, botox, reconstruction. Deep hair health recovery.',
    rit_cut_title: 'Haircuts', rit_cut_text: 'From classic lines to modern textures.',
    rit_style_title: 'Styling', rit_style_text: 'Evening and bridal looks.',

    tr_overline: 'Results', tr_title: 'Real transformations', tr_before: 'Before', tr_after: 'After',
    stat_years: 'years of experience', stat_clients: 'satisfied clients',

    about_overline: 'About', about_title: 'We don\'t do hairstyles. We create feeling.',
    about_text: 'SVS Beauty Space is where every detail is considered. From technique selection to personalized aftercare. Premium world-class cosmetics. Signature methods. A space designed for you.',
    spec_overline: 'Experts', spec_headline: 'Experience. Sensitivity. Mastery.',
    spec_text: 'Our team are experts who live and breathe beauty every day.',

    book_overline: 'Booking', book_title: 'Ready for a change?',
    book_text: 'Book a consultation — together we\'ll find the perfect solution.',
    book_cta: 'Book online',

    contact_hint: 'Tap to get in touch',
    contact_hours_title: 'Hours', contact_hours: 'Mon — Sun: 8 AM — 7 PM',
    contact_address_title: 'Address',
    contact_address: '1st Naberezhna r. Strilka, 50, Sumy',
    contact_directions: 'Get directions',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  pl: {
    lang_label: 'PL',
    nav_services: 'Usługi', nav_shop: 'Sklep', nav_results: 'Efekty',
    nav_about: 'O nas', nav_contact: 'Kontakt', nav_book: 'Rezerwacja',

    hero_line1: 'Piękno,', hero_line2: 'które się czuje',
    hero_sub: 'Ekskluzywna przestrzeń piękna i estetyki',
    hero_cta: 'Zarezerwuj', hero_shop: 'Sklep',

    svc_overline: 'Usługi', svc_title: 'Indywidualne piękno w szczegółach',

    rit_color_title: 'Koloryzacja', rit_color_text: 'Blond, balejaż, ombre. Autorska technika Foiled Cashmere.',
    rit_care_title: 'Regeneracja', rit_care_text: 'Biowyrównanie, botoks, rekonstrukcja. Głęboka regeneracja zdrowia włosów.',
    rit_cut_title: 'Strzyżenie', rit_cut_text: 'Od klasycznych linii po nowoczesne tekstury.',
    rit_style_title: 'Fryzury', rit_style_text: 'Stylizacje wieczorowe i ślubne.',

    tr_overline: 'Efekty', tr_title: 'Prawdziwe metamorfozy', tr_before: 'Przed', tr_after: 'Po',
    stat_years: 'lat doświadczenia', stat_clients: 'zadowolonych klientów',

    about_overline: 'O nas', about_title: 'Nie robimy fryzur. Tworzymy odczucia.',
    about_text: 'SVS Beauty Space to miejsce, gdzie każdy szczegół jest przemyślany. Od doboru techniki po indywidualną pielęgnację. Ekskluzywne kosmetyki światowych marek. Autorskie metody. Przestrzeń stworzona dla Ciebie.',
    spec_overline: 'Eksperci', spec_headline: 'Doświadczenie. Wrażliwość. Mistrzostwo.',
    spec_text: 'Nasz zespół to eksperci, którzy żyją pięknem i tworzą je każdego dnia.',

    book_overline: 'Rezerwacja', book_title: 'Gotowa na zmianę?',
    book_text: 'Zarezerwuj konsultację — wspólnie dobierzemy idealne rozwiązanie.',
    book_cta: 'Zarezerwuj online',

    contact_hint: 'Kliknij, aby się skontaktować',
    contact_hours_title: 'Godziny', contact_hours: 'Pn — Nd: 8:00 — 19:00',
    contact_address_title: 'Adres',
    contact_address: '1-ša Naberežna r. Strilka, 50, Sumy',
    contact_directions: 'Wyznacz trasę',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  it: {
    lang_label: 'IT',
    nav_services: 'Servizi', nav_shop: 'Shop', nav_results: 'Risultati',
    nav_about: 'Chi siamo', nav_contact: 'Contatti', nav_book: 'Prenota',

    hero_line1: 'Bellezza,', hero_line2: 'che si sente',
    hero_sub: 'Uno spazio premium di bellezza ed estetica',
    hero_cta: 'Prenota ora', hero_shop: 'Shop',

    svc_overline: 'Servizi', svc_title: 'Bellezza personalizzata nei dettagli',

    rit_color_title: 'Colorazione', rit_color_text: 'Biondo, balayage, ombré. Tecnica esclusiva Foiled Cashmere.',
    rit_care_title: 'Ricostruzione', rit_care_text: 'Lisciatura biologica, botox, ricostruzione. Recupero profondo della salute dei capelli.',
    rit_cut_title: 'Tagli', rit_cut_text: 'Dalle linee classiche alle texture moderne.',
    rit_style_title: 'Acconciature', rit_style_text: 'Look da sera e da sposa.',

    tr_overline: 'Risultati', tr_title: 'Trasformazioni reali', tr_before: 'Prima', tr_after: 'Dopo',
    stat_years: 'anni di esperienza', stat_clients: 'clienti soddisfatti',

    about_overline: 'Chi siamo', about_title: 'Non facciamo acconciature. Creiamo emozioni.',
    about_text: 'SVS Beauty Space è il luogo dove ogni dettaglio è curato. Dalla scelta della tecnica alla cura personalizzata. Cosmetici premium di marchi mondiali. Metodi esclusivi. Uno spazio creato per te.',
    spec_overline: 'Esperti', spec_headline: 'Esperienza. Sensibilità. Maestria.',
    spec_text: 'Il nostro team è composto da esperti che vivono la bellezza e la creano ogni giorno.',

    book_overline: 'Prenotazione', book_title: 'Pronta al cambiamento?',
    book_text: 'Prenota una consulenza — insieme troveremo la soluzione perfetta.',
    book_cta: 'Prenota online',

    contact_hint: 'Tocca per contattarci',
    contact_hours_title: 'Orari', contact_hours: 'Lun — Dom: 8:00 — 19:00',
    contact_address_title: 'Indirizzo',
    contact_address: '1-ša Naberežna r. Strilka, 50, Sumy',
    contact_directions: 'Ottieni indicazioni',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  de: {
    lang_label: 'DE',
    nav_services: 'Leistungen', nav_shop: 'Shop', nav_results: 'Ergebnisse',
    nav_about: 'Über uns', nav_contact: 'Kontakt', nav_book: 'Termin',

    hero_line1: 'Schönheit,', hero_line2: 'die man spürt',
    hero_sub: 'Ein Premium-Raum für Schönheit und Ästhetik',
    hero_cta: 'Termin buchen', hero_shop: 'Shop',

    svc_overline: 'Leistungen', svc_title: 'Individuelle Schönheit im Detail',

    rit_color_title: 'Coloration', rit_color_text: 'Blond, Balayage, Ombré. Exklusive Foiled-Cashmere-Technik.',
    rit_care_title: 'Regeneration', rit_care_text: 'Bio-Glättung, Botox, Rekonstruktion. Tiefe Regeneration gesunder Haare.',
    rit_cut_title: 'Haarschnitte', rit_cut_text: 'Von klassischen Linien bis zu modernen Texturen.',
    rit_style_title: 'Frisuren', rit_style_text: 'Abend- und Brautlooks.',

    tr_overline: 'Ergebnisse', tr_title: 'Echte Verwandlungen', tr_before: 'Vorher', tr_after: 'Nachher',
    stat_years: 'Jahre Erfahrung', stat_clients: 'zufriedene Kunden',

    about_overline: 'Über uns', about_title: 'Wir machen keine Frisuren. Wir schaffen Gefühl.',
    about_text: 'SVS Beauty Space ist ein Ort, an dem jedes Detail durchdacht ist. Von der Wahl der Technik bis zur individuellen Pflege. Premium-Kosmetik weltweiter Marken. Exklusive Methoden. Ein Raum, der für Sie geschaffen wurde.',
    spec_overline: 'Experten', spec_headline: 'Erfahrung. Feingefühl. Meisterschaft.',
    spec_text: 'Unser Team besteht aus Experten, die Schönheit leben und sie jeden Tag erschaffen.',

    book_overline: 'Termin', book_title: 'Bereit für Veränderung?',
    book_text: 'Vereinbaren Sie eine Beratung — gemeinsam finden wir die perfekte Lösung.',
    book_cta: 'Online buchen',

    contact_hint: 'Zum Kontaktieren tippen',
    contact_hours_title: 'Öffnungszeiten', contact_hours: 'Mo — So: 8:00 — 19:00',
    contact_address_title: 'Adresse',
    contact_address: '1-ša Naberežna r. Strilka, 50, Sumy',
    contact_directions: 'Route planen',

    footer_copy: '© 2026 SVS Beauty Space',
  },

  es: {
    lang_label: 'ES',
    nav_services: 'Servicios', nav_shop: 'Tienda', nav_results: 'Resultados',
    nav_about: 'Nosotros', nav_contact: 'Contacto', nav_book: 'Reservar',

    hero_line1: 'Belleza,', hero_line2: 'que se siente',
    hero_sub: 'Un espacio premium de belleza y estética',
    hero_cta: 'Reservar', hero_shop: 'Tienda',

    svc_overline: 'Servicios', svc_title: 'Belleza individual en los detalles',

    rit_color_title: 'Coloración', rit_color_text: 'Rubio, balayage, ombré. Técnica exclusiva Foiled Cashmere.',
    rit_care_title: 'Restauración', rit_care_text: 'Bio-alisado, botox, reconstrucción. Recuperación profunda de la salud del cabello.',
    rit_cut_title: 'Cortes', rit_cut_text: 'Desde líneas clásicas hasta texturas modernas.',
    rit_style_title: 'Peinados', rit_style_text: 'Looks de noche y de novia.',

    tr_overline: 'Resultados', tr_title: 'Transformaciones reales', tr_before: 'Antes', tr_after: 'Después',
    stat_years: 'años de experiencia', stat_clients: 'clientes satisfechos',

    about_overline: 'Nosotros', about_title: 'No hacemos peinados. Creamos sensaciones.',
    about_text: 'SVS Beauty Space es un lugar donde cada detalle está pensado. Desde la elección de la técnica hasta el cuidado personalizado. Cosmética premium de marcas mundiales. Métodos exclusivos. Un espacio creado para ti.',
    spec_overline: 'Expertos', spec_headline: 'Experiencia. Sensibilidad. Maestría.',
    spec_text: 'Nuestro equipo son expertos que viven la belleza y la crean cada día.',

    book_overline: 'Reserva', book_title: '¿Lista para un cambio?',
    book_text: 'Reserva una consulta — juntos encontraremos la solución perfecta.',
    book_cta: 'Reservar online',

    contact_hint: 'Toca para contactar',
    contact_hours_title: 'Horario', contact_hours: 'Lun — Dom: 8:00 — 19:00',
    contact_address_title: 'Dirección',
    contact_address: '1-ša Naberézhna r. Strilka, 50, Sumy',
    contact_directions: 'Cómo llegar',

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
    if (bl.startsWith('pl')) return 'pl';
    if (bl.startsWith('it')) return 'it';
    if (bl.startsWith('de')) return 'de';
    if (bl.startsWith('es')) return 'es';
    if (bl.startsWith('en')) return 'en';
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
