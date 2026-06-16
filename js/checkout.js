/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Checkout
   Повна онлайн-оплата через Mono (картка · Apple Pay · Google Pay).
   Накладений платіж / оплата при отриманні — вимкнено.
   ═══════════════════════════════════════════════════════ */

const API = '/api';
const STORAGE_CART = 'svs_cart';
const STORAGE_USER = 'svs_user';
const STORAGE_TOKEN = 'svs_token';

// ── State ───────────────────────────────────────────────
let cart = [];
let currentUser = null;
let stripe = null;
let elements = null;
let paymentElement = null;
let orderId = null;
let isMaster = false;

// ── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadSession();
  loadCart();

  if (!cart.length) {
    renderEmpty();
    return;
  }

  // Оплата лише онлайн через Mono — Stripe не ініціалізуємо
  render();
});

function loadSession() {
  try {
    const u = localStorage.getItem(STORAGE_USER);
    const t = localStorage.getItem(STORAGE_TOKEN);
    if (u && t) {
      currentUser = JSON.parse(u);
      isMaster = currentUser.role === 'master' && currentUser.approved === true;
    }
  } catch { /* ignore */ }
}

function loadCart() {
  try {
    cart = JSON.parse(localStorage.getItem(STORAGE_CART) || '[]');
  } catch {
    cart = [];
  }
}

function saveCart() {
  localStorage.setItem(STORAGE_CART, JSON.stringify(cart));
}

// ── Stripe init ─────────────────────────────────────────
async function initStripe() {
  try {
    const res = await fetch(`${API}/payments/config`);
    const { publishableKey } = await res.json();
    if (publishableKey) {
      stripe = Stripe(publishableKey);
    }
  } catch {
    // Stripe not configured — dev mode
  }
}

// ── Price helpers ────────────────────────────────────────
function getItemPrice(item) {
  if (!item.product) return 0;
  const vol = item.product.volumes?.[item.volIdx ?? 0];
  if (!vol) return 0;
  return isMaster ? (vol.wholesale ?? vol.price) : vol.price;
}

function getItemTotal(item) {
  return getItemPrice(item) * item.qty;
}

function getCartTotal() {
  return cart.reduce((sum, item) => sum + getItemTotal(item), 0);
}

function resolveCartProducts() {
  // Attach product objects from SHOP_PRODUCTS
  cart = cart.map((item) => {
    if (!item.product && typeof SHOP_PRODUCTS !== 'undefined') {
      const product = SHOP_PRODUCTS.find((p) => p.id === item.id);
      return { ...item, product };
    }
    return item;
  }).filter((item) => item.product);
}

// ── Render ──────────────────────────────────────────────
function render() {
  resolveCartProducts();
  if (!cart.length) { renderEmpty(); return; }

  const page = document.getElementById('checkoutPage');
  const total = getCartTotal();

  page.innerHTML = `
    <div class="container checkout-layout">
      <!-- Left: order summary -->
      <section class="checkout-summary">
        <h2 class="checkout-section-title">Ваше замовлення</h2>
        <div class="checkout-items" id="checkoutItems"></div>
        ${renderDeliveryForm()}
        <div class="checkout-field" style="margin-top:16px">
          <label>Промокод (якщо є)</label>
          <input type="text" id="promoCode" placeholder="Наприклад: SVS10"
            autocomplete="off" autocapitalize="characters" style="text-transform:uppercase">
        </div>
        <div class="checkout-total-row">
          <span>Разом${isMaster ? ' (оптова ціна)' : ''}:</span>
          <strong id="checkoutTotal">${total.toLocaleString('uk-UA')} ₴</strong>
        </div>
      </section>

      <!-- Right: payment -->
      <section class="checkout-payment">
        <h2 class="checkout-section-title">Оплата</h2>

        <div id="paymentSection">
          ${stripe ? '<div id="paymentElement" class="checkout-payment-element"><div class="stripe-placeholder">Завантаження форми оплати...</div></div>' : ''}

          <div class="checkout-error" id="checkoutError"></div>

          <div class="checkout-payment-methods">
            <p class="checkout-payment-note">Повна оплата онлайн карткою через Mono — Visa, Mastercard, Apple&nbsp;Pay, Google&nbsp;Pay. Замовлення підтверджується одразу після оплати.</p>
          </div>

          <button class="checkout-pay-btn" id="payBtn">
            Перейти до оплати · ${total.toLocaleString('uk-UA')} ₴
          </button>

          <div class="checkout-secure-note">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            Захищена оплата через Mono · кошти повертаються при скасуванні
          </div>
        </div>
      </section>
    </div>
  `;

  renderItems();

  if (stripe) {
    createPaymentIntent().then(mountStripe);
  }

  document.getElementById('payBtn')?.addEventListener('click', handlePay);
}

