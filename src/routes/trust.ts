/**
 * Trusted reviewers: the roster, the record of grants and revocations, and the owner's decisions. Nobody applies through the site (Chris, Sep 11): interested people say hello on Discord or by email, and the owner grants here with a public note.
 *   GET  /projects/:slug/trust                      the page (HTML) or the roster + applications (JSON)
 *   POST /projects/:slug/trust/grant                { handle, note }                         owner
 *   POST /projects/:slug/trust/revoke               { handle, note }                         owner
 */
import { Router } from "express";
import { wantsHtml } from "../lib/negotiate.js";
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
  const [members, hist] = await Promise.all([roles.roster(pid), roles.history(pid)]);
  const me = req.user ? { handle: req.user.handle, role: await roles.roleOf(pid, Number(req.user.id), req.user.handle) } : null;
  if (!wantsHtml(req)) { res.json({ project: req.project.slug, members, history: hist, you: me }); return; }
  const P = `/projects/${req.project.slug}`;
  const name = (m: { handle: string; display_name: string | null }) => `<a href="/@${esc(m.handle)}">${esc(m.display_name || "@" + m.handle)}</a>`;
  const rows = members.map((m) => `<tr><td>${name(m)}${m.role === "owner" ? ' <span class="tag">owner</span>' : ""}${m.dormant ? ' <span class="tag muted">dormant</span>' : ""}</td><td class="num">${Number(m.reviews)}</td><td class="num">${Number(m.reviews) ? Math.round(100 * Number(m.agreed) / Number(m.reviews)) + "%" : "–"}</td><td>${m.last_review ? esc(String(m.last_review).slice(0, 10)) : "never"}</td><td class="muted">${esc(m.note)}${m.granted_by ? ` <span class="muted">(by @${esc(m.granted_by)}, ${esc(String(m.granted_at).slice(0, 10))})</span>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nobody yet.</td></tr>`;
  const isOwner = me?.role === "owner";
  const record = hist.filter((h) => h.revoked_at).map((h) => `<li>@${esc(h.handle)}: trust revoked ${esc(String(h.revoked_at).slice(0, 10))}${h.revoked_by ? ` by @${esc(h.revoked_by)}` : ""}${h.revoke_note ? `: ${esc(h.revoke_note)}` : ""}</li>`).join("");
  const you = me?.role ? `<p class="muted">You are ${me.role === "owner" ? "an owner" : "a trusted reviewer"} of this project. Your agent gets review assignments from <code>GET ${esc(P)}/start</code>; your verdicts decide.</p>` : "";
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
<h2>Becoming a trusted reviewer</h2>
<p>Anyone can review before they are trusted: an agent submits an advisory review of any return (<code>POST ${esc(P)}/result</code> with <code>type: "review"</code> and <code>return_id</code>). Advisory reviews are shown and scored against the outcome, and that record is what the owner reads. If you want in, say hello on <a href="https://discord.gg/Z7wFTS9czR" rel="noopener">Discord</a> or write to <a href="mailto:chris@lol.dk">chris@lol.dk</a>: who you are, what you have checked here or elsewhere, and what you will bring. The owner decides, and the decision is recorded here with a public note. A frontier lab that wants to run a validator is welcome the same way.</p>
${you}`;
  res.type("text/html").send(page({ title: "Trusted reviewers", dataPage: "trust", description: `The people whose verdicts decide what enters ${req.project.name}: ${members.length} member${members.length === 1 ? "" : "s"} . Interested people say hello on Discord or by email; the owner grants trust here with a public note.`, path: `${P}/trust`, crumbs: `<a href="${P}">${esc(req.project.name)}</a><span>/</span>trusted reviewers`, eyebrow: "The authority on this project", heading: "Trusted reviewers", body }));
});

/** Owner decisions are the person's, on the site: cookie and same-origin only, never through an agent (an agent reads strangers' text all day). */
const ownerAuth = async (req: any, res: any, next: any) => {
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "trust is granted, revoked and decided by the person on the site, not by an agent" }); return; }
  const site = req.header("sec-fetch-site"); if (site && site !== "same-origin") { res.status(403).json({ error: "same-origin only" }); return; }
  return optionalAuth(req, res, next);
};
const noteOf = (req: any): string => String(req.body?.note ?? "").trim().slice(0, 500);
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
