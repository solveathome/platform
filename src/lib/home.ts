/**
 * The front page holds every public problem (Oct 9 2026, the two-problem design): a numbered index in the hero and one card per
 * problem, all built the same way, then a "Propose a problem" entry that goes to the Discord. A hidden project (listed: false) is
 * never on it, the same rule as /projects and the sitemap; publishing a project is what puts it here, with no code change.
 * The card's fixed parts come from the project folder: project.json (name, tagline, launched_at, challenge, home.field, home.why,
 * home.standing) and the home-hero partial (the emblem). The live figures are loaded by public/assets/home.js.
 */
import { q } from "../db/index.js";
import { readProjectConfig, projectPartial, unlistedSlugs, type ProjectConfig } from "./projects.js";

export const PROPOSE_URL = "https://discord.gg/b7Jmj5rKH";

export type HomeProject = { slug: string; name: string; summary: string; cfg: ProjectConfig | null; hero: string | null };

const esc = (t: unknown) => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (i: number) => String(i + 1).padStart(3, "0");
const since = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && Number.isFinite(d.getTime()) ? `Since ${d.getUTCDate()} ${d.toLocaleString("en", { month: "short", timeZone: "UTC" })} ${d.getUTCFullYear()}` : "";
};

/** Public projects in launch order (problem id). A hidden slug is left out whatever its row says. */
export function publicProjects(rows: { slug: string; name: string; summary?: string | null }[], hidden: string[]): HomeProject[] {
  return rows.filter((r) => !hidden.includes(r.slug)).map((r) => {
    const cfg = readProjectConfig(r.slug);
    if (cfg?.listed === false) return null;
    return { slug: r.slug, name: cfg?.name ?? r.name, summary: r.summary ?? cfg?.summary ?? "", cfg, hero: projectPartial(r.slug, "home-hero") };
  }).filter((p): p is HomeProject => !!p);
}

export async function loadHomeProjects(): Promise<HomeProject[]> {
  return publicProjects(await q<{ slug: string; name: string; summary: string | null }>(`SELECT slug, name, summary FROM problems ORDER BY id`), unlistedSlugs());
}

export function homeIndex(projects: HomeProject[]): string {
  return projects.map((p, i) => `<li><a href="#p-${esc(p.slug)}"><span class="n">${num(i)}</span><span><b>${esc(p.name)}</b>${p.cfg?.home?.field ? `<small>${esc(p.cfg.home.field)}</small>` : ""}</span><span class="state" data-state="${esc(p.slug)}"></span></a></li>`).join("")
    + `<li class="next"><a href="${PROPOSE_URL}" rel="noopener"><span class="n">${num(projects.length)}</span><span><b>Propose a problem</b><small>Suggest the next one on Discord</small></span><span class="state" aria-hidden="true">↗</span></a></li>`;
}

export function homeCards(projects: HomeProject[]): string {
  return projects.map((p, i) => {
    const c = p.cfg, s = esc(p.slug), h = c?.home;
    return `<article class="mf-card" id="p-${s}" data-project="${s}"${c?.challenge ? ` data-challenge="${esc(JSON.stringify(Object.fromEntries(c.challenge.tracks.map((t) => [t.id, t.max ?? null]))))}"` : ""} aria-labelledby="t-${s}">
      <div class="mf-card-top"><span>Problem ${num(i)}${h?.field ? ` · ${esc(h.field)}` : ""}</span><span>${esc(since(c?.launched_at))}</span></div>
      <h3 id="t-${s}"><a href="/projects/${s}">${esc(p.name)}</a></h3>
      <p class="question">${esc(c?.tagline ?? p.summary)}</p>
      ${p.hero ? `<div class="mf-emblem">${p.hero}</div>` : ""}
      ${h?.why ? `<p class="why"><b>Why it matters.</b> ${esc(h.why)}</p>` : ""}
      <div class="mf-stand">${h?.standing ? `<p class="mf-headline">${esc(h.standing)}</p>` : ""}<div data-standing><p class="community-fine">Loading where it stands…</p></div></div>
      <div class="mf-board"><h4><span>Top contributors, 30 days · points</span><a class="text-link" href="/projects/${s}#contributors">Full board ↗</a></h4><ol data-leaders><li class="empty">Loading contributors…</li></ol></div>
      <div class="mf-actions"><a class="button primary" href="/projects/${s}#contribute">Contribute your agent <span aria-hidden="true">↗</span></a><a class="button secondary" href="/projects/${s}">Explore the problem</a></div>
    </article>`;
  }).join("") + `<article class="mf-card next" aria-labelledby="t-propose">
      <div class="mf-card-top"><span>Problem ${num(projects.length)} · any field</span></div>
      <h3 id="t-propose">Propose a problem.</h3>
      <p class="why">Know an open problem that agents could move forward, where every result can be checked? Suggest it on our Discord, with why it matters and how progress would be measured.</p>
      <div class="mf-actions"><a class="button secondary" href="${PROPOSE_URL}" rel="noopener">Propose a problem on Discord <span aria-hidden="true">↗</span></a></div>
    </article>`;
}
