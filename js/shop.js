/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Shop Engine v3
   Volumes selector, wholesale prices, product pages,
   auth-aware pricing (master / user)
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Auth state (set by auth.js when loaded) ──
  var currentUser = JSON.parse(localStorage.getItem('svs_user') || 'null');
  var isMaster = currentUser && currentUser.role === 'master';

  // ── State ──
  var cart = JSON.parse(localStorage.getItem('svs_cart') || '[]');
  var activeBrand = null;
  var activeCategory = null;
  var searchQuery = '';
  var sortMode = 'popular';

  // ── DOM refs ──
  var brandGrid      = document.getElementById('brandGrid');
  var catGrid        = document.getElementById('catGrid');
  var productsGrid   = document.getElementById('productsGrid');
  var productsTitle  = document.getElementById('productsTitle');
  var productsEmpty  = document.getElementById('productsEmpty');
  var cartDrawer     = document.getElementById('cartDrawer');
  var cartOverlay    = document.getElementById('cartOverlay');
  var cartItems      = document.getElementById('cartItems');
  var cartEmpty      = document.getElementById('cartEmpty');
  var cartFooter     = document.getElementById('cartFooter');
  var cartCount      = document.getElementById('cartCount');
  var cartTotal      = document.getElementById('cartTotal');
  var searchBar      = document.getElementById('searchBar');
  var searchInput    = document.getElementById('searchInput');
  var sortSelect     = document.getElementById('sortSelect');

  // ── Helpers ──
  function brandName(id) {
    var b = SHOP_BRANDS.find(function (br) { return br.id === id; });
    return b ? b.name : id;
  }

  function getProductPrice(p, volIdx) {
    var vi = (volIdx !== undefined) ? volIdx : 0;
    var vol = p.volumes[vi];
    if (!vol) return 0;
    return isMaster ? vol.wholesale : vol.price;
  }

  function getCartItem(productId) {
    return cart.find(function (c) { return c.id === productId; });
  }

  function getCartVolIdx(productId) {
    var item = getCartItem(productId);
    return item ? (item.volIdx || 0) : 0;
  }

  // ── Product image ──
  function imgHtml(p, small) {
    var sz = small ? 'product-card__img-placeholder--sm' : '';
    if (p.photo) {
      return '<img src="' + p.photo + '" alt="' + p.name + '" class="product-card__photo" loading="lazy" onerror="this.style.display=\'none\';this.nextSibling.style.display=\'flex\'">' +
             '<div class="product-card__img-placeholder ' + sz + '" style="display:none"><span>' + brandName(p.brand).charAt(0) + '</span></div>';
    }
    return '<div class="product-card__img-placeholder ' + sz + '"><span>' + brandName(p.brand).charAt(0) + '</span></div>';
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
        renderBrands(); renderCategories(); renderProducts();
      });
    });
  }

  // ── Categories (accordion groups) ──
  var openGroup = null;

  function renderCategories() {
    var counts = {}, totalCount = 0;
    SHOP_PRODUCTS.forEach(function (p) {
      if (activeBrand && p.brand !== activeBrand) return;
      counts[p.category] = (counts[p.category] || 0) + 1;
      totalCount++;
    });

    var groups = (typeof SHOP_CATEGORY_GROUPS !== 'undefined') ? SHOP_CATEGORY_GROUPS : null;

    // "All" button
    var html = '<button class="shop-cat' + (!activeCategory ? ' shop-cat--active' : '') + '" data-cat="">' +
      '<span class="shop-cat__icon">☆</span><span class="shop-cat__name">Усі <span class="shop-cat__count">' + totalCount + '</span></span></button>';

    if (groups) {
      // Render grouped accordion
      groups.forEach(function (g, gi) {
        var groupCount = 0;
        g.cats.forEach(function (cid) { groupCount += (counts[cid] || 0); });
        if (!groupCount) return;

        var isOpen = openGroup === gi;
        var hasActive = g.cats.indexOf(activeCategory) !== -1;

        html += '<div class="shop-cat-group' + (isOpen ? ' is-open' : '') + (hasActive ? ' has-active' : '') + '">' +
          '<button class="shop-cat-group__header" data-group="' + gi + '">' +
            '<span class="shop-cat-group__name">' + g.name + '</span>' +
            '<span class="shop-cat-group__count">' + groupCount + '</span>' +
            '<span class="shop-cat-group__arrow">›</span>' +
          '</button>';

        if (isOpen) {
          html += '<div class="shop-cat-group__items">';
          g.cats.forEach(function (cid) {
            if (!counts[cid]) return;
            var cat = SHOP_CATEGORIES.find(function (c) { return c.id === cid; });
            if (!cat) return;
            html += '<button class="shop-cat' + (activeCategory === cid ? ' shop-cat--active' : '') + '" data-cat="' + cid + '">' +
              '<span class="shop-cat__icon">' + cat.icon + '</span><span class="shop-cat__name">' + cat.name + ' <span class="shop-cat__count">' + counts[cid] + '</span></span></button>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
    } else {
      // Fallback: flat categories
      SHOP_CATEGORIES.forEach(function (c) {
        if (!counts[c.id]) return;
        html += '<button class="shop-cat' + (activeCategory === c.id ? ' shop-cat--active' : '') + '" data-cat="' + c.id + '">' +
          '<span class="shop-cat__icon">' + c.icon + '</span><span class="shop-cat__name">' + c.name + ' <span class="shop-cat__count">' + counts[c.id] + '</span></span></button>';
      });
    }

    catGrid.innerHTML = html;

    // Group accordion click
    catGrid.querySelectorAll('.shop-cat-group__header').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var gi = parseInt(btn.dataset.group);
        openGroup = (openGroup === gi) ? null : gi;
        renderCategories();
      });
    });

    // Category button click
    catGrid.querySelectorAll('.shop-cat[data-cat]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeCategory = btn.dataset.cat || null;
        renderCategories(); renderProducts();
      });
    });
  }

  // ── Products ──
  function getFilteredProducts() {
    var list = SHOP_PRODUCTS.slice();
    if (activeBrand) list = list.filter(function (p) { return p.brand === activeBrand; });
    if (activeCategory) list = list.filter(function (p) { return p.category === activeCategory; });
    if (searchQuery) {
      var q = searchQuery.toLowerCase();
      list = list.filter(function (p) {
        return p.name.toLowerCase().indexOf(q) !== -1 ||
               brandName(p.brand).toLowerCase().indexOf(q) !== -1 ||
               (p.desc || '').toLowerCase().indexOf(q) !== -1;
      });
    }
    if (sortMode === 'price-asc') list.sort(function (a, b) { return getProductPrice(a) - getProductPrice(b); });
    else if (sortMode === 'price-desc') list.sort(function (a, b) { return getProductPrice(b) - getProductPrice(a); });
    else if (sortMode === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'uk'); });
    else list.sort(function (a, b) { return (b.popular ? 1 : 0) - (a.popular ? 1 : 0); });
    return list;
  }

  function renderProducts() {
    var list = getFilteredProducts();

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
    list.forEach(function (p, i) {
      var inCart = getCartItem(p.id);
      var volIdx = inCart ? (inCart.volIdx || 0) : 0;
      var vol = p.volumes[volIdx];
      var price = isMaster ? vol.wholesale : vol.price;
      var qty = inCart ? inCart.qty : 1;
      var displayPrice = inCart ? price * qty : price;

      var badgeHtml = '';
      if (p.badge === 'sale') badgeHtml = '<span class="product-card__badge product-card__badge--sale">Знижка</span>';
      else if (p.badge === 'hit') badgeHtml = '<span class="product-card__badge product-card__badge--hit">Хіт</span>';
      else if (p.badge === 'new') badgeHtml = '<span class="product-card__badge product-card__badge--new">Новинка</span>';

      // Volume selector (only if > 1 volume)
      var volSelectorHtml = '';
      if (p.volumes.length > 1) {
        volSelectorHtml = '<div class="product-card__vols" data-pid="' + p.id + '">';
        p.volumes.forEach(function (v, vi) {
          volSelectorHtml += '<button class="product-card__vol-btn' + (vi === volIdx ? ' active' : '') + '" data-pid="' + p.id + '" data-vi="' + vi + '">' + v.v + '</button>';
        });
        volSelectorHtml += '</div>';
      } else {
        volSelectorHtml = '<span class="product-card__volume">' + vol.v + '</span>';
      }

      // Wholesale badge for masters
      var masterBadge = isMaster ? '<span class="product-card__wholesale-badge">Опт</span>' : '';

      html += '<a class="product-card" href="product.html#' + p.id + '" data-id="' + p.id + '" style="animation-delay:' + (i * 0.04) + 's;text-decoration:none;color:inherit;display:block">' +
        '<div class="product-card__img">' +
          imgHtml(p, false) +
          badgeHtml +
          masterBadge +
        '</div>' +
        '<div class="product-card__body">' +
          '<p class="product-card__brand">' + brandName(p.brand) + '</p>' +
          '<h3 class="product-card__name">' + p.name + '</h3>' +
          volSelectorHtml +
          (p.desc ? '<p class="product-card__desc">' + p.desc.substring(0, 90) + (p.desc.length > 90 ? '…' : '') + '</p>' : '') +
          '<div class="product-card__footer">' +
            '<div class="product-card__prices">' +
              '<span class="product-card__price" id="price-' + p.id + '">' + displayPrice + ' ₴</span>' +
            '</div>' +
            '<div class="product-card__actions">' +
              (inCart ?
                '<div class="product-card__qty">' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="-1" onclick="event.preventDefault()">−</button>' +
                  '<span class="product-card__qty-num">' + qty + '</span>' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="1" onclick="event.preventDefault()">+</button>' +
                '</div>'
              :
                '<button class="product-card__add" data-id="' + p.id + '" onclick="event.preventDefault()">Додати</button>'
              ) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</a>';
    });

    productsGrid.innerHTML = html;

    // Volume selector buttons
    productsGrid.querySelectorAll('.product-card__vol-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var pid = btn.dataset.pid;
        var vi = parseInt(btn.dataset.vi);
        // Update active vol buttons
        var vols = productsGrid.querySelectorAll('.product-card__vol-btn[data-pid="' + pid + '"]');
        vols.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        // Update cart item vol or temp display
        var item = getCartItem(pid);
        var p = SHOP_PRODUCTS.find(function (pr) { return pr.id === pid; });
        if (!p) return;
        if (item) { item.volIdx = vi; saveCart(); }
        var vol = p.volumes[vi];
        var newPrice = isMaster ? vol.wholesale : vol.price;
        var qty = item ? item.qty : 1;
        var priceEl = document.getElementById('price-' + pid);
        if (priceEl) priceEl.textContent = (newPrice * qty) + ' ₴';
      });
    });

    // Add-to-cart
    productsGrid.querySelectorAll('.product-card__add').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var pid = btn.dataset.id;
        // get active volIdx
        var activeVolBtn = productsGrid.querySelector('.product-card__vol-btn[data-pid="' + pid + '"].active');
        var vi = activeVolBtn ? parseInt(activeVolBtn.dataset.vi) : 0;
        addToCart(pid, vi);
      });
    });

    // Qty on cards
    productsGrid.querySelectorAll('.product-card__qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        updateQty(btn.dataset.id, parseInt(btn.dataset.delta));
      });
    });
  }

  // ── Cart logic ──
  function addToCart(productId, volIdx) {
    var existing = getCartItem(productId);
    if (existing) {
      existing.qty++;
    } else {
      cart.push({ id: productId, qty: 1, volIdx: volIdx || 0 });
    }
    saveCart();
    renderProducts();
    renderCart();
    lotusCartAnimation();
  }

  function updateQty(productId, delta) {
    var item = getCartItem(productId);
    if (!item) return;
    item.qty += delta;
    if (item.qty < 1) {
      cart = cart.filter(function (c) { return c.id !== productId; });
      saveCart();
      renderCart();
      renderProducts();
      return;
    }
    saveCart();
    renderCart();
    // Update card in-place instead of full re-render
    var card = productsGrid.querySelector('.product-card[data-id="' + productId + '"]');
    if (card) {
      var qtyNum = card.querySelector('.product-card__qty-num');
      if (qtyNum) qtyNum.textContent = item.qty;
      var p = SHOP_PRODUCTS.find(function (pr) { return pr.id === productId; });
      if (p) {
        var vol = p.volumes[item.volIdx || 0];
        var price = isMaster ? vol.wholesale : vol.price;
        var priceEl = document.getElementById('price-' + productId);
        if (priceEl) priceEl.textContent = (price * item.qty) + ' ₴';
      }
    }
  }

  function saveCart() {
    localStorage.setItem('svs_cart', JSON.stringify(cart));
  }

  function renderCart() {
    var total = 0, count = 0;
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
      var vi = item.volIdx || 0;
      var vol = p.volumes[vi] || p.volumes[0];
      var price = isMaster ? vol.wholesale : vol.price;
      var subtotal = price * item.qty;
      total += subtotal;
      count += item.qty;

      html += '<div class="cart-item">' +
        '<div class="cart-item__img">' + imgHtml(p, true) + '</div>' +
        '<div class="cart-item__info">' +
          '<p class="cart-item__name">' + p.name + '</p>' +
          '<p class="cart-item__volume">' + brandName(p.brand) + ' · ' + vol.v + '</p>' +
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

  // ── Lotus animation ──
  function lotusCartAnimation() {
    var lotus = document.getElementById('shopLotus');
    if (!lotus) return;
    if (window.SVSLotus) SVSLotus.wiggle('shopLotus');
    var rect = lotus.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    for (var i = 0; i < 8; i++) {
      var dot = document.createElement('div');
      dot.className = 'lotus-sparkle';
      var angle = (Math.PI * 2 / 8) * i + (Math.random() - 0.5) * 0.5;
      var dist = 30 + Math.random() * 40;
      dot.style.cssText = 'left:' + cx + 'px;top:' + cy + 'px;width:' + (4 + Math.random() * 4) + 'px;height:' + dot.style.width;
      dot.style.animationDelay = (i * 0.04) + 's';
      dot.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
      dot.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
      document.body.appendChild(dot);
      setTimeout(function (el) { el.remove(); }.bind(null, dot), 1000);
    }
  }

  // ── Cart drawer ──
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
  function openSearch() { searchBar.classList.add('is-open'); searchInput.focus(); }
  function closeSearch() {
    searchBar.classList.remove('is-open');
    searchInput.value = '';
    searchQuery = '';
    renderProducts();
  }

  // ── Auth header ──
  function renderAuthHeader() {
    var btn = document.getElementById('accountBtn');
    var label = document.getElementById('accountLabel');
    if (!btn) return;
    if (currentUser) {
      btn.title = currentUser.name || currentUser.phone || 'Кабінет';
      if (label) label.textContent = currentUser.name ? currentUser.name.split(' ')[0] : 'Кабінет';
      if (isMaster) { btn.classList.add('is-master'); }
    } else {
      btn.title = 'Увійти';
      if (label) label.textContent = 'Вхід';
    }
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
    renderBrands(); renderCategories(); renderProducts();
  });

  sortSelect.addEventListener('change', function () {
    sortMode = sortSelect.value;
    renderProducts();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeCart(); closeSearch(); }
  });

  // ── Init ──
  if (window.SVSLotus) SVSLotus.init('shopLotus', 'scroll');
  renderAuthHeader();
  renderBrands();
  renderCategories();
  renderProducts();
  renderCart();

})();
