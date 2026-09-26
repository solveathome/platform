/**
 * The owners' log of announcements (#sah-discord-announcer, src/lib/announce.ts): what was posted, dropped, skipped or left out of a post.
 * Posts go out without approval (Chris, Sep 26 2026, #sah-discord-autopost); an owner may still suppress a row that has not gone out, and
 * approves only if the project turns `approval` back on.
 *   GET  /projects/:slug/announcements                  owner: the page (HTML) or the rows (JSON)
 *   POST /projects/:slug/announcements/:id/approve      owner, on the site
 *   POST /projects/:slug/announcements/:id/suppress     owner, on the site  { reason }
 * Decisions are the person's, on the site: cookie and same-origin only, never an agent's bearer token (as on the trust page).
 */
import { Router } from "express";
import { one, q } from "../db/index.js";
import { optionalAuth, cookieToken } from "../lib/auth.js";
import { wantsHtml } from "../lib/negotiate.js";
import { page, esc } from "../lib/page.js";
import * as roles from "../lib/roles.js";
import { announceConfig, announceEnabled, approve, buildPost, suppress, webhookUrl } from "../lib/announce.js";
import { readProjectConfig } from "../lib/projects.js";

export const announcements = Router({ mergeParams: true });

async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}
async function owner(req: any, res: any, next: any): Promise<void> {
  if (!req.user || !(await roles.isOwner(Number(req.project.id), Number(req.user.id), req.user.handle))) { res.status(403).json({ error: "owner only: sign in on the site as an owner of this project" }); return; }
  next();
}
const siteOnly = async (req: any, res: any, next: any) => {
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "announcements are approved by the person on the site, not by an agent" }); return; }
  const site = req.header("sec-fetch-site"); if (site && site !== "same-origin") { res.status(403).json({ error: "same-origin only" }); return; }
  return optionalAuth(req, res, next);
};

const ROWS = `SELECT a.*, u.handle AS finder, g.handle AS approved_by_handle, r.type, r.target, rr.id AS route_id, rr.title AS route_title, rv.announce_md
  FROM announcements a JOIN users u ON u.id = a.finder_user_id JOIN returns r ON r.id = a.return_id LEFT JOIN users g ON g.id = a.approved_by
  LEFT JOIN reviews rv ON rv.id = a.review_id LEFT JOIN research_routes rr ON rr.id = r.research_route_id
  WHERE a.problem_id = $1`;

