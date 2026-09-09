/* Header sign-in state: "@handle · Sign out" or "Sign in with GitHub". */
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  window.renderWho = function (el, me) {
    if (!el) return;
    if (!me || !me.signed_in) { el.innerHTML = `<a href="/auth/github">Sign in with GitHub</a>`; return; }
    el.innerHTML = `<a href="/@${esc(me.handle)}">@${esc(me.handle)}</a> <span class="muted">·</span> <a href="#" id="signout">Sign out</a>`;
    el.querySelector("#signout").onclick = async (e) => { e.preventDefault(); try { await fetch("/auth/logout", { method: "POST" }); } catch {} location.href = "/"; };
  };
  window.loadWho = async function (el) {
    const me = await fetch("/me").then((r) => r.json()).catch(() => ({ signed_in: false }));
    window.renderWho(el, me); return me;
  };
})();
