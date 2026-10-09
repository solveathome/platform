/**
 * Record challenge pages and API (Oct 9 2026, the MD5 Research Challenge; src/lib/challenges.ts holds the rules). Mounted ahead of
 * the research project routes: on a project with a `challenge` block this router answers the project page, the track and record
 * pages, submissions and the export; on every other project it steps aside.
 *
 * Humans read, agents post: a submission needs the agent's token, a live session of this project and its model, like every write.
 */
import { Router } from "express";
import { q, one } from "../db/index.js";
import { bearer } from "../lib/auth.js";
import { wantsHtml } from "../lib/negotiate.js";
import { shareMeta } from "../lib/share.js";
import { notFoundPage } from "../lib/seo.js";
import { crediter } from "../lib/display-name.js";
import { assignmentMutation } from "../lib/assignments.js";
import { isListed, projectPartial, readProjectConfig } from "../lib/projects.js";
import { ChallengeError, challengeConfig, currentTarget, fmtValue, prefix, publicSubmission, submissionRow, submit, trackByLane, trackById, trackView, verify, metricOf,
  type ChallengeConfig, type ChallengeTrack, type TrackView, type Namespace, VERIFIER_VERSION, LIVE_SQL } from "../lib/challenges.js";
import { RFC1321_IMPLEMENTATION } from "../lib/md5.js";

export const challenges = Router({ mergeParams: true });
const OWNERS = () => new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const iso = (d: any) => d ? new Date(d).toISOString() : "";
const utc = (d: any) => d ? iso(d).slice(0, 16).replace("T", " ") + " UTC" : "";
const safeUrl = (u: string) => /^https:\/\//.test(u) ? u : "#";

/** Resolve a challenge project; anything else goes on to the research routes. */
async function challengeProject(req: any, _res: any, next: any): Promise<void> {
  const cfg = challengeConfig(String(req.params.slug ?? ""));
  if (!cfg) { next("router"); return; }
  const p = await one(`SELECT * FROM problems WHERE slug = $1`, [req.params.slug]);
  if (!p) { next("router"); return; }
  req.project = p; req.challenge = cfg; next();
}
challenges.use(challengeProject);

const sendError = (res: any, e: any) => {
  if (e instanceof ChallengeError) { res.status(e.status).json({ error: e.message, ...e.extra, ...(e.status === 429 ? { priority_reserved: false } : {}) }); return true; }
  return false;
};
const namespaceOf = (req: any): Namespace => req.query?.namespace === "demo" ? "demo" : "live";

// ---------------------------------------------------------------------------------------------------------------------------
// The step chart: verified platform history as a step line, the published target as a labelled reference outside it.

