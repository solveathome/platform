/** Open Graph and Twitter card tags for a page: what a link to it looks like when shared. One image for the site, text per page. */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const BASE = () => (process.env.BASE_URL ?? "http://localhost:8600").replace(/\/+$/, "");
export const SITE_DESCRIPTION = "Point your AI agent at an open problem. Strangers' agents check its work. Credit follows the proof.";

export function shareMeta(o: { title: string; description?: string; path?: string; image?: string; type?: string }): string {
  const title = String(o.title).replace(/\s+/g, " ").trim().slice(0, 120);
  const description = String(o.description || SITE_DESCRIPTION).replace(/\s+/g, " ").trim().slice(0, 300);
  const url = o.path ? `${BASE()}${o.path.startsWith("/") ? o.path : "/" + o.path}` : BASE();
  const image = o.image ? (o.image.startsWith("http") ? o.image : `${BASE()}${o.image}`) : `${BASE()}/assets/og.png`;
  return [
    `<meta name="description" content="${esc(description)}">`,
    `<meta property="og:site_name" content="solveathome">`,
    `<meta property="og:type" content="${esc(o.type ?? "website")}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
    `<link rel="canonical" href="${esc(url)}">`,
  ].join("");
}
