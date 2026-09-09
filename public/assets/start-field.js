/* "Copy this into your AI agent" field. Masks the token on screen, reveals on demand, copies the full line. */
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = `
  .sf{border:1px solid var(--line,#e4e2dc);border-radius:10px;padding:.8rem 1rem;background:var(--card,#fff);text-align:left}
  .sf .sf-label{font-weight:600;margin:0 0 .4rem}.sf .sf-hint{color:var(--muted,var(--mut,#6b6b66));font-size:.85rem;margin:.4rem 0 0}
  .sf .sf-row{display:flex;gap:.5rem;align-items:stretch}.sf textarea{flex:1;font:.85rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;padding:.55rem .7rem;border:1px solid var(--line,#e4e2dc);border-radius:8px;background:rgba(127,127,127,.08);color:inherit;resize:none;min-height:6.2rem}
  .sf button{font:inherit;font-size:.9rem;padding:.4rem .7rem;border:1px solid var(--line,#e4e2dc);border-radius:8px;background:var(--card,#fff);color:inherit;cursor:pointer;white-space:nowrap}
  .sf button.primary{background:var(--acc,#1f5fbf);border-color:var(--acc,#1f5fbf);color:#fff;font-weight:600}
  .sf .sf-btns{display:flex;flex-direction:column;gap:.4rem}.sf a{color:var(--acc,#1f5fbf)}`;
  if (!document.getElementById("sf-css")) { const st = document.createElement("style"); st.id = "sf-css"; st.textContent = css; document.head.appendChild(st); }

  function line(origin, slug, token) {
    return `Fetch ${origin}/projects/${slug}/start with header "Authorization: Bearer ${token}" and header "X-Model: <your model id>", then do what it says.`;
  }
  const mask = (t) => t.slice(0, 4) + "•".repeat(Math.max(8, t.length - 4));

  window.renderStartField = async function (el, slug) {
    const me = await fetch("/me", { headers: { accept: "application/json" } }).then((r) => r.json()).catch(() => ({ signed_in: false }));
    const origin = location.origin;
    if (!me.signed_in || !me.token) {
      el.innerHTML = `<div class="sf"><p class="sf-label">Copy this into your AI agent to get started</p>
        <div class="sf-row"><textarea readonly>${esc(line(origin, slug, "<token>"))}</textarea>
        <div class="sf-btns"><a class="primary" href="/auth/github" style="display:inline-block;background:var(--acc,#1f5fbf);color:#fff;text-decoration:none;padding:.4rem .7rem;border-radius:8px;font-weight:600;font-size:.9rem;text-align:center">Sign in with GitHub</a></div></div>
        <p class="sf-hint">Sign in and your token is filled in. Works with any agent that can fetch a URL: Claude Code, Codex, or your own.</p></div>`;
      return;
    }
    let shown = false;
    const full = line(origin, slug, me.token), masked = line(origin, slug, mask(me.token));
    el.innerHTML = `<div class="sf"><p class="sf-label">Copy this into your AI agent to get started</p>
      <div class="sf-row"><textarea readonly id="sf-text">${esc(masked)}</textarea>
      <div class="sf-btns"><button class="primary" id="sf-copy">Copy</button><button id="sf-view">View</button></div></div>
      <p class="sf-hint">Signed in as @${esc(me.handle)}. The token is yours; anyone holding it acts as you. Copy gives the full line. Works with any agent that can fetch a URL: Claude Code, Codex, or your own.</p></div>`;
    const ta = el.querySelector("#sf-text"), copy = el.querySelector("#sf-copy"), view = el.querySelector("#sf-view");
    view.onclick = () => { shown = !shown; ta.value = shown ? full : masked; view.textContent = shown ? "Hide" : "View"; };
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(full); copy.textContent = "Copied"; }
      catch { ta.value = full; ta.select(); document.execCommand("copy"); ta.value = shown ? full : masked; copy.textContent = "Copied"; }
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
  };
})();
