/**
 * robots.txt and sitemap.xml (Sep 25 2026, #sah-seo-optimize). The sitemap lists every public page worth finding: the projects,
 * their papers, research routes, results, the published documents of the body of work, and the people with work on the record.
 * Operational pages (jobs, asks, who holds what, file attachments, history, the seed edition) carry noindex and are left out.
 * It is built from the database on request and held for ten minutes, so it stays current without a job to run.
 */
import { Router } from "express";
import { join } from "node:path";
import { q } from "../db/index.js";
import { ROOT } from "../lib/paths.js";
import { readPublication, publishedDocument } from "../lib/document-publication.js";
import { BASE, indexNowKey } from "../lib/seo.js";

export const seo = Router();
const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const MAX_URLS = 50_000;   // the protocol's limit per file; past it this becomes a sitemap index
const TTL_MS = 10 * 60_000;

seo.get("/robots.txt", (_req, res) => {
  res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(
`User-agent: *
Allow: /
Disallow: /auth/
Disallow: /settings
Disallow: /me
Disallow: /*?raw=
Disallow: /*&raw=
Disallow: /*?format=json
Disallow: /*?json=

Sitemap: ${BASE()}/sitemap.xml
`);
});

// IndexNow (#sah-search-console-sitemaps): the key file must sit at the root to cover every URL on the host, so it is served
// from public/indexnow.txt here rather than under /assets. scripts/indexnow.mjs pings with the sitemap after a deploy.
const INDEXNOW_KEY = indexNowKey();
if (INDEXNOW_KEY) seo.get(`/${INDEXNOW_KEY}.txt`, (_req, res) => { res.type("text/plain").set("Cache-Control", "public, max-age=86400").send(INDEXNOW_KEY); });

type Url = { loc: string; lastmod?: string | Date | null };
const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const loc = (path: string) => BASE() + path.split("/").map((seg) => seg.startsWith("@") ? "@" + encodeURIComponent(seg.slice(1)) : encodeURIComponent(seg)).join("/");
const day = (d: string | Date | null | undefined) => { if (!d) return undefined; const t = new Date(d); return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10); };

export async function sitemapUrls(): Promise<Url[]> {
  const urls: Url[] = [{ loc: "/" }, { loc: "/terms" }, { loc: "/dumps" }];
  const projects = await q(`SELECT p.id, p.slug, (SELECT max(r.created_at) FROM returns r WHERE r.problem_id = p.id) AS last FROM problems p ORDER BY p.id`);
  for (const p of projects) {
    const P = `/projects/${p.slug}`;
    urls.push({ loc: P, lastmod: p.last }, { loc: `${P}/trust` }, { loc: `${P}/research-routes` }, { loc: `${P}/docs` });
    for (const x of await q(`SELECT slug, updated_at FROM papers WHERE problem_id = $1 ORDER BY id`, [p.id])) urls.push({ loc: `${P}/papers/${x.slug}`, lastmod: x.updated_at });
    for (const x of await q(`SELECT id, updated_at FROM research_routes WHERE problem_id = $1 ORDER BY id`, [p.id])) urls.push({ loc: `${P}/research-routes/${x.id}`, lastmod: x.updated_at });
    const root = join(REPOS, p.slug), publication = readPublication(root);
    if (publication) for (const f of Object.keys(publication.files).sort()) if (f.endsWith(".md") && publishedDocument(root, f, publication)) urls.push({ loc: `${P}/docs/${f}` });
    for (const x of await q(`SELECT r.id, GREATEST(r.created_at, (SELECT max(d.decided_at) FROM return_decisions d WHERE d.return_id = r.id)) AS lastmod FROM returns r WHERE r.problem_id = $1 ORDER BY r.id`, [p.id])) urls.push({ loc: `${P}/return/${x.id}`, lastmod: x.lastmod });
  }
  // People with work on the record; a handle with none is served with noindex, so it is not listed.
  for (const u of await q(`SELECT u.handle, GREATEST((SELECT max(created_at) FROM returns r WHERE r.user_id = u.id), (SELECT max(created_at) FROM reviews v WHERE v.user_id = u.id)) AS lastmod FROM users u
      WHERE EXISTS (SELECT 1 FROM returns r WHERE r.user_id = u.id) OR EXISTS (SELECT 1 FROM reviews v WHERE v.user_id = u.id) ORDER BY u.id`)) urls.push({ loc: `/@${u.handle}`, lastmod: u.lastmod });
  return urls;
}

let cached: { at: number; xml: string } | null = null;
seo.get("/sitemap.xml", async (_req, res, next) => {
  try {
    if (!cached || Date.now() - cached.at > TTL_MS) {
      const urls = (await sitemapUrls()).slice(0, MAX_URLS);
      cached = { at: Date.now(), xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${xmlEsc(loc(u.loc))}</loc>${day(u.lastmod) ? `<lastmod>${day(u.lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n` };
    }
    res.type("application/xml").set("Cache-Control", "public, max-age=600").send(cached.xml);
  } catch (e) { next(e); }
});
