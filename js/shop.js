/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Shop Engine v1
   Pure JS, no dependencies. Cart in localStorage.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── State ──
  var cart = JSON.parse(localStorage.getItem('svs_cart') || '[]');
  var activeCategory = null;
  var searchQuery = '';
  var sortMode = 'popular';

  // ── DOM refs ──
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

  // ── Categories ──
  function renderCategories() {
    var html = '<button class="shop-cat' + (!activeCategory ? ' shop-cat--active' : '') + '" data-cat="">' +
      '<span class="shop-cat__icon">☆</span><span class="shop-cat__name">Усі</span></button>';
    SHOP_CATEGORIES.forEach(function (c) {
      html += '<button class="shop-cat' + (activeCategory === c.id ? ' shop-cat--active' : '') + '" data-cat="' + c.id + '">' +
        '<span class="shop-cat__icon">' + c.icon + '</span><span class="shop-cat__name">' + c.name + '</span></button>';
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

    if (activeCategory) {
      list = list.filter(function (p) { return p.category === activeCategory; });
    }

    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function (p) {
        return p.name.toLowerCase().indexOf(q) !== -1 ||
               p.brand.toLowerCase().indexOf(q) !== -1 ||
               p.desc.toLowerCase().indexOf(q) !== -1 ||
               p.category.toLowerCase().indexOf(q) !== -1;
      });
    }

    // Sort
    if (sortMode === 'price-asc') list.sort(function (a, b) { return a.price - b.price; });
    else if (sortMode === 'price-desc') list.sort(function (a, b) { return b.price - a.price; });
    else if (sortMode === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'uk'); });
    else list.sort(function (a, b) { return (b.popular ? 1 : 0) - (a.popular ? 1 : 0); });

    return list;
  }

  function renderProducts() {
    var list = getFilteredProducts();

    if (activeCategory) {
      var cat = SHOP_CATEGORIES.find(function (c) { return c.id === activeCategory; });
      productsTitle.textContent = cat ? cat.name : 'Усі товари';
    } else if (searchQuery) {
      productsTitle.textContent = 'Результати: «' + searchQuery + '»';
    } else {
      productsTitle.textContent = 'Усі товари';
    }

    if (!list.length) {
      productsGrid.innerHTML = '';
      productsEmpty.style.display = 'block';
      return;
    }
    productsEmpty.style.display = 'none';

    var html = '';
    list.forEach(function (p) {
      var inCart = cart.find(function (c) { return c.id === p.id; });
      var badgeHtml = '';
      if (p.badge === 'sale') badgeHtml = '<span class="product-card__badge product-card__badge--sale">Знижка</span>';
      else if (p.badge === 'hit') badgeHtml = '<span class="product-card__badge product-card__badge--hit">Хіт</span>';
      else if (p.badge === 'new') badgeHtml = '<span class="product-card__badge product-card__badge--new">Новинка</span>';

      var priceHtml = '';
      if (p.oldPrice) {
        priceHtml = '<span class="product-card__old-price">' + p.oldPrice + ' ₴</span> <span class="product-card__price product-card__price--sale">' + p.price + ' ₴</span>';
      } else {
        priceHtml = '<span class="product-card__price">' + p.price + ' ₴</span>';
      }

      html += '<div class="product-card" data-id="' + p.id + '">' +
        '<div class="product-card__img">' +
          '<div class="product-card__img-placeholder">' +
            '<span>' + p.name.charAt(0) + '</span>' +
          '</div>' +
          badgeHtml +
        '</div>' +
        '<div class="product-card__body">' +
          '<p class="product-card__brand">' + p.brand + '</p>' +
          '<h3 class="product-card__name">' + p.name + '</h3>' +
          '<p class="product-card__volume">' + p.volume + '</p>' +
          '<p class="product-card__desc">' + p.desc + '</p>' +
          '<div class="product-card__footer">' +
            '<div class="product-card__prices">' + priceHtml + '</div>' +
            '<button class="product-card__add' + (inCart ? ' product-card__add--in-cart' : '') + '" data-id="' + p.id + '">' +
              (inCart ? '✓ У кошику' : 'Додати') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    });

    productsGrid.innerHTML = html;

    // Animate cards in
    productsGrid.querySelectorAll('.product-card').forEach(function (card, i) {
      card.style.animationDelay = (i * 0.06) + 's';
    });

    // Add-to-cart buttons
    productsGrid.querySelectorAll('.product-card__add').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleCart(btn.dataset.id);
      });
    });
  }

  // ── Cart logic ──
  function toggleCart(productId) {
    var idx = cart.findIndex(function (c) { return c.id === productId; });
    var adding = idx === -1;
    if (adding) {
      cart.push({ id: productId, qty: 1 });
    } else {
      cart.splice(idx, 1);
    }
    saveCart();
    renderProducts();
    renderCart();
    if (adding) lotusCartAnimation();
  }

  function lotusCartAnimation() {
    var lotus = document.getElementById('shopLotus');
    if (!lotus) return;

    // Wiggle
    lotus.classList.remove('is-wiggling');
    void lotus.offsetWidth;
    lotus.classList.add('is-wiggling');
    setTimeout(function() { lotus.classList.remove('is-wiggling'); }, 900);

    // Sparkle droplets
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
      dot.style.setProperty('transform', 'translate(' + tx + 'px, ' + ty + 'px) scale(0)');
      dot.style.animationDelay = (i * 0.04) + 's';
      dot.style.width = (4 + Math.random() * 4) + 'px';
      dot.style.height = dot.style.width;
      // Set final transform via animation
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
            '<span>' + p.name.charAt(0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="cart-item__info">' +
          '<p class="cart-item__name">' + p.name + '</p>' +
          '<p class="cart-item__volume">' + p.volume + '</p>' +
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
    if (searchQuery) activeCategory = null;
    renderCategories();
    renderProducts();
  });

  sortSelect.addEventListener('change', function () {
    sortMode = sortSelect.value;
    renderProducts();
  });

  // Escape key
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeCart();
      closeSearch();
    }
  });

  // ── Init ──
  renderCategories();
  renderProducts();
  renderCart();

})();
