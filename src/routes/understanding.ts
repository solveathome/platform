/**
 * The record page of a project: what its agents proved, computed, formalised and ruled out, each item linked to its evidence.
 * Written by hand in projects/<slug>/understanding.md (Chris, Oct 15 2026: "a page that in human terms explains our current understanding
 * of the problem, our state of the art, with sources links lean papers etc"). A project without the file has no such page.
 *   GET /projects/:slug/understanding        the page (HTML) or { project, markdown } (JSON)
 */
import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { wantsHtml } from "../lib/negotiate.js";
import { page, esc } from "../lib/page.js";
import { protectMath } from "../lib/math.js";
import { projectDir, readProjectConfig } from "../lib/projects.js";
import { notFoundPage } from "../lib/seo.js";

export const understanding = Router({ mergeParams: true });

/** The file's front matter is two lines, `heading:` and `description:`, then a blank line and the markdown. */
export function readUnderstanding(slug: string): { heading: string; description: string; markdown: string } | null {
  const dir = projectDir(slug); if (!dir) return null;
  const f = join(dir, "understanding.md"); if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { heading: meta.heading ?? "The record", description: meta.description ?? "", markdown: m ? text.slice(m[0].length) : text };
}

const render = (t: string) => { const m = protectMath(t); return m.restore(marked.parse(m.text, { gfm: true }) as string); };

understanding.get("/understanding", (req: any, res) => {
  const slug = String(req.params.slug), cfg = readProjectConfig(slug), doc = cfg ? readUnderstanding(slug) : null;
  if (!cfg || !doc) { res.status(404); if (wantsHtml(req)) res.type("text/html").send(notFoundPage("This project has no plain-language page.")); else res.json({ error: "no such page" }); return; }
  if (!wantsHtml(req)) { res.json({ project: slug, heading: doc.heading, markdown: doc.markdown }); return; }
  const P = `/projects/${slug}`;
  // Tables scroll inside their own box on a phone instead of widening the page.
  // Sources are the point of the page, so its links are underlined (the site's links are bare); its sections read as sections.
  const style = `<style>.understanding{max-width:46rem}.understanding a{text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:.22em;text-decoration-thickness:1px}.understanding a:hover{text-decoration-color:currentColor}.understanding h3{font-size:1.45rem;margin:3rem 0 .75rem;line-height:1.3}.understanding h3:first-of-type{margin-top:2rem}.understanding table{line-height:1.6}.understanding td{overflow-wrap:normal;word-break:normal;hyphens:manual}.understanding td:first-child{min-width:7rem}.understanding td code{overflow-wrap:anywhere;font-size:.8em}.understanding ol,.understanding ul{padding-left:1.25rem}.understanding li{margin-bottom:.4rem}</style>`;
  const body = style + `<div class="understanding">${render(doc.markdown).replace(/<table>/g, '<div class="wrap"><table>').replace(/<\/table>/g, "</table></div>").replace(/<a href="(https?:\/\/[^"]+)"/g, '<a href="$1" rel="noopener"')}</div>`;
  res.type("text/html").send(page({ title: cfg.name, dataPage: "understanding", description: doc.description, path: `${P}/understanding`, crumbs: `<a href="${P}">${esc(cfg.name)}</a><span>/</span>the record`, eyebrow: "Body of work", heading: doc.heading, body, type: "article" }));
});
