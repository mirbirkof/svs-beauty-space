/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Scroll Animation System v2
   Vogue × Saint Laurent × Aman

   Fixed: parallax/heroZoom conflict, rv+sticky overlap,
   i18n-safe text reveals, counter threshold, cursor
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reducedMotion = prefersReducedMotion.matches;

  prefersReducedMotion.addEventListener('change', function (e) {
    reducedMotion = e.matches;
  });

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function onScroll(callback) {
    var ticking = false;
    function handler() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        callback();
        ticking = false;
      });
    }
    window.addEventListener('scroll', handler, { passive: true });
    return function () {
      window.removeEventListener('scroll', handler);
    };
  }


  /* ═══════════════════════════════════════════════════════
     1. PARALLAX — only about__media, NOT hero (hero has its own CSS anim)
     ═══════════════════════════════════════════════════════ */
  function initParallax() {
    if (reducedMotion) return function () {};

    var elements = document.querySelectorAll('.about__media img');
    if (!elements.length) return function () {};

    elements.forEach(function (img) {
      img.classList.add('has-parallax');
    });

    function update() {
      elements.forEach(function (img) {
        var parent = img.parentElement;
        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;

        if (rect.bottom < -100 || rect.top > vh + 100) return;

        var centerOffset = (rect.top + rect.height / 2 - vh / 2) / vh;
        var translateY = centerOffset * -12;

        img.style.transform = 'translate3d(0,' + translateY + '%,0) scale(1.08)';
      });
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     2. SMOOTH COUNTER ANIMATION — fixed threshold
     ═══════════════════════════════════════════════════════ */
  function initCounters() {
    if (reducedMotion) return function () {};

    var statNums = document.querySelectorAll('.stat__num');
    if (!statNums.length) return function () {};

    function animateCounter(el) {
      var raw = el.textContent.trim();
      var match = raw.match(/^(\d+)(\D*)$/);
      if (!match) return;

      var target = parseInt(match[1], 10);
      var suffix = match[2] || '';
      var duration = 2200;
      var startTime = null;

      function easeOutQuart(t) {
        return 1 - Math.pow(1 - t, 4);
      }

      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        var elapsed = timestamp - startTime;
        var progress = clamp(elapsed / duration, 0, 1);
        var easedProgress = easeOutQuart(progress);
        var current = Math.round(easedProgress * target);

        el.textContent = current + suffix;

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          el.textContent = target + suffix;
        }
      }

      el.textContent = '0' + suffix;
      requestAnimationFrame(step);
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -30px 0px'
    });

    statNums.forEach(function (el) { observer.observe(el); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     3. IMAGE SCALE ON SCROLL — excludes rv-img (no conflict)
     ═══════════════════════════════════════════════════════ */
  function initImageScale() {
    if (reducedMotion) return function () {};

    var images = document.querySelectorAll('.svc-card__img img');
    if (!images.length) return function () {};

    function update() {
      images.forEach(function (img) {
        var parent = img.closest('.svc-card__img');
        if (!parent) return;

        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;

        if (rect.bottom < 0 || rect.top > vh) return;

        var progress = clamp(1 - (rect.top - vh * 0.2) / (vh * 0.6), 0, 1);
        var scale = lerp(1.08, 1.0, progress);

        img.style.transform = 'scale(' + scale.toFixed(4) + ')';
      });
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     4. SCROLL PROGRESS INDICATOR
     ═══════════════════════════════════════════════════════ */
  function initScrollProgress() {
    if (reducedMotion) return function () {};

    var bar = document.createElement('div');
    bar.className = 'scroll-progress';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Scroll progress');
    document.body.appendChild(bar);

    function update() {
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
      bar.style.width = progress.toFixed(1) + '%';
    }

    var cleanup = onScroll(update);
    update();

    return function () {
      cleanup();
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    };
  }


  /* ═══════════════════════════════════════════════════════
     5. SECTION FADE TRANSITIONS
     ═══════════════════════════════════════════════════════ */
  function initSectionFade() {
    if (reducedMotion) return function () {};

    var sections = document.querySelectorAll('.services, .results, .about, .contact');
    if (!sections.length) return function () {};

    sections.forEach(function (s) {
      s.classList.add('section-fade');
    });

    function update() {
      var vh = window.innerHeight;

      sections.forEach(function (section) {
        var rect = section.getBoundingClientRect();

        if (rect.bottom < -200 || rect.top > vh + 200) {
          section.style.opacity = '';
          return;
        }

        var opacity = 1;

        if (rect.top < 0) {
          var exitProgress = clamp(Math.abs(rect.top) / (rect.height * 0.4), 0, 1);
          opacity = lerp(1, 0.3, exitProgress);
        }

        if (rect.top > vh * 0.85) {
          var enterProgress = clamp((rect.top - vh * 0.85) / (vh * 0.15), 0, 1);
          opacity = lerp(1, 0.7, enterProgress);
        }

        section.style.opacity = opacity.toFixed(3);
      });
    }

    var cleanup = onScroll(update);
    update();

    return function () {
      cleanup();
      sections.forEach(function (s) {
        s.style.opacity = '';
        s.classList.remove('section-fade');
      });
    };
  }


  /* ═══════════════════════════════════════════════════════
     6. CUSTOM CURSOR FOLLOWER (lerp-smoothed)
     ═══════════════════════════════════════════════════════ */
  function initCursorFollower() {
    if (reducedMotion) return function () {};
    if (!window.matchMedia('(pointer: fine)').matches) return function () {};

    var cursor = document.querySelector('.cursor');
    var dot = cursor && cursor.querySelector('.cursor__dot');
    var ring = cursor && cursor.querySelector('.cursor__ring');
    if (!cursor || !dot || !ring) return function () {};

    var mx = -100, my = -100;
    var dx = -100, dy = -100;
    var rx = -100, ry = -100;
    var raf;

    function onMove(e) {
      mx = e.clientX;
      my = e.clientY;
    }

    function animate() {
      dx = lerp(dx, mx, 0.25);
      dy = lerp(dy, my, 0.25);
      rx = lerp(rx, mx, 0.12);
      ry = lerp(ry, my, 0.12);

      dot.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) translate(-50%,-50%)';
      ring.style.transform = 'translate(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px) translate(-50%,-50%)';

      raf = requestAnimationFrame(animate);
    }

    // Hover states
    var interactiveEls = document.querySelectorAll('a, button, .transform, .svc-card, [data-transform]');
    function onEnter() { document.body.classList.add('cursor--hover'); }
    function onLeave() { document.body.classList.remove('cursor--hover'); }

    interactiveEls.forEach(function (el) {
      el.addEventListener('mouseenter', onEnter);
      el.addEventListener('mouseleave', onLeave);
    });

    // Drag state
    var transforms = document.querySelectorAll('[data-transform]');
    transforms.forEach(function (t) {
      t.addEventListener('mousedown', function () { document.body.classList.add('cursor--drag'); });
    });
    window.addEventListener('mouseup', function () { document.body.classList.remove('cursor--drag'); });

    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(animate);

    return function () {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
      interactiveEls.forEach(function (el) {
        el.removeEventListener('mouseenter', onEnter);
        el.removeEventListener('mouseleave', onLeave);
      });
    };
  }


  /* ═══════════════════════════════════════════════════════
     7. MAGNETIC CURSOR EFFECT
     ═══════════════════════════════════════════════════════ */
  function initMagneticCursor() {
    if (reducedMotion) return function () {};
    if (!window.matchMedia('(pointer: fine)').matches) return function () {};

    var buttons = document.querySelectorAll('.btn, .link-arrow, .nav__link, .nav__lang, .swiper-btn');
    if (!buttons.length) return function () {};

    var MAX_PULL = 6;
    var cleanups = [];

    buttons.forEach(function (btn) {
      btn.classList.add('magnetic-btn');

      function onMove(e) {
        var rect = btn.getBoundingClientRect();
        var centerX = rect.left + rect.width / 2;
        var centerY = rect.top + rect.height / 2;

        var dx = e.clientX - centerX;
        var dy = e.clientY - centerY;

        var pullX = (dx / (rect.width / 2)) * MAX_PULL;
        var pullY = (dy / (rect.height / 2)) * MAX_PULL;

        btn.style.transform = 'translate3d(' + pullX.toFixed(1) + 'px,' + pullY.toFixed(1) + 'px,0)';
      }

      function onLeave() {
        btn.style.transform = '';
      }

      btn.addEventListener('mousemove', onMove);
      btn.addEventListener('mouseleave', onLeave);

      cleanups.push(function () {
        btn.removeEventListener('mousemove', onMove);
        btn.removeEventListener('mouseleave', onLeave);
        btn.style.transform = '';
        btn.classList.remove('magnetic-btn');
      });
    });

    return function () {
      cleanups.forEach(function (fn) { fn(); });
    };
  }


  /* ═══════════════════════════════════════════════════════
     8. HORIZONTAL SECTION SLIDE (sections slide in from sides)
     ═══════════════════════════════════════════════════════ */
  function initHorizontalReveal() {
    if (reducedMotion) return function () {};

    var targets = document.querySelectorAll('.results__slider, .about__media');
    if (!targets.length) return function () {};

    targets.forEach(function (el) {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-60px)';
      el.style.transition = 'opacity 1.2s cubic-bezier(0.22,1,0.36,1), transform 1.2s cubic-bezier(0.22,1,0.36,1)';
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateX(0)';
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -60px 0px'
    });

    targets.forEach(function (el) { observer.observe(el); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     ORCHESTRATOR
     ═══════════════════════════════════════════════════════ */
  var activeEffects = {};

  var effects = {
    parallax:         initParallax,
    counters:         initCounters,
    imageScale:       initImageScale,
    scrollProgress:   initScrollProgress,
    sectionFade:      initSectionFade,
    cursorFollower:   initCursorFollower,
    magneticCursor:   initMagneticCursor,
    horizontalReveal: initHorizontalReveal
  };

  function initScrollAnimations() {
    if (reducedMotion) return;

    Object.keys(effects).forEach(function (key) {
      try {
        activeEffects[key] = effects[key]();
      } catch (e) {
        console.warn('[SVS Scroll] Failed to init ' + key + ':', e);
      }
    });
  }

  function toggleEffect(name, enable) {
    if (!effects[name]) return;

    if (enable && !activeEffects[name]) {
      activeEffects[name] = effects[name]();
    } else if (!enable && activeEffects[name]) {
      if (typeof activeEffects[name] === 'function') {
        activeEffects[name]();
      }
      delete activeEffects[name];
    }
  }

  function destroyAll() {
    Object.keys(activeEffects).forEach(function (key) {
      if (typeof activeEffects[key] === 'function') {
        activeEffects[key]();
      }
    });
    activeEffects = {};
  }

  window.SVSScroll = {
    init: initScrollAnimations,
    toggle: toggleEffect,
    destroy: destroyAll,
    effects: Object.keys(effects)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollAnimations);
  } else {
    initScrollAnimations();
  }

})();
