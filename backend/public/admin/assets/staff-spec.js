/* staff-spec.js — ОДНЕ правило для поля «Посада» співробітника (нотатка #170).
   Власник: «неверно написал професию, пришлось удалить…». Посада — вільний текст, тож
   описка («Манкюр») жила вічно і розводила людей по різних «професіях» у звітах.
   Тут: список підказок (вже вживані в салоні + базові) і перепит, коли введене схоже
   на відому посаду на 1–2 літери. Підключають і каркас адмінки (картка співробітника),
   і модуль «Команда» (додавання) — щоб правило не розійшлося між екранами. */
(function () {
  var BASE = ['Майстер манікюру', 'Майстер педикюру', 'Манікюр', 'Педикюр', 'Перукар', 'Барбер',
    'Косметолог', 'Лешмейкер', 'Бровист', 'Масажист', 'Візажист', 'Адміністратор'];
  function norm(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function list(masters) {
    var seen = new Map();
    BASE.concat((masters || []).map(function (m) { return m && m.specialty; })).forEach(function (v) {
      var t = norm(v); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    });
    return Array.from(seen.values()).sort(function (a, b) { return a.localeCompare(b, 'uk'); });
  }
  function lev(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    var d = []; for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  /* Відома посада, на яку введене схоже як описка, або null. «Відомі» — базові та ті,
     що вживають ≥2 людини: одинична описка не має «підтверджувати» сама себе. */
  function typo(v, masters) {
    var t = norm(v); if (t.length < 4) return null;
    var cnt = {};
    (masters || []).forEach(function (m) { var k = norm(m && m.specialty).toLowerCase(); if (k) cnt[k] = (cnt[k] || 0) + 1; });
    var known = list(masters).filter(function (x) { return BASE.indexOf(x) >= 0 || cnt[x.toLowerCase()] >= 2; });
    if (known.some(function (x) { return x.toLowerCase() === t.toLowerCase(); })) return null;
    var best = null, bd = 9;
    known.forEach(function (x) { var dd = lev(t, x); if (dd < bd) { bd = dd; best = x; } });
    return (bd > 0 && bd <= 2) ? best : null;
  }
  function confirmFix(v, masters) {
    var t = norm(v), fix = typo(t, masters);
    if (!fix) return t;
    return confirm('Посада «' + t + '» схожа на «' + fix + '».\n\nОК — записати «' + fix + '».\nСкасувати — лишити як ввели.') ? fix : t;
  }
  function fill(datalistId, masters) {
    var dl = document.getElementById(datalistId); if (!dl) return;
    dl.innerHTML = list(masters).map(function (v) { return '<option value="' + String(v).replace(/"/g, '&quot;') + '">'; }).join('');
  }
  window.StaffSpec = { list: list, typo: typo, confirmFix: confirmFix, fill: fill, norm: norm };
})();
