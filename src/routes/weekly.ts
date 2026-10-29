/**
 * The weekly progress pages and the summary job's calls (#sah-weekly-progress-build, src/lib/weekly.ts).
 *   GET  /projects/:slug/weekly                      the archive: every published week
 *   GET  /projects/:slug/weekly/:date                one week (its last day): the post, and the record its summary was made from
 *   POST /projects/:slug/weekly/:date/approve        owner, on the site: a held week goes out on the next pass
 *   GET  /projects/:slug/weekly-summary/compute      the compute signal: how many weeks wait for their summary (bearer)
 *   POST /projects/:slug/weekly-summary/lease        the summary job takes the oldest waiting week (bearer)
 *   POST /projects/:slug/weekly-summary/:id          its lines { lines: [...] }, checked here (bearer, X-Model)
 *   POST /projects/:slug/weekly-summary/:id/release  hands a leased week back (bearer)
 * A held or suppressed week is not shown to anyone but the owners. The job's token is WEEKLY_SUMMARY_TOKEN, a key of this service's own,
 * never a contributor's token: the job writes only the summary lines, and the server decides what is kept.
 */
import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { one, q } from "../db/index.js";
import { optionalAuth, cookieToken } from "../lib/auth.js";
import { wantsHtml } from "../lib/negotiate.js";
import { page, esc } from "../lib/page.js";
import * as roles from "../lib/roles.js";
import { creditHtml } from "../lib/display-name.js";
import { isListed } from "../lib/projects.js";
import { PUBLISHED_SQL, approveWeek, leaseSummary, releaseSummary, saveSummary, summaryWaiting, weekLabel, type SummaryLine } from "../lib/weekly.js";

export const weekly = Router({ mergeParams: true });

