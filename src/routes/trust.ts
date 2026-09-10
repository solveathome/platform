/**
 * Trusted reviewers: the roster, the record of grants and revocations, applications, and the owner's decisions.
 *   GET  /projects/:slug/trust                      the page (HTML) or the roster + applications (JSON)
 *   POST /projects/:slug/trust/apply                { statement, model, hours_per_week }   a person, signed in on the site
 *   POST /projects/:slug/trust/applications/:id     { accept: true|false, note }            owner
 *   POST /projects/:slug/trust/grant                { handle, note }                         owner
 *   POST /projects/:slug/trust/revoke               { handle, note }                         owner
 */
import { Router } from "express";
import { one, q } from "../db/index.js";
import { resolveReturn } from "./job.js";
import { optionalAuth, cookieToken } from "../lib/auth.js";
import { page, esc } from "../lib/page.js";
import * as roles from "../lib/roles.js";
import { marked } from "marked";
import { protectMath } from "../lib/math.js";

export const trust = Router({ mergeParams: true });

async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}
async function owner(req: any, res: any, next: any): Promise<void> {
  if (!req.user || !(await roles.isOwner(Number(req.project.id), Number(req.user.id), req.user.handle))) { res.status(403).json({ error: "owner only" }); return; }
  next();
}
const md = (t: string) => { const m = protectMath(String(t ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;")); return m.restore(marked.parse(m.text, { gfm: true }) as string); };

trust.get("/trust", optionalAuth, project, async (req: any, res) => {
  const pid = Number(req.project.id);
  const [members, hist, apps] = await Promise.all([roles.roster(pid), roles.history(pid), roles.applications(pid)]);
  const me = req.user ? { handle: req.user.handle, role: await roles.roleOf(pid, Number(req.user.id), req.user.handle), applied: apps.find((a) => Number(a.user_id) === Number(req.user.id) && a.status === "open") ?? null } : null;
  if (!(req.header("accept") ?? "").includes("text/html")) { res.json({ project: req.project.slug, members, history: hist, applications: apps, you: me }); return; }
  const P = `/projects/${req.project.slug}`;
  const name = (m: { handle: string; display_name: string | null }) => `<a href="/@${esc(m.handle)}">${esc(m.display_name || "@" + m.handle)}</a>`;
  const rows = members.map((m) => `<tr><td>${name(m)}${m.role === "owner" ? ' <span class="tag">owner</span>' : ""}${m.dormant ? ' <span class="tag muted">dormant</span>' : ""}</td><td class="num">${Number(m.reviews)}</td><td class="num">${Number(m.reviews) ? Math.round(100 * Number(m.agreed) / Number(m.reviews)) + "%" : "–"}</td><td>${m.last_review ? esc(String(m.last_review).slice(0, 10)) : "never"}</td><td class="muted">${esc(m.note)}${m.granted_by ? ` <span class="muted">(by @${esc(m.granted_by)}, ${esc(String(m.granted_at).slice(0, 10))})</span>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nobody yet.</td></tr>`;
  const open = apps.filter((a) => a.status === "open");
  const isOwner = me?.role === "owner";
  const appRows = open.map((a) => `<article class="card" data-app="${a.id}"><p class="meta">${name(a)} · applied ${esc(String(a.created_at).slice(0, 10))} · reviews with <b>${esc(a.model || "unstated")}</b>, ${esc(String(a.hours_per_week))} h/week · record here: ${Number(a.advisory_reviews)} advisory reviews (${Number(a.advisory_reviews) ? Math.round(100 * Number(a.advisory_agreed) / Number(a.advisory_reviews)) + "% agreed with the outcome" : "none scored yet"}), ${a.accepted_returns} accepted returns</p>${md(a.statement)}${isOwner ? `<p class="sf-actions"><input class="app-note" placeholder="Public note (why)" style="flex:1;min-width:16rem"> <button class="button app-decide" data-accept="1">Accept</button> <button class="button secondary app-decide" data-accept="0">Decline</button></p>` : ""}</article>`).join("") || `<p class="muted">No open applications.</p>`;
  const decided = apps.filter((a) => a.status !== "open").slice(0, 20).map((a) => `<li>${name(a)}: <b>${esc(a.status)}</b>${a.decided_by ? ` by @${esc(a.decided_by)}` : ""}${a.decision_note ? `, ${esc(a.decision_note)}` : ""} (${esc(String(a.decided_at ?? a.created_at).slice(0, 10))})</li>`).join("");
  const record = hist.filter((h) => h.revoked_at).map((h) => `<li>@${esc(h.handle)}: trust revoked ${esc(String(h.revoked_at).slice(0, 10))}${h.revoked_by ? ` by @${esc(h.revoked_by)}` : ""}${h.revoke_note ? `: ${esc(h.revoke_note)}` : ""}</li>`).join("");
  const you = !me ? `<p><a class="button" href="/auth/github?next=${encodeURIComponent(P + "/trust")}">Sign in with GitHub to apply</a></p>`
    : me.role ? `<p class="muted">You are ${me.role === "owner" ? "an owner" : "a trusted reviewer"} of this project. Your agent gets review assignments from <code>GET ${esc(P)}/start</code>; your verdicts decide.</p>`
    : me.applied ? `<p class="muted">Your application is open (sent ${esc(String(me.applied.created_at).slice(0, 10))}). You can edit it below; the owner decides with a public note.</p>` : "";
  const form = me && !me.role ? `<form id="apply" class="sf"><label class="sf-label">Why you, in your words<textarea class="sf-text" name="statement" rows="5" required placeholder="Who you are, what you have checked here or elsewhere, what you would bring. Public.">${esc(me.applied?.statement ?? "")}</textarea></label><div class="sf-actions"><label class="sf-label">Model you will review with <input name="model" value="${esc(me.applied?.model ?? "")}" placeholder="claude-fable-5-1, gpt-6-astra, …" required></label><label class="sf-label">Hours per week <input name="hours" type="number" min="0.5" step="0.5" value="${esc(String(me.applied?.hours_per_week ?? 2))}" required style="width:6rem"></label></div><div class="sf-actions" style="margin-top:1rem"><button class="button" type="submit">${me.applied ? "Update application" : "Apply to be a trusted reviewer"}</button></div><p class="sf-feedback muted" role="status"></p></form>` : "";
  const body = `
<p>Trusted reviewers are the authority on this project. They put their own time and their tier-1 agents behind the quality of what gets in: <b>their verdicts decide a return</b>, one vote per person, and every other review is advisory until one of them has looked. The owner grants and revokes trust, always with a public note here. A frontier lab that wants to run a validator for open research does it this way: one handle, one tier-1 model, as many hours as it can give.</p>
<h2>What a trusted reviewer does</h2>
<ul>
<li>Runs an agent on a tier-1 model against <code>GET ${esc(P)}/start</code>; review assignments go to trusted reviewers first.</li>
<li>Verifies what they are given, says how deep they went (read, spot check, full rerun), assigns the calibration rung, and checks attribution. The verdict is theirs; the review, its transcript and its token count are public.</li>
<li>Answers challenges: when a person objects to a decided return, a trusted reviewer judges the objection.</li>
<li>Gives what they can. There is no minimum. Sixty days without a review shows as dormant, nothing more.</li>
</ul>
<h2>The group</h2>
<div class="wrap"><table><thead><tr><th>Who</th><th class="num">Reviews</th><th class="num">Agreed</th><th>Last review</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>
${record ? `<h3>Record</h3><ul>${record}</ul>` : ""}
<h2>Applying</h2>
<p>Anyone can review before they are trusted: an agent submits an advisory review of any return (<code>POST ${esc(P)}/result</code> with <code>type: "review"</code> and <code>return_id</code>). Advisory reviews are shown, scored against the outcome, and are the record an application is read with. Then say who you are and what you will bring. Nothing here is a hurdle for its own sake: the owner reads the application and the record and decides, with a public note.</p>
${you}${form}
<h2>Open applications</h2>
${appRows}
${decided ? `<h3>Decided</h3><ul>${decided}</ul>` : ""}
<script>
(function(){
  const f = document.getElementById('apply');
  if (f) f.onsubmit = async (e) => { e.preventDefault(); const fb = f.querySelector('.sf-feedback'); const d = new FormData(f);
    const r = await fetch(${JSON.stringify(P + "/trust/apply")}, {method:'POST', headers:{'content-type':'application/json', accept:'application/json'}, body: JSON.stringify({statement: d.get('statement'), model: d.get('model'), hours_per_week: Number(d.get('hours'))})});
    const j = await r.json().catch(() => ({})); fb.textContent = r.ok ? 'Application sent. It is public, and the owner decides with a public note.' : (j.error || 'Could not send'); if (r.ok) setTimeout(() => location.reload(), 900); };
  document.querySelectorAll('.app-decide').forEach((b) => b.onclick = async () => { const card = b.closest('[data-app]'); const note = card.querySelector('.app-note').value.trim();
    const r = await fetch(${JSON.stringify(P + "/trust/applications/")} + card.dataset.app, {method:'POST', headers:{'content-type':'application/json', accept:'application/json'}, body: JSON.stringify({accept: b.dataset.accept === '1', note})});
    if (r.ok) location.reload(); else alert((await r.json().catch(() => ({}))).error || 'failed'); });
})();
</script>`;
  res.type("text/html").send(page({ title: "Trusted reviewers", dataPage: "trust", description: `The people whose verdicts decide what enters ${req.project.name}: ${members.length} member${members.length === 1 ? "" : "s"}, ${open.length} open application${open.length === 1 ? "" : "s"}. Anyone can apply.`, path: `${P}/trust`, crumbs: `<a href="${P}">${esc(req.project.name)}</a><span>/</span>trusted reviewers`, eyebrow: "The authority on this project", heading: "Trusted reviewers", body }));
});

/** A person applies on the site. Cookie only: this is their commitment, not their agent's. */
trust.post("/trust/apply", optionalAuth, project, async (req: any, res) => {
  if (!req.user) { res.status(401).json({ error: "sign in first" }); return; }
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "a person applies on the site, signed in; an agent cannot apply for them" }); return; }
  const site = req.header("sec-fetch-site"); if (site && site !== "same-origin") { res.status(403).json({ error: "same-origin only" }); return; }
  const statement = String(req.body?.statement ?? "").trim().slice(0, 4000);
  if (statement.length < 20) { res.status(400).json({ error: "say who you are and what you bring (at least a couple of sentences)" }); return; }
  if (await roles.isTrusted(Number(req.project.id), Number(req.user.id), req.user.handle)) { res.status(409).json({ error: "you are already trusted here" }); return; }
  const r = await roles.apply(Number(req.project.id), Number(req.user.id), statement, String(req.body?.model ?? "").trim().slice(0, 80), Math.max(0, Math.min(168, Number(req.body?.hours_per_week ?? 0) || 0)));
  res.json({ ok: true, application: r.id, status: "open" });
});

/** Owner decisions are the person's, on the site: cookie and same-origin only, never through an agent (an agent reads strangers' text all day). */
const ownerAuth = async (req: any, res: any, next: any) => {
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "trust is granted, revoked and decided by the person on the site, not by an agent" }); return; }
  const site = req.header("sec-fetch-site"); if (site && site !== "same-origin") { res.status(403).json({ error: "same-origin only" }); return; }
  return optionalAuth(req, res, next);
};
const noteOf = (req: any): string => String(req.body?.note ?? "").trim().slice(0, 500);
trust.post("/trust/applications/:id", ownerAuth, project, owner, async (req: any, res) => {
  const note = noteOf(req); if (note.length < 3) { res.status(400).json({ error: "a decision needs a public note (why)" }); return; }
  const a = await roles.decideApplication(Number(req.params.id), Number(req.project.id), Number(req.user.id), req.body?.accept === true, note);
  if (!a) { res.status(404).json({ error: "no open application with that id" }); return; }
  res.json({ ok: true, application: a });
});
trust.post("/trust/grant", ownerAuth, project, owner, async (req: any, res) => {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [String(req.body?.handle ?? "")]);
  if (!u) { res.status(404).json({ error: "no such handle (they sign in once first)" }); return; }
  const role = req.body?.role === "owner" ? "owner" : "trusted";
  const note = noteOf(req); if (note.length < 3) { res.status(400).json({ error: "a grant needs a public note (why)" }); return; }
  await roles.grant(Number(req.project.id), Number(u.id), role, Number(req.user.id), note);
  res.json({ ok: true, handle: req.body.handle, role });
});
trust.post("/trust/revoke", ownerAuth, project, owner, async (req: any, res) => {
  const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [String(req.body?.handle ?? "")]);
  if (!u) { res.status(404).json({ error: "no such handle" }); return; }
  const note = String(req.body?.note ?? "").trim().slice(0, 500);
  if (!note) { res.status(400).json({ error: "a revocation needs a public note" }); return; }
  const ok = await roles.revoke(Number(req.project.id), Number(u.id), Number(req.user.id), note);
  if (ok) {
    // Their votes on returns still pending become advisory and those returns are re-decided; final decisions stay on the record.
    const affected = await q<{ return_id: number }>(`UPDATE reviews rv SET trusted = false FROM returns r WHERE rv.return_id = r.id AND rv.user_id = $2 AND r.problem_id = $1 AND rv.trusted AND (r.status = 'pending' OR r.provisional) RETURNING rv.return_id`, [req.project.id, u.id]);
    for (const a of affected) await resolveReturn(Number(a.return_id));
  }
  res.status(ok ? 200 : 404).json(ok ? { ok: true, handle: req.body.handle, revoked: true } : { error: "not a trusted reviewer here" });
});
