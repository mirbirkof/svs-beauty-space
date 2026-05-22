/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Scroll Animation System v3
   Cinematic Silk · Hair Flow · Blur-to-Focus
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var reducedMotion = prefersReducedMotion.matches;
  prefersReducedMotion.addEventListener('change', function (e) { reducedMotion = e.matches; });

  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function onScroll(callback) {
    var ticking = false;
    function handler() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { callback(); ticking = false; });
    }
    window.addEventListener('scroll', handler, { passive: true });
    return function () { window.removeEventListener('scroll', handler); };
  }


  /* ═══════════════════════════════════════════════════════
     1. SILK REVEAL — hero silk layer dissolves on scroll
     ═══════════════════════════════════════════════════════ */
  function initSilkReveal() {
    if (reducedMotion) return function () {};

    var silk = document.getElementById('heroSilk');
    if (!silk) return function () {};

    function update() {
      var scrollY = window.pageYOffset;
      var vh = window.innerHeight;
      // Silk dissolves in first 30% of viewport height
      var progress = clamp(scrollY / (vh * 0.3), 0, 1);

      var blur = lerp(2, 0, progress);
      var opacity = lerp(1, 0, progress);

      silk.style.setProperty('--silk-blur', blur.toFixed(1) + 'px');
      silk.style.setProperty('--silk-opacity', opacity.toFixed(3));
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     2. HAIR FLOW — SVG lines sway gently on scroll
     ═══════════════════════════════════════════════════════ */
  function initHairFlow() {
    if (reducedMotion) return function () {};

    var lines = document.querySelectorAll('.hair-line');
    if (!lines.length) return function () {};

    var baseD = [];
    lines.forEach(function (line) {
      baseD.push(line.getAttribute('d'));
    });

    var scrollOffset = 0;
    var currentOffset = 0;

    function update() {
      scrollOffset = window.pageYOffset * 0.02;
    }

    // Smooth interpolation via rAF
    var raf;
    function animate() {
      currentOffset = lerp(currentOffset, scrollOffset, 0.05);

      lines.forEach(function (line, i) {
        var shift = Math.sin(currentOffset + i * 1.2) * (8 + i * 3);
        var vertShift = Math.cos(currentOffset * 0.7 + i) * (4 + i * 2);

        // Shift the middle control points of the path
        line.style.transform = 'translateY(' + (shift).toFixed(1) + 'px)';
        line.style.opacity = (0.4 + Math.sin(currentOffset * 0.3 + i) * 0.2).toFixed(2);
      });

      raf = requestAnimationFrame(animate);
    }

    var cleanup = onScroll(update);
    raf = requestAnimationFrame(animate);

    return function () {
      cleanup();
      cancelAnimationFrame(raf);
    };
  }


  /* ═══════════════════════════════════════════════════════
     3. PARALLAX — about section only
     ═══════════════════════════════════════════════════════ */
  function initParallax() {
    if (reducedMotion) return function () {};

    var elements = document.querySelectorAll('.about__media img');
    if (!elements.length) return function () {};

    elements.forEach(function (img) { img.classList.add('has-parallax'); });

    function update() {
      elements.forEach(function (img) {
        var parent = img.parentElement;
        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;
        if (rect.bottom < -100 || rect.top > vh + 100) return;
        var centerOffset = (rect.top + rect.height / 2 - vh / 2) / vh;
        var translateY = centerOffset * -12;
        img.style.transform = 'translate3d(0,' + translateY + '%,0) scale(1.06)';
      });
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     4. COUNTERS
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

      function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        var elapsed = timestamp - startTime;
        var progress = clamp(elapsed / duration, 0, 1);
        el.textContent = Math.round(easeOutQuart(progress) * target) + suffix;
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = target + suffix;
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
    }, { threshold: 0.15, rootMargin: '0px 0px -30px 0px' });

    statNums.forEach(function (el) { observer.observe(el); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     5. SCROLL PROGRESS
     ═══════════════════════════════════════════════════════ */
  function initScrollProgress() {
    if (reducedMotion) return function () {};

    var bar = document.createElement('div');
    bar.className = 'scroll-progress';
    bar.setAttribute('role', 'progressbar');
    document.body.appendChild(bar);

    function update() {
      var scrollTop = window.pageYOffset;
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (docHeight > 0 ? (scrollTop / docHeight) * 100 : 0).toFixed(1) + '%';
    }

    var cleanup = onScroll(update);
    update();
    return function () { cleanup(); if (bar.parentNode) bar.parentNode.removeChild(bar); };
  }


  /* ═══════════════════════════════════════════════════════
     6. SECTION FADE
     ═══════════════════════════════════════════════════════ */
  function initSectionFade() {
    // Disabled — caused visible flicker/fading on scroll
    return function () {};
  }


  /* ═══════════════════════════════════════════════════════
     7. CUSTOM CURSOR FOLLOWER
     ═══════════════════════════════════════════════════════ */
  function initCursorFollower() {
    if (reducedMotion) return function () {};
    if (!window.matchMedia('(pointer: fine)').matches) return function () {};

    var cursor = document.querySelector('.cursor');
    var dot = cursor && cursor.querySelector('.cursor__dot');
    var ring = cursor && cursor.querySelector('.cursor__ring');
    if (!cursor || !dot || !ring) return function () {};

    var mx = -100, my = -100, dx = -100, dy = -100, rx = -100, ry = -100;
    var raf;

    function onMove(e) { mx = e.clientX; my = e.clientY; }

    function animate() {
      dx = lerp(dx, mx, 0.2);
      dy = lerp(dy, my, 0.2);
      rx = lerp(rx, mx, 0.08);
      ry = lerp(ry, my, 0.08);

      dot.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) translate(-50%,-50%)';
      ring.style.transform = 'translate(' + rx.toFixed(1) + 'px,' + ry.toFixed(1) + 'px) translate(-50%,-50%)';

      raf = requestAnimationFrame(animate);
    }

    var interactiveEls = document.querySelectorAll('a, button, .transform, .svc-card');
    function onEnter() { document.body.classList.add('cursor--hover'); }
    function onLeave() { document.body.classList.remove('cursor--hover'); }

    interactiveEls.forEach(function (el) {
      el.addEventListener('mouseenter', onEnter);
      el.addEventListener('mouseleave', onLeave);
    });

    window.addEventListener('mousemove', onMove);
    raf = requestAnimationFrame(animate);

    return function () {
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(raf);
    };
  }


  /* ═══════════════════════════════════════════════════════
     8. MAGNETIC CURSOR
     ═══════════════════════════════════════════════════════ */
  function initMagneticCursor() {
    if (reducedMotion) return function () {};
    if (!window.matchMedia('(pointer: fine)').matches) return function () {};

    var buttons = document.querySelectorAll('.btn, .link-arrow, .nav__link, .nav__lang, .swiper-btn');
    if (!buttons.length) return function () {};

    var MAX_PULL = 5;
    var cleanups = [];

    buttons.forEach(function (btn) {
      btn.classList.add('magnetic-btn');
      function onMove(e) {
        var rect = btn.getBoundingClientRect();
        var dx = e.clientX - (rect.left + rect.width / 2);
        var dy = e.clientY - (rect.top + rect.height / 2);
        btn.style.transform = 'translate3d(' + ((dx / (rect.width / 2)) * MAX_PULL).toFixed(1) + 'px,' + ((dy / (rect.height / 2)) * MAX_PULL).toFixed(1) + 'px,0)';
      }
      function onLeave() { btn.style.transform = ''; }
      btn.addEventListener('mousemove', onMove);
      btn.addEventListener('mouseleave', onLeave);
      cleanups.push(function () {
        btn.removeEventListener('mousemove', onMove);
        btn.removeEventListener('mouseleave', onLeave);
        btn.style.transform = '';
      });
    });

    return function () { cleanups.forEach(function (fn) { fn(); }); };
  }


  /* ═══════════════════════════════════════════════════════
     ORCHESTRATOR
     ═══════════════════════════════════════════════════════ */
  var activeEffects = {};

  var effects = {
    silkReveal:     initSilkReveal,
    hairFlow:       initHairFlow,
    parallax:       initParallax,
    counters:       initCounters,
    scrollProgress: initScrollProgress,
    sectionFade:    initSectionFade,
    cursorFollower: initCursorFollower,
    magneticCursor: initMagneticCursor
  };

  function initScrollAnimations() {
    if (reducedMotion) return;
    Object.keys(effects).forEach(function (key) {
      try { activeEffects[key] = effects[key](); }
      catch (e) { console.warn('[SVS] ' + key + ':', e); }
    });
  }

  function destroyAll() {
    Object.keys(activeEffects).forEach(function (key) {
      if (typeof activeEffects[key] === 'function') activeEffects[key]();
    });
    activeEffects = {};
  }

  window.SVSScroll = { init: initScrollAnimations, destroy: destroyAll, effects: Object.keys(effects) };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollAnimations);
  } else {
    initScrollAnimations();
  }

})();
