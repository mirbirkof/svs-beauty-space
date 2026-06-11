/* ═══════════════════════════════════════════════════════
   SVS BEAUTY SPACE — 3D Motion Background
   WebGL silk waves · gold lighting · mouse parallax
   Zero dependencies. Auto-disables on reduced-motion / no WebGL.
   ═══════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var canvas = document.createElement('canvas');
  canvas.className = 'bg3d';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(canvas, document.body.firstChild);

  var gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) { canvas.remove(); return; }

  var VERT = [
    'attribute vec2 p;',
    'void main(){ gl_Position = vec4(p, 0.0, 1.0); }'
  ].join('\n');

  var FRAG = [
    'precision mediump float;',
    'uniform vec2 uRes;',
    'uniform float uTime;',
    'uniform vec2 uMouse;',
    '',
    'float hash(vec2 n){ return fract(sin(dot(n, vec2(12.9898,78.233))) * 43758.5453); }',
    'float noise(vec2 x){',
    '  vec2 i = floor(x); vec2 f = fract(x);',
    '  f = f*f*(3.0-2.0*f);',
    '  float a = hash(i), b = hash(i+vec2(1.,0.)), c = hash(i+vec2(0.,1.)), d = hash(i+vec2(1.,1.));',
    '  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);',
    '}',
    '',
    '/* silk heightfield — layered drifting waves */',
    'float silk(vec2 p, float t){',
    '  float h = 0.0;',
    '  h += sin(p.x*1.4 + t*0.32 + sin(p.y*1.1 + t*0.21)*1.6) * 0.55;',
    '  h += sin(p.y*1.9 - t*0.26 + sin(p.x*1.6 - t*0.16)*1.3) * 0.35;',
    '  h += sin((p.x+p.y)*2.6 + t*0.42) * 0.16;',
    '  h += noise(p*1.8 + vec2(t*0.05, -t*0.04)) * 0.22;',
    '  return h;',
    '}',
    '',
    'void main(){',
    '  vec2 uv = gl_FragCoord.xy / uRes;',
    '  vec2 p = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;',
    '  float t = uTime;',
    '',
    '  /* mouse parallax — gentle world shift */',
    '  p += uMouse * 0.12;',
    '',
    '  vec2 w = p * 1.7;',
    '  float e = 0.05;',
    '  float h  = silk(w, t);',
    '  float hx = silk(w + vec2(e,0.), t);',
    '  float hy = silk(w + vec2(0.,e), t);',
    '  vec3 N = normalize(vec3(h-hx, h-hy, e*2.2));',
    '',
    '  /* moving key light + fixed rim */',
    '  vec3 L1 = normalize(vec3(cos(t*0.13)*0.7, sin(t*0.11)*0.5, 0.62));',
    '  vec3 L2 = normalize(vec3(-0.5, 0.65, 0.45));',
    '  float dif = max(dot(N,L1), 0.0);',
    '  float spec = pow(max(dot(reflect(-L1, N), vec3(0.,0.,1.)), 0.0), 24.0);',
    '  float rim = pow(max(dot(N,L2), 0.0), 3.0);',
    '',
    '  /* palette: deep warm black -> gold */',
    '  vec3 base = vec3(0.039, 0.035, 0.031);',
    '  vec3 gold = vec3(0.788, 0.663, 0.431);',
    '  vec3 goldSoft = vec3(0.831, 0.733, 0.541);',
    '',
    '  vec3 col = base;',
    '  col += gold * dif * 0.055;',
    '  col += goldSoft * spec * 0.11;',
    '  col += gold * rim * 0.03;',
    '  col += gold * smoothstep(0.6, 1.3, h) * 0.03;',
    '',
    '  /* floating gold dust */',
    '  vec2 dp = p*7.0 + vec2(t*0.06, t*0.10);',
    '  float dust = step(0.985, hash(floor(dp)));',
    '  float tw = 0.5 + 0.5*sin(t*1.7 + hash(floor(dp))*40.0);',
    '  col += gold * dust * tw * smoothstep(0.9, 0.0, length(fract(dp)-0.5)) * 0.35;',
    '',
    '  /* vignette so content stays readable */',
    '  float vig = smoothstep(1.25, 0.35, length(p));',
    '  col *= mix(0.7, 1.0, vig);',
    '',
    '  /* fade strength toward page center-top where text sits */',
    '  float alpha = 0.85;',
    '  gl_FragColor = vec4(col, alpha);',
    '}'
  ].join('\n');

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.remove(); return; }

  var prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); return; }
  gl.useProgram(prog);

  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  var uRes = gl.getUniformLocation(prog, 'uRes');
  var uTime = gl.getUniformLocation(prog, 'uTime');
  var uMouse = gl.getUniformLocation(prog, 'uMouse');

  /* render at reduced internal resolution — silk is soft, nobody notices */
  var SCALE = Math.min(window.devicePixelRatio || 1, 1.25) * 0.7;
  function resize() {
    var w = Math.max(1, Math.floor(window.innerWidth * SCALE));
    var h = Math.max(1, Math.floor(window.innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
    }
  }
  resize();
  window.addEventListener('resize', resize);

  var mx = 0, my = 0, tmx = 0, tmy = 0;
  window.addEventListener('pointermove', function (e) {
    tmx = (e.clientX / window.innerWidth - 0.5) * 2.0;
    tmy = -(e.clientY / window.innerHeight - 0.5) * 2.0;
  }, { passive: true });

  var running = true;
  var start = performance.now();

  function frame(now) {
    if (!running) return;
    mx += (tmx - mx) * 0.04;
    my += (tmy - my) * 0.04;
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform2f(uMouse, mx, my);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduced) requestAnimationFrame(frame);
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { running = false; }
    else if (!reduced && !running) { running = true; requestAnimationFrame(frame); }
  });

  /* reduced motion → render a single static frame, no animation loop */
  requestAnimationFrame(frame);
})();