async function project(req: any, res: any, next: any): Promise<void> {
  const p = await one(`SELECT id, slug, name FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  req.project = p; next();
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: any) => new Date(d).toISOString().slice(0, 10);
const ROW = `SELECT d.*, to_char(d.week_start, 'YYYY-MM-DD') AS s, to_char(d.week_end, 'YYYY-MM-DD') AS e FROM weekly_digests d`;

/** The post's own markdown (bold, bullets, links) as HTML; everything else escaped. Template text and checked lines only. */
function postHtml(md: string, skipTitle: boolean): string {
  const inline = (s: string) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
  const out: string[] = []; let list = false;
  const lines = md.split("\n"); if (skipTitle) lines.shift();
  for (const raw of lines) {
    const l = raw.trimEnd();
    if (l.startsWith("Full week: ")) continue;   // the page links to itself; the archive link is at the bottom
    if (l.startsWith("- ")) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (!l) continue;
    const h = /^\*\*([^*]+)\*\*$/.exec(l); const h2 = /^\*\*([^*]+)\*\* \(([^)]+)\)$/.exec(l);
    if (h) out.push(`<h2>${esc(h[1])}</h2>`); else if (h2) out.push(`<h2>${esc(h2[1])} <span class="muted">(${esc(h2[2])})</span></h2>`); else out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

// Page-only rules (checked at 390, 820 and 1440 px): table cells keep their words whole, the return ids give way on a phone, links look like links.
const STYLE = `<style>
[data-page="weekly"] .document a{text-decoration:underline;text-underline-offset:2px}
[data-page="weekly"] .document td,[data-page="weekly"] .document th{overflow-wrap:normal;word-break:normal}
[data-page="weekly"] .document td.nw,[data-page="weekly"] .document th.nw{white-space:nowrap}
[data-page="weekly"] .document h3{font-size:1rem;margin-top:1.6em}
[data-page="weekly"] .weekly-doc{margin:0 0 1.2em}
[data-page="weekly"] .weekly-doc p{margin:0 0 .3em}
@media (max-width:600px){[data-page="weekly"] .document .ret{display:none}}
</style>`;

weekly.get("/weekly", project, async (req: any, res) => {
  const P = `/projects/${req.project.slug}`;
  const rows = await q<any>(`${ROW} WHERE d.problem_id = $1 AND ${PUBLISHED_SQL} ORDER BY d.week_start DESC LIMIT 520`, [req.project.id]);
  const list = rows.map((d) => ({ week_start: d.s, week_end: d.e, label: weekLabel(d.s, d.e), url: `${P}/weekly/${d.e}`, status: d.status, posted_at: d.posted_at, lines: (d.summary ?? []).length, corrected_at: d.corrected_at }));
  if (req.query.json || !wantsHtml(req)) { res.json({ project: req.project.slug, weeks: list }); return; }
  const body = `${STYLE}<p class="lead">One short post a week on where the research stands: the week's numbers, counted by the server, and two to four lines on what moved, each checked against that week's record. Weeks run Monday to Sunday, Copenhagen time; each is posted on the Monday after.</p>
${list.length ? `<ul class="weekly-list">${list.map((w) => `<li><a href="${esc(w.url)}">Week of ${esc(w.label)}</a>${w.corrected_at ? ' <span class="muted">corrected</span>' : ""}</li>`).join("")}</ul>` : `<p class="muted">No week has been published yet. The first one goes out on the Monday after its week.</p>`}`;
  res.type("text/html").send(page({ title: `Weekly progress · ${req.project.name}`, dataPage: "weekly", description: `Where the research on ${req.project.name} stands, week by week: the numbers and what moved.`, path: `${P}/weekly`, robots: isListed(req.project.slug) ? undefined : "noindex, nofollow", crumbs: `<a href="${P}">${esc(req.project.name)}</a><span>/</span>weekly`, eyebrow: "Week by week", heading: "Weekly progress", body }));
});

weekly.get("/weekly/:date", optionalAuth, project, async (req: any, res, next) => {
  if (!DATE.test(req.params.date)) { next(); return; }
  const P = `/projects/${req.project.slug}`;
  const d = await one<any>(`${ROW} WHERE d.problem_id = $1 AND d.week_end = $2::date`, [req.project.id, req.params.date]);
  const published = d ? !!(await one(`SELECT 1 FROM weekly_digests d WHERE d.id = $1 AND ${PUBLISHED_SQL}`, [d.id])) : false;
  const owner = !!req.user && (await roles.isOwner(Number(req.project.id), Number(req.user.id), req.user.handle));
  if (!d || (!published && !owner)) { res.status(404).json({ error: "no published week ends on that day", archive: `${P}/weekly` }); return; }
  const lines: SummaryLine[] = d.summary ?? [];
  if (req.query.json || !wantsHtml(req)) {
    res.json({ project: req.project.slug, week_start: d.s, week_end: d.e, status: d.status, published, text_md: d.text_md, numbers: d.numbers, summary: lines, summary_dropped: d.summary_dropped, summary_model: d.summary_model, record: d.record, corrections: d.corrections, posted_at: d.posted_at });
    return;
  }
  const r = d.record ?? { routes: [], documents: [], papers: [], findings_resolved: [] };
  const top = await q<any>(`SELECT handle, display_name FROM users WHERE handle = ANY($1::text[])`, [(d.numbers?.top ?? []).map((t: any) => t.handle)]);
  const who = new Map(top.map((u) => [u.handle, u]));
  const ownerBox = !published ? `<div class="card"><p><b>Not published.</b> Status: ${esc(d.status)}. ${d.status === "held" ? "This week waits for an owner's approval; nobody else sees this page, and nothing is posted or emailed until then." : ""}</p>${d.status === "held" ? `<form method="post" action="${P}/weekly/${esc(d.e)}/approve"><button type="submit">Approve and post</button></form>` : ""}</div>` : "";
  const rid = (id: number) => `<a href="${P}/return/${id}">#${id}</a>`;
  const routesHtml = r.routes.length ? `<table><thead><tr><th>Route</th><th class="nw">Now</th><th>This week</th><th class="ret">Returns</th></tr></thead><tbody>${r.routes.map((x: any) => `<tr><td><a href="${P}/research-routes/${x.id}">${x.id}</a> ${esc(x.title)}${x.new ? ' <span class="muted">new</span>' : ""}</td><td class="nw">${esc(x.state)}</td><td class="wk">${esc([...new Set(x.outcomes as string[])].join(", "))}</td><td class="ret">${x.return_ids.slice(0, 8).map(rid).join(" ")}${x.return_ids.length > 8 ? ` +${x.return_ids.length - 8}` : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No route moved.</p>`;
  const docsHtml = r.documents.length ? r.documents.map((x: any) => `<div class="weekly-doc"><p><b>${esc(x.path)}</b> version ${esc(x.version)}${x.return_id ? `, ${rid(x.return_id)}` : ""}${x.summary ? `: ${esc(x.summary)}` : ""}</p><details><summary>The diff</summary><pre class="diff">${esc(x.diff)}${x.diff_clipped ? "\n… (cut here; the whole diff is in the document's history)" : ""}</pre></details></div>`).join("") : `<p class="muted">No document changed.</p>`;
  const fixedHtml = r.findings_resolved.length ? `<ul>${r.findings_resolved.map((f: any) => `<li><b>${esc(f.path)}</b>${f.return_id ? `, fixed by ${rid(f.return_id)}` : ""}: ${esc(f.note)}</li>`).join("")}</ul>` : `<p class="muted">None.</p>`;
  const dropped = (d.summary_dropped ?? []) as Array<{ text: string; why: string }>;
  const corrections = (d.corrections ?? []) as Array<{ at: string; reason: string }>;
  const body = `${STYLE}${ownerBox}
<article class="weekly-post">${postHtml(d.text_md, true)}</article>
${top.length ? `<p class="muted">Top contributors by name: ${(d.numbers.top as any[]).map((t) => who.get(t.handle) ? creditHtml(who.get(t.handle)) : esc(t.handle)).join(" · ")}</p>` : ""}
${corrections.length ? `<h2>Corrections</h2><ul>${corrections.map((c) => `<li>${esc(day(c.at))}: ${esc(c.reason)}</li>`).join("")}</ul>` : ""}
<h2>How this was made</h2>
<ul>
<li><b>Numbers:</b> counted by the server from the records of ${esc(weekLabel(d.s, d.e))} (Monday to Sunday, Copenhagen time). Agents are sessions seen in the week; the top list leaves out the project's own account (${esc((d.numbers?.excluded_handles ?? []).join(", ") || "none")}), whose sessions still count in the totals.</li>
<li><b>What moved:</b> ${lines.length ? `${lines.length} line${lines.length === 1 ? "" : "s"} written by a model${d.summary_model ? ` (${esc(d.summary_model)})` : ""} from the record below and nothing else` : d.summary_status === "none" ? "no lines this week: the post went out with numbers only" : "not written yet"}. Every line must cite a route or return in the record, and every number in it must be in the record; ${dropped.length ? `${dropped.length} line${dropped.length === 1 ? " was" : "s were"} dropped by that check` : "none was dropped"}.</li>
</ul>
${dropped.length ? `<details><summary>Lines the check dropped</summary><ul>${dropped.map((x) => `<li>${esc(x.text)} <span class="muted">(${esc(x.why)})</span></li>`).join("")}</ul></details>` : ""}
<h2>The week's record</h2>
<h3>Routes that moved (${r.routes.length})</h3>
<div class="table-scroll">${routesHtml}</div>
<h3>Document revisions (${r.documents.length})</h3>
${docsHtml}
<h3>Findings resolved (${r.findings_resolved.length})</h3>
${fixedHtml}
<p><a href="${P}/weekly">All weeks</a></p>`;
  res.type("text/html").send(page({ title: `Week of ${weekLabel(d.s, d.e)} · ${req.project.name}`, dataPage: "weekly", description: d.text_md.split("\n").filter((l: string) => l.startsWith("- ")).slice(0, 2).join(" ").replace(/\*\*/g, "").slice(2, 300), path: `${P}/weekly/${d.e}`, robots: published && isListed(req.project.slug) ? undefined : "noindex, nofollow", crumbs: `<a href="${P}">${esc(req.project.name)}</a><span>/</span><a href="${P}/weekly">weekly</a><span>/</span>${esc(d.e)}`, eyebrow: "Weekly progress", heading: `Week of ${weekLabel(d.s, d.e)}`, body }));
});

// The owner's approval is the person's, on the site: cookie and same-origin, never an agent's bearer token (as on the announcements page).
const siteOnly = async (req: any, res: any, next: any) => {
  if ((req.header("authorization") ?? "").startsWith("Bearer ") || !cookieToken(req)) { res.status(403).json({ error: "a week is approved by the person on the site, not by an agent" }); return; }
  const site = req.header("sec-fetch-site"); if (site && site !== "same-origin") { res.status(403).json({ error: "same-origin only" }); return; }
  return optionalAuth(req, res, next);
};
weekly.post("/weekly/:date/approve", siteOnly, project, async (req: any, res) => {
  if (!req.user || !(await roles.isOwner(Number(req.project.id), Number(req.user.id), req.user.handle))) { res.status(403).json({ error: "owner only" }); return; }
  const d = DATE.test(req.params.date) ? await one<any>(`SELECT id FROM weekly_digests WHERE problem_id = $1 AND week_end = $2::date`, [req.project.id, req.params.date]) : null;
  if (!d) { res.status(404).json({ error: "no such week" }); return; }
  const ok = await approveWeek(Number(d.id), `@${req.user.handle} on the site`);
  if (wantsHtml(req)) { res.redirect(303, `/projects/${req.project.slug}/weekly/${req.params.date}`); return; }
  res.status(ok ? 200 : 409).json(ok ? { approved: true } : { error: "the week is not held" });
});

// ---------- the summary job (compute source sah-weekly) ----------

function jobAuth(req: any, res: any, next: any): void {
  const want = String(process.env.WEEKLY_SUMMARY_TOKEN ?? "");
  const got = String(req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (want.length < 32 || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) { res.status(401).json({ error: "the weekly summary job's token is required" }); return; }
  next();
}
weekly.get("/weekly-summary/compute", jobAuth, project, async (req: any, res) => {
  const n = await summaryWaiting(Number(req.project.id));
  res.json({ ready: n ? 1 : 0, urgency: n ? "normal" : "low", facts: { waiting: n } });
});
weekly.post("/weekly-summary/lease", jobAuth, project, async (req: any, res) => {
  const d = await leaseSummary(Number(req.project.id));
  if (!d) { res.json({ week: null, note: "No week waits for its summary. Stop." }); return; }
  res.json({ week: { id: Number(d.id), week_start: day(d.week_start), week_end: day(d.week_end) }, record_md: d.summary_input,
    return_format: { lines: "an array of 2 to 4 strings, one line each" },
    submit: `POST /projects/${req.project.slug}/weekly-summary/${d.id}`, release: `POST /projects/${req.project.slug}/weekly-summary/${d.id}/release` });
});
weekly.post("/weekly-summary/:id/release", jobAuth, project, async (req: any, res) => {
  res.json({ released: await releaseSummary(Number(req.project.id), Number(req.params.id)) });
});
weekly.post("/weekly-summary/:id", jobAuth, project, async (req: any, res) => {
  const model = String(req.header("x-model") ?? "").trim();
  if (!model) { res.status(400).json({ error: "send X-Model with your model id" }); return; }
  if (!/^\d+$/.test(req.params.id)) { res.status(404).json({ error: "no such week" }); return; }
  const out = await saveSummary(Number(req.project.id), Number(req.params.id), req.body?.lines, model);
  if ("error" in out) { res.status(409).json(out); return; }
  res.json({ kept: out.kept.map((l) => l.text), dropped: out.dropped, note: out.kept.length ? "Saved. Stop." : "No line passed the check; the week goes out with numbers only. Stop." });
});
