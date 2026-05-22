/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — App v2 (Vogue Editorial)
   Fixed: no rv+sticky conflict, i18n-safe, hero entrance
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Reveal (simple, no conflict with other systems) ── */
  function initReveal() {
    const els = document.querySelectorAll('.rv, .rv-img');
    if (!els.length) return;
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('is-v');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
    els.forEach(el => io.observe(el));
  }

  /* ── Hero cinematic entrance ──────────────────────── */
  function initHeroEntry() {
    const hero = document.querySelector('.hero');
    if (!hero) return;

    // Quick entrance — photo appears fast
    setTimeout(() => {
      hero.classList.add('hero--loaded');
      hero.querySelectorAll('.rv, .rv-img').forEach(el => el.classList.add('is-v'));
    }, 100);

    // Switch to breathing after zoom settles
    setTimeout(() => {
      hero.classList.add('hero--breathing');
    }, 3500);
  }

  /* ── Nav ─────────────────────────────────────────── */
  function initNav() {
    const nav = document.getElementById('nav');
    const burger = document.getElementById('navBurger');
    const links = document.getElementById('navLinks');

    let t = false;
    window.addEventListener('scroll', () => {
      if (t) return; t = true;
      requestAnimationFrame(() => {
        nav.classList.toggle('nav--scrolled', scrollY > 60);
        t = false;
      });
    }, { passive: true });

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

    // Lang buttons (both desktop and mobile)
    document.querySelectorAll('.nav__lang[data-lang]').forEach(btn => {
      btn.addEventListener('click', () => I18N.set(btn.dataset.lang));
    });
  }

  /* ── Before/After slider ─────────────────────────── */
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

      // Auto-sweep on first view to show affordance
      let swept = false;
      const swIO = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting && !swept) {
            swept = true;
            swIO.unobserve(slider);
            // Animate handle from 50% to 30% and back
            let start = null;
            function sweep(ts) {
              if (!start) start = ts;
              const elapsed = ts - start;
              const dur = 1500;
              const progress = Math.min(elapsed / dur, 1);
              const p = progress < 0.5
                ? 50 - 20 * (progress * 2)
                : 30 + 20 * ((progress - 0.5) * 2);
              before.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
              handle.style.left = p + '%';
              if (progress < 1) requestAnimationFrame(sweep);
            }
            setTimeout(() => requestAnimationFrame(sweep), 600);
          }
        });
      }, { threshold: 0.3 });
      swIO.observe(slider);

      slider.addEventListener('mousedown', e => { drag = true; e.preventDefault(); pos(e.clientX); });
      slider.addEventListener('touchstart', e => { drag = true; e.preventDefault(); pos(e.touches[0].clientX); }, { passive: false });
      window.addEventListener('mousemove', e => { if (drag) pos(e.clientX); });
      window.addEventListener('touchmove', e => { if (drag) pos(e.touches[0].clientX); }, { passive: false });
      window.addEventListener('mouseup', () => { drag = false; });
      window.addEventListener('touchend', () => { drag = false; });
    });
  }

  /* ── Swiper init ────────────────────────────────── */
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

  /* ── Smooth anchors ─────────────────────────────── */
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

  /* ── Service card overlay visible on touch ──────── */
  function initTouchOverlays() {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    document.querySelectorAll('.svc-card__overlay').forEach(el => {
      el.classList.add('svc-card__overlay--visible');
    });
  }

  /* ── Init ────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    I18N.init();
    initHeroEntry();
    initReveal();
    initNav();
    initTransforms();
    initSwiper();
    initAnchors();
    initTouchOverlays();
  });
})();
