/* ═══════════════════════════════════════════════════════
   SVS BEAUTY SPACE — Shop Atelier 3D
   Золоті нитки (стиль concept-3d-v2), вплетені у дії магазину:
   · додав у кошик   → золота хвиля від точки кліку + іскра летить у кошик
   · відкрив кошик   → нитки стікаються до правого краю (до шухляди)
   · скрол           → формація ниток пливе
   · курсор          → паралакс + відштовхування
   Zero dependencies. Auto-off: reduced-motion / no WebGL.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var mobile = window.innerWidth < 700;

  /* ── Canvas ────────────────────────────────────────── */
  var canvas = document.createElement('canvas');
  canvas.className = 'bg3d';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:block;';
  document.body.insertBefore(canvas, document.body.firstChild);

  var gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });

  var STRANDS = mobile ? 9 : 16;
  var BASE_A = mobile ? 0.5 : 0.8; /* загальна яскравість ниток */

  var VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }';

  var FRAG = [
    'precision mediump float;',
    'uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;',
    'uniform float uScroll; uniform float uPulse; uniform vec2 uPulseO; uniform float uGather;',
    '',
    'float hash(vec2 n){ return fract(sin(dot(n, vec2(12.9898,78.233))) * 43758.5453); }',
    'float noise(vec2 x){',
    '  vec2 i = floor(x); vec2 f = fract(x); f = f*f*(3.0-2.0*f);',
    '  float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));',
    '  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);',
    '}',
    '',
    '/* приглушений шовк як підкладка */',
    'float silk(vec2 p, float t){',
    '  float h = sin(p.x*1.4 + t*0.30 + sin(p.y*1.1 + t*0.2)*1.6)*0.55;',
    '  h += sin(p.y*1.9 - t*0.24 + sin(p.x*1.6 - t*0.15)*1.3)*0.65;',
    '  return h;',
    '}',
    '',
    'void main(){',
    '  vec2 p = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;',
    '  float t = uTime;',
    '  p += uMouse * 0.10;',
    '',
    '  /* кошик відкрито: поле повертається, нитки течуть вертикально біля правого краю */',
    '  vec2 pg = vec2(p.y*1.4 + t*0.05, (p.x - 0.62)*2.4);',
    '  vec2 pp = mix(p, pg, uGather);',
    '',
    '  vec3 base = vec3(0.039, 0.035, 0.031);',
    '  vec3 gold = vec3(0.804, 0.659, 0.420);',
    '  vec3 lite = vec3(0.95, 0.80, 0.52);',
    '',
    '  /* шовкова підкладка (ледь помітна) */',
    '  float s = silk(p*1.7, t);',
    '  vec3 col = base + gold * smoothstep(0.4, 1.4, s) * 0.05;',
    '',
    '  /* золоті нитки */',
    '  float acc = 0.0; float shineAcc = 0.0;',
    '  for (int i = 0; i < ' + STRANDS + '; i++){',
    '    float fi = float(i);',
    '    float seed = hash(vec2(fi, 7.31));',
    '    float lane = (seed - 0.5) * 1.9;                 /* вертикальне розкладання */',
    '    float amp  = 0.10 + seed*0.22;',
    '    float ph   = seed * 31.4;',
    '    float spd  = 0.25 + seed*0.45;',
    '    float y = lane',
    '      + sin(pp.x*(1.1+seed*1.8) + t*spd + ph + uScroll*3.0)*amp',
    '      + sin(pp.x*(3.1+seed*2.2) - t*spd*0.7 + ph*1.7)*amp*0.35;',
    '    /* пульс: хвиля амплітуди, що розходиться від точки кліку */',
    '    float pd = length(p - uPulseO);',
    '    float wave = sin(pd*9.0 - uPulse*14.0) * smoothstep(1.6, 0.0, pd) * (uPulse*(1.0-uPulse))*4.0;',
    '    y += wave * 0.07 * (0.5+seed);',
    '    /* курсор відштовхує */',
    '    float md = length(p - uMouse*vec2(0.9,0.5));',
    '    y += sign(y - uMouse.y*0.5+0.001) * smoothstep(0.35, 0.0, md) * 0.10;',
    '',
    '    float d = abs(pp.y - y);',
    '    float w = 0.0014 + seed*0.0022;',
    '    float g = w / (d + 0.004);',
    '    float shine = 0.5 + 0.5*sin(pp.x*22.0 - t*1.6 + ph);',
    '    acc += g * (0.35 + shine*0.65);',
    '    shineAcc += g * shine;',
    '  }',
    '  acc *= ' + BASE_A.toFixed(2) + ';',
    '  /* пульс підсвічує всі нитки коротким спалахом */',
    '  acc *= 1.0 + (uPulse*(1.0-uPulse))*2.2;',
    '  col += mix(gold, lite, clamp(shineAcc*0.4,0.,1.)) * min(acc, 1.6) * 0.55;',
    '',
    '  /* золоте кільце, що розбігається від точки додавання */',
    '  float pd2 = length(p - uPulseO);',
    '  float ring = smoothstep(0.06, 0.0, abs(pd2 - uPulse*1.5)) * (1.0-uPulse) * step(0.001, uPulse);',
    '  col += lite * ring * 0.5;',
    '',
    '  /* золотий пил */',
    '  vec2 dp = p*7.0 + vec2(t*0.06, t*0.10);',
    '  float dust = step(0.985, hash(floor(dp)));',
    '  float tw = 0.5 + 0.5*sin(t*1.7 + hash(floor(dp))*40.0);',
    '  col += gold * dust * tw * smoothstep(0.18, 0.0, length(fract(dp)-0.5)) * 0.6;',
    '',
    '  float vig = smoothstep(1.25, 0.35, length(p));',
    '  col *= mix(0.8, 1.0, vig);',
    '  gl_FragColor = vec4(col, 0.9);',
    '}'
  ].join('\n');

  var program = null, U = {};
  if (gl) (function initGL() {
    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn('[atelier]', gl.getShaderInfoLog(sh)); return null; }
      return sh;
    }
    var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { canvas.remove(); gl = null; return; }
    program = gl.createProgram();
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { canvas.remove(); gl = null; return; }
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uRes', 'uTime', 'uMouse', 'uScroll', 'uPulse', 'uPulseO', 'uGather'].forEach(function (n) { U[n] = gl.getUniformLocation(program, n); });
  })();
  if (!gl) canvas.remove();

  /* ── Стан анімації ─────────────────────────────────── */
  var SCALE = Math.min(window.devicePixelRatio || 1, 1.25) * 0.7;
  function resize() {
    if (!gl) return;
    var w = Math.max(1, Math.floor(window.innerWidth * SCALE));
    var h = Math.max(1, Math.floor(window.innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(U.uRes, w, h);
    }
  }
  if (gl) { resize(); window.addEventListener('resize', resize); }

  var mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('pointermove', function (e) {
    tmx = (e.clientX / window.innerWidth - 0.5) * 2.0;
    tmy = -(e.clientY / window.innerHeight - 0.5) * 2.0;
  }, { passive: true });

  var scroll = 0, scrollT = 0;
  window.addEventListener('scroll', function () {
    var max = document.body.scrollHeight - window.innerHeight;
    scrollT = max > 0 ? window.scrollY / max : 0;
  }, { passive: true });

  var pulse = 0, pulseX = 0, pulseY = 0;       /* 1 → 0 затухання */
  var gather = 0, gatherT = 0;                  /* кошик відкрито → 1 */

  /* точка кліку у системі шейдера (центр=0, y вгору, масштаб за висотою) */
  function toShader(clientX, clientY) {
    pulseX = (clientX - window.innerWidth / 2) / window.innerHeight;
    pulseY = -(clientY - window.innerHeight / 2) / window.innerHeight;
  }

  /* ── Хуки дій магазину (без правок shop.js) ────────── */

  /* 1. Додавання в кошик: хвиля + іскра в кошик */
  document.addEventListener('click', function (e) {
    var add = e.target.closest && e.target.closest('.product-card__add, .product-card__qty-btn[data-delta="1"]');
    if (!add) return;
    toShader(e.clientX || 0, e.clientY || 0);
    pulse = 1.0;
    if (!reduced) flySpark(add);
  }, true);

  /* 2. Кошик відкрито/закрито: нитки стікаються */
  var drawer = document.getElementById('cartDrawer');
  if (drawer) {
    new MutationObserver(function () {
      gatherT = drawer.classList.contains('is-open') ? 1 : 0;
    }).observe(drawer, { attributes: true, attributeFilter: ['class'] });
  }

  /* іскра: золота крапка летить від кнопки до іконки кошика */
  function flySpark(fromEl) {
    var cartBtn = document.getElementById('cartToggle');
    if (!cartBtn || !fromEl.getBoundingClientRect) return;
    var a = fromEl.getBoundingClientRect(), b = cartBtn.getBoundingClientRect();
    var sp = document.createElement('div');
    sp.className = 'atelier-spark';
    sp.style.left = (a.left + a.width / 2) + 'px';
    sp.style.top = (a.top + a.height / 2) + 'px';
    document.body.appendChild(sp);
    var dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    var dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    sp.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: 'translate(' + dx * 0.5 + 'px,' + (dy * 0.5 - 60) + 'px) scale(1.4)', opacity: 1, offset: 0.55 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(0.3)', opacity: 0.2 }
    ], { duration: 650, easing: 'cubic-bezier(.4,0,.6,1)' }).onfinish = function () {
      sp.remove();
      cartBtn.classList.add('atelier-cart-pop');
      setTimeout(function () { cartBtn.classList.remove('atelier-cart-pop'); }, 350);
    };
  }

  /* ── Reveal: плавна поява секцій (як на сайті) ─────── */
  var revealEls = document.querySelectorAll('.shop-hero__title, .shop-hero__trust, .shop-reviews__card, .atelier-marquee');
  if ('IntersectionObserver' in window && !reduced) {
    revealEls.forEach(function (el, i) {
      el.classList.add('atelier-fade');
      el.style.transitionDelay = (i % 3) * 0.12 + 's';
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('atelier-in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* перша поява карток товарів — каскад (тільки початкове завантаження) */
  var grid = document.getElementById('productsGrid');
  if (grid && !reduced) {
    var did = false;
    var cascade = function () {
      if (did || !grid.children.length) return;
      did = true;
      Array.prototype.slice.call(grid.children, 0, 24).forEach(function (card, i) {
        card.style.opacity = '0';
        card.style.transform = 'translateY(26px)';
        card.style.transition = 'opacity .8s ease ' + (i % 8) * 0.07 + 's, transform .9s cubic-bezier(.16,1,.3,1) ' + (i % 8) * 0.07 + 's';
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          card.style.opacity = ''; card.style.transform = '';
        }); });
      });
    };
    new MutationObserver(cascade).observe(grid, { childList: true });
    cascade(); /* якщо каталог уже відрендерено до підключення */
  }

  /* ── Магнітна кнопка оформлення (десктоп) ──────────── */
  if (matchMedia('(pointer:fine)').matches && !reduced) {
    document.addEventListener('pointermove', function (e) {
      var m = e.target.closest && e.target.closest('.cart-drawer__checkout');
      if (!m) return;
      var r = m.getBoundingClientRect();
      m.style.transform = 'translate(' + (e.clientX - r.left - r.width / 2) * 0.18 + 'px,' + (e.clientY - r.top - r.height / 2) * 0.3 + 'px)';
    });
    document.addEventListener('pointerout', function (e) {
      var m = e.target.closest && e.target.closest('.cart-drawer__checkout');
      if (m) m.style.transform = '';
    });
  }

  /* ── Render loop ───────────────────────────────────── */
  if (gl) {
    var running = true, start = performance.now(), last = start;
    var frame = function (now) {
      if (!running) return;
      var dt = Math.min(now - last, 100); last = now;
      var k = 1 - Math.pow(0.94, dt / 16.7);
      mx += (tmx - mx) * k * 0.6; my += (tmy - my) * k * 0.6;
      scroll += (scrollT - scroll) * k;
      gather += (gatherT - gather) * k * 0.7;
      if (pulse > 0) pulse = Math.max(0, pulse - dt / 900);
      gl.uniform1f(U.uTime, (now - start) / 1000);
      gl.uniform2f(U.uMouse, mx, my);
      gl.uniform1f(U.uScroll, scroll);
      gl.uniform1f(U.uPulse, 1.0 - pulse); /* 0→1 хвиля назовні */
      gl.uniform1f(U.uGather, gather);
      gl.uniform2f(U.uPulseO, pulseX, pulseY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduced) requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { running = false; }
      else if (!reduced && !running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
    });
    requestAnimationFrame(frame);
  }
})();
