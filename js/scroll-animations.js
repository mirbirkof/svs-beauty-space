/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Premium Scroll Animation System
   Apple x Aman x Saint Laurent

   Pure vanilla JS. No dependencies.
   IntersectionObserver + rAF + scroll events.
   Each effect is a standalone function with kill switch.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Globals & Utilities ─────────────────────────────── */
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
     1. PARALLAX IMAGES
     ═══════════════════════════════════════════════════════ */
  function initParallax() {
    if (reducedMotion) return function () {};

    var elements = document.querySelectorAll('.about__media img, .hero__bg img');
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
        var translateY = centerOffset * -15;

        img.style.transform = 'translate3d(0,' + translateY + '%,0) scale(1.08)';
      });
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     2. STICKY REVEAL SECTIONS
     ═══════════════════════════════════════════════════════ */
  function initStickyReveal() {
    if (reducedMotion) return function () {};

    var containers = document.querySelectorAll('.about__text, .contact__cta, .contact__info');
    if (!containers.length) return function () {};

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        var children = entry.target.querySelectorAll('.t-overline, .t-h2, .t-h3, .t-display, .t-body-sm, .t-body, .link-arrow, .btn, .t-caption, p');
        var delay = 0;

        children.forEach(function (child) {
          if (child.classList.contains('sticky-reveal')) return;
          child.classList.add('sticky-reveal');
          child.setAttribute('data-delay', String(Math.min(delay, 5)));
          void child.offsetHeight;
          setTimeout(function () {
            child.classList.add('is-visible');
          }, 50 + delay * 100);
          delay++;
        });

        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -60px 0px'
    });

    containers.forEach(function (el) { observer.observe(el); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     3. SMOOTH COUNTER ANIMATION
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
      var duration = 2000;
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
      threshold: 0.5
    });

    statNums.forEach(function (el) { observer.observe(el); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     4. TEXT LINE REVEAL
     ═══════════════════════════════════════════════════════ */
  function initTextLineReveal() {
    if (reducedMotion) return function () {};

    var headings = document.querySelectorAll('.t-display, .t-h2');
    if (!headings.length) return function () {};

    headings.forEach(function (heading) {
      if (heading.querySelector('.line-reveal')) return;

      var children = heading.childNodes;
      var lines = [];
      var currentLine = [];

      children.forEach(function (node) {
        if (node.nodeName === 'BR') {
          if (currentLine.length) lines.push(currentLine);
          currentLine = [];
        } else {
          currentLine.push(node.cloneNode(true));
        }
      });
      if (currentLine.length) lines.push(currentLine);

      if (lines.length <= 1) {
        var wrapper = document.createElement('span');
        wrapper.className = 'line-reveal';
        var inner = document.createElement('span');
        inner.className = 'line-reveal__inner';
        while (heading.firstChild) {
          inner.appendChild(heading.firstChild);
        }
        wrapper.appendChild(inner);
        heading.appendChild(wrapper);
      } else {
        heading.innerHTML = '';
        lines.forEach(function (lineNodes, i) {
          var wrapper = document.createElement('span');
          wrapper.className = 'line-reveal';
          wrapper.style.display = 'block';
          var inner = document.createElement('span');
          inner.className = 'line-reveal__inner';
          inner.style.display = 'inline-block';
          inner.style.transitionDelay = (i * 0.12) + 's';
          lineNodes.forEach(function (node) {
            inner.appendChild(node);
          });
          wrapper.appendChild(inner);
          heading.appendChild(wrapper);
        });
      }
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var reveals = entry.target.querySelectorAll('.line-reveal');
        reveals.forEach(function (el) {
          el.classList.add('is-revealed');
        });
        observer.unobserve(entry.target);
      });
    }, {
      threshold: 0.2,
      rootMargin: '0px 0px -40px 0px'
    });

    headings.forEach(function (h) { observer.observe(h); });
    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     5. IMAGE SCALE ON SCROLL
     ═══════════════════════════════════════════════════════ */
  function initImageScale() {
    if (reducedMotion) return function () {};

    var images = document.querySelectorAll('.svc-card__img img, .rv-img img');
    if (!images.length) return function () {};

    images.forEach(function (img) {
      var parent = img.closest('.rv-img, .svc-card__img');
      if (parent) parent.classList.add('img-scale-wrap');
    });

    function update() {
      images.forEach(function (img) {
        var parent = img.closest('.img-scale-wrap');
        if (!parent) return;

        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;

        if (rect.bottom < 0 || rect.top > vh) return;

        var progress = clamp(1 - (rect.top - vh * 0.2) / (vh * 0.6), 0, 1);
        var scale = lerp(1.05, 1.0, progress);

        img.style.transform = 'scale(' + scale.toFixed(4) + ')';
      });
    }

    var cleanup = onScroll(update);
    update();
    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     6. SCROLL PROGRESS INDICATOR
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
     7. SECTION FADE TRANSITIONS
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
     8. MAGNETIC CURSOR EFFECT
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
     ORCHESTRATOR
     ═══════════════════════════════════════════════════════ */
  var activeEffects = {};

  var effects = {
    parallax:       initParallax,
    stickyReveal:   initStickyReveal,
    counters:       initCounters,
    textLineReveal: initTextLineReveal,
    imageScale:     initImageScale,
    scrollProgress: initScrollProgress,
    sectionFade:    initSectionFade,
    magneticCursor: initMagneticCursor
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

  /* ── Public API ─────────────────────────────────────── */
  window.SVSScroll = {
    init: initScrollAnimations,
    toggle: toggleEffect,
    destroy: destroyAll,
    effects: Object.keys(effects)
  };

  /* ── Auto-init on DOMContentLoaded ──────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScrollAnimations);
  } else {
    initScrollAnimations();
  }

})();
