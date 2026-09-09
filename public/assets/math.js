/* Math rendering: KaTeX auto-render over the page, and over anything inserted later. */
(function () {
  var V = "0.16.11", B = "https://cdnjs.cloudflare.com/ajax/libs/KaTeX/" + V + "/";
  var css = document.createElement("link"); css.rel = "stylesheet"; css.href = B + "katex.min.css"; document.head.appendChild(css);
  var opts = { delimiters: [{left: "$$", right: "$$", display: true}, {left: "\\[", right: "\\]", display: true}, {left: "\\(", right: "\\)", display: false}, {left: "$", right: "$", display: false}],
               throwOnError: false, ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"], ignoredClasses: ["sf", "no-math"] };
  var ready = false, pending = [];
  window.renderMath = function (el) { if (!ready) { pending.push(el || document.body); return; } try { renderMathInElement(el || document.body, opts); } catch (e) {} };
  function load(src, cb) { var s = document.createElement("script"); s.src = src; s.onload = cb; document.head.appendChild(s); }
  load(B + "katex.min.js", function () { load(B + "contrib/auto-render.min.js", function () {
    ready = true; window.renderMath(document.body); pending.forEach(function (el) { window.renderMath(el); }); pending = [];
    var timer = null;
    new MutationObserver(function (muts) {
      clearTimeout(timer);
      timer = setTimeout(function () { muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && !n.closest(".katex")) window.renderMath(n); }); }); }, 60);
    }).observe(document.body, { childList: true, subtree: true });
  }); });
})();
