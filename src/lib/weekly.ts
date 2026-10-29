/**
 * The weekly progress post (#sah-weekly-progress-build; Chris approved the proposal on 29 Oct 2026, "Build it as proposed"; asked for by
 * a contributor in #general on 28 Oct: "each week ... a text that resumes where we're at"). One post per project per week, Monday to
 * Sunday in Copenhagen, built on Monday morning and posted at 10:00 to the project's own read-only Discord channel through its own
 * webhook, kept as a page per week (/projects/<slug>/weekly/<last day>, archive at /weekly), and carried in that Monday's email.
 *
 * Decisions, from the approved proposal:
 *  - Numbers are SQL and a fixed template, never a model. The sessions on the project's own account (config `exclude_handles`) count in
 *    the totals but not in the top contributors. Reviews are a count, with no reviewer named. No "% solved" number: there is none.
 *  - The "What moved" lines (2 to 4) are written by a model in a compute job (the `sah-weekly` source), never here. It is given the
 *    week's record (route moves, accepted paper revisions, findings) and nothing else. Every line must cite a route or a return of that
 *    record, and every number in it must appear in what it was given; a line that fails is dropped with the reason, kept in
 *    summary_dropped. No line passing means the post goes out with numbers only.
 *  - The first `approvals_required` posts (2) wait for the owner's approval (status 'held'); a held week's page and email section stay
 *    unpublished until then. After that a week is 'ready' and posts itself at publish time.
 *  - A posted message is never posted again: a wrong number is fixed by editing the webhook message (correct()), and the change is kept.
 *
 * Config per project in project.json, off unless set: "weekly": { "enabled": true, "since": "<first Monday>", "webhook_env": "...",
 * "exclude_handles": [...], "also": [{ "slug": "...", "label": "..." }], "closing": "...", "approvals_required": 2,
 * "build_hour": 6, "publish_hour": 10 }. ANNOUNCE_ENABLED=0 stops the posting, as it does every Discord post.
 */
import { q, one } from "../db/index.js";
import { listProjectConfigs, readProjectConfig, type ProjectConfig } from "./projects.js";
import { announceEnabled, overclaim, type Fetch } from "./announce.js";

export const TZ = "Europe/Copenhagen";
export type WeeklyConfig = { enabled: boolean; since: string | null; webhook_env: string; exclude_handles: string[]; also: Array<{ slug: string; label: string }>;
  closing: string; approvals_required: number; build_hour: number; publish_hour: number };
export function weeklyConfig(cfg: ProjectConfig | null | undefined): WeeklyConfig {
  const w = (cfg as any)?.weekly ?? {};
  const hour = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? (v as number) : d);
  return {
    enabled: w.enabled === true, since: typeof w.since === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.since) ? w.since : null,
    webhook_env: typeof w.webhook_env === "string" && w.webhook_env ? w.webhook_env : "DISCORD_WEEKLY_WEBHOOK_URL",
    exclude_handles: Array.isArray(w.exclude_handles) ? w.exclude_handles.map(String) : [],
    also: Array.isArray(w.also) ? w.also.filter((a: any) => a?.slug).map((a: any) => ({ slug: String(a.slug), label: String(a.label ?? a.slug) })) : [],
    closing: typeof w.closing === "string" ? w.closing : "",
    approvals_required: Number.isInteger(w.approvals_required) && w.approvals_required >= 0 ? w.approvals_required : 2,
    build_hour: hour(w.build_hour, 6), publish_hour: hour(w.publish_hour, 10),
  };
}
export const weeklySlugs = (): string[] => listProjectConfigs().filter((c) => weeklyConfig(c).enabled).map((c) => c.slug);
export function weeklyWebhook(cfg: WeeklyConfig, env: Record<string, string | undefined> = process.env): URL | null {
  const raw = String(env[cfg.webhook_env] ?? "").trim(); if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) ? u : null; } catch { return null; }
}

// ---------- numbers: SQL only ----------

/** The week's bounds in Copenhagen time, as timestamps; `end` is the last day, inclusive. */
async function bounds(start: string, end: string): Promise<{ from: Date; to: Date }> {
  const b = await one<any>(`SELECT ($1::date)::timestamp AT TIME ZONE '${TZ}' AS f, ($2::date + 1)::timestamp AT TIME ZONE '${TZ}' AS t`, [start, end]);
  return { from: new Date(b.f), to: new Date(b.t) };
}

// The order of the sample post (proven, measured, verified), then the rest of the ladder.
const RUNG_ORDER = ["proven", "measured", "verified", "heuristic", "conjectured", "refuted"];

export type ProjectWeek = { agents: number; people: number; sessions_before: number; sessions_after: number; returns: number; accepted: number;
  by_rung: Record<string, number>; rejected: number; recorded: number; pending: number; reviews: number; tokens: number; cpu_hours: number };
