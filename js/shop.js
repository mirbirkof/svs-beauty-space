/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Shop Engine v4
   Pagination, dropdown categories, improved search,
   cart delete button, responsive brand grid
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Auth state ──
  var currentUser = JSON.parse(localStorage.getItem('svs_user') || 'null');
  var isMaster = currentUser && currentUser.role === 'master';

  // ── State ──
  var cart = JSON.parse(localStorage.getItem('svs_cart') || '[]');
  var activeBrand = null;
  var activeCategory = null;
  var searchQuery = '';
  var sortMode = 'popular';
  var currentPage = 1;
  var perPage = parseInt(localStorage.getItem('svs_perpage') || '60');
  var catDropdownOpen = false;

  // ── DOM refs ──
  var brandGrid      = document.getElementById('brandGrid');
  var catToggle      = document.getElementById('catToggle');
  var catBtnLabel    = document.getElementById('catBtnLabel');
  var catDropdown    = document.getElementById('catDropdown');
  var catDropdownInner = document.getElementById('catDropdownInner');
  var catOverlay     = document.getElementById('catOverlay');
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
  var heroSearchInput = document.getElementById('heroSearchInput');
  var sortSelect     = document.getElementById('sortSelect');
  var perPageSelect  = document.getElementById('perPageSelect');
  var pagination     = document.getElementById('pagination');
  var pageNumbers    = document.getElementById('pageNumbers');
  var pagePrev       = document.getElementById('pagePrev');
  var pageNext       = document.getElementById('pageNext');

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

  // ── Fuzzy search (matches parts of words) ──
  function matchesSearch(p, q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    var haystack = (p.name + ' ' + brandName(p.brand) + ' ' + (p.desc || '')).toLowerCase();
    return terms.every(function(term) { return haystack.indexOf(term) !== -1; });
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
    var html = '<button class="shop-brand' + (!activeBrand ? ' shop-brand--active' : '') + '" data-brand="">Усі</button>';
    SHOP_BRANDS.forEach(function (b) {
      html += '<button class="shop-brand' + (activeBrand === b.id ? ' shop-brand--active' : '') + '" data-brand="' + b.id + '">' + b.name + '</button>';
    });
    brandGrid.innerHTML = html;
    brandGrid.querySelectorAll('.shop-brand').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeBrand = btn.dataset.brand || null;
        currentPage = 1;
        renderBrands(); renderProducts(); updateCatBtnLabel();
      });
    });
  }

  // ── Category Dropdown ──
  function renderCatDropdown() {
    var counts = {};
    SHOP_PRODUCTS.forEach(function (p) {
      if (activeBrand && p.brand !== activeBrand) return;
      counts[p.category] = (counts[p.category] || 0) + 1;
    });

    var groups = (typeof SHOP_CATEGORY_GROUPS !== 'undefined') ? SHOP_CATEGORY_GROUPS : null;
    var html = '<button class="cat-dropdown__item' + (!activeCategory ? ' cat-dropdown__item--active' : '') + '" data-cat="">' +
      '<span class="cat-dropdown__icon">☆</span><span>Усі категорії</span></button>';

    if (groups) {
      groups.forEach(function (g) {
        var groupCount = 0;
        g.cats.forEach(function (cid) { groupCount += (counts[cid] || 0); });
        if (!groupCount) return;

        html += '<div class="cat-dropdown__group-title">' + g.name + ' <span class="cat-dropdown__group-count">' + groupCount + '</span></div>';
        g.cats.forEach(function (cid) {
          if (!counts[cid]) return;
          var cat = SHOP_CATEGORIES.find(function (c) { return c.id === cid; });
          if (!cat) return;
          html += '<button class="cat-dropdown__item' + (activeCategory === cid ? ' cat-dropdown__item--active' : '') + '" data-cat="' + cid + '">' +
            '<span class="cat-dropdown__icon">' + cat.icon + '</span><span>' + cat.name + '</span><span class="cat-dropdown__count">' + counts[cid] + '</span></button>';
        });
      });
    } else {
      SHOP_CATEGORIES.forEach(function (c) {
        if (!counts[c.id]) return;
        html += '<button class="cat-dropdown__item' + (activeCategory === c.id ? ' cat-dropdown__item--active' : '') + '" data-cat="' + c.id + '">' +
          '<span class="cat-dropdown__icon">' + c.icon + '</span><span>' + c.name + '</span><span class="cat-dropdown__count">' + counts[c.id] + '</span></button>';
      });
    }

    catDropdownInner.innerHTML = html;

    catDropdownInner.querySelectorAll('.cat-dropdown__item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeCategory = btn.dataset.cat || null;
        currentPage = 1;
        closeCatDropdown();
        renderProducts();
        updateCatBtnLabel();
      });
    });
  }

  function openCatDropdown() {
    renderCatDropdown();
    catDropdown.classList.add('is-open');
    catOverlay.classList.add('is-open');
    catDropdownOpen = true;
  }

  function closeCatDropdown() {
    catDropdown.classList.remove('is-open');
    catOverlay.classList.remove('is-open');
    catDropdownOpen = false;
  }

  function updateCatBtnLabel() {
    if (activeCategory) {
      var cat = SHOP_CATEGORIES.find(function (c) { return c.id === activeCategory; });
      catBtnLabel.textContent = cat ? cat.name : 'Категорії';
      catToggle.classList.add('shop-filters__cat-btn--active');
    } else {
      catBtnLabel.textContent = 'Категорії';
      catToggle.classList.remove('shop-filters__cat-btn--active');
    }
  }

  // ── Products ──
  function getFilteredProducts() {
    var list = SHOP_PRODUCTS.slice();
    if (activeBrand) list = list.filter(function (p) { return p.brand === activeBrand; });
    if (activeCategory) list = list.filter(function (p) { return p.category === activeCategory; });
    if (searchQuery) {
      list = list.filter(function (p) { return matchesSearch(p, searchQuery); });
    }
    // Sort: sets first (higher AOV), then by selected mode
    if (sortMode === 'price-asc') list.sort(function (a, b) { return getProductPrice(a) - getProductPrice(b); });
    else if (sortMode === 'price-desc') list.sort(function (a, b) { return getProductPrice(b) - getProductPrice(a); });
    else if (sortMode === 'name') list.sort(function (a, b) { return a.name.localeCompare(b.name, 'uk'); });
    else {
      // Popular: sets/kits first, then popular flag, then rest
      list.sort(function (a, b) {
        var aSet = /набір|набор|set|kit/i.test(a.name) ? 1 : 0;
        var bSet = /набір|набор|set|kit/i.test(b.name) ? 1 : 0;
        if (bSet !== aSet) return bSet - aSet;
        return (b.popular ? 1 : 0) - (a.popular ? 1 : 0);
      });
    }
    return list;
  }

  function renderProducts() {
    var list = getFilteredProducts();
    var totalProducts = list.length;
    var totalPages = Math.max(1, Math.ceil(totalProducts / perPage));
    if (currentPage > totalPages) currentPage = totalPages;

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
    productsTitle.textContent = title + ' (' + totalProducts + ')';

    if (!list.length) {
      productsGrid.innerHTML = '';
      productsEmpty.style.display = 'block';
      pagination.style.display = 'none';
      return;
    }
    productsEmpty.style.display = 'none';

    // Paginate
    var start = (currentPage - 1) * perPage;
    var pageItems = list.slice(start, start + perPage);

    var html = '';
    pageItems.forEach(function (p, i) {
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

      var masterBadge = isMaster ? '<span class="product-card__wholesale-badge">Опт</span>' : '';

      html += '<a class="product-card" href="product.html#' + p.id + '" data-id="' + p.id + '" style="animation-delay:' + (i * 0.03) + 's">' +
        '<div class="product-card__img">' + imgHtml(p, false) + badgeHtml + masterBadge + '</div>' +
        '<div class="product-card__body">' +
          '<p class="product-card__brand">' + brandName(p.brand) + '</p>' +
          '<h3 class="product-card__name">' + p.name + '</h3>' +
          volSelectorHtml +
          '<div class="product-card__footer">' +
            '<div class="product-card__prices"><span class="product-card__price" id="price-' + p.id + '">' + displayPrice + ' ₴</span></div>' +
            '<div class="product-card__actions">' +
              (inCart ?
                '<div class="product-card__qty">' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="-1" onclick="event.preventDefault()">−</button>' +
                  '<span class="product-card__qty-num">' + qty + '</span>' +
                  '<button class="product-card__qty-btn" data-id="' + p.id + '" data-delta="1" onclick="event.preventDefault()">+</button>' +
                '</div>'
              :
                '<button class="product-card__add" data-id="' + p.id + '" onclick="event.preventDefault()">В кошик</button>'
              ) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</a>';
    });

    productsGrid.innerHTML = html;

    // Pagination
    if (totalPages > 1) {
      pagination.style.display = 'flex';
      renderPagination(totalPages);
    } else {
      pagination.style.display = 'none';
    }

    // Event listeners
    productsGrid.querySelectorAll('.product-card__vol-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var pid = btn.dataset.pid;
        var vi = parseInt(btn.dataset.vi);
        productsGrid.querySelectorAll('.product-card__vol-btn[data-pid="' + pid + '"]').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
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

    productsGrid.querySelectorAll('.product-card__add').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var pid = btn.dataset.id;
        var activeVolBtn = productsGrid.querySelector('.product-card__vol-btn[data-pid="' + pid + '"].active');
        var vi = activeVolBtn ? parseInt(activeVolBtn.dataset.vi) : 0;
        addToCart(pid, vi);
      });
    });

    productsGrid.querySelectorAll('.product-card__qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        updateQty(btn.dataset.id, parseInt(btn.dataset.delta));
      });
    });

    // Scroll to top on page change
    if (start > 0) {
      var productsSection = document.getElementById('products');
      if (productsSection) productsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ── Pagination ──
  function renderPagination(totalPages) {
    pagePrev.disabled = currentPage <= 1;
    pageNext.disabled = currentPage >= totalPages;

    var html = '';
    var maxVisible = 7;
    var startPage = Math.max(1, currentPage - 3);
    var endPage = Math.min(totalPages, startPage + maxVisible - 1);
    if (endPage - startPage < maxVisible - 1) startPage = Math.max(1, endPage - maxVisible + 1);

    if (startPage > 1) html += '<button class="shop-pagination__num" data-page="1">1</button><span class="shop-pagination__dots">…</span>';

    for (var i = startPage; i <= endPage; i++) {
      html += '<button class="shop-pagination__num' + (i === currentPage ? ' shop-pagination__num--active' : '') + '" data-page="' + i + '">' + i + '</button>';
    }

    if (endPage < totalPages) html += '<span class="shop-pagination__dots">…</span><button class="shop-pagination__num" data-page="' + totalPages + '">' + totalPages + '</button>';

    pageNumbers.innerHTML = html;
    pageNumbers.querySelectorAll('.shop-pagination__num').forEach(function (btn) {
      btn.addEventListener('click', function () {
        currentPage = parseInt(btn.dataset.page);
        renderProducts();
      });
    });
  }

  // ── Cart logic ──
  function addToCart(productId, volIdx) {
    var existing = getCartItem(productId);
    if (existing) { existing.qty++; }
    else { cart.push({ id: productId, qty: 1, volIdx: volIdx || 0 }); }
    saveCart(); renderProducts(); renderCart(); lotusCartAnimation();
  }

  function updateQty(productId, delta) {
    var item = getCartItem(productId);
    if (!item) return;
    item.qty += delta;
    if (item.qty < 1) { removeFromCart(productId); return; }
    saveCart(); renderCart();
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

  function removeFromCart(productId) {
    cart = cart.filter(function (c) { return c.id !== productId; });
    saveCart(); renderCart(); renderProducts();
  }

  function saveCart() { localStorage.setItem('svs_cart', JSON.stringify(cart)); }

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
        '<div class="cart-item__right">' +
          '<div class="cart-item__price">' + subtotal + ' ₴</div>' +
          '<button class="cart-item__remove" data-id="' + p.id + '" aria-label="Видалити">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>' +
          '</button>' +
        '</div>' +
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
    cartItems.querySelectorAll('.cart-item__remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeFromCart(btn.dataset.id);
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
  function openCart() { cartDrawer.classList.add('is-open'); cartOverlay.classList.add('is-open'); document.body.style.overflow = 'hidden'; }
  function closeCart() { cartDrawer.classList.remove('is-open'); cartOverlay.classList.remove('is-open'); document.body.style.overflow = ''; }

  // ── Search ──
  function openSearch() { searchBar.classList.add('is-open'); searchInput.focus(); }
  function closeSearch() { searchBar.classList.remove('is-open'); searchInput.value = ''; searchQuery = ''; heroSearchInput.value = ''; renderProducts(); }

  function handleSearch(value) {
    searchQuery = value.trim();
    if (searchQuery) { activeBrand = null; activeCategory = null; }
    currentPage = 1;
    renderBrands(); renderProducts(); updateCatBtnLabel();
  }

  // ── Auth header ──
  function renderAuthHeader() {
    var btn = document.getElementById('accountBtn');
    var label = document.getElementById('accountLabel');
    if (!btn) return;
    if (currentUser) {
      btn.title = currentUser.name || currentUser.phone || 'Кабінет';
      if (label) label.textContent = currentUser.name ? currentUser.name.split(' ')[0] : 'Кабінет';
      if (isMaster) btn.classList.add('is-master');
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
  catToggle.addEventListener('click', function () { catDropdownOpen ? closeCatDropdown() : openCatDropdown(); });
  catOverlay.addEventListener('click', closeCatDropdown);

  // Hero search
  heroSearchInput.addEventListener('input', function () { handleSearch(heroSearchInput.value); searchInput.value = heroSearchInput.value; });
  heroSearchInput.addEventListener('focus', function () {
    if (window.innerWidth < 640) { openSearch(); }
  });

  // Nav search
  searchInput.addEventListener('input', function () { handleSearch(searchInput.value); heroSearchInput.value = searchInput.value; });

  sortSelect.addEventListener('change', function () { sortMode = sortSelect.value; currentPage = 1; renderProducts(); });

  perPageSelect.value = String(perPage);
  perPageSelect.addEventListener('change', function () {
    perPage = parseInt(perPageSelect.value);
    localStorage.setItem('svs_perpage', String(perPage));
    currentPage = 1;
    renderProducts();
  });

  pagePrev.addEventListener('click', function () { if (currentPage > 1) { currentPage--; renderProducts(); } });
  pageNext.addEventListener('click', function () { currentPage++; renderProducts(); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeCart(); closeSearch(); closeCatDropdown(); }
  });

  // ── Init ──
  if (window.SVSLotus) SVSLotus.init('shopLotus', 'scroll');
  renderAuthHeader();
  renderBrands();
  updateCatBtnLabel();
  renderProducts();
  renderCart();

})();
