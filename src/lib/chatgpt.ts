/**
 * The ChatGPT plugin (POST /mcp): three read-only tools over what the site already serves anonymously, the projects, their
 * research routes, open questions, papers and accepted results. Nothing here takes a token, opens a session, creates an
 * assignment or writes a row: a ChatGPT user gets an open problem to work on in the conversation and the public record,
 * and taking part stays on the site with the person's own account and agent (the plugin rules forbid redirecting the
 * interaction, and the site's rule is that only consented agent sessions take work). Every link is tagged utm_source=chatgpt.
 */
import { q } from "../db/index.js";
import { questions, type Question } from "./questions.js";
import { listPapers } from "../routes/papers.js";
import { jobLabel, withoutKindPrefix } from "./research-format.js";
import { createPlugin, widgetHtml, type Args, type Plugin, type ToolContext, type ToolResult } from "./chatgpt-plugin/index.js";

export type ProjectRow = { id: number; slug: string; name: string; summary: string; status_md: string; featured: boolean; accepted: number; queued: number; active_agents: number };
export type RouteRow = { id: number; title: string; state: string; contribution_md: string; uncertainty_md: string; next_step: any; updated_at: string };
export type PaperRow = { slug: string; title: string; kind: string; status_label?: string; status: string; final_rung: string | null; summary: string; url: string };
export type ResultRow = { id: number; type: string; title: string; label: string; final_rung: string | null; created_at: string };

/** Where the tools read from: the database in the server, recorded public JSON in a check script. */
export type Source = {
  projects(): Promise<ProjectRow[]>;
  routes(p: ProjectRow): Promise<RouteRow[]>;
  questions(p: ProjectRow): Question[] | Promise<Question[]>;
  papers(p: ProjectRow): Promise<PaperRow[]>;
  accepted(p: ProjectRow, limit: number): Promise<ResultRow[]>;
};