export type WeeklyNumbers = ProjectWeek & {
  routes: { moved: number; new: number; result: number; known: number; blocked: number; now: Record<string, number> };
  papers_accepted: number; document_versions: number; documents: number; findings_opened: number; findings_resolved: number;
  top: Array<{ handle: string; points: number }>; excluded_handles: string[];
  also: Array<{ slug: string; label: string; agents: number; returns: number; accepted: number; records: number }>;
};

/** Agents: sessions that were seen in the week (started before its end, last seen after its start), the count the project page shows. */
async function projectWeek(problemId: number, from: Date, to: Date): Promise<ProjectWeek> {
  const P = [problemId, from, to];
  const s = await one<any>(`SELECT count(*) FILTER (WHERE started_at < $3 AND last_seen >= $2)::int AS agents,
      count(DISTINCT user_id) FILTER (WHERE started_at < $3 AND last_seen >= $2)::int AS people,
      count(*) FILTER (WHERE started_at < $2)::int AS before, count(*) FILTER (WHERE started_at < $3)::int AS after
    FROM sessions WHERE problem_id = $1`, P);
  const r = await one<any>(`SELECT count(*)::int AS returns, count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected, count(*) FILTER (WHERE status = 'recorded')::int AS recorded,
      count(*) FILTER (WHERE status = 'pending')::int AS pending, coalesce(sum(cpu_hours), 0)::float AS cpu,
      coalesce(sum(coalesce((tokens->>'input')::numeric, 0) + coalesce((tokens->>'output')::numeric, 0)), 0)::float AS tokens
    FROM returns WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3`, P);
  const rungs = await q<any>(`SELECT final_rung, count(*)::int AS n FROM returns WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3 AND status = 'accepted' AND final_rung IS NOT NULL GROUP BY 1`, P);
  const rv = await one<any>(`SELECT count(*)::int AS n FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= $2 AND rv.created_at < $3`, P);
  return { agents: s.agents, people: s.people, sessions_before: s.before, sessions_after: s.after, returns: r.returns, accepted: r.accepted,
    by_rung: Object.fromEntries(rungs.map((x) => [x.final_rung, x.n])), rejected: r.rejected, recorded: r.recorded, pending: r.pending,
    reviews: rv?.n ?? 0, tokens: Math.round(r.tokens), cpu_hours: Math.round(r.cpu * 100) / 100 };
}

export async function weeklyNumbers(problemId: number, from: Date, to: Date, cfg: WeeklyConfig): Promise<WeeklyNumbers> {
  const P = [problemId, from, to];
  const base = await projectWeek(problemId, from, to);
  const moved = `SELECT DISTINCT e.route_id FROM research_events e JOIN research_routes r ON r.id = e.route_id WHERE r.problem_id = $1 AND e.created_at >= $2 AND e.created_at < $3`;
  const rt = await one<any>(`SELECT (SELECT count(*)::int FROM (${moved}) m) AS moved,
      (SELECT count(*)::int FROM research_routes WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3) AS new,
      (SELECT count(*) FILTER (WHERE r.state = 'result')::int FROM (${moved}) m JOIN research_routes r ON r.id = m.route_id) AS result,
      (SELECT count(*) FILTER (WHERE r.state = 'known')::int FROM (${moved}) m JOIN research_routes r ON r.id = m.route_id) AS known,
      (SELECT count(*) FILTER (WHERE r.state = 'blocked')::int FROM (${moved}) m JOIN research_routes r ON r.id = m.route_id) AS blocked`, P);
  const now = await q<any>(`SELECT state, count(*)::int AS n FROM research_routes WHERE problem_id = $1 GROUP BY 1`, [problemId]);
  const docs = await one<any>(`SELECT (SELECT count(*)::int FROM returns WHERE problem_id = $1 AND type = 'paper' AND status = 'accepted' AND created_at >= $2 AND created_at < $3) AS papers,
      (SELECT count(*)::int FROM document_versions WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3) AS versions,
      (SELECT count(DISTINCT path)::int FROM document_versions WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3) AS documents,
      (SELECT count(*)::int FROM findings WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3) AS opened,
      (SELECT count(*)::int FROM findings WHERE problem_id = $1 AND resolved_at >= $2 AND resolved_at < $3) AS resolved`, P);
  const top = await q<any>(`SELECT u.handle, sum(c.points)::float AS points FROM credits c JOIN users u ON u.id = c.user_id
    WHERE c.problem_id = $1 AND c.created_at >= $2 AND c.created_at < $3 AND NOT (u.handle = ANY($4::text[])) GROUP BY u.handle HAVING sum(c.points) > 0 ORDER BY 2 DESC, 1 LIMIT 5`, [...P, cfg.exclude_handles]);
  const also: WeeklyNumbers["also"] = [];
  for (const a of cfg.also) {
    const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [a.slug]); if (!p) continue;
    const w = await projectWeek(Number(p.id), from, to);
    const rec = await one<any>(`SELECT count(*)::int AS n FROM challenge_events WHERE problem_id = $1 AND namespace = 'live' AND kind = 'record' AND created_at >= $2 AND created_at < $3`, [p.id, from, to]);
    also.push({ slug: a.slug, label: a.label, agents: w.agents, returns: w.returns, accepted: w.accepted, records: rec?.n ?? 0 });
  }
  return { ...base, routes: { moved: rt.moved, new: rt.new, result: rt.result, known: rt.known, blocked: rt.blocked, now: Object.fromEntries(now.map((x) => [x.state, x.n])) },
    papers_accepted: docs.papers, document_versions: docs.versions, documents: docs.documents, findings_opened: docs.opened, findings_resolved: docs.resolved,
    top: top.map((t) => ({ handle: t.handle, points: Math.round(t.points) })), excluded_handles: cfg.exclude_handles, also };
}

