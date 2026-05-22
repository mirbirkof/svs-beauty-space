/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Premium Scroll Animation System
   Apple × Aman × Saint Laurent

   Pure vanilla JS. No dependencies.
   IntersectionObserver + rAF + scroll events.
   Each effect is a standalone function with kill switch.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Globals & Utilities ─────────────────────────────── */
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reducedMotion = prefersReducedMotion.matches;

  prefersReducedMotion.addEventListener('change', function (e) {
    reducedMotion = e.matches;
  });

  /** Clamp a number between min and max */
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /** Linear interpolation */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** Throttled scroll listener via rAF */
  function onScroll(callback) {
    let ticking = false;
    function handler() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        callback();
        ticking = false;
      });
    }
    window.addEventListener('scroll', handler, { passive: true });
    // Return cleanup function
    return function () {
      window.removeEventListener('scroll', handler);
    };
  }

  /** Get element's vertical center position relative to viewport */
  function getVisibilityRatio(el) {
    var rect = el.getBoundingClientRect();
    var vh = window.innerHeight;
    // 0 = element top at viewport bottom, 1 = element bottom at viewport top
    return clamp(1 - (rect.top / vh), 0, 1);
  }


  /* ═══════════════════════════════════════════════════════
     1. PARALLAX IMAGES
     Images in .split__media and .hero__media move at
     different speeds — subtle 10-20% offset.
     ═══════════════════════════════════════════════════════ */
  function initParallax() {
    if (reducedMotion) return function () {};

    var elements = document.querySelectorAll('.split__media img, .hero__media img');
    if (!elements.length) return function () {};

    // Mark for will-change
    elements.forEach(function (img) {
      img.classList.add('has-parallax');
    });

    function update() {
      elements.forEach(function (img) {
        var parent = img.parentElement;
        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;

        // Only process if in viewport (with buffer)
        if (rect.bottom < -100 || rect.top > vh + 100) return;

        // Calculate offset: center = 0, top = negative, bottom = positive
        var centerOffset = (rect.top + rect.height / 2 - vh / 2) / vh;
        // 15% parallax intensity — cinematic, not aggressive
        var translateY = centerOffset * -15;

        img.style.transform = 'translate3d(0,' + translateY + '%,0) scale(1.08)';
      });
    }

    var cleanup = onScroll(update);
    update(); // Initial call

    return cleanup;
  }


  /* ═══════════════════════════════════════════════════════
     2. STICKY REVEAL SECTIONS
     Text content fades and slides in with staggered delays.
     Uses IntersectionObserver for trigger + CSS transitions.
     ═══════════════════════════════════════════════════════ */
  function initStickyReveal() {
    if (reducedMotion) return function () {};

    var containers = document.querySelectorAll('.split__text, .about__text, .booking__inner, .contact__info');
    if (!containers.length) return function () {};

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        var children = entry.target.querySelectorAll('.t-overline, .t-h2, .t-display, .t-body-sm, .t-body, .link-arrow, .btn, .t-caption, p');
        var delay = 0;

        children.forEach(function (child) {
          // Skip if already has reveal class from app.js
          if (child.classList.contains('sticky-reveal')) return;

          child.classList.add('sticky-reveal');
          child.setAttribute('data-delay', String(Math.min(delay, 5)));

          // Force reflow then add visible class
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
     Stat numbers count up from 0 when scrolled into view.
     Handles formats: "10+", "2000+", "Raywell" (text stays).
     ═══════════════════════════════════════════════════════ */
  function initCounters() {
    if (reducedMotion) return function () {};

    var statNums = document.querySelectorAll('.stat__num');
    if (!statNums.length) return function () {};

    function animateCounter(el) {
      var raw = el.textContent.trim();
      var match = raw.match(/^(\d+)(\D*)$/);

      // If no number found (e.g. "Raywell"), skip animation
      if (!match) return;

      var target = parseInt(match[1], 10);
      var suffix = match[2] || '';
      var duration = 2000; // 2 seconds — elegant pace
      var startTime = null;

      // Easing: decelerate curve (fast start, slow end)
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

      // Start from 0
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
     Headings reveal line by line with translateY animation.
     Wraps each text node line in a clip container.
     ═══════════════════════════════════════════════════════ */
  function initTextLineReveal() {
    if (reducedMotion) return function () {};

    var headings = document.querySelectorAll('.t-display, .t-h2');
    if (!headings.length) return function () {};

    // Wrap inner content for line reveal
    headings.forEach(function (heading) {
      // Skip if already processed
      if (heading.querySelector('.line-reveal')) return;

      // Get direct child nodes (text + <br> + <span>)
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

      // If only one line, wrap entire content
      if (lines.length <= 1) {
        var wrapper = document.createElement('span');
        wrapper.className = 'line-reveal';
        var inner = document.createElement('span');
        inner.className = 'line-reveal__inner';

        // Move all children
        while (heading.firstChild) {
          inner.appendChild(heading.firstChild);
        }
        wrapper.appendChild(inner);
        heading.appendChild(wrapper);
      } else {
        // Multiple lines: wrap each
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
     Images slightly scale down from 1.05 to 1.0 as they
     approach viewport center. Cinematic zoom-settle.
     ═══════════════════════════════════════════════════════ */
  function initImageScale() {
    if (reducedMotion) return function () {};

    var images = document.querySelectorAll('.rit__img img, .ray-item__img img, .rv-img img');
    if (!images.length) return function () {};

    images.forEach(function (img) {
      img.closest('.rv-img, .rit__img, .ray-item__img').classList.add('img-scale-wrap');
    });

    function update() {
      images.forEach(function (img) {
        var parent = img.closest('.img-scale-wrap');
        if (!parent) return;

        var rect = parent.getBoundingClientRect();
        var vh = window.innerHeight;

        // Only process if in viewport
        if (rect.bottom < 0 || rect.top > vh) return;

        // Progress: 0 = just entering, 1 = center of viewport
        var progress = clamp(1 - (rect.top - vh * 0.2) / (vh * 0.6), 0, 1);
        // Scale from 1.05 to 1.0
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
     Thin gold line at top of page.
     ═══════════════════════════════════════════════════════ */
  function initScrollProgress() {
    if (reducedMotion) return function () {};

    // Create the progress bar element
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
     Sections fade slightly as you scroll past them.
     Exit animation — reduces opacity when leaving viewport.
     ═══════════════════════════════════════════════════════ */
  function initSectionFade() {
    if (reducedMotion) return function () {};

    var sections = document.querySelectorAll('.split, .rituals, .about, .transforms, .raywell, .voices, .booking, .contact');
    if (!sections.length) return function () {};

    sections.forEach(function (s) {
      s.classList.add('section-fade');
    });

    function update() {
      var vh = window.innerHeight;

      sections.forEach(function (section) {
        var rect = section.getBoundingClientRect();

        // Skip if completely outside viewport
        if (rect.bottom < -200 || rect.top > vh + 200) {
          section.style.opacity = '';
          return;
        }

        var opacity = 1;

        // Fade out when scrolling past (top of section moves above viewport)
        if (rect.top < 0) {
          // How far past the top: 0 = just passed, 1 = fully gone
          var exitProgress = clamp(Math.abs(rect.top) / (rect.height * 0.4), 0, 1);
          opacity = lerp(1, 0.3, exitProgress);
        }

        // Fade in when entering from bottom
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
     8. HORIZONTAL SLIDE FOR RITUALS
     Ritual cards slide in from alternating sides.
     ═══════════════════════════════════════════════════════ */
  function initRitualSlide() {
    if (reducedMotion) return function () {};

    var cards = document.querySelectorAll('.rit');
    if (!cards.length) return function () {};

    cards.forEach(function (card, i) {
      card.classList.add('rit-slide');
      card.classList.add(i % 2 === 0 ? 'rit-slide--left' : 'rit-slide--right');
    });

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;

        // Stagger within the grid
        var card = entry.target;
        var index = Array.prototype.indexOf.call(cards, card);
        var delay = index * 120; // 120ms stagger

        setTimeout(function () {
          card.classList.add('is-slid-in');
        }, delay);

        observer.unobserve(card);
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -30px 0px'
    });

    cards.forEach(function (card) { observer.observe(card); });

    return function () { observer.disconnect(); };
  }


  /* ═══════════════════════════════════════════════════════
     9. MAGNETIC CURSOR EFFECT
     Buttons attract toward cursor on hover (desktop only).
     Subtle — max 6px displacement. Premium micro-interaction.
     ═══════════════════════════════════════════════════════ */
  function initMagneticCursor() {
    if (reducedMotion) return function () {};

    // Only on devices with fine pointer (desktop)
    if (!window.matchMedia('(pointer: fine)').matches) return function () {};

    var buttons = document.querySelectorAll('.btn, .link-arrow, .nav__link, .nav__lang');
    if (!buttons.length) return function () {};

    var MAX_PULL = 6; // px — subtle, premium
    var cleanups = [];

    buttons.forEach(function (btn) {
      btn.classList.add('magnetic-btn');

      function onMove(e) {
        var rect = btn.getBoundingClientRect();
        var centerX = rect.left + rect.width / 2;
        var centerY = rect.top + rect.height / 2;

        var dx = e.clientX - centerX;
        var dy = e.clientY - centerY;

        // Normalize to max pull distance
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
     Initialize all effects. Each returns a cleanup function.
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
    ritualSlide:    initRitualSlide,
    magneticCursor: initMagneticCursor
  };

  /**
   * Initialize all scroll animations.
   * Call after DOM is ready.
   */
  function initScrollAnimations() {
    // If reduced motion, bail out entirely
    if (reducedMotion) return;

    Object.keys(effects).forEach(function (key) {
      try {
        activeEffects[key] = effects[key]();
      } catch (e) {
        console.warn('[SVS Scroll] Failed to init ' + key + ':', e);
      }
    });
  }

  /**
   * Toggle a specific effect on/off.
   * @param {string} name — effect key
   * @param {boolean} enable
   */
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

  /**
   * Destroy all active effects (cleanup).
   */
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
    // DOM already loaded (e.g. script at bottom of body)
    initScrollAnimations();
  }

})();