// The same rows the public /projects, /research-routes, /questions and /papers answers carry, read in-process and held a minute.
const memo = new Map<string, { at: number; value: any }>();
async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await load(); memo.set(key, { at: Date.now(), value }); return value;
}
export const dbSource: Source = {
  projects: () => cached("projects", async () => (await q(`SELECT p.id, p.slug, p.name, p.summary, p.status_md, p.featured,
      (SELECT count(*) FROM returns r WHERE r.problem_id = p.id AND r.status = 'accepted' AND NOT r.provisional) AS accepted,
      (SELECT count(*) FROM jobs j WHERE j.problem_id = p.id AND j.status = 'queued') AS queued,
      (SELECT count(*) FROM sessions x WHERE x.problem_id = p.id AND x.last_seen > now() - interval '1 day') AS active_agents
    FROM problems p ORDER BY p.featured DESC, p.id`)).map((r: any) => ({ ...r, id: Number(r.id), accepted: Number(r.accepted), queued: Number(r.queued), active_agents: Number(r.active_agents) }))),
  routes: (p) => cached(`routes:${p.id}`, async () => (await q(`SELECT id, title, state, contribution_md, uncertainty_md, next_step, updated_at FROM research_routes WHERE problem_id = $1 ORDER BY updated_at DESC, id DESC`, [p.id])).map((r: any) => ({ ...r, id: Number(r.id) }))),
  questions: (p) => questions(p.slug),
  papers: (p) => cached(`papers:${p.id}`, async () => (await listPapers(p.id, p.slug)) as PaperRow[]),
  // Titled and labelled the way the profile pages title a return (src/routes/board.ts).
  accepted: (p, limit) => cached(`accepted:${p.id}:${limit}`, async () => (await q(`SELECT r.id, r.type, r.final_rung, r.created_at, j.title AS job_title, j.type AS job_type, j.research_stage, j.follow_up_of, left(r.report_md, 600) AS report_md
      FROM returns r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.problem_id = $1 AND r.status = 'accepted' AND NOT r.provisional ORDER BY r.created_at DESC LIMIT $2`, [p.id, limit])).map((r: any) => ({
      id: Number(r.id), type: r.type, final_rung: r.final_rung, created_at: r.created_at,
      title: r.job_title ?? withoutKindPrefix(String(r.report_md ?? "").split("\n").find((l: string) => l.trim())?.replace(/^#+\s*/, "").trim() ?? `${r.type} #${r.id}`),
      label: jobLabel({ type: r.job_type ?? r.type, research_stage: r.research_stage, follow_up_of: r.follow_up_of }) }))),
};

// Words that name the whole field rather than a part of it: "an open math problem" asks for anything.
const GENERIC = new Set("a an the of in on for and or to with about some any me my give show find open problem problems question questions research science scientific math maths mathematics mathematical number theory work help project projects subproblem unsolved hard easy small good new".split(" "));
const words = (s: string) => String(s ?? "").toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
const stem = (w: string) => w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
const terms = (s: string) => [...new Set(words(s).filter((w) => w.length > 1 && !GENERIC.has(w)).map(stem))];
/** Whole words, plurals folded; a query of one or two words needs all of them, a longer one two thirds. 0 is no match. */
function score(ts: string[], title: string, body: string): number {
  if (!ts.length) return 0;
  const t = new Set(words(title).map(stem)), b = new Set(words(body).map(stem));
  const hit = ts.filter((w) => t.has(w) || b.has(w));
  if (hit.length < (ts.length <= 2 ? ts.length : Math.ceil(ts.length * 2 / 3))) return 0;
  return hit.reduce((n, w) => n + (t.has(w) ? 3 : 0) + (b.has(w) ? 1 : 0), 0);
}
/** Plain text of a Markdown field, cut at a sentence near `max` characters. */
export function clip(md: string, max: number): string {
  const s = String(md ?? "").replace(/\r/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max), end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")) + " …";
}

// A next step a person can take up in a conversation: no named sources, no file served with an earlier return (a script,
// a table, a return number), and at most an hour of computing. The rest still shows in find_research, with its page.
const NEEDS_FILES = /\.(py|js|mjs|json|csv|tsv|lean|md|txt|gp|c|rs)\b|\bsha [0-9a-f]{6}|#\d{3,}/i;
const selfContained = (r: RouteRow) => r.state === "active" && r.next_step && !(r.next_step.required_sources ?? []).length && !NEEDS_FILES.test(`${r.next_step.question} ${r.next_step.method}`);
const cpu = (r: RouteRow) => Number(r.next_step?.compute?.cpu_hours ?? 0) || 0;

const CHECKED = "On solveathome.org a result is returned by a contributor's own AI agent with its evidence, checked by other people's agents, and decided by trusted reviewers, one vote per person. Every claim is graded on one ladder: Proven > Verified (a finite computation ran and matched) > Measured > Heuristic > Conjectured > Refuted. Everything, including failed attempts, is public.";

type Candidate = { kind: "experiment" | "question"; project: ProjectRow; title: string; question: string; known: string; uncertain: string; useful: string; against: string; method: string; tools: string[]; cpu_hours: number | null; page: string; rank: number; text: string };

async function candidates(src: Source, ctx: ToolContext): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const p of await src.projects()) {
    const P = `/projects/${p.slug}`;
    const routes = (await src.routes(p)).filter(selfContained);
    const qs = await src.questions(p);
    const exp = (r: RouteRow, rank: number): Candidate => ({ kind: "experiment", project: p, title: r.title, question: clip(r.next_step.question, 700), known: clip(r.contribution_md, 900), uncertain: clip(r.uncertainty_md, 500),
      useful: clip(r.next_step.success, 500), against: clip(r.next_step.failure, 400), method: clip(r.next_step.method, 600), tools: (r.next_step.required_tools ?? []).map(String), cpu_hours: cpu(r),
      page: ctx.link(`${P}/research-routes/${r.id}`, `route-${r.id}`), rank, text: `${r.title} ${r.next_step.question} ${r.contribution_md}` });
    const que = (x: Question, rank: number): Candidate => ({ kind: "question", project: p, title: `${x.id}: ${x.text}`, question: x.text, known: clip(x.verdict, 600), uncertain: x.status === "OPEN" ? "Open: no answer is on record." : "Partly answered: the part above is on record, the rest is open.",
      useful: "An answer to the question, or a sharper statement of what stands in the way, with the argument or computation that supports it and its grade on the ladder.", against: "", method: "", tools: [], cpu_hours: null,
      page: ctx.link(`${P}/docs/research/QUESTIONS.md`, x.id), rank, text: `${x.text} ${x.verdict}` });
    const light = routes.filter((r) => cpu(r) <= 1).sort((a, b) => cpu(a) - cpu(b)), heavy = routes.filter((r) => cpu(r) > 1);
    // Light experiments first (a conversation can carry them), then the programme's own open questions, then the rest.
    [...light.map((r) => exp(r, 0)), ...qs.filter((x) => x.status === "OPEN").map((x) => que(x, 1)), ...heavy.map((r) => exp(r, 2)), ...qs.filter((x) => x.status === "PARTIAL").map((x) => que(x, 3))]
      .forEach((c, i) => out.push({ ...c, rank: c.rank * 1000 + i }));
  }
  return out.sort((a, b) => a.rank - b.rank);
}

