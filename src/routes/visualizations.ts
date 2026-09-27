/** Visualizations of a project's public record and the event stream they are drawn from (src/lib/visualizations.ts, src/lib/timeline.ts). */
import { Router } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { one, q } from "../db/index.js";
import { wantsHtml } from "../lib/negotiate.js";
import { PUBLIC_DIR } from "../lib/paths.js";
import { featuredProject, readProjectConfig } from "../lib/projects.js";
import { shareMeta } from "../lib/share.js";
import { abs, breadcrumbs, jsonLd, notFoundPage } from "../lib/seo.js";
import { TIMELINE_COUNT_SQL, TIMELINE_FIELDS, TIMELINE_PAGE, TIMELINE_SQL, cursorOf, encodeEvent, parseCursor } from "../lib/timeline.js";
import { VISUALIZATIONS, visualization } from "../lib/visualizations.js";

export const visualizations = Router({ mergeParams: true });
export const visualizationsRoot = Router();

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const project = (slug: string) => one<{ id: number; slug: string; name: string }>(`SELECT id, slug, name FROM problems WHERE slug = $1`, [slug]);
/** The first moment worth replaying: project.json's launched_at (testing before launch is left out), else everything. */
const floor = (slug: string) => { const at = readProjectConfig(slug)?.launched_at; return at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null; };

/**
 * GET /projects/:slug/timeline?after=<cursor>: up to 5,000 events after the cursor, oldest first (the wire form is in
 * src/lib/timeline.ts). `next` is set while more history follows; once caught up, poll with `after=cursor` for new events.
 * A full page never changes but for a late decision, so it may be kept for minutes; the tail is kept seconds.
 */
visualizations.get("/timeline", async (req: any, res) => {
  const p = await project(req.params.slug);
  if (!p) { res.status(404).json({ error: "unknown project" }); return; }
  const after = req.query.after === undefined ? null : parseCursor(req.query.after);
  if (req.query.after !== undefined && !after) { res.status(400).json({ error: "after must be the cursor of a previous page, as returned in next or cursor" }); return; }
  const limit = Math.min(TIMELINE_PAGE, Math.max(1, Number(req.query.limit) || TIMELINE_PAGE));
  const start = floor(p.slug);
  const rows = await q(TIMELINE_SQL, [p.id, start, after?.t ?? null, after?.k ?? null, after?.id ?? null, limit]);
  const last = rows.length ? cursorOf(rows[rows.length - 1]) : after ? `${after.t}|${after.k}|${after.id}` : null;
  const full = rows.length === limit;
  const head = after ? {} : {
    start: start ?? (rows[0] ? new Date(rows[0].t).toISOString() : null),
    total: (await one<{ n: number }>(TIMELINE_COUNT_SQL, [p.id, start]))?.n ?? rows.length,
    lanes: await q(`SELECT slug, title FROM lanes WHERE problem_id = $1 ORDER BY id`, [p.id]),
    fields: TIMELINE_FIELDS,
  };
  res.setHeader("Cache-Control", full && after ? "public, max-age=300" : "public, max-age=15");
  res.json({ project: p.slug, as_of: new Date().toISOString(), ...head, events: rows.map(encodeEvent), next: full ? last : null, cursor: last });
});

const shell = () => readFileSync(join(PUBLIC_DIR, "visualization.html"), "utf8");

/** GET /projects/:slug/visualizations: the registry for a client; a browser opens the first type. */
visualizations.get("/visualizations", async (req: any, res) => {
  const p = await project(req.params.slug);
  if (!p) { if (wantsHtml(req)) res.status(404).type("text/html").send(notFoundPage("No such project.")); else res.status(404).json({ error: "unknown project" }); return; }
  if (wantsHtml(req)) { res.redirect(302, `/projects/${p.slug}/visualizations/${VISUALIZATIONS[0].type}`); return; }
  res.json({ project: p.slug, data: { timeline: `/projects/${p.slug}/timeline` }, visualizations: VISUALIZATIONS.map((v) => ({ ...v, path: `/projects/${p.slug}/visualizations/${v.type}` })) });
});

visualizations.get("/visualizations/:type", async (req: any, res) => {
  const p = await project(req.params.slug), v = visualization(String(req.params.type));
  if (!p || !v) { if (wantsHtml(req)) res.status(404).type("text/html").send(notFoundPage(p ? "No such visualization." : "No such project.")); else res.status(404).json({ error: p ? "unknown visualization" : "unknown project", visualizations: VISUALIZATIONS.map((x) => x.type) }); return; }
  if (!wantsHtml(req)) { res.json({ project: p.slug, ...v, data: { timeline: `/projects/${p.slug}/timeline` } }); return; }
  const path = `/projects/${p.slug}/visualizations/${v.type}`;
  const tabs = VISUALIZATIONS.map((x) => `<a href="/projects/${esc(p.slug)}/visualizations/${esc(x.type)}"${x.type === v.type ? ' aria-current="page"' : ""}>${esc(x.title)}</a>`).join("");
  const ld = jsonLd({ "@context": "https://schema.org", "@graph": [breadcrumbs([{ name: "solveathome", path: "/" }, { name: p.name, path: `/projects/${p.slug}` }, { name: v.title, path }]), { "@type": "WebPage", "@id": abs(path), url: abs(path), name: `${v.title} · ${p.name}`, description: v.summary }] });
  res.type("text/html").send(shell()
    .replace("__SHARE__", shareMeta({ title: `${v.title} · ${p.name} · solveathome`, description: v.summary, path }) + ld)
    .replaceAll("__SLUG__", esc(p.slug)).replaceAll("__NAME__", esc(p.name)).replaceAll("__TYPE__", esc(v.type)).replaceAll("__TITLE__", esc(v.title))
    .replace("__SUMMARY__", esc(v.summary)).replace("__TABS__", tabs).replace("__SCRIPT__", esc(v.script)));
});

/** /visualizations and /visualizations/<type>: the featured project's. The site header links here. */
visualizationsRoot.get(["/visualizations", "/visualizations/:type"], async (req: any, res) => {
  const f = await featuredProject();
  if (!f) { res.status(404).type("text/html").send(notFoundPage("No project to show yet.")); return; }
  res.redirect(302, `/projects/${f.slug}/visualizations${req.params.type ? `/${encodeURIComponent(String(req.params.type))}` : ""}`);
});
