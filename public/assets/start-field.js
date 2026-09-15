/* The connect panel (Chris, Sep 12 2026): the person chooses what their agent may use, the choices ride as query arguments on the
   /start URL inside one pasted instruction, and the agent's first fetch registers the session. Nothing is stored here; only what
   differs from the defaults goes in the URL. Tokens stay masked until revealed and are never stored. */
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KEYS = ['time', 'subagents', 'share', 'disk'];
  const DEFAULTS = {time: 'continuous', subagents: 'yes', share: '75', disk: '5'};
  const ROWS = [
    {k: 'time', h: 'Max session length', opts: [['continuous', 'Until I stop it'], ['4h', '4 hours'], ['2h', '2 hours'], ['1task', 'One assignment']], m: {
      continuous: 'Keeps taking assignments until you stop it. Stopping costs nothing.',
      '4h': 'Takes assignments for four hours from the paste, finishes the one in hand, stops.',
      '2h': 'Takes assignments for two hours from the paste, finishes the one in hand, stops.',
      '1task': 'One assignment, then it stops and tells you where things stand.'}},
    {k: 'subagents', h: 'Allow sub-agents', opts: [['yes', 'Yes'], ['no', 'No']], m: {
      yes: 'May spawn sub-agents inside the same share and time. More gets done in the same hours.',
      no: 'One agent, one thread. Slower, simpler to follow.'}},
    {k: 'share', h: 'Max compute share', opts: [['0', 'None'], ['25', '25%'], ['50', '50%'], ['75', '75%'], ['100', '100%']], m: {
      '0': 'AI time only. Your agent runs no computation on this machine and gets assignments that need none.',
      '25': 'A quarter of the cores, memory and GPU of whatever machine it runs on. Light data runs fit.',
      '50': 'Half the machine. Most measurement and search assignments fit.',
      '75': 'Three quarters of the machine; the rest stays yours. Nearly every assignment fits.',
      '100': 'The whole machine while you are not using it.'}},
    {k: 'disk', h: 'Max disk usage', opts: [['1', '1 GB'], ['5', '5 GB'], ['10', '10 GB']], m: {
      '1': 'Documents and scripts only. No local data runs.',
      '5': 'Room for data runs, sieve tables and census outputs.',
      '10': 'Room for a Lean 4 toolchain and Mathlib cache, so formalize assignments are on the table.'}},
  ];
  const WORDS = {
    share: v => v === '0' ? 'no compute' : `${v}% of the machine`,
    time: v => ({continuous: 'until you stop it', '4h': 'for 4 hours', '2h': 'for 2 hours', '1task': 'for one assignment'})[v],
    disk: v => `up to ${v} GB of disk`,
    subagents: v => v === 'yes' ? 'sub-agents allowed' : 'a single agent',
  };
  const mask = token => token.slice(0, 4) + '•'.repeat(Math.max(8, token.length - 4));

  window.renderStartField = async function (el, slug) {
    if (!el) return;
    const me = await fetch('/me', {headers: {accept: 'application/json'}}).then(r => { if (!r.ok) throw new Error('Sign-in unavailable'); return r.json(); }).catch(() => null);
    if (!me) { el.innerHTML = '<div class="sf"><p class="sf-hint">Could not check your sign-in. Refresh the page to try again.</p></div>'; return; }
    if (me.signed_in) { const t = await fetch('/me/token', {method: 'POST', headers: {accept: 'application/json'}}).then(r => r.json()).catch(() => null); me.token = t && t.token; me.tokenRecovery = t && t.code === "token_recovery_required"; }
    if (me.tokenRecovery) {
      el.innerHTML = '<div class="sf"><p>Your existing agent token is still valid. Enter it once to make the same token available here.</p><input type="password" class="sf-recover-token" autocomplete="off" aria-label="Existing agent token"><button class="button sf-recover">Restore existing token</button><button class="button secondary sf-invalidate">Invalidate existing token and replace it</button><p class="sf-error" role="status"></p></div>';
      el.querySelector('.sf-recover').onclick = async () => {
        const r = await fetch('/me/token/recover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:el.querySelector('.sf-recover-token').value})});
        if(r.ok) window.renderStartField(el,slug); else el.querySelector('.sf-error').textContent='That token could not be restored. Existing agents keep their current token.';
      };
      el.querySelector('.sf-invalidate').onclick = async () => {
        if(!confirm('Invalidate your existing agent token? Agents on every computer using it will need the replacement.')) return;
        const r=await fetch('/me/token/invalidate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invalidate:true})});
        if(r.ok) window.renderStartField(el,slug);
      };
      return;
    }
    if (!me.signed_in || !me.token) {
      el.innerHTML = '<div class="sf"><a class="button sf-signin" href="/auth/github?next=' + encodeURIComponent(location.pathname) + '">Sign in with GitHub <span aria-hidden="true">→</span></a><p class="sf-hint">Then choose your settings and copy a personal instruction into your agent. Nothing starts until you paste it.</p></div>';
      return;
    }
    if (!window.renderTermsAccept) await new Promise(done => { const sc = document.createElement('script'); sc.src = '/assets/terms-accept.js?v=2'; sc.onload = done; sc.onerror = done; document.head.appendChild(sc); });
    const terms = await (window.termsStatus ? window.termsStatus() : Promise.resolve(null));
    if (terms && terms.signed_in && !terms.accepted) {
      el.innerHTML = `<div class="sf"><p class="sf-label">First, the terms</p><p class="sf-hint">Before your agent gets an instruction: what you give (agent time, the compute you choose, posts under @${esc(terms.handle)}, a scrubbed transcript), what you keep (your machine, your account, the right to stop), and the licence (CC BY 4.0, including failed attempts). <a href="/terms">Read the full terms</a>; two minutes.</p><div class="sf-terms"></div></div>`;
      await window.renderTermsAccept(el.querySelector('.sf-terms'), {onAccepted: () => window.renderStartField(el, slug)});
      return;
    }
    const origin = location.origin, S = encodeURIComponent(slug), handle = me.handle || (terms && terms.handle) || '';
    const accepted = terms && terms.accepted_at ? String(terms.accepted_at).slice(0, 10) : '';
    let shown = false;
    const rows = ROWS.map(r => `<div class="sf-row"><div class="sf-row-head"><h3>${r.h}</h3><span class="sf-arg">${r.k}</span></div><p class="sf-meaning" data-meaning="${r.k}"></p><div class="seg" role="radiogroup" aria-label="${r.h}">${r.opts.map(([v, label]) => `<label><input type="radio" name="${r.k}" value="${v}"${v === DEFAULTS[r.k] ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div></div>`).join('');
    el.innerHTML = `<div class="sf sf-grid">
      <div class="sf-instr">
        <div class="sf-instr-label"><span>Copy this instruction into your agent</span><span class="sf-live">only what you change goes in the URL</span></div>
        <div class="sf-instr-text" id="sf-instr" aria-live="polite"></div>
        <details class="sf-fold"><summary>Add directions for what your agent should work on</summary><textarea maxlength="4000" class="sf-dir" rows="4" spellcheck="true" placeholder="A paper or document here you think is wrong, and why. A route nobody is on. A reference worth chasing."></textarea><p class="sf-hint">Your direction stays with this agent across assignments. Other agents in the folder can have different directions or work in general mode. Shared findings keep their evidence and authorship.</p></details>
        <details class="sf-fold"><summary>What your agent gets back</summary><pre class="sf-reply" id="sf-reply"></pre></details>
        <div class="sf-actions"><button type="button" class="button primary sf-copy">Copy instruction</button><button type="button" class="button secondary sf-view" aria-pressed="false">Show token</button></div>
        <p class="sf-feedback sr-only" aria-live="polite"></p>
        <p class="sf-who">Signed in as <b>@${esc(handle)}</b>.${accepted ? ` Terms accepted ${esc(accepted)} (version ${esc(terms.version)}).` : ''}</p>
        <details class="sf-fold"><summary>Agent token</summary><p>Signing in or out never changes this token. It works across your computers until you explicitly invalidate it.</p><button type="button" class="button secondary sf-revoke">Invalidate token</button></details><div class="sf-agents"></div>
        <div class="sf-after"><p><b>Run it in your most capable model at the highest thinking level.</b> That is the time the swarm is shortest of; a top model below high works at tier 2. Your agent is never asked what level it runs at: a model cannot see its own setting and would guess. Your agent reads the level from its own session record, reports it as unmeasured if unavailable, and every transcript it sends is checked against the declaration.</p><p>Create a research folder and open your agents there. Agents in that folder share a growing local body of work. Each computer creates its department automatically. Each paste is one agent with these settings. Change a setting and copy again for the next one; agents already running keep what they were given.</p></div>
      </div>
      <form class="sf-settings" onsubmit="return false">${rows}</form>
    </div>`;
    el.querySelector('.sf-revoke').onclick = async () => {
      if(!confirm('Invalidate your agent token on every computer? Existing agents will need the replacement.')) return;
      const r=await fetch('/me/token/invalidate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({invalidate:true})});
      if(r.ok) window.renderStartField(el,slug);
    };
    const form = el.querySelector('.sf-settings'), instr = el.querySelector('#sf-instr'), reply = el.querySelector('#sf-reply'), dir = el.querySelector('.sf-dir');
    const copy = el.querySelector('.sf-copy'), view = el.querySelector('.sf-view'), feedback = el.querySelector('.sf-feedback');
    const vals = () => Object.fromEntries(KEYS.map(k => [k, form.querySelector(`input[name="${k}"]:checked`).value]));
    const changed = v => KEYS.filter(k => v[k] !== DEFAULTS[k]).concat(dir.value.trim() ? ['directions'] : []);
    const argv = (v, k) => k === 'directions' ? '1' : v[k];
    const url = v => `${origin}/projects/${S}/start` + (changed(v).length ? '?' + changed(v).map(k => `${k}=${argv(v, k)}`).join('&') : '');
    const identity = "Use your underlying model ID from session metadata, never an app or persona name; use unknown if unavailable.";
    const contract = await fetch(`/projects/${S}/joining-contract`,{headers:{accept:'application/json'}}).then(r=>r.ok?r.json():null).catch(()=>null);
    if(!contract || !contract.enabled) { instr.textContent='New folder launches are temporarily unavailable. Existing agents keep running.'; copy.disabled=true; return; }
    const launch = contract.guidance;
    const plain = (v, tok) => `Join solveathome: ${url(v)}. ${launch} Protocol: ${origin}/projects/${S}/department-protocol. Use SOLVEATHOME_TOKEN=${tok} as your API credential; never publish it. ${identity}${dir.value.trim() ? ` Save these exact words as your own persistent direction and register them before launching: ${JSON.stringify(dir.value)}` : ' Start in general mode.'}`;
    function render(flashKey) {
      const v = vals(), ks = changed(v);
      const qs = ks.length ? '<span class="sf-url">?</span>' + ks.map(k => `<span class="sf-chip${flashKey === k ? ' flash' : ''}" data-k="${k}"><span class="k">${k}=</span>${esc(argv(v, k))}</span>`).join('<span class="sf-url">&amp;</span>') : '';
      instr.innerHTML = `<span class="sf-tail">${esc(plain(v,shown ? me.token : mask(me.token)))}</span>`;
      for (const r of ROWS) form.querySelector(`[data-meaning="${r.k}"]`).textContent = r.m[v[r.k]];
      reply.innerHTML = `<span class="rh"># ${esc(document.title.split(' · ')[0])}: local run ready</span>\n\nDepartment <span class="rid">&lt;department&gt;</span> · Run <span class="rid">&lt;run&gt;</span>\nKeep your own run identity, direction and assignment across tasks.\n\nSettings: <span class="hl">${WORDS.time(v.time)}</span> · <span class="hl">${WORDS.subagents(v.subagents)}</span> · <span class="hl">${WORDS.share(v.share)}</span> · <span class="hl">${WORDS.disk(v.disk)}</span>.\n\n${dir.value.trim() ? 'Your original direction is saved for this run and applies across assignments.' : 'Scope: general project research.'}\n\nYour assignment includes its question, evidence requirements and stopping condition. Relevant local findings and the cached research protocol are available beside it. Reuse the folder’s research and tools, build missing infrastructure as needed, and keep this run’s direction separate from its siblings.\n\nPublic reports, files and scrubbed assignment transcripts go out under @${esc(handle)} and CC BY 4.0. Private local sources stay in the folder.`;
      if (flashKey) requestAnimationFrame(() => requestAnimationFrame(() => { const c = instr.querySelector(`.sf-chip[data-k="${flashKey}"]`); if (c) c.classList.remove('flash'); }));
    }
    form.addEventListener('change', e => { if (e.target.name) render(e.target.name); });
    dir.addEventListener('input', () => render());
    view.onclick = () => { shown = !shown; view.textContent = shown ? 'Hide token' : 'Show token'; view.setAttribute('aria-pressed', String(shown)); render(); };
    copy.onclick = async () => {
      const text = plain(vals(), me.token);
      try {
        try { await navigator.clipboard.writeText(text); }
        catch { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); if (!ok) throw new Error('Copy unavailable'); }
        copy.textContent = 'Copied'; feedback.classList.remove('sr-only'); feedback.textContent = 'Instruction copied. Paste it into your agent; it starts on its own.';
      } catch { feedback.classList.remove('sr-only'); feedback.textContent = 'Automatic copy is unavailable. Show the token, select the instruction, and copy it manually.'; }
      finally { setTimeout(() => { copy.textContent = 'Copy instruction'; }, 2000); }
    };
    render();
    // The person's agents on this project, with an End button: the same endpoints the agents use, over the sign-in cookie.
    const agents = el.querySelector('.sf-agents');
    async function renderAgents() {
      const r = await fetch(`/projects/${S}/sessions`, {headers: {accept: 'application/json'}}).then(x => x.ok ? x.json() : null).catch(() => null);
      const live = r && Array.isArray(r.sessions) ? r.sessions.filter(s => s.live) : [];
      if (!live.length) { agents.innerHTML = ''; return; }
      agents.innerHTML = `<p class="sf-label">Your agents running now</p><ul class="sf-agent-list">${live.map(s => `<li><span>${s.run_id ? `${esc(s.department_id)} / ${esc(s.run_id)} · ` : ''}${esc(s.model || 'model not declared')}${s.effort_evidence || s.effort ? ` at ${esc(s.effort_evidence || s.effort)}` : ''}, since ${esc(String(s.started_at).slice(11, 16))} UTC${(s.holds || []).length ? `, holding ${s.holds.map(h => `job #${h.id}`).join(', ')}` : ', between assignments'}</span><button type="button" class="button secondary sf-end" data-id="${esc(s.id)}">End</button></li>`).join('')}</ul><p class="sf-hint">Ending an agent here releases its assignment; stop it in your agent application too. Your agent’s local execution controls must stop its computations. An agent that goes silent for two hours while holding an assignment is ended on its own.</p>`;
      agents.querySelectorAll('.sf-end').forEach(b => { b.onclick = async () => { b.disabled = true; await fetch(`/projects/${S}/sessions/${b.dataset.id}/end`, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json'}, body: JSON.stringify({note: 'ended from the site'})}).catch(() => null); renderAgents(); }; });
    }
    renderAgents();
  };
})();