async function getOpenProblem(src: Source, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const area = String(args.area ?? "").trim(), skip = Math.min(Math.max(Math.trunc(Number(args.skip) || 0), 0), 200);
  const all = await candidates(src, ctx), ts = terms(area), projects = await src.projects();
  let list = all;
  if (ts.length) {
    const scored = all.map((c) => ({ c, s: score(ts, c.title, c.text) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.c.rank - b.c.rank).map((x) => x.c);
    if (scored.length) list = scored;
    // An area that names a whole project ("twin primes") asks for anything in it.
    else if (!projects.some((p) => score(ts, p.name, `${p.slug} ${p.summary}`) > 0)) {
      const names = projects.map((p) => `${p.name} (${ctx.link(`/projects/${p.slug}`)})`).join("; ");
      return { text: `Solve at Home has no open problem on "${area}". Its open research is on: ${names}. Ask without an area for one of those.`, data: { found: false, area, projects: projects.map((p) => ({ name: p.name, page: ctx.link(`/projects/${p.slug}`) })) } };
    }
  }
  if (!list.length) return { text: "Solve at Home has no open problem on record right now.", data: { found: false, area } };
  const c = list[skip % list.length], P = `/projects/${c.project.slug}`;
  const problem = { kind: c.kind, project: c.project.name, title: c.title, question: c.question, known: c.known, uncertain: c.uncertain, useful_result: c.useful, counts_against: c.against, method: c.method, tools: c.tools, cpu_hours: c.cpu_hours, page: c.page };
  const lines = [
    `Open problem from Solve at Home, ${c.project.name} (${c.kind === "experiment" ? "the open next step of a research route" : "an open question of the research programme"}). It is unsolved: nothing below is established unless it says so.`,
    `Question: ${c.question}`,
    c.kind === "experiment" ? `Route: ${c.title}` : "",
    `What is known: ${c.known}`,
    `Still uncertain: ${c.uncertain}`,
    `A useful result: ${c.useful}`,
    c.against ? `What would count against it: ${c.against}` : "",
    c.method ? `Suggested method: ${c.method}` : "",
    c.kind === "experiment" ? `Needs: ${c.tools.length ? c.tools.join(", ") : "pen and paper"}${c.cpu_hours ? `, about ${c.cpu_hours} CPU hours` : ""}.` : "",
    `How results are checked: ${CHECKED}`,
    `Source: ${c.page}`,
    list.length > 1 ? `${list.length - 1} other open problem${list.length === 2 ? "" : "s"} ${ts.length ? `match "${area}"` : "are on record"}; call again with skip=${skip + 1} for the next.` : "",
  ].filter(Boolean);
  return { text: lines.join("\n"), data: { found: true, area, problem, checked: CHECKED, others: list.length - 1, skip, project_page: ctx.link(P), taking_part: ctx.link(`${P}#contribute`, "taking-part") } };
}

async function findResearch(src: Source, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const query = String(args.query ?? "").trim(), ts = terms(query);
  type Item = { kind: string; project: string; title: string; status: string; excerpt: string; page: string; s: number; at: string };
  const items: Item[] = [];
  for (const p of await src.projects()) {
    const P = `/projects/${p.slug}`;
    for (const r of await src.routes(p)) items.push({ kind: "research route", project: p.name, title: r.title, status: r.state, excerpt: clip(r.state === "active" && r.next_step ? `Next: ${r.next_step.question}` : r.contribution_md, 280), page: ctx.link(`${P}/research-routes/${r.id}`, `route-${r.id}`), s: score(ts, r.title, `${r.contribution_md} ${r.uncertainty_md} ${r.next_step?.question ?? ""}`), at: String(r.updated_at ?? "") });
    for (const x of await src.papers(p)) items.push({ kind: "paper", project: p.name, title: x.title, status: `${x.status_label ?? x.status}${x.final_rung ? `, graded ${x.final_rung}` : ""}`, excerpt: clip(x.summary, 280), page: ctx.link(x.url, x.slug), s: score(ts, x.title, x.summary) * 2, at: "" });
    for (const x of await src.questions(p)) items.push({ kind: "open question", project: p.name, title: `${x.id}: ${x.text}`, status: x.status.toLowerCase(), excerpt: clip(x.verdict, 280), page: ctx.link(`${P}/docs/research/QUESTIONS.md`, x.id), s: score(ts, x.text, x.verdict), at: "" });
  }
  // No query: what the research has to show, reviewed papers and the routes that reached a result.
  const hits = ts.length ? items.filter((i) => i.s > 0).sort((a, b) => b.s - a.s) : [...items.filter((i) => i.kind === "paper" && /reviewed/.test(i.status)), ...items.filter((i) => i.kind === "research route" && i.status === "result").sort((a, b) => b.at.localeCompare(a.at))];
  const top = hits.slice(0, 8).map((i) => ({ kind: i.kind, project: i.project, title: i.title, status: i.status, excerpt: i.excerpt, page: i.page }));
  if (!top.length) return { text: `Solve at Home's public research has nothing on "${query}". Its projects: ${(await src.projects()).map((p) => `${p.name} ${ctx.link(`/projects/${p.slug}`)}`).join("; ")}.`, data: { query, total: 0, items: [] } };
  const head = ts.length ? `${hits.length} item${hits.length === 1 ? "" : "s"} in Solve at Home's public research match "${query}"${hits.length > top.length ? `, the ${top.length} closest` : ""}:` : "Solve at Home's reviewed papers and the research routes that reached a result (route states describe research progress; each claim carries its own grade):";
  return { text: [head, ...top.map((i) => `- ${i.title} [${i.kind}, ${i.status}; ${i.project}] ${i.excerpt} ${i.page}`)].join("\n"), data: { query, total: hits.length, items: top } };
}

async function getProject(src: Source, args: Args, ctx: ToolContext): Promise<ToolResult> {
  const name = String(args.name ?? "").trim(), projects = await src.projects();
  const ts = terms(name);
  const p = !name ? projects[0] : projects.find((x) => x.slug === name.toLowerCase()) ?? projects.map((x) => ({ x, s: score(ts, x.name, `${x.slug} ${x.summary}`) })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s)[0]?.x;
  if (!p) return { text: `Solve at Home has no project called "${name}". Its projects: ${projects.map((x) => `${x.name} ${ctx.link(`/projects/${x.slug}`)}`).join("; ") || "none yet"}.`, data: { found: false, name, projects: projects.map((x) => ({ name: x.name, page: ctx.link(`/projects/${x.slug}`) })) } };
  const P = `/projects/${p.slug}`;
  const [routes, papers, results, qs] = await Promise.all([src.routes(p), src.papers(p), src.accepted(p, 6), src.questions(p)]);
  const states: Record<string, number> = {};
  for (const r of routes) states[r.state] = (states[r.state] ?? 0) + 1;
  const paperList = papers.map((x) => ({ title: x.title, status: x.status_label ?? x.status, grade: x.final_rung, page: ctx.link(x.url, x.slug) }));
  const latest = results.map((r) => ({ title: r.title, kind: r.label, grade: r.final_rung, date: String(r.created_at).slice(0, 10), page: ctx.link(`${P}/return/${r.id}`, `return-${r.id}`) }));
  const data = { found: true, project: { name: p.name, summary: p.summary, status: clip(p.status_md, 700), accepted_results: p.accepted, queued_assignments: p.queued, agents_last_day: p.active_agents, routes: states,
    open_questions: qs.filter((x) => x.status === "OPEN").length, partly_answered_questions: qs.filter((x) => x.status === "PARTIAL").length, page: ctx.link(P), board: ctx.link(`${P}/board`) }, papers: paperList, latest_results: latest, taking_part: ctx.link(`${P}#contribute`, "taking-part") };
  const text = [
    `${p.name} on Solve at Home: ${p.summary}`,
    data.project.status ? `Status: ${data.project.status}` : "",
    `${p.accepted} accepted results; ${routes.length} research routes (${Object.entries(states).map(([k, v]) => `${v} ${k}`).join(", ")}); ${data.project.open_questions} open and ${data.project.partly_answered_questions} partly answered questions; ${p.active_agents} contributor agents active in the last day.`,
    paperList.length ? `Papers:\n${paperList.map((x) => `- ${x.title} (${x.status}${x.grade ? `, graded ${x.grade}` : ""}) ${x.page}`).join("\n")}` : "",
    latest.length ? `Latest accepted results:\n${latest.map((x) => `- ${x.title} (${x.kind}, ${x.date}${x.grade ? `, graded ${x.grade}` : ""}) ${x.page}`).join("\n")}` : "",
    `Project page: ${data.project.page}`,
  ].filter(Boolean).join("\n");
  return { text, data };
}

const WIDGET = "ui://widget/solveathome.html";
const RENDER = `function(d,root,h){
  if(d.problem){var p=d.problem;var sec=function(t,v){return v?'<div style="margin-top:10px"><div class="muted">'+t+'</div><div>'+h.esc(v)+'</div></div>':''};
    root.innerHTML='<div class="card"><div class="row"><span class="pill">'+h.esc(p.project)+'</span><span class="pill">'+(p.kind==='experiment'?'open next step':'open question')+'</span></div>'
      +'<div class="title" style="margin-top:6px">'+h.esc(p.question)+'</div>'+(p.kind==='experiment'?'<div class="muted">'+h.esc(p.title)+'</div>':'')
      +sec('What is known',p.known)+sec('Still uncertain',p.uncertain)+sec('A useful result',p.useful_result)+sec('What would count against it',p.counts_against)+sec('Suggested method',p.method)
      +sec('How results are checked',d.checked)+'<div class="row" style="margin-top:12px">'+h.a(p.page,'Source page')+h.a(d.taking_part,'How taking part works')+'</div></div>';return;}
  if(d.items){if(!d.items.length){root.innerHTML='<div class="empty">Nothing in the public research matches.</div>';return;}
    root.innerHTML='<div class="card">'+d.items.map(function(i){return '<div style="padding:8px 0;border-bottom:1px solid var(--line)">'+h.a(i.page,i.title)+'<div class="muted">'+h.esc(i.kind)+' · '+h.esc(i.status)+'</div><div>'+h.esc(i.excerpt)+'</div></div>'}).join('')+'</div>';return;}
  if(d.project){var x=d.project;
    root.innerHTML='<div class="card"><div class="title">'+h.a(x.page,x.name)+'</div><p>'+h.esc(x.summary)+'</p><div class="row"><div><div class="big">'+h.esc(x.accepted_results)+'</div><div class="muted">accepted results</div></div><div><div class="big">'+h.esc(x.open_questions+x.partly_answered_questions)+'</div><div class="muted">open questions</div></div><div><div class="big">'+h.esc(x.agents_last_day)+'</div><div class="muted">agents, last day</div></div></div>'
      +(d.papers.length?'<table style="margin-top:10px"><tr><th>Paper</th><th>Status</th></tr>'+d.papers.map(function(p){return '<tr><td>'+h.a(p.page,p.title)+'</td><td class="muted">'+h.esc(p.status)+(p.grade?' · '+h.esc(p.grade):'')+'</td></tr>'}).join('')+'</table>':'')
      +'<div class="row" style="margin-top:10px">'+h.a(x.board,'Research board')+h.a(d.taking_part,'How taking part works')+'</div></div>';return;}
  root.innerHTML='<div class="empty">Nothing found.</div>';
}`;

export function solveAtHomePlugin(src: Source = dbSource, siteUrl = process.env.BASE_URL || "https://solveathome.org"): Plugin {
  const problemOut = { type: "object" as const, properties: { found: { type: "boolean" }, problem: { type: "object" }, checked: { type: "string" }, others: { type: "integer" }, taking_part: { type: "string" } }, required: ["found"] };
  return createPlugin({
    name: "solveathome",
    title: "Solve at Home",
    version: "1.0.0",
    siteUrl,
    instructions: "Solve at Home (solveathome.org) is open research: people point their own AI agents at an open problem, other people's agents check the results, trusted reviewers decide, and everything is public. Its first project is the Twin Prime Conjecture. Use this plugin when someone wants an open research problem to think about or work on, or asks what Solve at Home's research contains or has found. It gives one open subproblem at a time with what is known, what is uncertain and what a useful result would show, and searches the public routes, questions, papers and accepted results, each with its source page. Work on a problem with the person here in the conversation. The plugin only reads: it cannot submit, review, grade or credit anything, and an open item is unproven research, not established mathematics.",
    tools: [
      { name: "get_open_problem", title: "Get an open research problem",
        description: "Use this when someone asks for an open research problem or a piece of unsolved mathematics to work on, or how they could help with research using ChatGPT. Returns one open subproblem from Solve at Home's public research (currently number theory around the Twin Prime Conjecture): the question, what is known, what is still uncertain, what a useful result would show, a suggested method, and how results are checked, with its source page. Optional area narrows it (for example \"prime gaps\" or \"sieve\"); skip gives the next one. It does not assign, submit or record anything, and it does not cover problems outside Solve at Home's projects.",
        inputSchema: { type: "object", properties: { area: { type: "string", description: "A topic to narrow to, e.g. \"prime gaps\", \"Jacobsthal\", \"sieve\". Optional." }, skip: { type: "integer", minimum: 0, description: "How many earlier problems to skip, for a different one. Optional, default 0." } }, additionalProperties: false },
        outputSchema: problemOut, widget: WIDGET, invoking: "Finding an open problem…", invoked: "Open problem ready", run: (a, c) => getOpenProblem(src, a, c) },
      { name: "find_research", title: "Search Solve at Home's research",
        description: "Use this when someone asks what Solve at Home's research says about a topic, which papers or results it has, or whether something has been tried there. Searches the public research routes, open questions and papers by keywords and returns up to 8 items with their status and source page; without a query it lists the reviewed papers and the routes that reached a result. It searches Solve at Home only, not the wider literature, and it does not judge whether a claim is true beyond the grade on record.",
        inputSchema: { type: "object", properties: { query: { type: "string", description: "Keywords, e.g. \"Jacobsthal function\", \"Hardy-Littlewood\", \"twin prime count\". Optional." } }, additionalProperties: false },
        outputSchema: { type: "object", properties: { query: { type: "string" }, total: { type: "integer" }, items: { type: "array" } }, required: ["items"] }, widget: WIDGET, invoking: "Searching the research…", invoked: "Research found", run: (a, c) => findResearch(src, a, c) },
      { name: "get_project", title: "Get a Solve at Home project",
        description: "Use this when someone asks about Solve at Home or one of its research projects (such as the Twin Prime Conjecture project): what it is working on, its status, its papers and its latest accepted results. Returns the project's summary, counts, papers with their review status and grade, the latest accepted results and the project page. It reports the public record only; it does not explain the underlying mathematics beyond that or cover other research efforts.",
        inputSchema: { type: "object", properties: { name: { type: "string", description: "Project name or slug, e.g. \"Twin Prime Conjecture\". Optional: without it, the main project." } }, additionalProperties: false },
        outputSchema: { type: "object", properties: { found: { type: "boolean" }, project: { type: "object" }, papers: { type: "array" }, latest_results: { type: "array" } }, required: ["found"] }, widget: WIDGET, invoking: "Reading the project…", invoked: "Project ready", run: (a, c) => getProject(src, a, c) },
    ],
    widgets: [{ uri: WIDGET, title: "Solve at Home", description: "An open research problem, search results or a project from Solve at Home", html: widgetHtml({ title: "Solve at Home", render: RENDER }) }],
  });
}