// ---------- the record: what changed, from what is stored ----------

const clip = (s: unknown, n: number) => { const t = String(s ?? "").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
export const DIFF_MAX = 20_000;
export type WeeklyRecord = {
  routes: Array<{ id: number; title: string; state: string; new: boolean; outcomes: string[]; return_ids: number[]; evidence: string }>;
  documents: Array<{ path: string; version: number; return_id: number | null; summary: string; diff: string; diff_clipped: boolean }>;
  papers: Array<{ return_id: number; paper: string | null; path: string | null }>;
  findings_resolved: Array<{ id: number; path: string; note: string; return_id: number | null }>;
};
export async function weeklyRecord(problemId: number, from: Date, to: Date): Promise<WeeklyRecord> {
  const P = [problemId, from, to];
  const routes = await q<any>(`SELECT r.id, r.title, r.state, r.created_at >= $2 AND r.created_at < $3 AS new,
      array_agg(e.outcome ORDER BY e.id) AS outcomes, array_remove(array_agg(DISTINCT e.return_id), NULL) AS return_ids,
      (array_agg(e.evidence_md ORDER BY e.id DESC))[1] AS evidence
    FROM research_events e JOIN research_routes r ON r.id = e.route_id WHERE r.problem_id = $1 AND e.created_at >= $2 AND e.created_at < $3
    GROUP BY r.id ORDER BY r.id`, P);
  const documents = await q<any>(`SELECT path, version, return_id, summary, diff FROM document_versions WHERE problem_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY id`, P);
  const papers = await q<any>(`SELECT id, paper_slug, revision_path FROM returns WHERE problem_id = $1 AND type = 'paper' AND status = 'accepted' AND created_at >= $2 AND created_at < $3 ORDER BY id`, P);
  const fixed = await q<any>(`SELECT id, path, note, resolved_by_return_id FROM findings WHERE problem_id = $1 AND resolved_at >= $2 AND resolved_at < $3 ORDER BY id`, P);
  return {
    routes: routes.map((r) => ({ id: Number(r.id), title: r.title, state: r.state, new: !!r.new, outcomes: r.outcomes, return_ids: (r.return_ids ?? []).map(Number).sort((a: number, b: number) => a - b), evidence: clip(r.evidence, 1600) })),
    documents: documents.map((d) => ({ path: d.path, version: d.version, return_id: d.return_id === null ? null : Number(d.return_id), summary: clip(d.summary, 600), diff: String(d.diff ?? "").slice(0, DIFF_MAX), diff_clipped: String(d.diff ?? "").length > DIFF_MAX })),
    papers: papers.map((p) => ({ return_id: Number(p.id), paper: p.paper_slug, path: p.revision_path })),
    findings_resolved: fixed.map((f) => ({ id: Number(f.id), path: f.path, note: clip(f.note, 400), return_id: f.resolved_by_return_id === null ? null : Number(f.resolved_by_return_id) })),
  };
}

/** What the summary job is given, and the only text its numbers may come from. Routes that closed or are new lead; long diffs are cut. */
export function summaryInput(name: string, label: string, n: WeeklyNumbers, r: WeeklyRecord): string {
  const rank = (x: WeeklyRecord["routes"][number]) => x.state === "result" ? 0 : x.state === "blocked" ? 1 : x.new ? 2 : x.state === "known" ? 4 : 3;
  const routes = [...r.routes].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const L: string[] = [`# ${name}: the week of ${label}`, "",
    `Counts: ${n.routes.moved} routes moved, ${n.routes.new} new; ${n.routes.result} reached a result, ${n.routes.known} found already known, ${n.routes.blocked} blocked. ${n.papers_accepted} paper revisions accepted (${n.document_versions} versions of ${n.documents} documents). ${n.findings_opened} findings opened, ${n.findings_resolved} resolved.`, "",
    "## Routes that moved", ""];
  for (const x of routes) {
    const ev = x.state === "result" || x.state === "blocked" ? clip(x.evidence, 1200) : x.state === "known" ? "" : clip(x.evidence, 400);
    L.push(`- route ${x.id} (${x.state}${x.new ? ", new this week" : ""}): ${clip(x.title, 200)}. Outcomes this week: ${[...new Set(x.outcomes)].join(", ")}. Returns: ${x.return_ids.map((i) => `return ${i}`).join(", ") || "none"}.${ev ? ` Last evidence: ${ev.replace(/\s+/g, " ")}` : ""}`);
  }
  L.push("", "## Accepted paper revisions", "");
  for (const p of r.papers) L.push(`- return ${p.return_id}: ${p.paper ?? p.path ?? "a paper"}`);
  L.push("", "## Document versions", "");
  for (const d of r.documents) L.push(`- ${d.path} version ${d.version}${d.return_id ? ` (return ${d.return_id})` : ""}: ${d.summary.replace(/\s+/g, " ")}`);
  L.push("", "## Findings resolved", "");
  for (const f of r.findings_resolved) L.push(`- in ${f.path}${f.return_id ? `, fixed by return ${f.return_id}` : ""}: ${f.note.replace(/\s+/g, " ")}`);
  return L.join("\n").slice(0, 120_000);
}

// ---------- the summary check: code decides what is kept ----------

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const numbersIn = (s: string): string[] => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => x.replace(/,(?=\d{3}\b)/g, "").replace(/,$/, ""));
export const LINE_MAX = 420, LINES_MAX = 4;
export type SummaryLine = { text: string; routes: number[]; returns: number[] };
/** Keep a line only when every route or return it cites is in the record, it cites at least one, and every number in it is in the input. */
export function checkSummary(lines: unknown, input: string, r: WeeklyRecord): { kept: SummaryLine[]; dropped: Array<{ text: string; why: string }> } {
  const routeIds = new Set(r.routes.map((x) => x.id));
  const returnIds = new Set([...r.routes.flatMap((x) => x.return_ids), ...r.documents.flatMap((d) => d.return_id ? [d.return_id] : []), ...r.papers.map((p) => p.return_id), ...r.findings_resolved.flatMap((f) => f.return_id ? [f.return_id] : [])]);
  const known = new Set(numbersIn(input));
  const kept: SummaryLine[] = [], dropped: Array<{ text: string; why: string }> = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const text = String(typeof raw === "string" ? raw : (raw as any)?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const drop = (why: string) => { dropped.push({ text: text.slice(0, 1000), why }); };
    if (kept.length >= LINES_MAX) { drop(`more than ${LINES_MAX} lines`); continue; }
    if (text.length > LINE_MAX) { drop(`longer than ${LINE_MAX} characters`); continue; }
    const over = overclaim(text); if (over) { drop(over); continue; }
    const cites = [...text.matchAll(/\b(routes?|returns?)\s+#?(\d+)((?:\s*(?:,|and)\s*#?\d+)*)/gi)];
    const routes: number[] = [], returns: number[] = [];
    for (const c of cites) for (const id of [c[2], ...numbersIn(c[3] ?? "")].map(Number)) (c[1].toLowerCase().startsWith("route") ? routes : returns).push(id);
    if (!routes.length && !returns.length) { drop("cites no route or return"); continue; }
    const badRoute = routes.find((i) => !routeIds.has(i)), badReturn = returns.find((i) => !returnIds.has(i));
    if (badRoute !== undefined) { drop(`route ${badRoute} is not in the week's record`); continue; }
    if (badReturn !== undefined) { drop(`return ${badReturn} is not in the week's record`); continue; }
    const cited = new Set([...routes, ...returns].map(String));
    const plain = text.replace(/\b(routes?|returns?)\s+#?\d+((?:\s*(?:,|and)\s*#?\d+)*)/gi, "");
    const strange = numbersIn(plain).find((x) => !known.has(x) && !cited.has(x));
    if (strange !== undefined) { drop(`the number ${strange} is not in the week's record`); continue; }
    const word = (plain.toLowerCase().match(/\b[a-z]+\b/g) ?? []).find((w) => WORDS[w] !== undefined && !known.has(String(WORDS[w])));
    if (word) { drop(`the number "${word}" is not in the week's record`); continue; }
    kept.push({ text, routes: [...new Set(routes)], returns: [...new Set(returns)] });
  }
  return { kept, dropped };
}

// ---------- the template ----------

const n = (x: number) => Math.round(x).toLocaleString("en-US");
const plural = (x: number, one: string, many: string) => `${n(x)} ${x === 1 ? one : many}`;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "22 to 28 Oct", "26 Oct to 1 Nov", "29 Dec 2026 to 4 Jan 2027". */
export function weekLabel(start: string, end: string): string {
  const [ys, ms, ds] = start.split("-").map(Number), [ye, me, de] = end.split("-").map(Number);
  if (ys !== ye) return `${ds} ${MONTH[ms - 1]} ${ys} to ${de} ${MONTH[me - 1]} ${ye}`;
  return ms === me ? `${ds} to ${de} ${MONTH[me - 1]}` : `${ds} ${MONTH[ms - 1]} to ${de} ${MONTH[me - 1]}`;
}
export function aboutTokens(t: number): string {
  const sig = (v: number) => String(Number(v.toPrecision(2)));
  return t >= 1e9 ? `${sig(t / 1e9)} billion` : t >= 1e6 ? `${sig(t / 1e6)} million` : t >= 1e3 ? `${sig(t / 1e3)} thousand` : n(t);
}

export type PostMeta = { name: string; slug: string; base: string; start: string; end: string; closing: string };
/** The post, in Discord markdown. Every line is a number from SQL, except the What moved lines, which passed checkSummary. */
export function renderPost(m: PostMeta, x: WeeklyNumbers, lines: SummaryLine[]): string {
  const host = m.base.replace(/^https?:\/\//, "");
  const url = `${m.base}/projects/${m.slug}/weekly/${m.end}`;
  const S: string[] = [`**${m.name}: week of ${weekLabel(m.start, m.end)}**`, "", "**This week**"];
  const up = x.sessions_before ? Math.round(100 * (x.sessions_after - x.sessions_before) / x.sessions_before) : null;
  S.push(`- ${plural(x.agents, "agent", "agents")} from ${plural(x.people, "person", "people")} worked on the problem. The all-time count went from ${n(x.sessions_before)} to ${n(x.sessions_after)}${up !== null && up > 0 ? `, up ${up} %` : ""}.`);
  const rungs = RUNG_ORDER.filter((g) => x.by_rung[g]).map((g) => `${n(x.by_rung[g])} ${g}`);
  S.push(`- ${plural(x.returns, "return", "returns")} came in.${x.accepted ? ` ${n(x.accepted)} ${x.accepted === 1 ? "was" : "were"} accepted after review${rungs.length ? `: ${rungs.join(", ")}` : ""}.` : " None was accepted after review yet."}${x.rejected ? ` ${n(x.rejected)} ${x.rejected === 1 ? "was" : "were"} not accepted.` : ""}`);
  S.push(`- ${plural(x.reviews, "review", "reviews")}. About ${aboutTokens(x.tokens)} tokens and ${plural(Math.round(x.cpu_hours), "CPU hour", "CPU hours")} went into the work.`);
  const rt = x.routes, now = rt.now;
  S.push("", "**Research routes**", `- ${plural(rt.moved, "route", "routes")} moved. ${n(rt.new)} ${rt.new === 1 ? "is" : "are"} new.`);
  const closed = [rt.result ? `${n(rt.result)} reached a result.` : "", rt.known ? `${n(rt.known)} turned out to be known already in the literature, so nobody spends more time on ${rt.known === 1 ? "it" : "them"}.` : "",
    rt.blocked ? `${n(rt.blocked)} ${rt.blocked === 1 ? "is" : "are"} blocked and ${rt.blocked === 1 ? "waits" : "wait"} for a new idea.` : ""].filter(Boolean);
  if (closed.length) S.push(`- ${closed.join(" ")}`);
  const c = (k: string) => now[k] ?? 0;
  S.push(`- Now open: ${n(c("active"))} active, ${n(c("proposed"))} proposed, ${n(c("blocked") + c("paused"))} blocked or paused. Closed: ${n(c("result"))} results, ${n(c("known"))} known.`);
  if (lines.length) S.push("", "**What moved**", ...lines.map((l) => `- ${l.text}`));
  if (x.top.length) S.push("", "**Top contributors this week** (points)", x.top.map((t) => `${t.handle.replace(/[^A-Za-z0-9_.-]/g, "")} ${n(t.points)}`).join(" · "));
  for (const a of x.also) S.push("", `**${a.label}:** ${plural(a.agents, "agent", "agents")}, ${plural(a.returns, "return", "returns")}, ${n(a.accepted)} accepted. ${a.records ? `${plural(a.records, "new record", "new records")} this week.` : "No new record this week."}`);
  S.push("", ...(m.closing ? [m.closing] : []), `Full week: [${host}/projects/${m.slug}/weekly/${m.end}](${url})`);
  return S.join("\n");
}
/** Discord takes 2,000 characters: the What moved lines go first, last one first, before anything else is cut. */
export function fitPost(m: PostMeta, x: WeeklyNumbers, lines: SummaryLine[], max = 2000): { text: string; lines: SummaryLine[] } {
  let keep = [...lines];
  for (;;) { const text = renderPost(m, x, keep); if (text.length <= max || !keep.length) return { text: text.slice(0, max), lines: keep }; keep = keep.slice(0, -1); }
}

// ---------- rows ----------

const BASE = () => (process.env.BASE_URL ?? "https://solveathome.org").replace(/\/+$/, "");
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Visible on the site and in email: approved, posted, or ready and past its publish time. A held or suppressed week is not. */
export const PUBLISHED_SQL = `(d.status IN ('approved','posted') OR (d.status = 'ready' AND d.publish_at <= now()))`;

async function meta(slug: string, start: string, end: string): Promise<{ p: { id: number; name: string }; m: PostMeta; cfg: WeeklyConfig }> {
  const p = await one<any>(`SELECT id, name FROM problems WHERE slug = $1`, [slug]); if (!p) throw new Error(`unknown project ${slug}`);
  const cfg = weeklyConfig(readProjectConfig(slug));
  return { p: { id: Number(p.id), name: p.name }, cfg, m: { name: p.name, slug, base: BASE(), start, end, closing: cfg.closing } };
}

/** The numbers, the record and the post for one week, without storing anything (the `build --dry` command and the tests). */
export async function composeWeek(slug: string, start: string, end: string) {
  const { p, m, cfg } = await meta(slug, start, end);
  const { from, to } = await bounds(start, end);
  const numbers = await weeklyNumbers(p.id, from, to, cfg);
  const record = await weeklyRecord(p.id, from, to);
  const input = summaryInput(p.name, weekLabel(start, end), numbers, record);
  return { problem_id: p.id, from, to, numbers, record, input, text: fitPost(m, numbers, []).text, cfg, meta: m };
}

/** Approved posts so far, the count that decides whether a new week waits for the owner. */
async function approvedPosts(problemId: number): Promise<number> {
  const r = await one<any>(`SELECT count(*)::int AS n FROM weekly_digests WHERE problem_id = $1 AND needs_approval AND approved_at IS NOT NULL AND status IN ('approved','posted')`, [problemId]);
  return r?.n ?? 0;
}

/** Store the week (once: the unique week key is the claim). `publishAt` is Monday publish_hour after the week, Copenhagen. */
export async function buildWeek(slug: string, start: string, end: string, opts: { publishAt?: Date } = {}): Promise<{ id: number; created: boolean }> {
  const w = await composeWeek(slug, start, end);
  const pub = opts.publishAt ?? new Date((await one<any>(`SELECT (($1::date + 1)::timestamp + make_interval(hours => $2)) AT TIME ZONE '${TZ}' AS t`, [end, w.cfg.publish_hour])).t);
  const needs = (await approvedPosts(w.problem_id)) < w.cfg.approvals_required;
  const row = await one<any>(`INSERT INTO weekly_digests (problem_id, week_start, week_end, from_at, to_at, numbers, record, summary_input, text_md, status, needs_approval, publish_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (problem_id, week_start) DO NOTHING RETURNING id`,
    [w.problem_id, start, end, w.from, w.to, JSON.stringify(w.numbers), JSON.stringify(w.record), w.input, w.text, needs ? "held" : "ready", needs, pub]);
  if (row) return { id: Number(row.id), created: true };
  const old = await one<any>(`SELECT id FROM weekly_digests WHERE problem_id = $1 AND week_start = $2`, [w.problem_id, start]);
  return { id: Number(old.id), created: false };
}

/** Numbers and record again for a week not yet posted (a fix before it goes out). A posted week is corrected with correct(). */
export async function rebuildWeek(id: number): Promise<boolean> {
  const d = await one<any>(`SELECT d.*, p.slug FROM weekly_digests d JOIN problems p ON p.id = d.problem_id WHERE d.id = $1`, [id]);
  if (!d || ["posted", "suppressed"].includes(d.status)) return false;
  const w = await composeWeek(d.slug, iso(new Date(d.week_start)), iso(new Date(d.week_end)));
  const lines = d.summary_status === "done" ? checkSummary(d.summary, w.input, w.record).kept : [];
  await q(`UPDATE weekly_digests SET numbers = $2, record = $3, summary_input = $4, summary = $5, text_md = $6 WHERE id = $1`,
    [id, JSON.stringify(w.numbers), JSON.stringify(w.record), w.input, JSON.stringify(lines), fitPost(w.meta, w.numbers, lines).text]);
  return true;
}

export async function rowMeta(d: any): Promise<PostMeta> {
  const slug = d.slug ?? (await one<any>(`SELECT slug FROM problems WHERE id = $1`, [d.problem_id])).slug;
  return (await meta(slug, iso(new Date(d.week_start)), iso(new Date(d.week_end)))).m;
}

// ---------- the summary job (compute source sah-weekly) ----------

export const LEASE_MIN = 30;
/** The signal compute reads: how many weeks wait for their summary. */
export async function summaryWaiting(problemId: number): Promise<number> {
  const r = await one<any>(`SELECT count(*)::int AS n FROM weekly_digests WHERE problem_id = $1 AND status IN ('held','ready','approved')
    AND (summary_status = 'waiting' OR (summary_status = 'leased' AND summary_leased_until < now()))`, [problemId]);
  return r?.n ?? 0;
}
export async function leaseSummary(problemId: number): Promise<any | null> {
  return (await one<any>(`UPDATE weekly_digests SET summary_status = 'leased', summary_leased_until = now() + make_interval(mins => $2)
    WHERE id = (SELECT id FROM weekly_digests WHERE problem_id = $1 AND status IN ('held','ready','approved')
      AND (summary_status = 'waiting' OR (summary_status = 'leased' AND summary_leased_until < now())) ORDER BY week_start LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id, week_start, week_end, summary_input`, [problemId, LEASE_MIN])) ?? null;
}
export async function releaseSummary(problemId: number, id: number): Promise<boolean> {
  return !!(await one(`UPDATE weekly_digests SET summary_status = 'waiting', summary_leased_until = NULL WHERE id = $1 AND problem_id = $2 AND summary_status = 'leased' RETURNING id`, [id, problemId]));
}
/** The job's lines: checked here, kept or dropped with the reason, and the post rendered again. Refused once the week is posted. */
export async function saveSummary(problemId: number, id: number, lines: unknown, model: string): Promise<{ kept: SummaryLine[]; dropped: Array<{ text: string; why: string }> } | { error: string }> {
  const d = await one<any>(`SELECT * FROM weekly_digests WHERE id = $1 AND problem_id = $2`, [id, problemId]);
  if (!d) return { error: "no such week" };
  if (d.status === "posted" || d.status === "suppressed") return { error: `the week is ${d.status}; its text is changed only by a correction` };
  if (d.summary_status !== "leased") return { error: `the week's summary is ${d.summary_status}, not leased: lease it first` };
  const res = checkSummary(lines, d.summary_input, d.record);
  const { text } = fitPost(await rowMeta(d), d.numbers, res.kept);
  console.log(`weekly ${id}: summary from ${model}: kept ${res.kept.length}, dropped ${res.dropped.length}${res.dropped.map((x) => `; ${x.why}`).join("")}`);
  await q(`UPDATE weekly_digests SET summary = $2, summary_dropped = $3, summary_status = 'done', summary_leased_until = NULL, summary_model = $4, summary_at = now(), text_md = $5 WHERE id = $1`,
    [id, JSON.stringify(res.kept), JSON.stringify(res.dropped), model.slice(0, 120), text]);
  return res;
}

// ---------- schedule, approval, posting, correction ----------

/** The last whole Monday-to-Sunday week before `now` in Copenhagen, and whether its build hour has come. */
export async function lastWeek(now: Date, buildHour: number): Promise<{ start: string; end: string; due: boolean }> {
  const r = await one<any>(`WITH l AS (SELECT ($1::timestamptz AT TIME ZONE '${TZ}') AS t), m AS (SELECT date_trunc('week', t)::date AS monday, t FROM l)
    SELECT to_char(monday - 7, 'YYYY-MM-DD') AS s, to_char(monday - 1, 'YYYY-MM-DD') AS e, t >= monday + make_interval(hours => $2) AS due FROM m`, [now, buildHour]);
  return { start: r.s, end: r.e, due: !!r.due };
}

async function send(fetchImpl: Fetch, url: string, method: string, body: any): Promise<any> {
  const r = await fetchImpl(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, allowed_mentions: { parse: [] }, flags: 4 }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`webhook ${method} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return method === "POST" ? r.json() : null;
}
const withPath = (u: URL, extra: string, wait: boolean): string => { const x = new URL(u.toString()); x.pathname = x.pathname.replace(/\/$/, "") + extra; if (wait) x.searchParams.set("wait", "true"); return x.toString(); };

export type WeeklyDispatch = { built: number[]; posted: number[]; waiting: Record<string, string> };
/** One pass for one project: build last week when its hour has come, then post what is due. Safe from two containers: claims first. */
export async function weeklyPass(slug: string, opts: { now?: Date; fetchImpl?: Fetch; env?: Record<string, string | undefined> } = {}): Promise<WeeklyDispatch> {
  const now = opts.now ?? new Date(), fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as Fetch);
  const out: WeeklyDispatch = { built: [], posted: [], waiting: {} };
  const cfg = weeklyConfig(readProjectConfig(slug)); if (!cfg.enabled || !cfg.since) return out;
  const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [slug]); if (!p) return out;
  const w = await lastWeek(now, cfg.build_hour);
  if (w.due && w.start >= cfg.since) { const b = await buildWeek(slug, w.start, w.end); if (b.created) out.built.push(b.id); }
  const hook = weeklyWebhook(cfg, opts.env ?? process.env);
  for (const d of await q<any>(`SELECT * FROM weekly_digests WHERE problem_id = $1 AND status IN ('held','ready','approved') AND posted_at IS NULL ORDER BY week_start`, [p.id])) {
    if (d.status === "held") { out.waiting[d.id] = "waits for the owner's approval"; continue; }
    if (new Date(d.publish_at) > now) { out.waiting[d.id] = `publishes at ${new Date(d.publish_at).toISOString()}`; continue; }
    // A summary still being written at publish time is let go: the post goes out with numbers only, as the proposal says.
    if (["waiting", "leased"].includes(d.summary_status)) await q(`UPDATE weekly_digests SET summary_status = 'none', summary_leased_until = NULL WHERE id = $1 AND summary_status IN ('waiting','leased')`, [d.id]);
    if (!announceEnabled()) { out.waiting[d.id] = "ANNOUNCE_ENABLED is off"; continue; }
    if (!hook) { out.waiting[d.id] = `webhook unset (${cfg.webhook_env})`; continue; }
    const cur = await one<any>(`SELECT text_md FROM weekly_digests WHERE id = $1`, [d.id]);
    const payload = { content: cur.text_md };
    const claimed = await one(`UPDATE weekly_digests SET status = 'posted', posted_at = $2, payload = $3 WHERE id = $1 AND status IN ('ready','approved') AND posted_at IS NULL RETURNING id`, [d.id, now, JSON.stringify(payload)]);
    if (!claimed) continue;
    try {
      const msg = await send(fetchImpl, withPath(hook, "", true), "POST", payload);
      await q(`UPDATE weekly_digests SET discord_message_id = $2 WHERE id = $1`, [d.id, msg?.id ? String(msg.id) : null]);
      out.posted.push(Number(d.id));
    } catch (err: any) {
      await q(`UPDATE weekly_digests SET status = $2, posted_at = NULL, payload = NULL WHERE id = $1`, [d.id, d.status]);
      out.waiting[d.id] = `send failed: ${err?.message ?? err}`;
      console.error(`weekly ${slug}: post of #${d.id} failed, will retry:`, err?.message ?? err);
    }
  }
  return out;
}

/** The owner's approval of a held week (the `approve` command, or the owner's button on the week page). It posts on the next pass. */
export async function approveWeek(id: number, by: string): Promise<boolean> {
  return !!(await one(`UPDATE weekly_digests SET status = 'approved', approved_at = now(), approved_by = $2 WHERE id = $1 AND status = 'held' RETURNING id`, [id, by.slice(0, 200)]));
}
export async function suppressWeek(id: number, by: string): Promise<boolean> {
  return !!(await one(`UPDATE weekly_digests SET status = 'suppressed', approved_by = $2 WHERE id = $1 AND status IN ('held','ready','approved') AND posted_at IS NULL RETURNING id`, [id, `suppressed by ${by}`.slice(0, 200)]));
}

/** A wrong line in a posted week: the message is edited in place (never a second post), and the old text is kept with the reason. */
export async function correctWeek(id: number, text: string, reason: string, opts: { fetchImpl?: Fetch; env?: Record<string, string | undefined>; now?: Date } = {}): Promise<{ ok: true } | { error: string }> {
  const d = await one<any>(`SELECT d.*, p.slug FROM weekly_digests d JOIN problems p ON p.id = d.problem_id WHERE d.id = $1`, [id]);
  if (!d) return { error: "no such week" };
  if (!reason.trim()) return { error: "a correction needs its reason" };
  if (text.length > 2000) return { error: `the text is ${text.length} characters; Discord takes 2,000` };
  const now = opts.now ?? new Date();
  const entry = { at: now.toISOString(), reason: reason.slice(0, 500), previous: d.text_md };
  if (d.status === "posted") {
    const hook = weeklyWebhook(weeklyConfig(readProjectConfig(d.slug)), opts.env ?? process.env);
    if (!hook) return { error: "webhook unset: the posted message cannot be edited" };
    if (!d.discord_message_id) return { error: "no message id on record to edit" };
    await send(opts.fetchImpl ?? (globalThis.fetch as unknown as Fetch), withPath(hook, `/messages/${d.discord_message_id}`, false), "PATCH", { content: text });
  }
  await q(`UPDATE weekly_digests SET text_md = $2, corrections = corrections || $3::jsonb, corrected_at = $4, payload = CASE WHEN status = 'posted' THEN jsonb_build_object('content', $2::text) ELSE payload END WHERE id = $1`,
    [id, text, JSON.stringify([entry]), now]);
  return { ok: true };
}

/** The week a Monday email carries: the newest published week of the project that ended in the last 8 days. */
export async function emailWeek(problemId: number, now = new Date()): Promise<{ week_end: string; label: string; lines: SummaryLine[] } | null> {
  const d = await one<any>(`SELECT to_char(d.week_start, 'YYYY-MM-DD') AS s, to_char(d.week_end, 'YYYY-MM-DD') AS e, d.summary FROM weekly_digests d
    WHERE d.problem_id = $1 AND ${PUBLISHED_SQL} AND d.to_at > $2::timestamptz - interval '8 days' AND d.to_at <= $2 ORDER BY d.week_start DESC LIMIT 1`, [problemId, now]);
  return d ? { week_end: d.e, label: weekLabel(d.s, d.e), lines: d.summary ?? [] } : null;
}

let running = false;
/** The periodic pass (server.ts, beside the record posts). */
export async function weeklyTick(): Promise<void> {
  if (running) return;
  running = true;
  try { for (const s of weeklySlugs()) await weeklyPass(s).catch((e) => console.error(`weekly ${s}:`, e?.message ?? e)); } finally { running = false; }
}
