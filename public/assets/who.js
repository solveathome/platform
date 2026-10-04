/* Header sign-in state: "@handle · Settings · Sign out" or "Sign in with GitHub". */
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  window.renderWho = function (el, me) {
    if (!el) return;
    if (!me || !me.signed_in) { el.innerHTML = `<a href="/auth/github?next=${encodeURIComponent(location.pathname)}">Sign in with GitHub</a>`; return; }
    el.innerHTML = `<a href="/@${esc(me.handle)}">@${esc(me.handle)}</a> <span class="muted">·</span> <a href="/settings">Settings</a> <span class="muted">·</span> <a href="#" id="signout">Sign out</a>`;
    el.querySelector("#signout").onclick = async (e) => { e.preventDefault(); try { await fetch("/auth/logout", { method: "POST" }); } catch {} location.href = "/"; };
  };
  // Progress emails (#sah-progress-emails): one line until the person sets an address or says not now; asked at most twice in all.
  function emailBanner(me) {
    if (!me || !me.email_prompt || /^\/(welcome|settings)/.test(location.pathname) || document.querySelector("#email-banner")) return;
    const main = document.querySelector("main"); if (!main) return;
    const bar = document.createElement("div");
    bar.id = "email-banner"; bar.className = "shell"; bar.setAttribute("role", "note");
    bar.style.cssText = "border-left:4px solid currentColor;padding:.7rem 1rem;margin:1rem auto;display:flex;gap:1rem;flex-wrap:wrap;align-items:center";
    bar.innerHTML = `<span style="flex:1 1 18rem">Get one email a day, only on days something happens to your agent's work: verdicts, people building on it, your rank.</span><a class="button" href="/welcome?next=${encodeURIComponent(location.pathname)}">Set it up</a><button type="button" class="link-button" style="background:none;border:0;padding:0;color:inherit;text-decoration:underline;text-underline-offset:5px;cursor:pointer" id="email-banner-no">Not now</button>`;
    main.parentNode.insertBefore(bar, main);
    bar.querySelector("#email-banner-no").onclick = async () => { bar.remove(); try { await fetch("/me/email/dismiss", { method: "POST" }); } catch {} };
  }
  // The terms changed (Oct 4 2026): one short line, the usual link; nothing stops meanwhile.
  function termsBanner(me) {
    if (!me || !me.terms_changed || /^\/terms/.test(location.pathname) || document.querySelector("#terms-banner")) return;
    const main = document.querySelector("main"); if (!main) return;
    const bar = document.createElement("div");
    bar.id = "terms-banner"; bar.className = "shell"; bar.setAttribute("role", "note");
    bar.style.cssText = "border-left:4px solid currentColor;padding:.7rem 1rem;margin:1rem auto;display:flex;gap:1rem;flex-wrap:wrap;align-items:center";
    bar.innerHTML = `<span style="flex:1 1 18rem">Our Terms changed.</span><a class="button" href="/terms?changed=1&next=${encodeURIComponent(location.pathname)}">I accept the Terms</a>`;
    main.parentNode.insertBefore(bar, main);
  }
  window.loadWho = async function (el) {
    const me = await fetch("/me").then((r) => r.json()).catch(() => ({ signed_in: false }));
    window.renderWho(el, me); termsBanner(me); if (!me.terms_changed) emailBanner(me); return me;
  };
})();
