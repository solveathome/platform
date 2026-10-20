/**
 * A project's own navigation (Oct 20 2026: the site header carried links that only made sense inside the first project). The site
 * header holds only what is site-wide; everything that belongs to one problem is listed here, from that project's config and files,
 * so a second project gets its own items without code: OEIS drafts only where `sequence_proposals` names some, The record only where
 * understanding.md exists, and `nav` in project.json appends links of the project's own.
 *
 * The project page shows the list as its section sidebar (panel tabs); every other page under /projects/<slug> gets it as a bar
 * under the site header, written in by projectNavBar so that no page shell can be left without it.
 */
import type { NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDir, projectPartial, readProjectConfig } from "./projects.js";

export type ProjectNavItem = { label: string; /** a panel of the project page, or a path under /projects/<slug> */ panel?: string; path?: string; /** the sub-pages this item stands for */ match?: RegExp };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function projectNavItems(slug: string): ProjectNavItem[] {
  const cfg = readProjectConfig(slug); if (!cfg) return [];
  const dir = projectDir(slug)!;
  const items: ProjectNavItem[] = [
    { label: "Overview", panel: "overview", match: /^\/(tracks|submissions)(\/|$)/ },   // a record challenge's track pages hang off the charts on its overview
    { label: "Work queue", panel: "work", match: /^\/(board|lanes?|state|asks|who)(\/|$)/ },
    { label: "Discussion", panel: "discussion", match: /^\/chat(\/|$)/ },
  ];
  if (projectPartial(slug, "prior-work")) items.push({ label: "Prior work", panel: "prior-work", match: /^\/(docs|seed|documents|history)(\/|$)/ });
  items.push({ label: "Contributors", panel: "contributors", match: /^\/(standings|leaderboard|credit|trust)(\/|$)/ });
  items.push({ label: "Proposed papers", panel: "papers", match: /^\/(papers|findings|questions)(\/|$)/ });
  if (cfg.sequence_proposals?.length) items.push({ label: "Proposed OEIS sequences", panel: "sequences", match: /^\/sequences(\/|$)/ });
  items.push({ label: "Replay", path: "/visualizations", match: /^\/visualizations(\/|$)/ });
  if (existsSync(join(dir, "understanding.md"))) items.push({ label: "The record", path: "/understanding", match: /^\/understanding(\/|$)/ });
  for (const n of cfg.nav ?? []) if (n?.label && /^\/[a-z0-9/_-]*$/i.test(String(n.path ?? ""))) items.push({ label: String(n.label), path: String(n.path) });
  return items;
}

const href = (slug: string, i: ProjectNavItem) => i.panel ? `/projects/${slug}#${i.panel}` : `/projects/${slug}${i.path}`;

/** The project page's sidebar: panels switch in place (data-panel-link), the rest are links. */
export function projectSectionNav(slug: string): string {
  return projectNavItems(slug).map((i, n) => `<a href="${i.panel ? `#${i.panel}` : esc(href(slug, i))}"${i.panel ? " data-panel-link" : ""}><span>${String(n + 1).padStart(2, "0")}</span>${esc(i.label)}</a>`).join("");
}

/** The bar on a project's sub-pages; `rest` is the path below /projects/<slug>. */
export function projectNavBarHtml(slug: string, rest: string): string {
  const cfg = readProjectConfig(slug); if (!cfg) return "";
  const links = projectNavItems(slug).map((i) => `<a href="${esc(href(slug, i))}"${i.match?.test(rest) ? ' aria-current="page"' : ""}>${esc(i.label)}</a>`).join("");
  return `<nav class="project-nav" aria-label="${esc(cfg.name)}"><div class="shell project-nav-inner"><a class="project-nav-name" href="/projects/${esc(slug)}">${esc(cfg.name)}</a><div class="project-nav-links">${links}</div></div></nav>`;
}

const HEADER = "<header data-site-header></header>";

/** Mounted on /projects/:slug ahead of the response cache, so a cached page gets the bar on every send as well. */
export function projectNavBar(req: Request, res: Response, next: NextFunction): void {
  const slug = String((req.params as any).slug ?? ""), rest = req.path;
  if (req.method !== "GET" || rest === "/" || rest === "" || !readProjectConfig(slug)) { next(); return; }
  const send = res.send.bind(res);
  res.send = ((body: any) => {
    if (typeof body === "string" && body.includes(HEADER) && !body.includes('class="project-nav"') && /html/.test(String(res.getHeader("content-type") ?? "text/html"))) body = body.replace(HEADER, () => HEADER + projectNavBarHtml(slug, rest));
    return send(body);
  }) as any;
  next();
}