function renderItems() {
  const container = document.getElementById('checkoutItems');
  if (!container) return;

  container.innerHTML = cart.map((item) => {
    const vol = item.product.volumes?.[item.volIdx ?? 0];
    const price = getItemPrice(item);
    const subtotal = price * item.qty;
    const photo = item.product.photo;

    return `
      <div class="checkout-item">
        <div class="checkout-item__img">
          ${photo
            ? `<img src="${photo}" alt="${item.product.name}" loading="lazy">`
            : `<div class="checkout-item__placeholder">${item.product.brand?.[0]?.toUpperCase() || '?'}</div>`}
        </div>
        <div class="checkout-item__info">
          <div class="checkout-item__name">${item.product.name}</div>
          <div class="checkout-item__meta">${vol?.v || ''} · ×${item.qty}</div>
        </div>
        <div class="checkout-item__price">${subtotal.toLocaleString('uk-UA')} ₴</div>
      </div>
    `;
  }).join('');
}

function renderDeliveryForm() {
  return `
    <div class="checkout-delivery">
      <h3 class="checkout-delivery__title">Доставка</h3>
      <div class="checkout-delivery__methods">
        <label class="checkout-delivery__option">
          <input type="radio" name="delivery" value="nova_poshta" checked>
          <span>Нова Пошта (відділення або поштомат)</span>
        </label>
        <label class="checkout-delivery__option">
          <input type="radio" name="delivery" value="ukrposhta">
          <span>Укрпошта</span>
        </label>
        <label class="checkout-delivery__option">
          <input type="radio" name="delivery" value="pickup">
          <span>Самовивіз (SVS Beauty Space, Суми)</span>
        </label>
      </div>
      <div class="checkout-delivery__fields">
        <div class="checkout-field">
          <label>Ім'я та прізвище</label>
          <input type="text" id="deliveryName" placeholder="Оля Ковальчук"
            value="${currentUser?.name || ''}" autocomplete="name">
        </div>
        <div class="checkout-field">
          <label>Номер телефону</label>
          <input type="tel" id="deliveryPhone" placeholder="+380 XX XXX XX XX"
            value="${currentUser?.phone || ''}" autocomplete="tel">
        </div>
        <div class="checkout-field" id="deliveryAddressWrap">
          <label>Місто та відділення / поштомат</label>
          <input type="text" id="deliveryAddress" placeholder="Харків, відділення №12">
        </div>
      </div>
    </div>
  `;
}

function renderLoginNotice() {
  return `
    <div class="checkout-login-notice">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
      <div>
        <strong>Увійдіть для оплати</strong>
        <p>Для оформлення замовлення потрібен обліковий запис.</p>
        <a href="account.html" class="checkout-login-link">Увійти / Зареєструватися</a>
      </div>
    </div>
  `;
}

function renderContactForm() {
  return `
    <div class="checkout-contact-form">
      <h3 class="checkout-delivery__title">Контактні дані</h3>
      <div class="checkout-delivery__fields">
        <div class="checkout-field">
          <label>Ім'я та прізвище</label>
          <input type="text" id="contactName" placeholder="Оля Ковальчук"
            value="${currentUser?.name || ''}" autocomplete="name">
        </div>
        <div class="checkout-field">
          <label>Номер телефону</label>
          <input type="tel" id="contactPhone" placeholder="+380 XX XXX XX XX"
            value="${currentUser?.phone || ''}" autocomplete="tel">
        </div>
      </div>
    </div>
  `;
}

function renderDevPayment() {
  return `
    <div class="checkout-dev-notice">
      <strong>Dev mode</strong> — Stripe не налаштовано.<br>
      Встановіть <code>STRIPE_SECRET_KEY</code> і <code>STRIPE_PUBLISHABLE_KEY</code> в <code>backend/.env</code>
    </div>
  `;
}

