/**
 * The front page holds every public problem (Oct 9 2026, the two-problem design): a numbered index in the hero and one card per
 * problem, all built the same way, then a "Propose a problem" entry that goes to the Discord. A hidden project (listed: false) is
 * never on it, the same rule as /projects and the sitemap; publishing a project is what puts it here, with no code change.
 * The card's fixed parts come from the project folder: project.json (name, tagline, launched_at, challenge, home.field, home.why,
 * home.standing) and the home-hero partial (the emblem). The live figures (standings, records, the swarm, one leaderboard across
 * problems) are rendered here too, in the first HTML (client, Oct 2026: "agent stats ... just loaded as the page loaded ... no slowdown
 * in page load"): nothing is fetched or rewritten after load. They come from homeData(), a short in-memory cache that is served
 * stale while one rebuild runs in the background, so no visitor waits for the standings queries (cache.ts does the same for pages).
 */
import { q } from "../db/index.js";
import { readProjectConfig, projectPartial, unlistedSlugs, type ProjectConfig } from "./projects.js";
import { standings } from "./standings.js";
import { trackView, currentTarget } from "./challenges.js";
import { creditHtml } from "./display-name.js";

export const PROPOSE_URL = "https://discord.gg/b7Jmj5rKH";

export type HomeProject = { id?: number; slug: string; name: string; summary: string; cfg: ProjectConfig | null; hero: string | null };

const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (i: number) => String(i + 1).padStart(3, "0");
const since = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? `Since ${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}` : "";
};

/** Public projects in launch order (problem id). A hidden slug is left out whatever its row says. */
export function publicProjects(rows: { id?: number | string; slug: string; name: string; summary?: string | null }[], hidden: string[]): HomeProject[] {
  return rows.filter((r) => !hidden.includes(r.slug)).map((r): HomeProject | null => {
    const cfg = readProjectConfig(r.slug);
    if (cfg?.listed === false) return null;
    return { id: r.id == null ? undefined : Number(r.id), slug: r.slug, name: cfg?.name ?? r.name, summary: r.summary ?? cfg?.summary ?? "", cfg, hero: projectPartial(r.slug, "home-hero") };
  }).filter((p): p is HomeProject => !!p);
}

export async function loadHomeProjects(): Promise<HomeProject[]> {
  return publicProjects(await q<{ id: number; slug: string; name: string; summary: string | null }>(`SELECT id, slug, name, summary FROM problems ORDER BY id`), unlistedSlugs());
}

export function homeIndex(projects: HomeProject[], d?: HomeData): string {
  return projects.map((p, i) => `<li><a href="#p-${esc(p.slug)}"><span class="n">${num(i)}</span><span><b>${esc(p.name)}</b>${p.cfg?.home?.field ? `<small>${esc(p.cfg.home.field)}</small>` : ""}</span><span class="state">${d?.by[p.slug] ? `${n(d.by[p.slug]!.totals.agents_24h)} agents` : ""}</span></a></li>`).join("")
    + `<li class="next"><a href="${PROPOSE_URL}" rel="noopener"><span class="n">${num(projects.length)}</span><span><b>Propose a problem</b><small>Suggest the next one on Discord</small></span><span class="state" aria-hidden="true">↗</span></a></li>`;
}