export function chartSvg(track: ChallengeTrack, view: TrackView, P: string, now = new Date()): string {
  const W = 480, H = 270, L = 44, R = 12, T = 22, B = 34, pw = W - L - R, ph = H - T - B;
  const target = view.target, steps = view.steps;
  const higher = track.better === "higher";
  const vals = [...steps.map((s) => s.value), ...(target ? [target.value] : [])];
  const top = higher ? Math.min(track.max ?? 32, Math.max(8, ...vals) + 2) : Math.ceil(Math.max(64, ...vals) * 1.15 / 16) * 16;
  const y = (v: number) => T + ph - (v / top) * ph;
  const t0 = steps.length ? new Date(steps[0].received_at).getTime() : now.getTime() - 86400e3;
  const t1 = Math.max(now.getTime(), t0 + 3600e3);
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * pw;
  const ticks = higher ? [0, Math.round(top / 2), top] : [0, Math.round(top / 2 / 16) * 16, top];
  const empty = higher ? "No verified submission yet" : "No verified pair yet";
  let path = "", dots = "";
  steps.forEach((s, i) => {
    const xs = x(new Date(s.received_at).getTime()), ys = y(s.value);
    const xn = i + 1 < steps.length ? x(new Date(steps[i + 1].received_at).getTime()) : x(t1);
    path += `${i ? `V${ys.toFixed(1)}` : `M${xs.toFixed(1)},${ys.toFixed(1)}`}H${xn.toFixed(1)}`;
    const label = `${fmtValue(track, s.value)} by @${s.handle}${s.model ? ` (${s.model})` : ""}, ${utc(s.received_at)}${s.known_result ? ", reproduction of a published result" : ""}`;
    dots += `<a href="${P}/submissions/${s.submission_id}" aria-label="${esc(label)}"><circle cx="${xs.toFixed(1)}" cy="${ys.toFixed(1)}" r="5" class="cc-dot"><title>${esc(label)}</title></circle></a>`;
  });
  const tline = target ? `<line x1="${L}" x2="${W - R}" y1="${y(target.value).toFixed(1)}" y2="${y(target.value).toFixed(1)}" class="cc-target"/><text x="${W - R}" y="${(y(target.value) - 6).toFixed(1)}" text-anchor="end" class="cc-tlabel">Best published: ${esc(fmtValue(track, target.value))}</text>` : "";
  const desc = steps.length ? `${steps.length} improvement(s); best ${fmtValue(track, view.best!.value)} by @${view.best!.handle}.` : `${empty}.`;
  return `<svg class="cc-chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="cc-t-${esc(track.lane)} cc-d-${esc(track.lane)}" preserveAspectRatio="xMidYMid meet">
<title id="cc-t-${esc(track.lane)}">${esc(track.name)}: verified platform submission history (${higher ? "higher is better" : "lower is better"})</title>
<desc id="cc-d-${esc(track.lane)}">${esc(desc)}${target ? ` Best published result verified by us: ${esc(fmtValue(track, target.value))}, ${esc(target.credit)}.` : ""}</desc>
${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="cc-grid"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="cc-axis">${v}</text>`).join("")}
<text x="${L}" y="${H - 12}" class="cc-axis">${esc(steps.length ? utc(t0).slice(0, 10) : "")}</text><text x="${W - R}" y="${H - 12}" text-anchor="end" class="cc-axis">now</text>
<text x="12" y="${T + ph / 2}" transform="rotate(-90 12 ${T + ph / 2})" text-anchor="middle" class="cc-axis">${esc(track.unit)}</text>
${tline}
${steps.length ? `<path d="${path}" class="cc-line"/>${dots}` : `<text x="${L + pw / 2}" y="${T + ph / 2}" text-anchor="middle" class="cc-empty">${esc(empty)}</text>`}
</svg>`;
}

function legend(track: ChallengeTrack, view: TrackView, P: string, name: (h: string) => string, max = 6): string {
  if (!view.steps.length) return `<p class="cc-note">${track.better === "lower" ? "No verified pair yet: only full collisions appear here, never partial matches." : "No verified submission yet. The first verified result starts the line."}</p>`;
  const rows = [...view.steps].reverse().slice(0, max);
  return `<ol class="cc-legend">${rows.map((s) => `<li><a href="${P}/submissions/${s.submission_id}"><b>${esc(fmtValue(track, s.value))}</b></a> ${name(s.handle)}${s.model ? ` <span class="cc-model">${esc(s.model)}</span>` : ""}${s.known_result ? ` <span class="cc-tag">reproduction</span>` : ""} <span class="cc-when">${esc(utc(s.received_at))}</span></li>`).join("")}</ol>${view.steps.length > max ? `<p class="cc-note"><a href="${P}/tracks/${track.lane}">All ${view.steps.length} improvements →</a></p>` : ""}`;
}

const STYLE = `<style>
.cc-grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:1.5rem;margin:0 0 2rem}
.cc-card{border-top:1px solid var(--line);padding-top:1rem;min-width:0}
.cc-card h2{font-size:1.1rem;margin:0 0 .25rem}.cc-card h2 a{text-decoration:underline;text-underline-offset:4px}
.cc-figures{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;font-size:.875rem;margin:.25rem 0 .5rem}.cc-figures b{font-family:var(--mono)}
.cc-chart{width:100%;height:auto;display:block}
.cc-grid{stroke:var(--line);stroke-width:1}.cc-axis{fill:var(--mut);font:13px var(--mono)}
.cc-line{fill:none;stroke:var(--brass,#d3ad3a);stroke-width:2.5}.cc-dot{fill:var(--brass,#d3ad3a);stroke:var(--bg);stroke-width:2}
.cc-target{stroke:var(--fg);stroke-width:1.5;stroke-dasharray:6 5}.cc-tlabel{fill:var(--fg);font:13px var(--mono)}
.cc-empty{fill:var(--mut);font:15px sans-serif}
.cc-legend{list-style:none;padding:0;margin:.5rem 0 0;font-size:.8125rem;line-height:1.6}.cc-legend li{overflow-wrap:anywhere}
.cc-legend a b{font-family:var(--mono)}.cc-model,.cc-when,.cc-tag{color:var(--mut);font-family:var(--mono);font-size:.75rem}.cc-tag{border:1px solid var(--line);border-radius:3px;padding:0 .3rem}
.cc-note{color:var(--mut);font-size:.8125rem;margin:.5rem 0 0}
.cc-beta{display:inline-block;border:1px solid var(--brass,#d3ad3a);color:var(--brass,#d3ad3a);border-radius:3px;padding:0 .5rem;font:.75rem/1.6 var(--mono);margin-bottom:1rem}
.cc-hex{font-family:var(--mono);font-size:.875rem;overflow-wrap:anywhere;word-break:break-all;user-select:all;background:var(--soft);padding:.5rem .75rem;border-radius:3px;display:block;line-height:1.7}
.cc-hex mark{background:var(--brass-soft,#3a3113);color:inherit;text-decoration:underline;text-underline-offset:3px}
.cc-dl{display:grid;grid-template-columns:minmax(8rem,max-content) minmax(0,1fr);gap:.4rem 1.25rem;font-size:.9375rem}.cc-dl dt{color:var(--mut)}.cc-dl dd{margin:0;min-width:0;overflow-wrap:anywhere}
.cc-table{width:100%;border-collapse:collapse;font-size:.875rem}.cc-table th,.cc-table td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}.cc-table td{overflow-wrap:anywhere}
.cc-wrap{overflow-x:auto;max-width:100%}
.cc-instr{font-family:var(--mono);font-size:.8125rem;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--soft);padding:1rem;border-radius:3px}
.cc-prose{max-width:46rem}main code{overflow-wrap:anywhere;word-break:break-word}.cc-prose p,.cc-prose li{line-height:1.75}
@media(max-width:640px){.cc-dl{grid-template-columns:minmax(0,1fr)}.cc-dl dt{margin-top:.5rem}}
</style>`;

function shell(o: { title: string; description: string; path: string; listed: boolean; crumbs: string; body: string; script?: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.title)} · solveathome</title>${shareMeta({ title: `${o.title} · solveathome`, description: o.description, path: o.path, robots: o.listed ? undefined : "noindex, nofollow" })}<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/assets/app.css?v=31">${STYLE}</head><body data-page="challenge"><header data-site-header></header><main class="shell" id="main"><nav class="breadcrumb" aria-label="Breadcrumb">${o.crumbs}</nav>${o.body}</main><footer data-site-footer></footer><script src="/assets/ui.js?v=21"></script>${o.script ?? ""}</body></html>`;
}

async function views(problemId: number, cfg: ChallengeConfig, ns: Namespace) {
  return Promise.all(cfg.tracks.map(async (t) => ({ track: t, view: await trackView(problemId, t, ns) })));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Pages.

/** GET /projects/:slug : the three charts first (Chris, Oct 9 2026), then the challenge, how to take part and the rules. */
challenges.get("/", async (req: any, res) => {
  const p = req.project, cfg: ChallengeConfig = req.challenge, P = `/projects/${p.slug}`, ns = namespaceOf(req);
  const all = await views(Number(p.id), cfg, ns);
  if (!wantsHtml(req)) { res.json(await overviewJson(p, cfg, ns)); return; }
  const name = await crediter();
  const listed = isListed(p.slug);
  const share = readProjectConfig(p.slug)?.share ?? {};
  const cards = all.map(({ track, view }) => `<section class="cc-card" aria-labelledby="h-${esc(track.lane)}">
<h2 id="h-${esc(track.lane)}"><a href="${P}/tracks/${esc(track.lane)}">${esc(track.name)}</a></h2>
<p class="cc-note">${esc(track.question)}</p>
<div class="cc-figures"><span>Platform best: <b>${esc(fmtValue(track, view.best?.value ?? null))}</b></span>${view.target ? `<span>Published: <b>${esc(fmtValue(track, view.target.value))}</b></span>` : ""}</div>
${chartSvg(track, view, P)}
${legend(track, view, P, name)}
${view.target ? `<p class="cc-note">Published target: ${esc(view.target.credit)}, <a href="${esc(safeUrl(view.target.source_url))}" rel="noopener nofollow">${esc(view.target.source_label)}</a> (checked ${esc(view.target.checked)}).</p>` : ""}
</section>`).join("");
  const intro = projectPartial(p.slug, "intro") ?? `<p class="lead">${esc(p.summary)}</p>`;
  const body = `<div class="page-heading"><div>${listed ? "" : `<span class="cc-beta">Hidden beta · not listed</span>`}<p class="eyebrow">Record challenge</p><h1>${esc(p.name)}</h1></div></div>
${ns === "demo" ? `<p class="cc-beta">Demo namespace: test submissions only, never on the records. <a href="${P}">Back to the records</a></p>` : ""}
<p class="cc-note">Verified platform submission history: each line steps when a new verified result beats the previous best; the dashed line is the best published result verified by us. Times are server receipt times in UTC.</p>
<div class="cc-grid3">${cards}</div>
<section class="panel cc-prose">${intro}</section>
<section class="panel" id="contribute"><h2>Run your agent on it</h2><div class="cc-prose"><p class="muted">Any model, any method, AI or plain code: your agent joins, takes one track at a time, searches on your machine within the limits you set, and sends its best candidates. The server recomputes every digest with two independent MD5 implementations and records the result in arrival order. Nothing is reviewed and nothing you send about the score is trusted.</p></div><div id="cc-join"><p class="muted">Loading…</p></div></section>
<section class="panel cc-prose"><h2>The rules</h2>${cfg.tracks.map((t) => `<h3><a href="${P}/tracks/${esc(t.lane)}">${esc(t.name)}</a> <code>${esc(t.id)}</code></h3>${mdLite(t.spec_md)}`).join("")}
<p>Inputs and the attribution you choose are public. A reproduced published result is recorded as a reproduction; its discoverer keeps the discovery credit. Verifier ${esc(VERIFIER_VERSION)}: OpenSSL MD5 and an independent RFC 1321 implementation (${esc(RFC1321_IMPLEMENTATION)}), plus the Python reference in the <a href="https://github.com/solveathome/platform/tree/main/projects/${esc(p.slug)}/verifier">project's verifier folder</a>.</p>
<p><a href="${P}/challenge">Specification and records (JSON)</a> · <a href="${P}/challenge/export.json">Export JSON</a> · <a href="${P}/challenge/export.csv">Export CSV</a></p></section>`;
  const script = `<script>(async()=>{const el=document.getElementById('cc-join');const S=${JSON.stringify(p.slug)};const esc=t=>String(t??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
try{const me=await fetch('/me',{headers:{accept:'application/json'}}).then(r=>r.json());
if(!me.signed_in){el.innerHTML='<p><a class="button primary" href="/auth/github?next='+encodeURIComponent(location.pathname)+'">Sign in with GitHub to get your agent instruction</a></p>';return;}
const t=await fetch('/me/token',{method:'POST',headers:{accept:'application/json'}}).then(r=>r.json()).catch(()=>null);
if(!t||!t.token){el.innerHTML='<p class="muted">Your agent token is not available here. Get it from <a href="/projects/'+esc(S)+'#contribute">any project page</a> or <a href="/settings">your settings</a>, and accept the <a href="/terms">terms</a> first.</p>';return;}
const url=location.origin+'/projects/'+S+'/start';
const lim=[['continuous','until you stop it'],['2h','for 2 hours'],['1task','for one assignment']];
const render=v=>{const q=v==='continuous'?'':'?time='+v;el.innerHTML='<p><label for="cc-time">Time</label> <select id="cc-time">'+lim.map(([k,l])=>'<option value="'+k+'"'+(k===v?' selected':'')+'>'+l+'</option>').join('')+'</select> <button class="button secondary" id="cc-copy" type="button">Copy</button></p><pre class="cc-instr" id="cc-text">'+esc('Join the '+${JSON.stringify(p.name)}+' on solveathome. GET '+url+q+' with headers "Authorization: Bearer '+t.token+'", "X-Model: <your exact model id>" and "X-Effort: <your thinking level as your harness records it, or unmeasured>". Follow the brief it returns, send its X-Session header on every later request, and stop when it says the session is over.')+'</pre><p class="cc-note">Your token is personal: paste this only into your own agent. You accepted the terms on the site; the agent asks you nothing else.</p>';
document.getElementById('cc-time').onchange=e=>render(e.target.value);document.getElementById('cc-copy').onclick=()=>navigator.clipboard&&navigator.clipboard.writeText(document.getElementById('cc-text').textContent);};render('continuous');
}catch{el.innerHTML='<p class="muted">Sign-in is unavailable right now. Refresh to try again.</p>';}})();</script>`;
  res.type("text/html").send(shell({ title: p.name, description: share.description ?? p.summary ?? "", path: P, listed, crumbs: `<a href="/">Overview</a><span aria-hidden="true">/</span><span>${esc(p.name)}</span>`, body, script }));
});

/** A small, safe renderer for the spec text in project.json: paragraphs, `code` and **bold**, escaped first. */
function mdLite(md: string): string {
  return md.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\n/g, " ")}</p>`).join("");
}

async function overviewJson(p: any, cfg: ChallengeConfig, ns: Namespace) {
  const all = await views(Number(p.id), cfg, ns);
  return { project: p.slug, name: p.name, listed: isListed(p.slug), namespace: ns, verifier_version: VERIFIER_VERSION, implementations: ["openssl", RFC1321_IMPLEMENTATION],
    tracks: all.map(({ track, view }) => ({ challenge_id: track.id, lane: track.lane, name: track.name, question: track.question, metric: track.metric, better: track.better, fields: track.fields, spec_md: track.spec_md,
      best: view.best, steps: view.steps, milestones: view.milestones, personal_bests: view.personal, submissions: view.submissions,
      published_target: currentTarget(track), target_history: track.targets })) };
}
challenges.get("/challenge", async (req: any, res) => { res.json(await overviewJson(req.project, req.challenge, namespaceOf(req))); });

/** GET /tracks/:lane : one track's chart, milestones, improvements, personal bests and target history. */
challenges.get("/tracks/:lane", async (req: any, res) => {
  const p = req.project, cfg: ChallengeConfig = req.challenge, P = `/projects/${p.slug}`, ns = namespaceOf(req);
  const track = trackByLane(cfg, String(req.params.lane)) ?? trackById(cfg, String(req.params.lane));
  if (!track) { res.status(404).type("text/html").send(notFoundPage("No such track.")); return; }
  const view = await trackView(Number(p.id), track, ns);
  if (!wantsHtml(req)) { res.json({ ...view, target_history: track.targets }); return; }
  const name = await crediter();
  const recent = await q(`SELECT s.id, s.score, s.total_bytes, s.a_bytes, s.b_bytes, s.received_at, s.model, s.duplicate_of, s.known_result, u.handle, NOT (${LIVE_SQL}) AS withdrawn
    FROM challenge_submissions s JOIN users u ON u.id = s.user_id WHERE s.problem_id = $1 AND s.challenge_id = $2 AND s.namespace = $3 ORDER BY s.id DESC LIMIT 50`, [p.id, track.id, ns]);
  const body = `<div class="page-heading"><div>${isListed(p.slug) ? "" : `<span class="cc-beta">Hidden beta · not listed</span>`}<p class="eyebrow">${esc(p.name)} · <code>${esc(track.id)}</code></p><h1>${esc(track.name)}</h1></div></div>
<div class="cc-prose">${mdLite(track.spec_md)}</div>
<section class="panel"><h2>Verified platform submission history</h2>
<div class="cc-figures"><span>Platform best: <b>${esc(fmtValue(track, view.best?.value ?? null))}</b></span><span>Submissions: <b>${view.submissions}</b></span>${view.target ? `<span>Best published result verified by us: <b>${esc(fmtValue(track, view.target.value))}</b></span>` : ""}</div>
${chartSvg(track, view, P)}${legend(track, view, P, name, 100)}</section>
${track.better === "higher" ? `<section class="panel"><h2>Site milestones</h2>${view.milestones.length ? `<div class="cc-wrap"><table class="cc-table"><thead><tr><th>Milestone</th><th>Reached by</th><th>Submission</th><th>Received</th></tr></thead><tbody>${view.milestones.map((m) => `<tr><td>${m.value}</td><td>${name(m.handle)}</td><td><a href="${P}/submissions/${m.submission_id}">#${m.submission_id}</a></td><td>${esc(utc(m.received_at))}</td></tr>`).join("")}</tbody></table></div>` : `<p class="cc-note">No milestone reached yet. A score of 0 is valid and earns none; a jump from 8 to 12 awards 9 through 12 to the same submission.</p>`}</section>` : ""}
<section class="panel"><h2>Personal bests</h2>${view.personal.length ? `<div class="cc-wrap"><table class="cc-table"><thead><tr><th>Contributor</th><th>Best</th><th>Submission</th><th>Submissions</th></tr></thead><tbody>${view.personal.map((r) => `<tr><td>${name(r.handle)}</td><td>${esc(fmtValue(track, r.best))}</td><td><a href="${P}/submissions/${r.submission_id}">#${r.submission_id}</a></td><td>${r.submissions}</td></tr>`).join("")}</tbody></table></div>` : `<p class="cc-note">Nobody yet.</p>`}</section>
<section class="panel"><h2>Published targets</h2><p class="cc-note">The best published results we located and verified ourselves: a reference line, never our progress, and not a claim of worldwide optimality. Every earlier target stays listed.</p><div class="cc-wrap"><table class="cc-table"><thead><tr><th>Value</th><th>Credit and source</th><th>Checked</th><th>Status</th></tr></thead><tbody>${[...track.targets].reverse().map((t) => `<tr><td>${esc(fmtValue(track, t.value))}</td><td>${esc(t.credit)}, <a href="${esc(safeUrl(t.source_url))}" rel="noopener nofollow">${esc(t.source_label)}</a>${t.detail ? `<br><span class="cc-note">${esc(t.detail)}</span>` : ""}</td><td>${esc(t.checked)}</td><td>${t.superseded_on ? `superseded ${esc(t.superseded_on)}${t.superseded_note ? `: ${esc(t.superseded_note)}` : ""}` : "current"}</td></tr>`).join("")}</tbody></table></div></section>
<section class="panel"><h2>Latest submissions</h2>${recent.length ? `<div class="cc-wrap"><table class="cc-table"><thead><tr><th>#</th><th>${track.better === "lower" ? "Bytes (a + b)" : "Score"}</th><th>By</th><th>Received</th><th></th></tr></thead><tbody>${recent.map((s: any) => `<tr><td><a href="${P}/submissions/${s.id}">#${s.id}</a></td><td>${track.better === "lower" ? `${s.total_bytes} (${s.a_bytes} + ${s.b_bytes})` : s.score}</td><td>${name(s.handle)}${s.model ? ` <span class="cc-model">${esc(s.model)}</span>` : ""}</td><td>${esc(utc(s.received_at))}</td><td>${[s.duplicate_of ? `duplicate of #${s.duplicate_of}` : "", s.known_result ? "reproduction" : "", s.withdrawn ? "withdrawn" : ""].filter(Boolean).join(", ")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="cc-note">None yet.</p>`}</section>`;
  res.type("text/html").send(shell({ title: `${track.name} · ${p.name}`, description: track.question, path: `${P}/tracks/${track.lane}`, listed: isListed(p.slug), crumbs: `<a href="/">Overview</a><span aria-hidden="true">/</span><a href="${P}">${esc(p.name)}</a><span aria-hidden="true">/</span><span>${esc(track.name)}</span>`, body }));
});

/** Highlight the first n characters with <mark>, and say it in words too: the match never depends on colour alone. */
const marked = (text: string, n: number) => `${n ? `<mark>${esc(text.slice(0, n))}</mark>` : ""}${esc(text.slice(n))}`;

/** GET /submissions/:id : the record page: exact inputs, digest, metric, receipt, submitter, attribution, verifier. */
challenges.get("/submissions/:id", async (req: any, res) => {
  const p = req.project, cfg: ChallengeConfig = req.challenge, P = `/projects/${p.slug}`;
  const id = Number(req.params.id);
  const s = Number.isInteger(id) && id > 0 ? await submissionRow(Number(p.id), id) : null;
  if (!s) { if (wantsHtml(req)) res.status(404).type("text/html").send(notFoundPage("No such submission.")); else res.status(404).json({ error: "no such submission" }); return; }
  if (!wantsHtml(req)) { res.json({ ...publicSubmission(s), corrections: s.corrections, events: s.events }); return; }
  const track = trackById(cfg, s.challenge_id)!;
  const name = await crediter();
  const higher = track.better === "higher";
  const inputs = s.inputs as Record<string, string>;
  let inputHtml = "";
  if (s.challenge_id === "md5-mirror-ascii32-v1") {
    inputHtml = `<dt>Candidate (32 ASCII characters, hashed as written)</dt><dd><code class="cc-hex">${marked(inputs.candidate, s.score)}</code></dd>`;
  } else if (inputs.input_hex !== undefined) {
    inputHtml = `<dt>Input (canonical hex, ${s.byte_length} bytes)</dt><dd><code class="cc-hex">${esc(inputs.input_hex) || "(empty: zero bytes)"}</code><a href="${P}/submissions/${s.id}/input.bin" download>Download the exact ${s.byte_length} bytes</a></dd>`;
  } else {
    inputHtml = `<dt>Input a (canonical hex, ${s.a_bytes} bytes)</dt><dd><code class="cc-hex">${esc(inputs.a_hex) || "(empty: zero bytes)"}</code><a href="${P}/submissions/${s.id}/a.bin" download>Download a (${s.a_bytes} bytes)</a></dd>
<dt>Input b (canonical hex, ${s.b_bytes} bytes)</dt><dd><code class="cc-hex">${esc(inputs.b_hex) || "(empty: zero bytes)"}</code><a href="${P}/submissions/${s.id}/b.bin" download>Download b (${s.b_bytes} bytes)</a></dd>`;
  }
  const matchWords = higher ? (s.challenge_id === "md5-mirror-ascii32-v1" ? `The first ${s.score} of 32 characters of the digest match the candidate (highlighted and underlined).${s.score === 32 ? " This is a complete fixed point." : " This is a partial match, not a fixed point."}` : `The digest starts with ${s.score} zero hex characters (highlighted and underlined).${s.score === 32 ? " This is an all-zero digest." : " This is a partial result, not an all-zero digest."}`) : `Both inputs have this full 128-bit digest: a complete collision of ${s.total_bytes} bytes in total.`;
  const checks = s.checks ?? {};
  const body = `<div class="page-heading"><div>${isListed(p.slug) ? "" : `<span class="cc-beta">Hidden beta · not listed</span>`}${s.namespace === "demo" ? `<span class="cc-beta">Demo data: not on the records</span>` : ""}<p class="eyebrow"><a href="${P}/tracks/${esc(track.lane)}">${esc(track.name)}</a> · <code>${esc(track.id)}</code></p><h1>Submission #${s.id}: ${esc(fmtValue(track, metricOf(track, s)))}</h1></div></div>
${s.withdrawn ? `<p class="cc-beta">Withdrawn by a correction: kept on the record, left out of records and charts.</p>` : ""}
<dl class="cc-dl">
<dt>Verified result</dt><dd>${higher ? `Score ${s.score} of 32` : `${s.total_bytes} bytes (${s.a_bytes} + ${s.b_bytes})`}. ${esc(matchWords)}</dd>
${inputHtml}
<dt>MD5 digest</dt><dd><code class="cc-hex">${higher ? marked(s.digest, s.score) : esc(s.digest)}</code></dd>
<dt>Receipt</dt><dd>#${s.id} in arrival order, received ${esc(utc(s.received_at))}, verified ${esc(utc(s.verified_at))} (<time datetime="${esc(iso(s.received_at))}">${esc(iso(s.received_at))}</time>)</dd>
<dt>Submitted by</dt><dd>${name(s.handle)}${s.model ? ` with <span class="cc-model">${esc(s.model)}</span> (the model the agent declared)` : ""}</dd>
<dt>Discovery attribution</dt><dd>${s.current_attribution ? esc(s.current_attribution) : s.known_result ? "a published result; its discoverer keeps the discovery credit" : "the submitter (no other attribution given)"}</dd>
${s.duplicate_of ? `<dt>Duplicate</dt><dd>The same input was first received as <a href="${P}/submissions/${s.duplicate_of}">#${s.duplicate_of}</a>, which holds the priority.</dd>` : ""}
${s.known_result ? `<dt>Known result</dt><dd>Reproduces a published result: recorded as a reproduction, not a new discovery.</dd>` : ""}
<dt>AI involvement (self-reported)</dt><dd>${s.ai_involvement ? esc(s.ai_involvement) : "not stated"}</dd>
<dt>Method (self-reported)</dt><dd>${s.method_md ? `<span style="white-space:pre-wrap">${esc(s.method_md)}</span>` : "not stated"}</dd>
<dt>Runtime and hardware (self-reported)</dt><dd>${s.runtime_s !== null ? `${esc(Number(s.runtime_s))} s` : "runtime not stated"}${s.hardware ? `; ${esc(s.hardware)}` : ""}</dd>
<dt>Verifier</dt><dd>${esc(s.verifier_version)}: ${Object.entries(checks).map(([k, v]) => `${esc(k)} ${esc((v as string[]).join(", "))}`).join("; ")}</dd>
${s.events.length ? `<dt>Earned on arrival</dt><dd>${s.events.map((e: any) => esc(e.kind === "milestone" ? `site milestone ${e.value}` : e.kind === "record" ? `site record ${fmtValue(track, e.value)}` : (e.note ?? `published target ${e.value}`))).join("; ")}</dd>` : ""}
${s.corrections.length ? `<dt>Corrections</dt><dd><ol>${s.corrections.map((c: any) => `<li>${esc(utc(c.created_at))}, ${esc(c.kind)}${c.attribution ? ` (attribution: ${esc(c.attribution)})` : ""}: ${esc(c.note)}${c.by ? ` (@${esc(c.by)})` : ""}</li>`).join("")}</ol></dd>` : ""}
</dl>
<p class="cc-note"><a href="${P}/submissions/${s.id}" type="application/json">This record as JSON</a> (send Accept: application/json) · <a href="${P}/tracks/${esc(track.lane)}">Back to the track</a></p>`;
  res.type("text/html").send(shell({ title: `Submission #${s.id} · ${track.name}`, description: `${track.name}: ${fmtValue(track, metricOf(track, s))}, verified ${utc(s.verified_at)}.`, path: `${P}/submissions/${s.id}`, listed: isListed(p.slug) && s.namespace === "live", crumbs: `<a href="/">Overview</a><span aria-hidden="true">/</span><a href="${P}">${esc(p.name)}</a><span aria-hidden="true">/</span><a href="${P}/tracks/${esc(track.lane)}">${esc(track.name)}</a><span aria-hidden="true">/</span><span>#${s.id}</span>`, body }));
});

/** The exact original bytes, as a download: never rendered, never sniffed. */
challenges.get("/submissions/:id/:file", async (req: any, res, next) => {
  const m = /^(input|a|b)\.bin$/.exec(String(req.params.file)); if (!m) { next(); return; }
  const s = await one(`SELECT id, inputs FROM challenge_submissions WHERE problem_id = $1 AND id = $2`, [req.project.id, Number(req.params.id) || 0]);
  const hex = s?.inputs?.[m[1] === "input" ? "input_hex" : `${m[1]}_hex`];
  if (typeof hex !== "string") { res.status(404).json({ error: "no such file" }); return; }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="submission-${s.id}-${m[1]}.bin"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(hex, "hex"));
});

// ---------------------------------------------------------------------------------------------------------------------------
// Export: every live submission and correction, in receipt order. Hidden projects are left out of the public dump; this is their export.

challenges.get("/challenge/export.:fmt", async (req: any, res) => {
  const rows = await q(`SELECT s.*, u.handle, NOT (${LIVE_SQL}) AS withdrawn FROM challenge_submissions s JOIN users u ON u.id = s.user_id WHERE s.problem_id = $1 AND s.namespace = 'live' ORDER BY s.id`, [req.project.id]);
  const corrections = await q(`SELECT c.id, c.submission_id, c.kind, c.note, c.attribution, u.handle AS by, c.created_at FROM challenge_corrections c JOIN challenge_submissions s ON s.id = c.submission_id LEFT JOIN users u ON u.id = c.user_id WHERE s.problem_id = $1 AND s.namespace = 'live' ORDER BY c.id`, [req.project.id]);
  const pub = rows.map((r: any) => { const fix = [...corrections].reverse().find((c: any) => c.submission_id === r.id && c.kind === "attribution"); return publicSubmission({ ...r, current_attribution: fix ? fix.attribution : r.attribution }); });
  if (req.params.fmt === "json") { res.json({ project: req.project.slug, exported_at: new Date().toISOString(), verifier_version: VERIFIER_VERSION, tracks: (req.challenge as ChallengeConfig).tracks.map((t) => ({ challenge_id: t.id, targets: t.targets })), submissions: pub, corrections }); return; }
  if (req.params.fmt !== "csv") { res.status(404).json({ error: "export.json or export.csv" }); return; }
  const cols = ["id", "challenge_id", "handle", "model", "received_at", "verified_at", "digest", "score", "byte_length", "a_bytes", "b_bytes", "total_bytes", "candidate", "input_hex", "a_hex", "b_hex", "duplicate_of", "known_result", "attribution", "ai_involvement", "runtime_s", "hardware", "verifier_version", "withdrawn"];
  // Spreadsheet formula injection: a cell starting with = + - @ is prefixed with a quote.
  const cell = (v: unknown) => { let t = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="${req.project.slug}-submissions.csv"`);
  res.send([cols.join(","), ...pub.map((r: any) => cols.map((c) => cell(c in r ? r[c] : r.inputs?.[c])).join(","))].join("\n") + "\n");
});

// ---------------------------------------------------------------------------------------------------------------------------
// Writes.

/** POST /challenge/preview : the verifier's answer with nothing stored. It reserves no priority and needs no token. */
challenges.post("/challenge/preview", (req: any, res) => {
  try {
    const b = req.body ?? {};
    const cfg: ChallengeConfig = req.challenge;
    const track = trackById(cfg, String(b.challenge_id ?? ""));
    if (!track) throw new ChallengeError(`challenge_id must be one of ${cfg.tracks.map((t) => t.id).join(", ")}`);
    const v = verify(track.id, b);
    res.json({ preview: true, priority_reserved: false, challenge_id: v.challenge_id, inputs: v.inputs, digest: v.digest, score: v.score, byte_length: v.byte_length, a_bytes: v.a_bytes, b_bytes: v.b_bytes, total_bytes: v.total_bytes, checks: v.checks, verifier_version: VERIFIER_VERSION });
  } catch (e) { if (!sendError(res, e)) throw e; }
});

/** POST /submissions : one candidate, from an agent's live session. The receipt is its place in line. */
challenges.post("/submissions", bearer, assignmentMutation(async (req: any, res: any) => {
  if (req.termsStale) { res.status(403).json({ error: req.termsStale }); return; }
  const s = req.agentSession;
  if (!s) { res.status(400).json({ error: `send X-Session: the session /projects/${req.project.slug}/start gave this agent. Submissions come from a running agent, under the terms its person accepted` }); return; }
  if (s.ended_at) { res.status(409).json({ error: "this session has ended; a new instruction from your person starts a new one", session: s.id }); return; }
  const held = await one(`SELECT id FROM jobs WHERE problem_id = $1 AND assigned_session = $2 AND status = 'assigned' ORDER BY assigned_at DESC LIMIT 1`, [req.project.id, s.id]);
  try {
    const out = await submit({ problemId: Number(req.project.id), slug: req.project.slug, userId: Number(req.user.id), sessionId: s.id, jobId: held ? Number(held.id) : null, model: req.model ?? s.model ?? null }, req.body);
    res.status(out.status).json(out.body);
  } catch (e) { if (!sendError(res, e)) throw e; }
}, { commitErrors: false }));

/** DELETE /submissions/:id : a demo submission, by its own submitter. Live receipts are never deleted; they are corrected. */
challenges.delete("/submissions/:id", bearer, async (req: any, res) => {
  const s = await one(`SELECT id, user_id, namespace FROM challenge_submissions WHERE problem_id = $1 AND id = $2`, [req.project.id, Number(req.params.id) || 0]);
  if (!s) { res.status(404).json({ error: "no such submission" }); return; }
  if (s.namespace !== "demo") { res.status(409).json({ error: "only demo submissions can be deleted; a live receipt stays on the record and is corrected instead" }); return; }
  if (Number(s.user_id) !== Number(req.user.id)) { res.status(403).json({ error: "only its submitter deletes a demo submission" }); return; }
  await q(`DELETE FROM challenge_corrections WHERE submission_id = $1`, [s.id]);
  await q(`DELETE FROM challenge_events WHERE submission_id = $1`, [s.id]);
  await q(`UPDATE challenge_submissions SET duplicate_of = NULL WHERE duplicate_of = $1`, [s.id]);
  await q(`DELETE FROM challenge_submissions WHERE id = $1`, [s.id]);
  res.json({ ok: true, deleted: Number(s.id) });
});

/** POST /challenge/finish : the report that closes a track assignment. */
challenges.post("/challenge/finish", bearer, assignmentMutation(async (req: any, res: any) => {
  const b = req.body ?? {};
  const j = await one(`SELECT * FROM jobs WHERE id = $1 AND problem_id = $2`, [Number(b.job_id) || 0, req.project.id]);
  if (!j || !String(j.origin_key ?? "").startsWith("challenge:")) { res.status(404).json({ error: "job_id must be the track assignment you hold" }); return; }
  if (Number(j.assigned_to) !== Number(req.user.id) || j.status !== "assigned") { res.status(409).json({ error: `job #${j.id} is ${j.status === "assigned" ? "held by someone else" : j.status}` }); return; }
  if (typeof b.report_md !== "string" || !b.report_md.trim()) { res.status(400).json({ error: "report_md is required: baseline, what you tried, measured results with submission ids, runtime and hardware, next idea" }); return; }
  if (b.report_md.length > 20000) { res.status(400).json({ error: "report_md is at most 20000 characters" }); return; }
  const r = await one(`INSERT INTO challenge_reports (problem_id, job_id, user_id, session_id, model, report_md) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [req.project.id, j.id, req.user.id, j.assigned_session, req.model ?? null, b.report_md]);
  await q(`UPDATE jobs SET status = 'returned' WHERE id = $1`, [j.id]);
  const n = await one(`SELECT count(*)::int AS n FROM challenge_submissions WHERE job_id = $1`, [j.id]);
  res.json({ ok: true, job_id: Number(j.id), report_id: Number(r.id), submissions_during_assignment: n.n, next: `GET /projects/${req.project.slug}/start with your X-Session` });
}, { completion: true }));

/** POST /challenge/corrections : an owner withdraws, restores or re-attributes a submission, with a dated note. Nothing is rewritten. */
challenges.post("/challenge/corrections", bearer, async (req: any, res) => {
  if (!OWNERS().has(String(req.user.handle).toLowerCase())) { res.status(403).json({ error: "owner only" }); return; }
  const b = req.body ?? {};
  if (!["void", "restore", "attribution"].includes(b.kind)) { res.status(400).json({ error: "kind must be void, restore or attribution" }); return; }
  if (typeof b.note !== "string" || !b.note.trim() || b.note.length > 2000) { res.status(400).json({ error: "note is required: why, with the evidence" }); return; }
  if (b.kind === "attribution" && (typeof b.attribution !== "string" || b.attribution.length > 200)) { res.status(400).json({ error: "attribution is required for an attribution correction (at most 200 characters)" }); return; }
  const s = await one(`SELECT id FROM challenge_submissions WHERE problem_id = $1 AND id = $2`, [req.project.id, Number(b.submission_id) || 0]);
  if (!s) { res.status(404).json({ error: "no such submission" }); return; }
  const c = await one(`INSERT INTO challenge_corrections (submission_id, kind, note, attribution, user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`, [s.id, b.kind, b.note, b.kind === "attribution" ? b.attribution : null, req.user.id]);
  res.json({ ok: true, correction_id: Number(c.id), created_at: c.created_at });
});
