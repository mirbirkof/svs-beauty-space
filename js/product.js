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
  var DEFAULT_HOW_TO_USE = {
    coloring: 'Змішайте фарбу з окисником у рекомендованих пропорціях (зазвичай 1:1 або 1:1.5). Нанесіть на сухе або злегка вологе волосся, рівномірно розподіліть від коренів до кінців. Витримайте 30–45 хвилин залежно від бажаного результату, потім ретельно змийте теплою водою. Нанесіть кондиціонер або маску для фіксації кольору.',
    care: 'Нанесіть на вологе волосся після шампуню. Рівномірно розподіліть від середини до кінців, уникаючи кореневої зони. Витримайте 3–5 хвилин, потім ретельно змийте теплою водою. Використовуйте регулярно для кращого результату.',
    repair: 'Нанесіть на вологе, попередньо вимите волосся. Особливу увагу приділіть пошкодженим зонам — кінцям та вибіленим ділянкам. Витримайте 5–15 хвилин, змийте. Для інтенсивного відновлення використовуйте 2–3 рази на тиждень.',
    styling: 'Нанесіть невелику кількість засобу на вологе або сухе волосся, рівномірно розподіліть від середини до кінців. Стилізуйте волосся відповідно до бажаного результату. Не змивайте.',
    special: 'Нанесіть на чисту шкіру голови або волосся, злегка масажуючи кінчиками пальців. Дотримуйтесь рекомендованого часу витримки. Для кращого результату проходьте повний курс без переривань.',
  };
  var DEFAULT_TECH = {
    coloring: 'Формула збагачена натуральними маслами та захисними комплексами. Технологія мікро-пігментів забезпечує насичений і стійкий колір до 8 тижнів. УФ-фільтри захищають колір від вигоряння на сонці.',
    care: 'Формула на основі кератинових протеїнів, гіалуронової кислоти та натуральних масел. Амінокислотний комплекс відновлює ліпідний шар волосся. Пантенол та вітамін E живлять і захищають кожну волосину.',
    repair: 'Кератинові протеїни та амінокислоти відновлюють дисульфідні зв\'язки в структурі волосся. Молекулярна технологія проникає в кортекс, відновлюючи його зсередини. Гідролізований шовк надає гладкості та дзеркального блиску.',
    styling: 'Легкі фіксуючі полімери та живильні компоненти забезпечують стійкий результат без обважнення. Термозахисна формула витримує температуру до 230°C. УФ-фільтри захищають волосся від сонячного вигоряння.',
    special: 'Активні компоненти цілеспрямовано впливають на стан шкіри голови та волосяного фолікулу. Природні екстракти та вітамінні комплекси живлять корені й стимулюють ріст. Клінічно перевірена ефективність після 4 тижнів застосування.',
  };

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
    var howToUse = p.howToUse || DEFAULT_HOW_TO_USE[p.category] || '';
    var tech = p.tech || DEFAULT_TECH[p.category] || '';
    return '<div class="product-accordion">' +
      accordionSection('Опис продукту', descContent, true) +
      (howToUse ? accordionSection('Застосування', '<p>' + howToUse + '</p>', false) : '') +
      (tech ? accordionSection('Склад та технологія', '<p>' + tech + '</p>', false) : '') +
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

    // Related products (same brand, same category)
    var related = SHOP_PRODUCTS.filter(function (pr) {
      return pr.id !== p.id && (pr.brand === p.brand || pr.category === p.category);
    }).slice(0, 4);

    var relatedHtml = '';
    if (related.length) {
      relatedHtml = '<section class="product-related"><div class="container"><h2 class="product-related__title">Схожі товари</h2><div class="product-related__grid">';
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
      relatedHtml;

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

  // ── Init ──
  if (window.SVSLotus) SVSLotus.init('shopLotus', 'scroll');
  renderProduct();
  renderCart();

})();
