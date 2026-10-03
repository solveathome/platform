/* The email step and the email section of /settings (#sah-progress-emails): the address and three choices. The server's answer counts. */
(function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const tz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } };
  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { "content-type": "application/json", accept: "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  }
  // opts: { from: "welcome" | "settings", next: "/path" }
  window.emailForm = async function (el, opts) {
    let st;
    try { st = await call("GET", "/me/email"); } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    const welcome = opts.from === "welcome";
    function render(said, bad) {
      const p = st.prefs, address = st.email || st.offered || "";
      const addrNote = st.email
        ? (st.status ? `<span class="problem">Mail to this address ${st.status === "bounced" ? "bounced" : "was marked as spam"}, so nothing is sent to it. Save an address to start again.</span>`
          : st.confirmed ? (st.source === "github_verified" ? "Verified by GitHub." : "Confirmed.") : `Waiting for you to click the link we sent. <button type="button" id="again" class="link-button">Send it again</button>`)
        : st.offered ? "From your GitHub account. Change it if you like." : "GitHub did not share a verified address. Type the one you read.";
      const radio = (v, label) => `<label class="email-choice"><input type="radio" name="updates" value="${v}" ${p.updates === v ? "checked" : ""}> ${label}</label>`;
      el.innerHTML = `<form id="email-form" novalidate>
        <label class="email-label" for="email-address">Email address</label>
        <div class="email-row"><input id="email-address" type="email" autocomplete="email" spellcheck="false" value="${esc(address)}" placeholder="you@example.com"></div>
        <p class="email-under muted">${addrNote}</p>
        <fieldset class="email-set"><legend>Your updates</legend>
          <p class="muted">At most one email a day, only on days something happened to your work: verdicts, work others built on, rank changes, questions for you, with your stats.</p>
          ${radio("daily", "Daily")} ${radio("weekly", "Weekly, on Mondays")} ${radio("off", "Off")}
        </fieldset>
        <fieldset class="email-set"><legend>From the project <span class="muted">(off unless you tick them)</span></legend>
          <label class="email-choice"><input type="checkbox" id="newsletter" ${p.newsletter ? "checked" : ""}> <span><b>Monthly letter:</b> what the swarm moved, which routes closed, what is hard right now</span></label>
          <label class="email-choice"><input type="checkbox" id="projects" ${p.projects ? "checked" : ""}> <span><b>New projects:</b> when a new open problem opens on solveathome</span></label>
        </fieldset>
        <p class="muted email-privacy">Whatever you pick, you never get more than one email a day from us. ${esc(st.privacy)}</p>
        <div class="email-actions"><button class="button" type="submit">${welcome ? "Save and continue" : "Save"}</button>
          ${welcome ? `<button type="button" id="later" class="link-button">Not now</button>` : st.email ? `<button type="button" id="delete" class="link-button">Delete my address</button> <a class="text-link" href="/me/email/preview" target="_blank" rel="noopener">Preview today's email</a>` : ""}</div>
        <p id="email-msg" class="${bad ? "problem" : "muted"}" aria-live="polite">${esc(said || "")}</p>
      </form>`;
      const f = el.querySelector("#email-form"), msg = el.querySelector("#email-msg");
      const fail = (e) => { msg.textContent = e.message; msg.className = "problem"; };
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const addr = el.querySelector("#email-address").value.trim();
        const body = { from: opts.from, tz: tz(), updates: f.querySelector("input[name=updates]:checked")?.value, newsletter: el.querySelector("#newsletter").checked, projects: el.querySelector("#projects").checked };
        if (addr && addr !== st.email) body.email = addr;
        if (!addr && !st.email) { fail(new Error("Type an address, or choose Not now.")); return; }
        try {
          st = await call("POST", "/me/email", body);
          const c = st.confirmation;
          const said = c ? (c.sent ? `Saved. We sent a confirmation link to ${st.email}; nothing is sent there until you click it.` : `Saved, but the confirmation email could not be sent (${c.reason}).`) : "Saved.";
          if (welcome) { if (!c || c.sent) { location.href = opts.next || "/"; return; } }
          render(said, c && !c.sent);
        } catch (e) { fail(e); }
      };
      const later = el.querySelector("#later");
      if (later) later.onclick = async () => { try { await call("POST", "/me/email/dismiss"); } catch {} location.href = opts.next || "/"; };
      const del = el.querySelector("#delete");
      if (del) del.onclick = async () => { if (!confirm("Delete your address? Nothing more will be sent to it.")) return; try { st = await call("DELETE", "/me/email"); render("Deleted. Nothing more is sent to it."); } catch (e) { fail(e); } };
      const again = el.querySelector("#again");
      if (again) again.onclick = async () => { try { const d = await call("POST", "/me/email/confirm-again"); render(d.confirmation.sent ? "Sent again." : `Could not send it: ${d.confirmation.reason}`, !d.confirmation.sent); } catch (e) { fail(e); } };
    }
    render();
  };
})();
