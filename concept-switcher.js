/* Concept switcher — floating panel to jump between the 10 design concepts.
   Selection persists in localStorage; demo.html redirects to it (default v2). */
(function () {
  var CONCEPTS = [
    { file: 'concept-3d.html',     n: 'v1',  name: 'Golden Silk', c: '#d4af37', bg: '#0a0a0c' },
    { file: 'concept-3d-v2.html',  n: 'v2',  name: 'Atelier',     c: '#e8c87a', bg: '#0b0b10' },
    { file: 'concept-3d-v3.html',  n: 'v3',  name: 'Porcelaine',  c: '#b8869a', bg: '#f5f1ec' },
    { file: 'concept-3d-v4.html',  n: 'v4',  name: 'Noir',        c: '#e32213', bg: '#060606' },
    { file: 'concept-3d-v5.html',  n: 'v5',  name: 'Mercure',     c: '#7ef0c2', bg: '#04130d' },
    { file: 'concept-3d-v6.html',  n: 'v6',  name: 'Soleil',      c: '#ff9d5c', bg: '#1a0f08' },
    { file: 'concept-3d-v7.html',  n: 'v7',  name: 'Aurora',      c: '#8be9fd', bg: '#050810' },
    { file: 'concept-3d-v8.html',  n: 'v8',  name: 'Collage',     c: '#e85d3a', bg: '#f2ead8' },
    { file: 'concept-3d-v9.html',  n: 'v9',  name: 'Chrome',      c: '#c8d4e8', bg: '#0d0d14' },
    { file: 'concept-3d-v10.html', n: 'v10', name: 'Sumi',        c: '#1a1a1a', bg: '#faf8f4' }
  ];
  var KEY = 'svs-concept-choice';
  var current = (location.pathname.split('/').pop() || 'concept-3d-v2.html');

  // Remember the page being viewed so demo.html follows the visitor
  try { localStorage.setItem(KEY, current); } catch (e) {}

  var css = [
    '#svs-sw-btn{position:fixed;right:16px;bottom:16px;z-index:99999;width:48px;height:48px;border-radius:50%;',
    'border:1px solid rgba(255,255,255,.25);background:rgba(20,20,25,.72);backdrop-filter:blur(12px);',
    '-webkit-backdrop-filter:blur(12px);cursor:pointer;display:flex;align-items:center;justify-content:center;',
    'transition:transform .25s ease,box-shadow .25s ease;box-shadow:0 4px 18px rgba(0,0,0,.35);padding:0}',
    '#svs-sw-btn:hover{transform:scale(1.08)}',
    '#svs-sw-btn svg{width:22px;height:22px;display:block}',
    '#svs-sw-panel{position:fixed;right:16px;bottom:74px;z-index:99999;width:228px;max-height:70vh;overflow-y:auto;',
    'border-radius:16px;border:1px solid rgba(255,255,255,.18);background:rgba(15,15,20,.88);',
    'backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);padding:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);',
    'opacity:0;pointer-events:none;transform:translateY(8px);transition:opacity .25s ease,transform .25s ease;',
    'font-family:Arial,sans-serif;-webkit-overflow-scrolling:touch}',
    '#svs-sw-panel.open{opacity:1;pointer-events:auto;transform:translateY(0)}',
    '#svs-sw-panel .sw-title{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,.45);',
    'padding:4px 8px 8px}',
    '.svs-sw-item{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;cursor:pointer;',
    'text-decoration:none;transition:background .2s ease}',
    '.svs-sw-item:hover{background:rgba(255,255,255,.08)}',
    '.svs-sw-item.active{background:rgba(255,255,255,.12)}',
    '.svs-sw-dot{width:26px;height:26px;border-radius:8px;flex:none;border:1px solid rgba(255,255,255,.2);position:relative;overflow:hidden}',
    '.svs-sw-dot i{position:absolute;left:0;top:0;width:100%;height:100%;display:block}',
    '.svs-sw-txt{display:flex;flex-direction:column;min-width:0}',
    '.svs-sw-txt b{font-size:12px;color:#fff;font-weight:600;line-height:1.2}',
    '.svs-sw-txt span{font-size:10px;color:rgba(255,255,255,.45);line-height:1.2}',
    '@media(max-width:480px){#svs-sw-panel{width:200px}}'
  ].join('');

  function init() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var btn = document.createElement('button');
    btn.id = 'svs-sw-btn';
    btn.setAttribute('aria-label', 'Выбор дизайна');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round">' +
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';

    var panel = document.createElement('div');
    panel.id = 'svs-sw-panel';
    var html = '<div class="sw-title">Варианты дизайна</div>';
    CONCEPTS.forEach(function (cp) {
      var active = cp.file === current ? ' active' : '';
      html += '<a class="svs-sw-item' + active + '" href="' + cp.file + '">' +
        '<span class="svs-sw-dot" style="background:' + cp.bg + '"><i style="background:linear-gradient(135deg,' +
        cp.c + ' 0%,transparent 65%);opacity:.85"></i></span>' +
        '<span class="svs-sw-txt"><b>' + cp.name + '</b><span>' + cp.n +
        (active ? ' · текущий' : '') + '</span></span></a>';
    });
    panel.innerHTML = html;

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      panel.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!panel.contains(e.target) && e.target !== btn) panel.classList.remove('open');
    });
    panel.addEventListener('click', function (e) {
      var a = e.target.closest('a.svs-sw-item');
      if (a) { try { localStorage.setItem(KEY, a.getAttribute('href')); } catch (err) {} }
    });

    document.body.appendChild(btn);
    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