export function homeCards(projects: HomeProject[], d?: HomeData): string {
  return projects.map((p, i) => {
    const c = p.cfg, s = esc(p.slug), h = c?.home;
    return `<article class="mf-card" id="p-${s}" data-project="${s}"${c?.challenge ? " data-challenge" : ""} aria-labelledby="t-${s}">
      <div class="mf-card-top"><span>Problem ${num(i)}${h?.field ? ` · ${esc(h.field)}` : ""}</span><span>${esc(since(c?.launched_at))}</span></div>
      <h3 id="t-${s}"><a href="/projects/${s}">${esc(p.name)}</a></h3>
      <p class="question">${esc(c?.tagline ?? p.summary)}</p>
      ${p.hero ? `<div class="mf-emblem">${p.hero}</div>` : ""}
      ${h?.why ? `<p class="why"><b>Why it matters.</b> ${esc(h.why)}</p>` : ""}
      <div class="mf-stand">${h?.standing ? `<p class="mf-headline">${esc(h.standing)}</p>` : ""}<div data-standing>${standingHtml(d?.by[p.slug])}</div></div>
      <div class="mf-board"><h4><span>Top contributors, 30 days · points</span><a class="text-link" href="/projects/${s}#contributors">Full board ↗</a></h4><ol data-leaders>${leadersHtml(d?.by[p.slug])}</ol></div>
      <div class="mf-actions"><a class="button primary" href="/projects/${s}#contribute">Contribute your agent <span aria-hidden="true">↗</span></a><a class="button secondary" href="/projects/${s}">Explore the problem</a></div>
    </article>`;
  }).join("") + `<article class="mf-card next" aria-labelledby="t-propose">
      <div class="mf-card-top"><span>Problem ${num(projects.length)} · any field</span></div>
      <h3 id="t-propose">Propose a problem.</h3>
      <p class="why">Know an open problem that agents could move forward, where every result can be checked? Suggest it on our Discord, with why it matters and how progress would be measured.</p>
      <div class="mf-actions"><a class="button secondary" href="${PROPOSE_URL}" rel="noopener">Propose a problem on Discord <span aria-hidden="true">↗</span></a></div>
    </article>`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Live figures, in the first render.

type Totals = Record<string, string | number>;
type Person = { handle: string; display_name?: string | null; points: string | number };
type Track = { id: string; name: string; better: "higher" | "lower"; max: number | null; best: number | null; published: number | null };
type Figures = { totals: Totals; people: Person[]; active: number | null; tracks: Track[] | null };
export type HomeData = { at: number; by: Record<string, Figures | null> };

async function figures(p: HomeProject): Promise<Figures | null> {
  if (p.id == null) return null;
  const [all, recent, tracks] = await Promise.all([
    standings(p.id, "all", 10),
    standings(p.id, "30d", 10, null, "points"),
    p.cfg?.challenge ? Promise.all(p.cfg.challenge.tracks.map(async (t) => {
      const v = await trackView(p.id!, t, "live");
      return { id: t.id, name: t.name, better: t.better, max: t.max ?? null, best: v.best ? Number(v.best.value) : null, published: currentTarget(t)?.value ?? null } as Track;
    })) : Promise.resolve(null),
  ]);
  const r: any = recent;
  const people = ((r.active_people || r.people || []) as Person[]).filter((x) => Number(x.points) > 0);
  return { totals: (all as any).totals ?? {}, people, active: r.active_people_total ?? r.people_total ?? null, tracks };
}

/** One rebuild of every public project's figures; a project that fails shows "unavailable" and the rest still render. */
export async function loadHomeData(projects: HomeProject[]): Promise<HomeData> {
  const got = await Promise.all(projects.map((p) => figures(p).catch((e) => { console.error(`home figures ${p.slug}:`, e?.message ?? e); return null; })));
  return { at: Date.now(), by: Object.fromEntries(projects.map((p, i) => [p.slug, got[i]])) };
}

// 30 s fresh, then served stale while one background rebuild runs; after 10 min unused it is rebuilt before the render.
// A warm-up at start and every 5 min (server.ts) keeps the first visitor after a restart or a quiet hour off the queries.
export const HOME_TTL_MS = 30_000, HOME_STALE_MS = 10 * 60_000;
let cached: { key: string; data: HomeData } | null = null;
let building: Promise<HomeData> | null = null;
function rebuild(projects: HomeProject[], key: string): Promise<HomeData> {
  building ??= loadHomeData(projects).then((data) => { cached = { key, data }; return data; }).finally(() => { building = null; });
  return building;
}
export async function homeData(projects: HomeProject[]): Promise<HomeData> {
  const key = projects.map((p) => p.slug).join(",");
  const age = cached && cached.key === key ? Date.now() - cached.data.at : Infinity;
  if (age < HOME_TTL_MS) return cached!.data;
  if (age < HOME_STALE_MS) { rebuild(projects, key).catch(() => {}); return cached!.data; }
  return rebuild(projects, key);
}
export async function warmHome(): Promise<void> { const list = await loadHomeProjects(); await rebuild(list, list.map((p) => p.slug).join(",")); }

const fmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const n = (v: unknown) => fmt.format(Number(v) || 0);
const pts = (v: unknown) => fmt.format(Math.round(Number(v) || 0));   // whole points everywhere on this page

function factsHtml(t: Totals): string {
  return `<dl class="mf-facts"><div><dt>accepted results</dt><dd>${n(t.returns_accepted)}</dd></div><div><dt>in review</dt><dd>${n(t.returns_pending)}</dd></div><div><dt>agents, 24 h</dt><dd>${n(t.agents_24h)}</dd></div></dl>`;
}
function tracksHtml(tracks: Track[]): string {
  const rows = tracks.map((t) => {
    const higher = t.better === "higher", top = t.max;
    const show = (v: number | null) => v == null ? "none yet" : higher && top ? `${n(v)} of ${n(top)}` : `${n(v)}${t.better === "lower" ? " bytes" : ""}`;
    const pct = (v: number) => `${Math.min(100, 100 * v / top!).toFixed(1)}%`;
    const bar = higher && top ? `<span class="mf-bar" aria-hidden="true">${t.best != null ? `<i style="width:${pct(t.best)}"></i>` : ""}${t.published != null ? `<s style="left:${pct(t.published)}"></s>` : ""}</span>` : "";
    return `<li><span>${esc(t.name)}</span><span class="v">here: ${esc(show(t.best))}${t.published != null ? ` · published: ${esc(show(t.published))}` : ""}</span>${bar}</li>`;
  }).join("");
  const lower = tracks.some((t) => t.better === "lower");
  return `<h4><span>Where the records stand</span></h4><ul class="mf-tracks">${rows}</ul><p class="mf-legend">Bar: best result verified here. Dashed mark: best published result, credited to its finder.${lower ? " Collision: fewer bytes is better." : ""}</p>`;
}
const standingHtml = (f: Figures | null | undefined) => !f ? `<p class="community-fine">Live figures are unavailable right now.</p>` : f.tracks ? tracksHtml(f.tracks) : factsHtml(f.totals);
const leadersHtml = (f: Figures | null | undefined) => !f ? `<li class="empty">Contributors are unavailable right now.</li>`
  : f.people.length ? f.people.slice(0, 3).map((p, i) => `<li><span>${i + 1}</span>${creditHtml(p)}<b>${pts(p.points)}</b></li>`).join("")
  : `<li class="empty">No accepted work yet. The first contributor leads this board.</li>`;

/** The hero's figures for all problems together: sessions, accepted results and reviews belong to one problem each, so they add up. */
export function homeSwarm(projects: HomeProject[], d?: HomeData): string {
  const ok = projects.map((p) => d?.by[p.slug]).filter((f): f is Figures => !!f);
  if (!ok.length) return "";
  const sum = (k: string) => ok.reduce((s, f) => s + (Number(f.totals[k]) || 0), 0);
  return `<div><b>${n(sum("agents_24h"))}</b><span>agents, 24 h</span></div><div><b>${n(sum("returns_accepted"))}</b><span>accepted results</span></div><div><b>${n(sum("reviews"))}</b><span>reviews</span></div>`;
}

/** One leaderboard across problems over 30 days: a person's points add up, with a chip per problem once there is more than one. */
export function homeLeaders(projects: HomeProject[], d?: HomeData): { rows: string; state: string } {
  const merged = new Map<string, Person & { total: number; by: string[] }>();
  for (const p of projects) for (const x of d?.by[p.slug]?.people ?? []) {
    const k = x.handle.toLowerCase(), e = merged.get(k) ?? { ...x, total: 0, by: [] };
    e.total += Number(x.points) || 0; e.by.push(`${p.name} ${pts(x.points)}`); merged.set(k, e);
  }
  const top = [...merged.values()].sort((a, b) => b.total - a.total).slice(0, 5), many = projects.length > 1;
  const rows = top.length ? top.map((e, i) => `<li><span class="r">${String(i + 1).padStart(2, "0")}</span><span class="who-cell">${creditHtml(e)}${many ? `<span class="chips">${e.by.map((c) => `<span>${esc(c)}</span>`).join("")}</span>` : ""}</span><b>${pts(e.total)}</b></li>`).join("")
    : `<li class="community-empty">No contributors in the last 30 days yet.</li>`;
  const one = projects.length === 1 ? d?.by[projects[0].slug] : null;
  return { rows, state: one && one.active != null ? `${n(one.active)} contributors active in the last 30 days · top 5` : `Top 5 across ${projects.length} problems` };
}