announcements.get("/announcements", optionalAuth, project, owner, async (req: any, res) => {
  const pid = Number(req.project.id), slug = req.project.slug;
  const cfg = announceConfig(readProjectConfig(slug));
  const held = await q(`${ROWS} AND a.status = 'held' ORDER BY a.due_at, a.id`, [pid]);
  const done = await q(`${ROWS} AND a.status <> 'held' ORDER BY a.id DESC LIMIT 50`, [pid]);
  const state = { discord: cfg.discord, enabled: announceEnabled(), webhook: webhookUrl(cfg) ? "set" : "unset", webhook_env: cfg.webhook_env, hold_hours: cfg.hold_hours, approval: cfg.approval, max_per_day: cfg.max_per_day, route_cooldown_hours: cfg.route_cooldown_hours, burst_per_hour: cfg.burst_per_hour };
  if (!wantsHtml(req)) { res.json({ project: slug, config: state, held, recent: done }); return; }
  const P = `/projects/${slug}`;
  const base = (process.env.BASE_URL ?? "").replace(/\/$/, "");
  const preview = (a: any) => {
    const target = a.target?.kind === "return" && Number.isInteger(Number(a.target.ref)) ? Number(a.target.ref) : null;
    const p = a.payload?.embeds?.[0] ?? buildPost({ kind: a.kind, final_rung: a.final_rung, return_id: Number(a.return_id), type: a.type, handle: a.finder, slug, base, decided_at: a.decided_at, route: a.route_id ? { id: Number(a.route_id), title: a.route_title } : null, target_return_id: target, note: a.announce_md });
    return `<div class="card"><b>${esc(p.title)}</b><pre style="white-space:pre-wrap">${esc(p.description)}</pre></div>`;
  };
  const when = (t: any) => t ? esc(new Date(t).toISOString().slice(0, 16).replace("T", " ")) + " UTC" : "";
  const heldHtml = held.map((a: any) => `<article class="card" id="a${esc(a.id)}">
<p><a href="${P}/return/${esc(a.return_id)}">Return #${esc(a.return_id)}</a> · ${esc(a.kind)} · found by <a href="/@${esc(a.finder)}">@${esc(a.finder)}</a> · decided ${when(a.decided_at)} · hold until ${when(a.due_at)}${a.approved_at ? ` · <b>approved</b> by @${esc(a.approved_by_handle ?? "")}` : ""}</p>
${a.flag ? `<p><b>Left out of the post:</b> ${esc(a.flag)}</p>` : ""}
${preview(a)}
<p>${a.approved_at || !cfg.approval ? "" : `<button data-act="approve" data-id="${esc(a.id)}">Approve</button> `}<button data-act="suppress" data-id="${esc(a.id)}">Suppress</button></p></article>`).join("") || `<p class="muted">Nothing is held.</p>`;
  const doneHtml = done.map((a: any) => `<tr><td><a href="${P}/return/${esc(a.return_id)}">#${esc(a.return_id)}</a></td><td>${esc(a.kind)}</td><td>@${esc(a.finder)}</td><td>${esc(a.status)}</td><td>${when(a.sent_at ?? a.corrected_at ?? a.created_at)}</td><td>${esc([a.suppressed_reason ?? a.correction, a.flag ? `left out: ${a.flag}` : null].filter(Boolean).join("; "))}</td></tr>`).join("");
  const body = `
<p>A post goes out when a reviewer holding a role on this project accepts a finding and marks it worth announcing, the acceptance is trusted and final, and it is a proof, a refutation, an upheld challenge, a reproduced computation or a validated direction. It names one person: the return's author. It goes out ${cfg.hold_hours ? `${esc(cfg.hold_hours)} hours after the decision` : "on the next pass after the decision (once a minute)"}${cfg.approval ? ", once you approve it here" : ", with nobody approving it"}. The record is read again just before sending: a decision reversed before then drops the row. A validator's note or route title that overclaims is left out of the post and noted here; a post whose credit the ledger does not back is skipped. A later decision that changes the acceptance corrects a sent post.</p>
<p class="muted">Posting to Discord: ${cfg.discord ? "on" : "off"} for this project. Kill switch: ${announceEnabled() ? "not set" : "<b>set (ANNOUNCE_ENABLED=0): nothing is sent</b>"}. Webhook (${esc(cfg.webhook_env)}): ${webhookUrl(cfg) ? "set" : "<b>unset: nothing is sent</b>"}. At most ${esc(cfg.max_per_day)} posts a day and one per route per ${esc(cfg.route_cooldown_hours)} h; sending pauses when more than ${esc(cfg.burst_per_hour)} rows queue in an hour.</p>
<h2>Waiting to go out</h2>${heldHtml}
<h2>Recent</h2>${doneHtml ? `<div class="wrap"><table><thead><tr><th>Return</th><th>Kind</th><th>Finder</th><th>Status</th><th>When</th><th>Note</th></tr></thead><tbody>${doneHtml}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}
<script>
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  const reason = act === "suppress" ? prompt("Why suppress it? (kept on the record)") : "";
  if (reason === null) return;
  b.disabled = true;
  const r = await fetch(location.pathname.replace(/\\/$/, "") + "/" + id + "/" + act, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ reason }) });
  if (r.ok) location.reload(); else { b.disabled = false; alert((await r.json().catch(() => ({}))).error || r.status); }
});
</script>`;
  res.type("text/html").send(page({ title: "Announcements", dataPage: "announcements", robots: "noindex", path: `${P}/announcements`, crumbs: `<a href="${P}">${esc(req.project.name)}</a><span>/</span>announcements`, eyebrow: "Owners only", heading: "Announcements", body }));
});

announcements.post("/announcements/:id/approve", siteOnly, project, owner, async (req: any, res) => {
  const ok = await approve(Number(req.params.id), Number(req.project.id), Number(req.user.id));
  res.status(ok ? 200 : 409).json(ok ? { ok: true, id: Number(req.params.id), approved: true } : { error: "not a held announcement of this project" });
});
announcements.post("/announcements/:id/suppress", siteOnly, project, owner, async (req: any, res) => {
  const ok = await suppress(Number(req.params.id), Number(req.project.id), req.user.handle, String(req.body?.reason ?? "").trim());
  res.status(ok ? 200 : 409).json(ok ? { ok: true, id: Number(req.params.id), suppressed: true } : { error: "not a held announcement of this project" });
});
