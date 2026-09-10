/**
 * Projects (Chris, Sep 10; Q71): the framework knows no particular problem. Everything problem-specific lives under
 * projects/<slug>/ (see projects/README.md) and is read from there by slug: config, briefs, provenance, HTML partials.
 * The featured project is what the front page and the one-line agent instruction point at.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { one } from "../db/index.js";
import { ROOT } from "./paths.js";

export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? join(ROOT, "projects");

export type Lane = { slug: string; title: string; variant?: string };
export type DocsRedirect = { match: string; flags?: string; to: string; why?: string };
export type ProjectConfig = {
  slug: string; name: string; repo_url: string; featured?: boolean; tagline?: string; summary?: string; status_md?: string;
  researcher?: string; lanes?: Lane[]; docs_redirects?: DocsRedirect[]; mirror?: { source_note?: string };
};

const safe = (slug: string) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(slug);
export function projectDir(slug: string): string | null { return safe(slug) ? join(PROJECTS_DIR, slug) : null; }

export function listProjectConfigs(): ProjectConfig[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && safe(d.name)).map((d) => readProjectConfig(d.name)).filter((c): c is ProjectConfig => !!c);
}
export function readProjectConfig(slug: string): ProjectConfig | null {
  const dir = projectDir(slug); if (!dir) return null;
  const f = join(dir, "project.json"); if (!existsSync(f)) return null;
  try { const c = JSON.parse(readFileSync(f, "utf8")); return c && c.slug === slug ? c : null; } catch { return null; }
}
/** An HTML fragment from projects/<slug>/partials/<name>.html, or null when the project has none. */
export function projectPartial(slug: string, name: string): string | null {
  const dir = projectDir(slug); if (!dir || !/^[a-z0-9-]+$/.test(name)) return null;
  const f = join(dir, "partials", `${name}.html`);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}
export function docsRedirect(slug: string, rel: string): string | null {
  for (const r of readProjectConfig(slug)?.docs_redirects ?? []) { try { if (new RegExp(r.match, r.flags ?? "").test(rel)) return r.to; } catch { /* bad pattern: ignore */ } }
  return null;
}

export type Featured = { slug: string; name: string; summary: string; tagline: string };
/** The featured project: FEATURED_PROJECT in the environment, else the problem flagged featured, else the oldest. Null on an empty instance. */
export async function featuredProject(): Promise<Featured | null> {
  const env = (process.env.FEATURED_PROJECT ?? "").trim();
  const row = env
    ? await one<{ slug: string; name: string; summary: string }>(`SELECT slug, name, summary FROM problems WHERE slug = $1`, [env])
    : await one<{ slug: string; name: string; summary: string }>(`SELECT slug, name, summary FROM problems ORDER BY featured DESC, id LIMIT 1`);
  if (!row) return null;
  const cfg = readProjectConfig(row.slug);
  return { slug: row.slug, name: row.name, summary: row.summary ?? "", tagline: cfg?.tagline ?? row.summary ?? "" };
}
