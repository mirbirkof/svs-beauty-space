/* ═══════════════════════════════════════════════════════
   SVS Beauty Space — Canvas Lotus v1
   Programmatic lotus with wide rounded petals
   Bloom controlled by scroll position
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // Gold palette
  var GOLD = 'rgba(201, 169, 110, ';
  var GOLD_LIGHT = 'rgba(225, 200, 145, ';
  var GOLD_DARK = 'rgba(160, 130, 80, ';

  function drawPetal(ctx, cx, cy, angle, openness, size, alpha) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Petal shape: wide rounded top, narrow base
    var h = size * (0.5 + openness * 0.5); // height grows as it opens
    var w = size * 0.32 * (0.3 + openness * 0.7); // width grows

    ctx.beginPath();
    ctx.moveTo(0, 0);
    // Left side curve
    ctx.bezierCurveTo(
      -w * 0.6, -h * 0.3,
      -w * 1.1, -h * 0.7,
      -w * 0.15, -h
    );
    // Top curve (wide rounded)
    ctx.bezierCurveTo(
      -w * 0.05, -h * 1.05,
      w * 0.05, -h * 1.05,
      w * 0.15, -h
    );
    // Right side curve
    ctx.bezierCurveTo(
      w * 1.1, -h * 0.7,
      w * 0.6, -h * 0.3,
      0, 0
    );
    ctx.closePath();

    // Gradient fill
    var grad = ctx.createLinearGradient(0, 0, 0, -h);
    grad.addColorStop(0, GOLD_DARK + (alpha * 0.9) + ')');
    grad.addColorStop(0.4, GOLD + alpha + ')');
    grad.addColorStop(0.85, GOLD_LIGHT + (alpha * 0.85) + ')');
    grad.addColorStop(1, GOLD_LIGHT + (alpha * 0.6) + ')');
    ctx.fillStyle = grad;
    ctx.fill();

    // Subtle edge line
    ctx.strokeStyle = GOLD_LIGHT + (alpha * 0.3) + ')';
    ctx.lineWidth = 0.5;
    ctx.stroke();

    // Center vein
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(0, -h * 0.85);
    ctx.strokeStyle = GOLD_DARK + (alpha * 0.25) + ')';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    ctx.restore();
  }

  function drawSeedPod(ctx, cx, cy, size, alpha) {
    var r = size * 0.09;
    ctx.beginPath();
    ctx.arc(cx, cy - size * 0.05, r, 0, Math.PI * 2);
    var grad = ctx.createRadialGradient(cx, cy - size * 0.05, 0, cx, cy - size * 0.05, r);
    grad.addColorStop(0, GOLD_LIGHT + (alpha * 0.9) + ')');
    grad.addColorStop(0.6, GOLD + (alpha * 0.7) + ')');
    grad.addColorStop(1, GOLD_DARK + (alpha * 0.5) + ')');
    ctx.fillStyle = grad;
    ctx.fill();

    // Seed dots
    for (var i = 0; i < 5; i++) {
      var a = (Math.PI * 2 / 5) * i - Math.PI / 2;
      var dr = r * 0.45;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * dr, cy - size * 0.05 + Math.sin(a) * dr, 1, 0, Math.PI * 2);
      ctx.fillStyle = GOLD_DARK + (alpha * 0.5) + ')';
      ctx.fill();
    }
  }

  function drawLotus(ctx, w, h, progress) {
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2;
    var cy = h * 0.62;
    var size = Math.min(w, h) * 0.42;

    // Glow behind
    if (progress > 0.05) {
      var glowR = size * (0.3 + progress * 0.7);
      var glow = ctx.createRadialGradient(cx, cy - size * 0.2, 0, cx, cy - size * 0.2, glowR);
      glow.addColorStop(0, 'rgba(201, 169, 110, ' + (progress * 0.15) + ')');
      glow.addColorStop(1, 'rgba(201, 169, 110, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy - size * 0.2, glowR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Eased progress for smoother animation
    var ep = progress < 0.5
      ? 2 * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 2) / 2;

    // Outer petals (5) — open widest
    var outerCount = 5;
    var outerOpen = Math.max(0, (ep - 0.15) / 0.85);
    for (var i = 0; i < outerCount; i++) {
      var baseAngle = ((i / outerCount) - 0.5) * Math.PI * 1.1;
      var petalAngle = baseAngle * (0.1 + outerOpen * 0.9);
      drawPetal(ctx, cx, cy, petalAngle, outerOpen, size * 0.95, 0.45 + outerOpen * 0.15);
    }

    // Middle petals (5) — medium spread
    var midCount = 5;
    var midOpen = Math.max(0, (ep - 0.08) / 0.92);
    for (var j = 0; j < midCount; j++) {
      var mBaseAngle = ((j / midCount) - 0.5) * Math.PI * 0.85;
      var mAngle = mBaseAngle * (0.1 + midOpen * 0.9);
      drawPetal(ctx, cx, cy, mAngle, midOpen, size * 0.82, 0.6 + midOpen * 0.2);
    }

    // Inner petals (3) — tight, open less
    var innerCount = 3;
    var innerOpen = Math.max(0, ep / 1.0);
    for (var k = 0; k < innerCount; k++) {
      var iBaseAngle = ((k / innerCount) - 0.5) * Math.PI * 0.5;
      var iAngle = iBaseAngle * (0.15 + innerOpen * 0.85);
      drawPetal(ctx, cx, cy, iAngle, innerOpen * 0.85, size * 0.7, 0.75 + innerOpen * 0.15);
    }

    // Center seed pod
    if (ep > 0.1) {
      drawSeedPod(ctx, cx, cy, size, Math.min(1, (ep - 0.1) / 0.5));
    }
  }

  // ── Public API ──
  window.SVSLotus = {
    init: function (canvasId, mode) {
      var canvas = document.getElementById(canvasId);
      if (!canvas) return null;

      // HiDPI — fallback to 130 if CSS hasn't applied yet
      var dpr = window.devicePixelRatio || 1;
      var w = canvas.offsetWidth || 130;
      var h = canvas.offsetHeight || 130;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      var ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      var state = { canvas: canvas, ctx: ctx, w: w, h: h, progress: -1 };

      if (mode === 'scroll') {
        // Gradual bloom: 0 at top → 1 at ~70% of page
        var ticking = false;
        function onScroll() {
          if (ticking) return;
          ticking = true;
          requestAnimationFrame(function () {
            var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            var p = Math.min(scrollY / (maxScroll * 0.65), 1);
            if (Math.abs(p - state.progress) > 0.002) {
              state.progress = p;
              drawLotus(ctx, w, h, p);
            }
            ticking = false;
          });
        }
        window.addEventListener('scroll', onScroll, { passive: true });
        // Initial draw
        onScroll();
      } else if (mode === 'full') {
        // Always fully open
        state.progress = 1;
        drawLotus(ctx, w, h, 1);
      }

      return state;
    },

    wiggle: function (canvasId) {
      var canvas = document.getElementById(canvasId);
      if (!canvas) return;
      canvas.style.animation = 'none';
      void canvas.offsetWidth;
      canvas.style.animation = 'lotusWiggle 0.8s ease';
      setTimeout(function () { canvas.style.animation = ''; }, 900);
    }
  };
})();
