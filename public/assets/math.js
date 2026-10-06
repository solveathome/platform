/* Math rendering: KaTeX auto-render over the page, and over anything inserted later. */
(function () {
  var V = "0.16.11", B = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/" + V + "/";
  var css = document.createElement("link"); css.rel = "stylesheet"; css.href = B + "katex.min.css"; document.head.appendChild(css);
  var opts = { delimiters: [{left: "$$", right: "$$", display: true}, {left: "\\[", right: "\\]", display: true}, {left: "\\(", right: "\\)", display: false}, {left: "$", right: "$", display: false}],
               throwOnError: false, ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"], ignoredClasses: ["sf", "no-math"] };
  var ready = false, pending = [];
  // KaTeX breaks an inline formula only at relations and operators, so a long list of numbers is one unbreakable piece: a formula with a piece wider than its line scrolls in its own box (.katex-wide) instead of widening the page.
  // KaTeX pins an equation number to the right edge of its box; once the formula and its number no longer fit, the number follows the formula and scrolls with it instead of covering it.
  function fit(root) {
    (root || document.body).querySelectorAll(".katex-display").forEach(function (d) {
      var tag = d.querySelector(".katex-html > .tag"), w = 0;
      d.querySelectorAll(".katex-html > .base").forEach(function (b) { w += b.offsetWidth; });
      d.classList.toggle("katex-display-wide", !!tag && w + tag.offsetWidth + 16 > d.clientWidth);
    });
    (root || document.body).querySelectorAll(".katex").forEach(function (k) {
      if (k.closest(".katex-display")) return;
      var box = k.parentElement; while (box && box !== document.body && getComputedStyle(box).display.indexOf("inline") === 0) box = box.parentElement;
      var room = box ? box.clientWidth : 0, wide = false;
      k.querySelectorAll(":scope > .katex-html > .base").forEach(function (b) { if (room && b.offsetWidth > room) wide = true; });
      k.classList.toggle("katex-wide", wide);
    });
  }
  window.renderMath = function (el) { if (!ready) { pending.push(el || document.body); return; } try { renderMathInElement(el || document.body, opts); fit(el); } catch (e) {} };
  var resized = null; window.addEventListener("resize", function () { clearTimeout(resized); resized = setTimeout(function () { fit(document.body); }, 150); });
  function load(src, cb) { var s = document.createElement("script"); s.src = src; s.onload = cb; document.head.appendChild(s); }
  load(B + "katex.min.js", function () { load(B + "contrib/auto-render.min.js", function () {
    ready = true; window.renderMath(document.body); pending.forEach(function (el) { window.renderMath(el); }); pending = [];
    if (document.fonts) document.fonts.ready.then(function () { fit(document.body); });   // widths change once the KaTeX fonts arrive
    var timer = null;
    new MutationObserver(function (muts) {
      clearTimeout(timer);
      timer = setTimeout(function () { muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && !n.closest(".katex")) window.renderMath(n); }); }); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
  }); });
})();
