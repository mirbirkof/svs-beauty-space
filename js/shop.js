/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Shop Engine v2
   Brands filter, quantity selector, retail prices only
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── State ──
  var cart = JSON.parse(localStorage.getItem('svs_cart') || '[]');
  var activeBrand = null;
  var activeCategory = null;
  var searchQuery = '';
  var sortMode = 'popular';

  // ── DOM refs ──
  var brandGrid = document.getElementById('brandGrid');
  var catGrid = document.getElementById('catGrid');
  var productsGrid = document.getElementById('productsGrid');
  var productsTitle = document.getElementById('productsTitle');
  var productsEmpty = document.getElementById('productsEmpty');
  var cartDrawer = document.getElementById('cartDrawer');
  var cartOverlay = document.getElementById('cartOverlay');
  var cartItems = document.getElementById('cartItems');
  var cartEmpty = document.getElementById('cartEmpty');
  var cartFooter = document.getElementById('cartFooter');
  var cartCount = document.getElementById('cartCount');
  var cartTotal = document.getElementById('cartTotal');
  var searchBar = document.getElementById('searchBar');
  var searchInput = document.getElementById('searchInput');
  var sortSelect = document.getElementById('sortSelect');

  // ── Brand name lookup ──
  function brandName(id) {
    var b = SHOP_BRANDS.find(function (br) { return br.id === id; });
    return b ? b.name : id;
  }

  // ── Brands ──
  function renderBrands() {
    var html = '<button class="shop-brand' + (!activeBrand ? ' shop-brand--active' : '') + '" data-brand="">Усі бренди</button>';
    SHOP_BRANDS.forEach(function (b) {
      html += '<button class="shop-brand' + (activeBrand === b.id ? ' shop-brand--active' : '') + '" data-brand="' + b.id + '">' + b.name + '</button>';
    });
    brandGrid.innerHTML = html;

    brandGrid.querySelectorAll('.shop-brand').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeBrand = btn.dataset.brand || null;
        renderBrands();
        renderCategories();
        renderProducts();
      });
    });
  }

  // ── Categories ──
  function renderCategories() {
    // Count products per category (respecting brand filter)
    var counts = {};
    var totalCount = 0;
    SHOP_PRODUCTS.forEach(function (p) {
      if (activeBrand && p.brand !== activeBrand) return;
      counts[p.category] = (counts[p.category] || 0) + 1;
      totalCount++;
    });

    var html = '<button class="shop-cat' + (!activeCategory ? ' shop-cat--active' : '') + '" data-cat="">' +
      '<span class="shop-cat__icon">☆</span><span class="shop-cat__name">Усі <span class="shop-cat__count">' + totalCount + '</span></span></button>';
    SHOP_CATEGORIES.forEach(function (c) {
      if (!counts[c.id]) return; // hide empty categories
      html += '<button class="shop-cat' + (activeCategory === c.id ? ' shop-cat--active' : '') + '" data-cat="' + c.id + '">' +
        '<span class="shop-cat__icon">' + c.icon + '</span><span class="shop-cat__name">' + c.name + ' <span class="shop-cat__count">' + counts[c.id] + '</span></span></button>';
    });
    catGrid.innerHTML = html;

    catGrid.querySelectorAll('.shop-cat').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeCategory = btn.dataset.cat || null;
        renderCategories();
        renderProducts();
      });
    });
  }

  // ── Products ──
  function getFilteredProducts() {
    var list = SHOP_PRODUCTS.slice();

    if (activeBrand) {
      list = list.filter(function (p) { return p.brand === activeBrand; });
    }

    if (activeCategory) {
      list = list.filter(function (p) { return p.category === activeCategory; });
    }

    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function (p) {
        return p.name.toLowerCase().indexOf(q) !== -1 ||
               brandName(p.brand).toLowerCase().indexOf(q) !== -1 ||
               p.desc.toLowerCase().indexOf(q) !== -1;
      });
    }

    if (sortMode === 'price-asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (sortMode === 'price-desc') list.sort(function (a, b) { return b.price - a.price; });
    else if (sortMode === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'uk'); });
    else list.sort(function (a, b) { return (b.popular ? 1 : 0) - (a.popular ? 1 : 0); });

    return list;
  }

  function renderProducts() {
    var list = getFilteredProducts();

    // Title
    var title = 'Усі товари';
    if (searchQuery) title = 'Результати: «' + searchQuery + '»';
    else if (activeBrand && activeCategory) {
      var br = SHOP_BRANDS.find(function (b) { return b.id === activeBrand; });
      var cat = SHOP_CATEGORIES.find(function (c) { return c.id === activeCategory; });
      title = (br ? br.name : '') + ' — ' + (cat ? cat.name : '');
    } else if (activeBrand) {
      var br2 = SHOP_BRANDS.find(function (b) { return b.id === activeBrand; });
      title = br2 ? br2.name : 'Усі товари';
    } else if (activeCategory) {
      var cat2 = SHOP_CATEGORIES.find(function (c) { return c.id === activeCategory; });
      title = cat2 ? cat2.name : 'Усі товари';
    }
    productsTitle.textContent = title + ' (' + list.length + ')';

    if (!list.length) {
      productsGrid.innerHTML = '';
      productsEmpty.style.display = 'block';
      return;
    }
    productsEmpty.style.display = 'none';

    var html = '';
    list.forEach(function (p) {
      var inCart = cart.find(function (c) { return c.id === p.id; });
      var qty = inCart ? inCart.qty : 1;
      var badgeHtml = '';
      if (p.badge === 'sale') badgeHtml = '<span class="product-card__badge product-card__badge--sale">Знижка</span>';
      else if (p.badge === 'hit') badgeHtml = '<span class="product-card__badge product-card__badge--hit">Хіт</span>';
      else if (p.badge === 'new') badgeHtml = '<span class="product-card__badge product-card__badge--new">Новинка</span>';

      var displayPrice = inCart ? p.price * qty : p.price;

      html += '<div class="product-card" data-id="' + p.id + '">' +
        '<div class="product-card__img">' +
          '<div class="product-card__img-placeholder">' +
            '<span>' + brandName(p.brand).charAt(0) + '</span>' +
          '</div>' +
          badgeHtml +
        '</div>' +
        '<div class="product-card__body">' +
          '<p class="product-card__brand">' + brandName(p.brand) + '</p>' +
          '<h3 class="product-card__name">' + p.name + '</h3>' +
          '<p class="product-card__volume">' + p.volume + '</p>' +
          (p.desc ? '<p class="product-card__desc">' + p.desc + '</p>' : '') +
          '<div class="product-card__footer">' +
            '<div class="product-card__prices">' +
              '<span class="product-card__price">' + displayPrice + ' ₴</span>' +
            '</div>' +
            '<div class="product-card__actions">' +
              (inCart ?
                '<div class="product-card__qty">' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="-1">−</button>' +
                  '<span class="product-card__qty-num">' + qty + '</span>' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="1">+</button>' +
                '</div>'
              :
                '<button class="product-card__add" data-id="' + p.id + '">Додати</button>'
              ) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    });

    productsGrid.innerHTML = html;

    productsGrid.querySelectorAll('.product-card').forEach(function (card, i) {
      card.style.animationDelay = (i * 0.04) + 's';
    });

    // Add-to-cart buttons
    productsGrid.querySelectorAll('.product-card__add').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        addToCart(btn.dataset.id);
      });
    });

    // Qty buttons on cards
    productsGrid.querySelectorAll('.product-card__qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        updateQty(btn.dataset.id, parseInt(btn.dataset.delta));
      });
    });
  }

  // ── Cart logic ──
  function addToCart(productId) {
    cart.push({ id: productId, qty: 1 });
    saveCart();
    renderProducts();
    renderCart();
    lotusCartAnimation();
  }

  function lotusCartAnimation() {
    var lotus = document.getElementById('shopLotus');
    if (!lotus) return;

    if (window.SVSLotus) SVSLotus.wiggle('shopLotus');
    else {
      lotus.classList.remove('is-wiggling');
      void lotus.offsetWidth;
      lotus.classList.add('is-wiggling');
      setTimeout(function() { lotus.classList.remove('is-wiggling'); }, 900);
    }

    var rect = lotus.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    for (var i = 0; i < 8; i++) {
      var dot = document.createElement('div');
      dot.className = 'lotus-sparkle';
      var angle = (Math.PI * 2 / 8) * i + (Math.random() - 0.5) * 0.5;
      var dist = 30 + Math.random() * 40;
      var tx = Math.cos(angle) * dist;
      var ty = Math.sin(angle) * dist;
      dot.style.left = cx + 'px';
      dot.style.top = cy + 'px';
      dot.style.animationDelay = (i * 0.04) + 's';
      dot.style.width = (4 + Math.random() * 4) + 'px';
      dot.style.height = dot.style.width;
      dot.style.animation = 'none';
      document.body.appendChild(dot);
      void dot.offsetWidth;
      dot.style.animation = '';
      dot.style.setProperty('--tx', tx + 'px');
      dot.style.setProperty('--ty', ty + 'px');
      setTimeout(function(el) { el.remove(); }.bind(null, dot), 1000);
    }
  }

  function updateQty(productId, delta) {
    var item = cart.find(function (c) { return c.id === productId; });
    if (!item) return;
    item.qty += delta;
    if (item.qty < 1) {
      cart = cart.filter(function (c) { return c.id !== productId; });
    }
    saveCart();
    renderCart();
    renderProducts();
  }

  function saveCart() {
    localStorage.setItem('svs_cart', JSON.stringify(cart));
  }

  function renderCart() {
    var total = 0;
    var count = 0;

    if (!cart.length) {
      cartItems.innerHTML = '';
      cartEmpty.style.display = 'block';
      cartFooter.style.display = 'none';
      cartCount.style.display = 'none';
      return;
    }

    cartEmpty.style.display = 'none';
    cartFooter.style.display = 'block';

    var html = '';
    cart.forEach(function (item) {
      var p = SHOP_PRODUCTS.find(function (pr) { return pr.id === item.id; });
      if (!p) return;
      var subtotal = p.price * item.qty;
      total += subtotal;
      count += item.qty;

      html += '<div class="cart-item">' +
        '<div class="cart-item__img">' +
          '<div class="product-card__img-placeholder product-card__img-placeholder--sm">' +
            '<span>' + brandName(p.brand).charAt(0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item__info">' +
          '<p class="cart-item__name">' + p.name + '</p>' +
          '<p class="cart-item__volume">' + brandName(p.brand) + ' · ' + p.volume + '</p>' +
          '<div class="cart-item__controls">' +
            '<button class="cart-item__qty-btn" data-id="' + p.id + '" data-delta="-1">−</button>' +
            '<span class="cart-item__qty">' + item.qty + '</span>' +
            '<button class="cart-item__qty-btn" data-id="' + p.id + '" data-delta="1">+</button>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item__price">' + subtotal + ' ₴</div>' +
      '</div>';
    });

    cartItems.innerHTML = html;
    cartTotal.textContent = total + ' ₴';
    cartCount.textContent = count;
    cartCount.style.display = 'flex';

    cartItems.querySelectorAll('.cart-item__qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        updateQty(btn.dataset.id, parseInt(btn.dataset.delta));
      });
    });
  }

  // ── Cart drawer toggle ──
  function openCart() {
    cartDrawer.classList.add('is-open');
    cartOverlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closeCart() {
    cartDrawer.classList.remove('is-open');
    cartOverlay.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  // ── Search ──
  function openSearch() {
    searchBar.classList.add('is-open');
    searchInput.focus();
  }

  function closeSearch() {
    searchBar.classList.remove('is-open');
    searchInput.value = '';
    searchQuery = '';
    renderProducts();
  }

  // ── Events ──
  document.getElementById('cartToggle').addEventListener('click', openCart);
  document.getElementById('cartClose').addEventListener('click', closeCart);
  cartOverlay.addEventListener('click', closeCart);

  document.getElementById('searchToggle').addEventListener('click', openSearch);
  document.getElementById('searchClose').addEventListener('click', closeSearch);

  searchInput.addEventListener('input', function () {
    searchQuery = searchInput.value.trim();
    if (searchQuery) { activeBrand = null; activeCategory = null; }
    renderBrands();
    renderCategories();
    renderProducts();
  });

  sortSelect.addEventListener('change', function () {
    sortMode = sortSelect.value;
    renderProducts();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeCart();
      closeSearch();
    }
  });

  // ── Init ──
  if (window.SVSLotus) {
    SVSLotus.init('shopLotus', 'scroll');
  }

  renderBrands();
  renderCategories();
  renderProducts();
  renderCart();

})();
