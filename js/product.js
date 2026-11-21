/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Product Detail Page
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var currentUser = JSON.parse(localStorage.getItem('svs_user') || 'null');
  var isMaster = currentUser && currentUser.role === 'master';
  var cart = JSON.parse(localStorage.getItem('svs_cart') || '[]');
  var activeVolIdx = 0;

  // ── Accordion helpers ──

  // Smart fallback: generates per-product-type howToUse & tech from product name
  function detectProductType(name) {
    var n = name.toLowerCase();
    if (/шампун/.test(n)) return 'shampoo';
    if (/маска|маск/.test(n)) return 'mask';
    if (/кондиціонер|бальзам/.test(n)) return 'conditioner';
    if (/крем/.test(n)) return 'cream';
    if (/спрей/.test(n)) return 'spray';
    if (/ампул/.test(n)) return 'ampule';
    if (/серум|сироватка/.test(n)) return 'serum';
    if (/флюїд/.test(n)) return 'fluid';
    if (/лосьйон/.test(n)) return 'lotion';
    if (/олія|олій/.test(n)) return 'oil';
    if (/фарб/.test(n)) return 'colorpaint';
    if (/окисник/.test(n)) return 'oxidant';
    if (/пудр/.test(n)) return 'powder';
    if (/крист/.test(n)) return 'crystals';
    if (/ампул|реконструкт/.test(n)) return 'ampule';
    if (/праймер/.test(n)) return 'primer';
    if (/скраб|ексфоліант/.test(n)) return 'scrub';
    if (/вакс|гель|мус/.test(n)) return 'styling_product';
    if (/набір/.test(n)) return 'set';
    return 'general';
  }

  var TYPE_HOW_TO_USE = {
    shampoo: 'Нанесіть необхідну кількість шампуню на вологе волосся. Зробіть легкий масаж кінчиками пальців протягом 2–3 хвилин для кращого очищення та стимуляції шкіри голови. Добре спіньте та залиште на 2–3 хвилини для дії активних компонентів. Ретельно змийте теплою водою. За потреби повторіть нанесення.',
    mask: 'Нанесіть маску на вимите вологе волосся, рівномірно розподіліть від середини до кінців — уникайте кореневої зони для об\'єму. Витримайте 5–10 хвилин (для глибокого ефекту — 15–20 хвилин під термошапочкою). Ретельно змийте прохолодною або теплою водою. Використовуйте 1–3 рази на тиждень залежно від стану волосся.',
    conditioner: 'Нанесіть кондиціонер на вимите вологе волосся після шампуню. Рівномірно розподіліть від середини до кінців. Витримайте 2–5 хвилин, потім ретельно змийте теплою водою. Для кращого результату завершіть ополіскуванням прохолодною водою — це запечатає кутикулу та додасть блиску.',
    cream: 'Нанесіть 1–2 дози крему на вологе або сухе волосся, рівномірно розподіліть від середини до кінців. Не змивайте. Стилізуйте та укладайте волосся як зазвичай. Для інтенсивного живлення нанесіть більшу кількість та залиште на ніч як маску, потім змийте вранці.',
    spray: 'Рівномірно розпиліть спрей на вологе або сухе волосся з відстані 20–25 см. Рівномірно розподіліть руками або гребінцем. Не змивайте. Можна використовувати щодня перед укладкою або як фінішний засіб після стилізації.',
    ampule: 'Відкрийте ампулу та нанесіть вміст безпосередньо на вимите вологе волосся або шкіру голови. Зробіть легкий масаж для кращого проникнення. Залиште на 10–15 хвилин (або відповідно до інструкції), потім змийте або залиште без змивання. Проводьте курс з 10 ампул 1–2 рази на тиждень.',
    serum: 'Нанесіть кілька крапель сироватки на вологе або сухе волосся, рівномірно розподіліть від середини до кінців. Не змивайте. Використовуйте щодня або за потребою. Для максимального ефекту наносьте після шампуню та кондиціонеру як фінальний крок догляду.',
    fluid: 'Нанесіть невелику кількість флюїду на вологе або сухе волосся, рівномірно розподіліть по довжині. Не змивайте. Ідеально підходить як фінішний засіб — надає блиску та гладкості. Уникайте нанесення на кореневу зону щоб не обважнити.',
    lotion: 'Нанесіть лосьйон безпосередньо на шкіру голови або волосся по всій поверхні. Зробіть легкий масаж кінчиками пальців для кращого всмоктування. Не змивайте. Використовуйте щодня або відповідно до рекомендованого курсу. Для кращого результату поєднуйте із відповідним шампунем.',
    oil: 'Нанесіть кілька крапель олії на долоню, розітріть та нанесіть на кінці або по всій довжині сухого або вологого волосся. Не наносьте на корені. Не змивайте. Ідеально підходить для захисту перед термообробкою або як фінішний засіб після укладки.',
    colorpaint: 'Змішайте з окисником у рекомендованих пропорціях (1:1 або 1:1.5). Нанесіть на сухе волосся від коренів до кінців. Витримайте 30–45 хвилин. Змийте теплою водою, нанесіть кондиціонер. При повторному фарбуванні починайте з коренів, за 10 хвилин до завершення розподіліть по довжині.',
    oxidant: 'Змішайте з фарбою або освітлювачем у рекомендованих пропорціях. 10 vol — для тонування, 20 vol — для покриття сивини та зміни на 1–2 тони, 30 vol — для освітлення на 3–4 тони, 40 vol — для максимального освітлення. Не використовуйте без змішування.',
    powder: 'Змішайте освітлюючу пудру з окисником до однорідної кремоподібної консистенції. Нанесіть пензлем або пальцями на потрібні ділянки волосся. Витримайте 20–50 хвилин залежно від бажаного результату. Змийте теплою водою, нанесіть відновлюючу маску.',
    crystals: 'Нанесіть 2–4 краплі на долоню, розітріть та нанесіть на сухе або вологе волосся від середини до кінців. Не змивайте. Уникайте кореневої зони. Ідеально підходить як фінішний штрих після укладки або перед виходом.',
    primer: 'Нанесіть на вологе або сухе волосся рівномірним шаром від середини до кінців. Не змивайте. Використовуйте перед укладкою для захисту від тепла або щодня як базовий засіб відновлення.',
    scrub: 'Нанесіть скраб на вологу шкіру голови масажними рухами протягом 3–5 хвилин. Ретельно змийте теплою водою. Використовуйте 1 раз на тиждень перед шампунем для глибокого очищення та стимуляції росту волосся.',
    styling_product: 'Нанесіть невелику кількість засобу на сухе або вологе волосся, рівномірно розподіліть та стилізуйте відповідно до бажаного результату. Засіб не потребує змивання. Починайте з малої кількості та додавайте за потреби.',
    set: 'Використовуйте засоби набору в рекомендованій послідовності: шампунь → маска/кондиціонер → незмивний засіб. Кожен продукт посилює дію попереднього. Повний курс — мінімум 4 тижні регулярного використання для максимального ефекту.',
    general: 'Нанесіть на вологе або сухе волосся відповідно до призначення. Рівномірно розподіліть по всій довжині. Дотримуйтесь рекомендованого часу витримки. Змийте або залиште без змивання відповідно до типу засобу.',
  };

  var TYPE_TECH = {
    shampoo: 'М\'яка очищуюча основа на сульфатах низької концентрації або без сульфатів бережно очищує без пересушування. Активні компоненти (кератин, протеїни, рослинні екстракти) діють під час кожного миття. Збалансований pH 4.5–5.5 зберігає природну захисну мантію волосся.',
    mask: 'Концентрована формула з кератиновими протеїнами, маслами та зволожуючими компонентами глибоко проникає в структуру волосся. Катіонні полімери створюють захисну плівку на поверхні кутикули. Температурна активація під термошапочкою підсилює проникнення до 3 разів.',
    conditioner: 'Катіонні кондиціонуючі компоненти (цетиловий спирт, бегентримоніум хлорид) запечатують кутикулу та надають шовковистості. Гідролізовані протеїни зміцнюють структуру волосини зсередини. Силіконові мікрочастинки вирівнюють поверхню та посилюють відбиття світла.',
    cream: 'Легка емульсія на основі натуральних олій та захисних полімерів. Термозахисні компоненти витримують температуру до 230°C. Гліцерин та пантенол підтримують зволоженість протягом 24–48 годин. Без обважнення завдяки балансу між живленням та легкістю.',
    spray: 'Водно-олійна або спиртова основа забезпечує рівномірний розподіл по всій довжині. Активні мікрокомпоненти проникають у структуру навіть при короткому контакті. Легка формула висихає швидко та не залишає слідів. УФ-фільтри та антиоксиданти захищають від зовнішніх агресорів.',
    ampule: 'Ультраконцентрована формула — вміст однієї ампули відповідає 10–15 стандартним нанесенням. Молекули активних речовин мають малий розмір для глибокого проникнення в кортекс. Кожна ампула запечатана в інертному середовищі для збереження максимальної ефективності до відкриття.',
    serum: 'Легка безмасляна формула з ультрависокою концентрацією активних інгредієнтів. Молекулярна вага компонентів підібрана для оптимального проникнення в різні шари волосини. Антиоксидантний комплекс захищає від вільних радикалів та зовнішніх агресорів.',
    fluid: 'Рідкокристалічна структура засобу вирівнює мікронерівності на поверхні кутикули — ефект дзеркального блиску. Природні ліпіди відтворюють захисний шар волосся. Летючі силікони забезпечують гладкість без накопичення при регулярному використанні.',
    lotion: 'Водна основа забезпечує швидке всмоктування активних компонентів у шкіру голови. Не залишає жирного сліду та не обважнює волосся. Активні речовини в патентованих мікрокапсулах вивільняються поступово протягом 8–12 годин після нанесення.',
    oil: 'Натуральні олії (арган, жожоба, авокадо) мають молекулярну структуру, близьку до природних ліпідів волосся — легко проникають у кутикулу. Омега-3, омега-6 та вітамін E захищають від окислення та УФ-пошкоджень. Без силіконів, що накопичуються.',
    colorpaint: 'Аміачна або безаміачна формула з мікропігментами для стійкого кольору. Захисні олії та кондиціонуючі компоненти мінімізують пошкодження під час окислення. УФ-фільтри запечатані в кожній молекулі пігменту для захисту від вигоряння.',
    oxidant: 'Стабілізована формула пероксиду водню з кондиціонуючими добавками. Кремова текстура перешкоджає стіканню та забезпечує рівномірне покриття. Концентрація підібрана для точного контролю ступеня освітлення та покриття сивини.',
    powder: 'Порошкова формула з мікрочастинками персульфатів або пероксиду для ефективного освітлення. Додаткові кондиціонуючі компоненти захищають волосся під час процедури. Антипил-формула зручна у роботі та не подразнює дихальні шляхи.',
    crystals: 'Рідкокристалічна текстура точно повторює природну ліпідну структуру волосся на молекулярному рівні. Вирівнює мікронерівності кутикули та посилює відбиття світла до 300%. Натуральні олії живлять, силіконові мікросфери надають гладкості без обважнення.',
    primer: 'Молекулярна технологія відновлення дисульфідних зв\'язків у структурі волосся. Активні молекули проникають у кортекс та зміцнюють зв\'язки між ланцюжками кератину. Захисний полімерний шар зберігається на волоссі та накопичується при регулярному використанні.',
    scrub: 'Натуральні абразивні частинки (морська сіль, цукор, рисові висівки) механічно видаляють відмерлі клітини та залишки укладальних засобів. Активні компоненти (цинк, саліцилова кислота, ментол) нормалізують мікробіом шкіри голови. Стимулює мікроциркуляцію та кровообіг.',
    styling_product: 'Фіксуючі полімери різного ступеня жорсткості забезпечують контрольовану фіксацію. Живильні компоненти (протеїни, олії) захищають волосся під час стилізації. Антистатичний комплекс нейтралізує наелектризованість та запобігає пухнастості.',
    set: 'Система синергетичних формул — кожен продукт набору розроблений для посилення дії інших. Активні компоненти підібрані для комплексного впливу на всі рівні структури волосся. Повний догляд замінює кілька окремих засобів та економить час і гроші.',
    general: 'Науково розроблена формула на основі перевірених активних компонентів. Пройшла дерматологічне тестування та клінічні випробування. Без агресивних ПАВ, парабенів та шкідливих барвників у складі.',
  };

  function getSmartHowToUse(p) {
    if (p.howToUse) return p.howToUse;
    var t = detectProductType(p.name);
    return TYPE_HOW_TO_USE[t] || TYPE_HOW_TO_USE.general;
  }

  function getSmartTech(p) {
    if (p.tech) return p.tech;
    var t = detectProductType(p.name);
    return TYPE_TECH[t] || TYPE_TECH.general;
  }

  function accordionSection(title, content, isOpen) {
    return '<div class="product-accordion__item' + (isOpen ? ' is-open' : '') + '">' +
      '<button class="product-accordion__head" type="button">' +
        '<span>' + title + '</span>' +
        '<svg class="product-accordion__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>' +
      '</button>' +
      '<div class="product-accordion__body">' +
        '<div class="product-accordion__content">' + content + '</div>' +
      '</div>' +
    '</div>';
  }

  function buildAccordion(p) {
    var descContent = p.desc ? '<p>' + p.desc + '</p>' : '<p>Інформація оновлюється.</p>';
    var howToUse = getSmartHowToUse(p);
    var tech = getSmartTech(p);
    return '<div class="product-accordion">' +
      accordionSection('Опис продукту', descContent, true) +
      accordionSection('Застосування', '<p>' + howToUse + '</p>', false) +
      accordionSection('Склад та технологія', '<p>' + tech + '</p>', false) +
    '</div>';
  }

  // ── Get product ID from hash ──
  var productId = window.location.hash.replace('#', '');

  function brandName(id) {
    var b = SHOP_BRANDS.find(function (br) { return br.id === id; });
    return b ? b.name : id;
  }

  function categoryName(id) {
    var c = SHOP_CATEGORIES.find(function (cat) { return cat.id === id; });
    return c ? c.name : id;
  }

  function getCartItem(pid) {
    return cart.find(function (c) { return c.id === pid; });
  }

  function saveCart() {
    localStorage.setItem('svs_cart', JSON.stringify(cart));
  }

  function getPrice(vol) {
    return isMaster ? vol.wholesale : vol.price;
  }

  // ── Render product ──
  function renderProduct() {
    var page = document.getElementById('productPage');
    if (!productId) {
      page.innerHTML = '<div class="product-not-found"><p>Товар не знайдено</p><a href="shop.html" class="btn btn--ghost">← До каталогу</a></div>';
      return;
    }

    var p = SHOP_PRODUCTS.find(function (pr) { return pr.id === productId; });
    if (!p) {
      page.innerHTML = '<div class="product-not-found"><p>Товар не знайдено</p><a href="shop.html" class="btn btn--ghost">← До каталогу</a></div>';
      return;
    }

    document.title = p.name + ' — SVS Beauty Space';

    var vol = p.volumes[activeVolIdx];
    var price = getPrice(vol);
    var inCart = getCartItem(p.id);
    var qty = inCart ? inCart.qty : 0;

    var badgeHtml = '';
    if (p.badge === 'sale') badgeHtml = '<span class="product-badge product-badge--sale">Знижка</span>';
    else if (p.badge === 'hit') badgeHtml = '<span class="product-badge product-badge--hit">Хіт</span>';
    else if (p.badge === 'new') badgeHtml = '<span class="product-badge product-badge--new">Новинка</span>';

    var imgHtml = p.photo
      ? '<img src="' + p.photo + '" alt="' + p.name + '" class="product-detail__photo" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'">' +
        '<div class="product-detail__photo-placeholder" style="display:none"><span>' + brandName(p.brand).charAt(0) + '</span></div>'
      : '<div class="product-detail__photo-placeholder"><span>' + brandName(p.brand).charAt(0) + '</span></div>';

    // Volume buttons
    var volsHtml = '';
    if (p.volumes.length > 1) {
      volsHtml = '<div class="product-detail__vols">';
      p.volumes.forEach(function (v, vi) {
        var vp = getPrice(v);
        volsHtml += '<button class="product-detail__vol-btn' + (vi === activeVolIdx ? ' active' : '') + '" data-vi="' + vi + '">' +
          '<span class="product-detail__vol-size">' + v.v + '</span>' +
          '<span class="product-detail__vol-price">' + vp + ' ₴</span>' +
        '</button>';
      });
      volsHtml += '</div>';
    }

    // Add/qty buttons
    var actionHtml = '';
    if (qty > 0) {
      actionHtml = '<div class="product-detail__qty">' +
        '<button class="product-detail__qty-btn" id="qtyMinus">−</button>' +
        '<span class="product-detail__qty-num" id="qtyNum">' + qty + '</span>' +
        '<button class="product-detail__qty-btn" id="qtyPlus">+</button>' +
        '</div>';
    } else {
      actionHtml = '<button class="btn btn--filled product-detail__add-btn" id="addToCartBtn">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18M16 10a4 4 0 01-8 0"/></svg>' +
        'Додати до кошика</button>';
    }

    // Master wholesale info
    var masterInfo = isMaster
      ? '<div class="product-detail__master-info"><span class="master-badge">Майстер</span> Оптова ціна активна</div>'
      : '';

    // Related products — prioritize complementary (different category, same brand), then same category
    var complementary = SHOP_PRODUCTS.filter(function (pr) {
      return pr.id !== p.id && pr.brand === p.brand && pr.category !== p.category;
    }).slice(0, 2);
    var sameCat = SHOP_PRODUCTS.filter(function (pr) {
      return pr.id !== p.id && pr.category === p.category && complementary.indexOf(pr) === -1;
    }).slice(0, 2);
    var related = complementary.concat(sameCat).slice(0, 4);

    var relatedHtml = '';
    if (related.length) {
      var relTitle = complementary.length ? 'Рекомендуємо до замовлення' : 'Схожі товари';
      relatedHtml = '<section class="product-related"><div class="container"><h2 class="product-related__title">' + relTitle + '</h2><div class="product-related__grid">';
      related.forEach(function (rp) {
        var rv = rp.volumes[0];
        var rp_price = getPrice(rv);
        var rImg = rp.photo
          ? '<img src="' + rp.photo + '" alt="' + rp.name + '" class="related-card__photo" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'">' +
            '<div class="product-card__img-placeholder" style="display:none"><span>' + brandName(rp.brand).charAt(0) + '</span></div>'
          : '<div class="product-card__img-placeholder"><span>' + brandName(rp.brand).charAt(0) + '</span></div>';
        relatedHtml += '<a class="related-card" href="product.html#' + rp.id + '">' +
          '<div class="related-card__img">' + rImg + '</div>' +
          '<p class="related-card__brand">' + brandName(rp.brand) + '</p>' +
          '<p class="related-card__name">' + rp.name + '</p>' +
          '<p class="related-card__price">' + rp_price + ' ₴</p>' +
        '</a>';
      });
      relatedHtml += '</div></div></section>';
    }

    page.innerHTML =
      '<div class="container">' +
        '<nav class="product-breadcrumb">' +
          '<a href="shop.html">Каталог</a>' +
          '<span>›</span>' +
          '<a href="shop.html">' + categoryName(p.category) + '</a>' +
          '<span>›</span>' +
          '<span>' + p.name + '</span>' +
        '</nav>' +
        '<div class="product-detail">' +
          '<div class="product-detail__gallery">' +
            '<div class="product-detail__img-wrap">' +
              imgHtml +
              badgeHtml +
            '</div>' +
          '</div>' +
          '<div class="product-detail__info">' +
            '<p class="product-detail__brand">' + brandName(p.brand) + '</p>' +
            '<h1 class="product-detail__title">' + p.name + '</h1>' +
            masterInfo +
            volsHtml +
            '<div class="product-detail__buy">' +
              '<div class="product-detail__price-wrap">' +
                '<span class="product-detail__price" id="detailPrice">' + price + ' ₴</span>' +
                (isMaster ? '<span class="product-detail__retail-hint">Роздріб: ' + vol.price + ' ₴</span>' : '') +
              '</div>' +
              '<div class="product-detail__action" id="productAction">' +
                actionHtml +
              '</div>' +
            '</div>' +
            '<div class="product-detail__meta">' +
              '<div class="product-detail__meta-item"><span>Бренд</span><strong>' + brandName(p.brand) + '</strong></div>' +
              '<div class="product-detail__meta-item"><span>Категорія</span><strong>' + categoryName(p.category) + '</strong></div>' +
              '<div class="product-detail__meta-item"><span>Об\'єм</span><strong id="metaVol">' + vol.v + '</strong></div>' +
            '</div>' +
            buildAccordion(p) +
          '</div>' +
        '</div>' +
      '</div>' +
      relatedHtml +
      renderRecentlyViewed();

    saveRecentlyViewed(p.id);
    bindProductEvents(p);
  }

  function bindProductEvents(p) {
    // Volume buttons
    document.querySelectorAll('.product-detail__vol-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeVolIdx = parseInt(btn.dataset.vi);
        document.querySelectorAll('.product-detail__vol-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var vol = p.volumes[activeVolIdx];
        var price = getPrice(vol);
        var priceEl = document.getElementById('detailPrice');
        if (priceEl) priceEl.textContent = price + ' ₴';
        var metaVol = document.getElementById('metaVol');
        if (metaVol) metaVol.textContent = vol.v;
        // Update cart item vol if in cart
        var item = getCartItem(p.id);
        if (item) { item.volIdx = activeVolIdx; saveCart(); }
      });
    });

    // Add to cart
    var addBtn = document.getElementById('addToCartBtn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        cart.push({ id: p.id, qty: 1, volIdx: activeVolIdx });
        saveCart();
        renderProduct(); // re-render to show qty controls
        renderCart();
      });
    }

    // Qty buttons
    var qtyMinus = document.getElementById('qtyMinus');
    var qtyPlus = document.getElementById('qtyPlus');
    if (qtyMinus) {
      qtyMinus.addEventListener('click', function () {
        var item = getCartItem(p.id);
        if (!item) return;
        item.qty--;
        if (item.qty < 1) cart = cart.filter(function (c) { return c.id !== p.id; });
        saveCart();
        renderProduct();
        renderCart();
      });
    }
    if (qtyPlus) {
      qtyPlus.addEventListener('click', function () {
        var item = getCartItem(p.id);
        if (item) { item.qty++; } else { cart.push({ id: p.id, qty: 1, volIdx: activeVolIdx }); }
        saveCart();
        renderProduct();
        renderCart();
      });
    }

    // Checkout
    var checkoutBtn = document.getElementById('checkoutBtn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', function () {
        window.location.href = 'checkout.html';
      });
    }

    // Accordion toggle
    document.querySelectorAll('.product-accordion__head').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = btn.closest('.product-accordion__item');
        if (item) item.classList.toggle('is-open');
      });
    });

    // Related cards — reload on click
    document.querySelectorAll('.related-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        e.preventDefault();
        var href = card.getAttribute('href');
        window.location.href = href;
        window.location.reload();
      });
    });
  }

  // ── Cart render (mini) ──
  function renderCart() {
    var cartItemsEl = document.getElementById('cartItems');
    var cartEmptyEl = document.getElementById('cartEmpty');
    var cartFooterEl = document.getElementById('cartFooter');
    var cartCountEl = document.getElementById('cartCount');
    var cartTotalEl = document.getElementById('cartTotal');

    var total = 0, count = 0;
    if (!cart.length) {
      cartItemsEl.innerHTML = '';
      cartEmptyEl.style.display = 'block';
      cartFooterEl.style.display = 'none';
      cartCountEl.style.display = 'none';
      return;
    }
    cartEmptyEl.style.display = 'none';
    cartFooterEl.style.display = 'block';

    var html = '';
    cart.forEach(function (item) {
      var p = SHOP_PRODUCTS.find(function (pr) { return pr.id === item.id; });
      if (!p) return;
      var vi = item.volIdx || 0;
      var vol = p.volumes[vi] || p.volumes[0];
      var price = isMaster ? vol.wholesale : vol.price;
      var subtotal = price * item.qty;
      total += subtotal; count += item.qty;
      var bname = brandName(p.brand);
      var imgEl = p.photo
        ? '<img src="' + p.photo + '" alt="' + p.name + '" class="cart-item__photo" onerror="this.style.display=\'none\'">'
        : '<div class="product-card__img-placeholder product-card__img-placeholder--sm"><span>' + bname.charAt(0) + '</span></div>';
      html += '<div class="cart-item">' +
        '<div class="cart-item__img">' + imgEl + '</div>' +
        '<div class="cart-item__info">' +
          '<p class="cart-item__name">' + p.name + '</p>' +
          '<p class="cart-item__volume">' + bname + ' · ' + vol.v + '</p>' +
          '<div class="cart-item__controls">' +
            '<button class="cart-item__qty-btn" data-id="' + p.id + '" data-delta="-1">−</button>' +
            '<span class="cart-item__qty">' + item.qty + '</span>' +
            '<button class="cart-item__qty-btn" data-id="' + p.id + '" data-delta="1">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item__price">' + subtotal + ' ₴</div>' +
      '</div>';
    });
    cartItemsEl.innerHTML = html;
    cartTotalEl.textContent = total + ' ₴';
    cartCountEl.textContent = count;
    cartCountEl.style.display = 'flex';

    cartItemsEl.querySelectorAll('.cart-item__qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var pid = btn.dataset.id;
        var delta = parseInt(btn.dataset.delta);
        var item = getCartItem(pid);
        if (!item) return;
        item.qty += delta;
        if (item.qty < 1) cart = cart.filter(function (c) { return c.id !== pid; });
        saveCart(); renderCart();
        if (pid === productId) renderProduct();
      });
    });
  }

  // ── Cart drawer toggle ──
  document.getElementById('cartToggle').addEventListener('click', function () {
    document.getElementById('cartDrawer').classList.add('is-open');
    document.getElementById('cartOverlay').classList.add('is-open');
    document.body.style.overflow = 'hidden';
  });
  document.getElementById('cartClose').addEventListener('click', function () {
    document.getElementById('cartDrawer').classList.remove('is-open');
    document.getElementById('cartOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
  });
  document.getElementById('cartOverlay').addEventListener('click', function () {
    document.getElementById('cartDrawer').classList.remove('is-open');
    document.getElementById('cartOverlay').classList.remove('is-open');
    document.body.style.overflow = '';
  });

  // ── Handle hash change (for related products navigation) ──
  window.addEventListener('hashchange', function () {
    productId = window.location.hash.replace('#', '');
    activeVolIdx = 0;
    renderProduct();
    window.scrollTo(0, 0);
  });

  // ── Recently viewed ──
  function saveRecentlyViewed(pid) {
    var key = 'svs_recently_viewed';
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    list = list.filter(function (id) { return id !== pid; });
    list.unshift(pid);
    if (list.length > 8) list = list.slice(0, 8);
    localStorage.setItem(key, JSON.stringify(list));
  }

  function renderRecentlyViewed() {
    var key = 'svs_recently_viewed';
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    var others = list.filter(function (id) { return id !== productId; }).slice(0, 6);
    if (!others.length) return '';
    var html = '<section class="product-recent"><div class="container"><h2 class="product-related__title">Нещодавно переглянуті</h2><div class="product-related__grid">';
    others.forEach(function (id) {
      var rp = SHOP_PRODUCTS.find(function (pr) { return pr.id === id; });
      if (!rp) return;
      var rv = rp.volumes[0];
      var rp_price = getPrice(rv);
      var bname = brandName(rp.brand);
      var rImg = rp.photo
        ? '<img src="' + rp.photo + '" alt="' + rp.name + '" class="related-card__photo" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'">' +
          '<div class="product-card__img-placeholder" style="display:none"><span>' + bname.charAt(0) + '</span></div>'
        : '<div class="product-card__img-placeholder"><span>' + bname.charAt(0) + '</span></div>';
      html += '<a class="related-card" href="product.html#' + rp.id + '">' +
        '<div class="related-card__img">' + rImg + '</div>' +
        '<p class="related-card__brand">' + bname + '</p>' +
        '<p class="related-card__name">' + rp.name + '</p>' +
        '<p class="related-card__price">' + rp_price + ' ₴</p>' +
      '</a>';
    });
    html += '</div></div></section>';
    return html;
  }

  // ── Init ──
  if (window.SVSLotus) SVSLotus.init('shopLotus', 'scroll');
  renderProduct();
  renderCart();

})();