function renderEmpty() {
  const page = document.getElementById('checkoutPage');
  page.innerHTML = `
    <div class="container checkout-empty">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ccc" stroke-width="1.2">
        <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18M16 10a4 4 0 01-8 0"/>
      </svg>
      <h2>Кошик порожній</h2>
      <p>Додайте товари, щоб оформити замовлення</p>
      <a href="shop.html" class="checkout-empty-btn">До каталогу</a>
    </div>
  `;
}

// ── Stripe payment intent ────────────────────────────────
async function createPaymentIntent() {
  const token = localStorage.getItem(STORAGE_TOKEN);
  if (!token) return null;

  const delivery = getDeliveryData();
  const items = cart.map((item) => {
    const vol = item.product.volumes?.[item.volIdx ?? 0];
    return {
      id: item.id,
      qty: item.qty,
      volIdx: item.volIdx ?? 0,
      price: vol?.price ?? 0,
      wholesale: vol?.wholesale ?? 0,
    };
  });

  try {
    const res = await fetch(`${API}/payments/create-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ items, delivery }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    orderId = data.orderId;
    return data.clientSecret;
  } catch (err) {
    showError(err.message);
    return null;
  }
}

async function mountStripe(clientSecret) {
  if (!clientSecret || !stripe) return;

  const container = document.getElementById('paymentElement');
  if (!container) return;

  container.innerHTML = '';

  elements = stripe.elements({
    clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#c9a96e',
        colorBackground: '#ffffff',
        colorText: '#1a1a1a',
        colorDanger: '#c0392b',
        fontFamily: 'Inter, system-ui, sans-serif',
        borderRadius: '10px',
        spacingUnit: '4px',
      },
    },
  });

  paymentElement = elements.create('payment', {
    layout: { type: 'tabs', defaultCollapsed: false },
    wallets: { googlePay: 'auto', applePay: 'auto' },
  });

  paymentElement.mount('#paymentElement');

  // Update pay button
  const total = getCartTotal();
  const btn = document.getElementById('payBtn');
  if (btn) btn.textContent = `Сплатити ${total.toLocaleString('uk-UA')} ₴`;
}

// ── Handle payment ───────────────────────────────────────
async function handlePay() {
  const btn = document.getElementById('payBtn');

  // Validate delivery form
  const name = document.getElementById('deliveryName')?.value?.trim();
  const phone = document.getElementById('deliveryPhone')?.value?.trim();
  if (!name || !phone) {
    showError('Вкажіть ім\'я та номер телефону');
    return;
  }

  // Єдиний шлях оплати — повна предоплата онлайн через Mono
  btn.disabled = true;
  btn.innerHTML = '<span class="checkout-spinner-sm"></span>Оформлення...';
  hideError();
  try {
    const order = await submitOrder();
    localStorage.removeItem(STORAGE_CART);
    if (order && order.pay_url) {
      // повна оплата: одразу ведемо на платіжну сторінку Mono
      btn.innerHTML = '<span class="checkout-spinner-sm"></span>Перехід до оплати...';
      window.location.href = order.pay_url;
      return;
    }
    // Mono тимчасово недоступний — показуємо замовлення з кнопкою оплати/контактом
    showSuccess(order);
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = `Перейти до оплати · ${getCartTotal().toLocaleString('uk-UA')} ₴`;
  }
}

// ── Реальный сабмит заказа на сервер ─────────────────────
async function submitOrder() {
  if (!window.SVS_API) throw new Error('Сервіс тимчасово недоступний. Оновіть сторінку.');

  // 1) свежий каталог с variant_id (vid) — маппим корзину на БД
  let catalog;
  try {
    const r = await fetch(window.SVS_API.baseUrl + '/api/catalog/legacy/all');
    catalog = await r.json();
  } catch {
    throw new Error('Немає зв\'язку з сервером. Перевірте інтернет і спробуйте ще раз.');
  }
  const byId = {};
  (catalog.products || []).forEach((p) => { byId[p.id] = p; });

  const items = [];
  for (const item of cart) {
    const fresh = byId[item.id];
    const vol = fresh?.volumes?.[item.volIdx ?? 0];
    if (!vol || !vol.vid) {
      throw new Error(`Товар «${item.product?.name || item.id}» більше недоступний. Видаліть його з кошика.`);
    }
    items.push({ variant_id: vol.vid, qty: item.qty });
  }

  // 2) payload
  const delivery = getDeliveryData();
  const promo = document.getElementById('promoCode')?.value?.trim();
  const payload = {
    items,
    contact: { name: delivery.name, phone: delivery.phone },
    delivery: { type: delivery.method, name: delivery.name, phone: delivery.phone, address: delivery.address || '' },
  };
  if (promo) payload.promo_code = promo;

  // 3) отправка
  const res = await window.SVS_API.createOrder(payload);
  if (res && res.ok && res.order) return res.order;
  throw new Error(translateOrderError(res));
}

function translateOrderError(res) {
  const code = res?.error || 'unknown';
  const map = {
    'invalid-promo': 'Промокод недійсний або вже вичерпаний. Приберіть його або введіть інший.',
    'insufficient-stock': 'Деяких товарів недостатньо на складі. Зменшіть кількість у кошику.',
    'phone-required': 'Вкажіть номер телефону.',
    'variant-not-found': 'Один із товарів більше недоступний. Оновіть кошик.',
    'no-items': 'Кошик порожній.',
    'invalid-json': 'Сервер не відповідає. Спробуйте за хвилину.',
  };
  return map[code] || 'Не вдалося оформити замовлення. Спробуйте ще раз або зателефонуйте нам: +38 (099) 128-33-75';
}

function showSuccess(order) {
  // Clear cart
  localStorage.removeItem(STORAGE_CART);

  const orderNo = order?.id ? `SVS-${order.id}` : 'SVS-' + Date.now().toString(36).toUpperCase();
  const discountLine = order?.total != null
    ? `<p class="checkout-success__id">До сплати: <strong>${Number(order.total).toLocaleString('uk-UA')} ₴</strong></p>` : '';
  const payBtn = order?.pay_url
    ? `<a href="${order.pay_url}" class="checkout-empty-btn" style="margin-right:12px">Сплатити онлайн</a>` : '';
  const page = document.getElementById('checkoutPage');
  page.innerHTML = `
    <div class="container checkout-success">
      <div class="checkout-success__icon">✓</div>
      <h2>Замовлення оформлено!</h2>
      <p>Дякуємо за покупку. Менеджер зв'яжеться з вами для підтвердження деталей доставки та оплати.</p>
      <p class="checkout-success__id">№ замовлення: <strong>${orderNo}</strong></p>
      ${discountLine}
      <div class="checkout-success__actions">
        ${payBtn}
        <a href="shop.html" class="checkout-empty-btn">Продовжити покупки</a>
      </div>
    </div>
  `;
}

// ── Delivery helpers ─────────────────────────────────────
function getDeliveryData() {
  const method = document.querySelector('input[name="delivery"]:checked')?.value || 'nova_poshta';
  const name = document.getElementById('deliveryName')?.value;
  const phone = document.getElementById('deliveryPhone')?.value;
  const address = document.getElementById('deliveryAddress')?.value;
  return { method, name, phone, address };
}

// Hide address field for pickup
document.addEventListener('change', (e) => {
  if (e.target.name === 'delivery') {
    const wrap = document.getElementById('deliveryAddressWrap');
    if (wrap) wrap.style.display = e.target.value === 'pickup' ? 'none' : '';
  }
});

// ── Error helpers ────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('checkoutError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideError() {
  const el = document.getElementById('checkoutError');
  if (el) el.style.display = 'none';
}

function translateStripeError(err) {
  const map = {
    card_declined:        'Картку відхилено банком.',
    insufficient_funds:   'Недостатньо коштів.',
    expired_card:         'Термін дії картки закінчився.',
    incorrect_cvc:        'Невірний CVV-код.',
    processing_error:     'Помилка обробки. Спробуйте ще раз.',
    payment_intent_authentication_failure: 'Не вдалося підтвердити платіж.',
  };
  return map[err.code] || err.message || 'Помилка оплати. Спробуйте ще раз.';
}

// ── Check ?success=1 on return from 3DS ─────────────────
if (new URLSearchParams(window.location.search).get('success') === '1') {
  document.addEventListener('DOMContentLoaded', () => {
    loadSession();
    showSuccess();
  });
}
