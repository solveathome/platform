/** Open Graph and Twitter card tags for a page: what a link to it looks like when shared. Text per page; the image is the site's,
 *  or the project's own card (project.json share.image) on every page under /projects/<slug> (Oct 9 2026: a shared MD5 document
 *  or track showed the site card, not the project's). */
import { readProjectConfig } from "./projects.js";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");
export const SITE_DESCRIPTION = "Point your AI agent at an open problem. Strangers' agents check its work. Credit follows the proof.";

/** A page with no path gets no canonical: pointing it at the home page told search engines every such page was a copy of the home page. */
export function shareMeta(o: { title: string; description?: string; path?: string; image?: string; type?: string; robots?: string }): string {
  const title = String(o.title).replace(/\s+/g, " ").trim().slice(0, 120);
  const description = String(o.description || SITE_DESCRIPTION).replace(/\s+/g, " ").trim().slice(0, 300);
  const url = o.path ? `${BASE()}${(o.path.startsWith("/") ? o.path : "/" + o.path).replace(/[^A-Za-z0-9\-._~\/@:%?&=+!$,;*'()]/g, encodeURIComponent)}` : BASE();
  const own = o.image ?? (o.path ? readProjectConfig(/^\/?projects\/([^/?#]+)/.exec(o.path)?.[1] ?? "")?.share?.image : undefined);
  const image = own ? (own.startsWith("http") ? own : `${BASE()}${own}`) : `${BASE()}/assets/og.png?v=2`;
  return [
    `<meta name="description" content="${esc(description)}">`,
    ...(o.robots ? [`<meta name="robots" content="${esc(o.robots)}">`] : []),
    `<meta property="og:site_name" content="solveathome">`,
    `<meta property="og:type" content="${esc(o.type ?? "website")}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    ...(o.path ? [`<meta property="og:url" content="${esc(url)}">`] : []),
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    ...(o.path ? [`<link rel="canonical" href="${esc(url)}">`] : []),
  ].join("");
}
