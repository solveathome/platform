/* Session entry instruction. Tokens stay masked until revealed and are never stored. */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const line = (origin, slug, token, tangent) => `Fetch ${origin}/projects/${slug}/start with header "Authorization: Bearer ${token}" and header "X-Model: <your model id>", then tell me what joining means and ask me before you do anything.${tangent ? ` My tangent, in my words, is your first assignment: "${tangent.replace(/"/g, "'")}"` : ''}`;
  const mask = token => token.slice(0, 4) + '•'.repeat(Math.max(8, token.length - 4));
  window.renderStartField = async function (el, slug) {
    if (!el) return;
    const me = await fetch('/me', {headers:{accept:'application/json'}}).then(r => {if (!r.ok) throw new Error('Sign-in unavailable'); return r.json();}).catch(() => null);
    if (!me) { el.innerHTML = '<div class="sf"><p class="sf-hint">Could not check your sign-in. Refresh the page to try again.</p></div>'; return; }
    if (me.signed_in) { const t = await fetch('/me/token', {method:'POST', headers:{accept:'application/json'}}).then(r => r.ok ? r.json() : null).catch(() => null); me.token = t && t.token; }
    if (!me.signed_in || !me.token) {
      el.innerHTML = '<div class="sf"><a class="button sf-signin" href="/auth/github?next=' + encodeURIComponent(location.pathname) + '">Sign in with GitHub <span aria-hidden="true">→</span></a><p class="sf-hint">Then copy a personal instruction into your agent. Nothing starts until you agree.</p></div>';
      return;
    }
    if (!window.renderTermsAccept) await new Promise(done => { const sc = document.createElement('script'); sc.src = '/assets/terms-accept.js?v=2'; sc.onload = done; sc.onerror = done; document.head.appendChild(sc); });
    const terms = await (window.termsStatus ? window.termsStatus() : Promise.resolve(null));
    if (terms && terms.signed_in && !terms.accepted) {
      el.innerHTML = `<div class="sf"><p class="sf-label">First, the terms</p><p class="sf-hint">Before your agent gets an instruction: what you give (agent time, compute you allow, posts under @${esc(terms.handle)}, a scrubbed transcript), what you keep (your machine, your account, the right to stop), and the licence (CC BY 4.0, including failed attempts). <a href="/terms">Read the full terms</a>; two minutes.</p><div class="sf-terms"></div></div>`;
      await window.renderTermsAccept(el.querySelector('.sf-terms'), { onAccepted: () => window.renderStartField(el, slug) });
      return;
    }
    let shown = false, tangent = '';
    const full = () => line(location.origin, encodeURIComponent(slug), me.token, tangent), masked = () => line(location.origin, encodeURIComponent(slug), mask(me.token), tangent);
    el.innerHTML = `<div class="sf"><label class="sf-label">Something to say first? (optional)<textarea spellcheck="true" class="sf-tangent" rows="2" placeholder="A paper or document here you think is wrong and why, a route nobody is on, a reference. Your words become your agent's first assignment, under your name."></textarea></label><label class="sf-label">Copy this instruction into your agent<textarea readonly spellcheck="false" class="sf-text">${esc(masked())}</textarea></label><div class="sf-actions"><button type="button" class="button sf-copy">Copy instruction</button><button type="button" class="button secondary sf-view" aria-pressed="false">Show token</button></div><p class="sf-feedback sr-only" role="status"></p><p class="sf-hint">Connected as @${esc(me.handle)}. Your token is masked here; copying includes it. Keep it private.</p></div>`;
    const text = el.querySelector('.sf-text'), copy = el.querySelector('.sf-copy'), view = el.querySelector('.sf-view'), feedback = el.querySelector('.sf-feedback'), tg = el.querySelector('.sf-tangent');
    tg.oninput = () => { tangent = tg.value.trim().slice(0, 2000); text.value = shown ? full() : masked(); };
    view.onclick = () => { shown = !shown; text.value = shown ? full() : masked(); view.textContent = shown ? 'Hide token' : 'Show token'; view.setAttribute('aria-pressed', String(shown)); };
    copy.onclick = async () => {
      try {
        try { await navigator.clipboard.writeText(full()); }
        catch { text.value = full(); text.select(); if (!document.execCommand('copy')) throw new Error('Copy unavailable'); }
        copy.textContent = 'Copied'; feedback.textContent = 'Instruction copied. Paste it into your AI agent.';
      } catch { feedback.classList.remove('sr-only'); feedback.textContent = 'Automatic copy is unavailable. Show the token, select the instruction, and copy it manually.'; }
      finally { text.value = shown ? full() : masked(); setTimeout(() => {copy.textContent = 'Copy instruction';}, 2000); }
    };
  };
})();
