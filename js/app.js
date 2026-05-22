/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — App (Compact Premium)
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Reveal ─────────────────────────────────────────── */
  function initReveal() {
    const els = document.querySelectorAll('.rv, .rv-img');
    if (!els.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('is-v'); io.unobserve(e.target); } });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ── Hero entry ─────────────────────────────────────── */
  function initHeroEntry() {
    setTimeout(() => {
      document.querySelectorAll('.hero .rv, .hero .rv-img').forEach(el => el.classList.add('is-v'));
    }, 200);
  }

  /* ── Nav ─────────────────────────────────────────────── */
  function initNav() {
    const nav = document.getElementById('nav');
    const burger = document.getElementById('navBurger');
    const links = document.getElementById('navLinks');

    // Scroll
    let t = false;
    window.addEventListener('scroll', () => {
      if (t) return; t = true;
      requestAnimationFrame(() => { nav.classList.toggle('nav--scrolled', scrollY > 60); t = false; });
    }, { passive: true });

    // Burger
    if (burger && links) {
      burger.addEventListener('click', () => {
        burger.classList.toggle('is-open');
        links.classList.toggle('is-open');
        document.body.style.overflow = links.classList.contains('is-open') ? 'hidden' : '';
      });
      links.querySelectorAll('.nav__link').forEach(a => a.addEventListener('click', () => {
        burger.classList.remove('is-open');
        links.classList.remove('is-open');
        document.body.style.overflow = '';
      }));
    }

    // Lang buttons
    document.querySelectorAll('.nav__lang[data-lang]').forEach(btn => {
      btn.addEventListener('click', () => I18N.set(btn.dataset.lang));
    });
  }

  /* ── Before/After ───────────────────────────────────── */
  function initTransforms() {
    document.querySelectorAll('[data-transform]').forEach(slider => {
      const before = slider.querySelector('.transform__before');
      const handle = slider.querySelector('.transform__handle');
      if (!before || !handle) return;
      let drag = false;
      function pos(x) {
        const r = slider.getBoundingClientRect();
        let p = ((x - r.left) / r.width) * 100;
        p = Math.max(5, Math.min(95, p));
        before.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
        handle.style.left = p + '%';
      }
      slider.addEventListener('mousedown', e => { drag = true; e.preventDefault(); pos(e.clientX); });
      slider.addEventListener('touchstart', e => { drag = true; e.preventDefault(); pos(e.touches[0].clientX); }, { passive: false });
      window.addEventListener('mousemove', e => { if (drag) pos(e.clientX); });
      window.addEventListener('touchmove', e => { if (drag) pos(e.touches[0].clientX); }, { passive: false });
      window.addEventListener('mouseup', () => { drag = false; });
      window.addEventListener('touchend', () => { drag = false; });
    });
  }

  /* ── Swiper init ────────────────────────────────────── */
  function initSwiper() {
    if (typeof Swiper === 'undefined') return;

    new Swiper('#servicesSwiper', {
      slidesPerView: 1.15,
      spaceBetween: 20,
      speed: 800,
      grabCursor: true,
      pagination: {
        el: '#svcPagination',
        clickable: true,
      },
      navigation: {
        prevEl: '#svcPrev',
        nextEl: '#svcNext',
      },
      breakpoints: {
        480: {
          slidesPerView: 1.5,
          spaceBetween: 24,
        },
        768: {
          slidesPerView: 2.3,
          spaceBetween: 28,
        },
        1200: {
          slidesPerView: 3.2,
          spaceBetween: 32,
        },
      },
    });
  }

  /* ── Smooth anchors ─────────────────────────────────── */
  function initAnchors() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const t = document.querySelector(a.getAttribute('href'));
        if (!t) return;
        e.preventDefault();
        window.scrollTo({ top: t.getBoundingClientRect().top + scrollY - 72, behavior: 'smooth' });
      });
    });
  }

  /* ── Init ───────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    I18N.init();
    initHeroEntry();
    initReveal();
    initNav();
    initTransforms();
    initSwiper();
    initAnchors();
  });
})();
