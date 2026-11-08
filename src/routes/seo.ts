/**
 * robots.txt and sitemap.xml (Sep 25 2026, #sah-seo-optimize). The sitemap lists every public page worth finding: the projects,
 * their papers, research routes, results, record-challenge tracks and the submissions that moved a record, the published documents of the
 * body of work, and the people with work on the record.
 * Operational pages (jobs, asks, who holds what, file attachments, history, the seed edition, working files under /docs/) carry noindex and are left out.
 * It is built from the database on request and held for ten minutes, so it stays current without a job to run.
 */
import { readUnderstanding } from "./understanding.js";
import { Router, type Request, type Response, type NextFunction } from "express";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db/index.js";
import { ROOT } from "../lib/paths.js";
import { readPublication, publishedDocument } from "../lib/document-publication.js";
import { BASE, readerDoc } from "../lib/seo.js";
import { unlistedSlugs } from "../lib/projects.js";
import { indexNowKey } from "../lib/indexnow.js";
import { challengeConfig, trackView } from "../lib/challenges.js";
import { projectDir } from "../lib/projects.js";
import { TERMS_VERSION } from "../lib/terms.js";
import { PRIVACY_UPDATED } from "../lib/privacy.js";
import { dumpDays } from "../lib/dump.js";
import { documentRecords, documentDates } from "../lib/document-record.js";
import { sha256 as contentHash } from "../lib/document-publication.js";
import { OVERLAY } from "../lib/revisions.js";
import * as roles from "../lib/roles.js";
import { wantsHtml } from "../lib/negotiate.js";
import { etagOf, httpDate, notModified, type Strip } from "../lib/validators.js";

export const seo = Router();
const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const MAX_URLS = 50_000;   // the protocol's limit per file; past it this becomes a sitemap index
const TTL_MS = 10 * 60_000;
const DUMPS = process.env.DUMP_DIR ?? join(ROOT, "data", "dumps");

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

// IndexNow's key file (src/lib/indexnow.ts): the key, alone, at /<key>.txt.
seo.get("/:file.txt", (req, res, next) => {
  if (req.params.file !== indexNowKey()) return next();
  res.type("text/plain").set("Cache-Control", "public, max-age=3600").send(indexNowKey());
});

type Url = { loc: string; lastmod?: string | Date | null };
const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));
const loc = (path: string) => BASE() + path.split("/").map((seg) => seg.startsWith("@") ? "@" + encodeURIComponent(seg.slice(1)) : encodeURIComponent(seg)).join("/");
const day = (d: string | Date | null | undefined) => { if (!d) return undefined; const t = new Date(d); return Number.isNaN(t.getTime()) ? undefined : t.toISOString().slice(0, 10); };

// A paper's and a route's lastmod is content_at (schema.sql): it moves when the page's content changes, never on a review that
// leaves it as it was (mba ask 7081), or the newest version, report or history entry the page lists (mba ask 7118). Returns, decisions, submissions and people are dated by the rows that make them.
// Every listed page has a lastmod (mba ask 7134): the policy pages their policy's own date, /dumps its newest snapshot, a project's
// lists the newest of what they list, the trust page its newest grant, revocation or member review, the plain-language page its
// file's date (a deploy's git pull touches only changed files; the image copy keeps mtimes), a document its Modified date, and the
// home page the newest return anywhere. The same day is the page's Last-Modified header (pageValidators) and its dateModified.
const newest = (...ds: (string | Date | null | undefined)[]) => ds.map(day).filter((d): d is string => !!d).sort().at(-1);
export async function sitemapUrls(): Promise<Url[]> {
  const home: Url = { loc: "/" };
  const urls: Url[] = [home, { loc: "/terms", lastmod: TERMS_VERSION.slice(0, 10) }, { loc: "/privacy", lastmod: PRIVACY_UPDATED }, { loc: "/dumps", lastmod: dumpDays(DUMPS)[0] }];
  const projects = await q(`SELECT p.id, p.slug, (SELECT max(r.created_at) FROM returns r WHERE r.problem_id = p.id) AS last FROM problems p WHERE NOT (p.slug = ANY($1::text[])) ORDER BY p.id`, [unlistedSlugs()]);   // a hidden project is not in the sitemap
  for (const p of projects) {
    const P = `/projects/${p.slug}`;
    home.lastmod = newest(home.lastmod, p.last);
    const [members, hist] = await Promise.all([roles.roster(Number(p.id)), roles.history(Number(p.id))]);
    const routesIndex: Url = { loc: `${P}/research-routes` }, docsIndex: Url = { loc: `${P}/docs` };
    urls.push({ loc: P, lastmod: p.last }, { loc: `${P}/board`, lastmod: p.last },
      { loc: `${P}/trust`, lastmod: newest(...members.flatMap((m: any) => [m.granted_at, m.last_review]), ...hist.flatMap((h: any) => [h.granted_at, h.revoked_at])) }, routesIndex, docsIndex);
    if (readUnderstanding(p.slug)) { const d = projectDir(p.slug); urls.push({ loc: `${P}/understanding`, lastmod: d ? statSync(join(d, "understanding.md")).mtime : undefined }); }
    // A paper page also lists its versions (returns) and referee reports, a route page its investigation history: a new one is
    // new text on the page even when the paper or route itself stays as it was (mba ask 7118), so the newest of them counts too.
    for (const x of await q(`SELECT pa.slug, GREATEST(pa.content_at,
        (SELECT max(r.created_at) FROM returns r WHERE r.problem_id = pa.problem_id AND r.paper_slug = pa.slug AND r.paper_exposition IS NULL),
        (SELECT max(rv.created_at) FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = pa.problem_id AND r.paper_slug = pa.slug AND r.paper_exposition IS NULL)) AS lastmod
        FROM papers pa WHERE pa.problem_id = $1 AND pa.retracted_at IS NULL ORDER BY pa.id`, [p.id])) urls.push({ loc: `${P}/papers/${x.slug}`, lastmod: x.lastmod });
    for (const x of await q(`SELECT rr.id, GREATEST(rr.content_at, (SELECT max(e.created_at) FROM research_events e WHERE e.route_id = rr.id)) AS lastmod
        FROM research_routes rr WHERE rr.problem_id = $1 ORDER BY rr.id`, [p.id])) { urls.push({ loc: `${P}/research-routes/${x.id}`, lastmod: x.lastmod }); routesIndex.lastmod = newest(routesIndex.lastmod, x.lastmod); }
    const root = join(REPOS, p.slug), publication = readPublication(root);
    // A document's date is the Modified date its page shows (src/routes/docs.ts): the served text (an accepted revision in the overlay, else the mirror) looked up in its record.
    const records = publication ? await documentRecords(Number(p.id)) : new Map();
    if (publication) for (const f of Object.keys(publication.files).sort()) if (readerDoc(f) && publishedDocument(root, f, publication)) {
      const ov = join(OVERLAY, p.slug, f);
      const modified = documentDates(publication, f, records.get(f), contentHash(readFileSync(existsSync(ov) ? ov : join(root, f)))).modified_at;
      urls.push({ loc: `${P}/docs/${f}`, lastmod: modified });
      docsIndex.lastmod = newest(docsIndex.lastmod, modified);
    }
    if (publication && !docsIndex.lastmod) docsIndex.lastmod = day(publication.generated_at);
    for (const x of await q(`SELECT r.id, GREATEST(r.created_at, (SELECT max(d.decided_at) FROM return_decisions d WHERE d.return_id = r.id)) AS lastmod FROM returns r WHERE r.problem_id = $1 ORDER BY r.id`, [p.id])) urls.push({ loc: `${P}/return/${x.id}`, lastmod: x.lastmod });
    // A record challenge's track pages and the submissions that moved its record (Oct 23 2026, #sah-bing-indexing-look-20261023: Bing
    // had found /tracks/self-match only by a link and left it unindexed). The thousands of other submissions are trial entries and stay out.
    const cfg = challengeConfig(p.slug);
    if (cfg) for (const t of cfg.tracks) {
      const v = await trackView(Number(p.id), t);
      urls.push({ loc: `${P}/tracks/${t.lane}`, lastmod: v.best?.received_at });
      for (const st of v.steps) urls.push({ loc: `${P}/submissions/${st.submission_id}`, lastmod: st.received_at });
    }
  }
  // People with work on the record; a handle with none is served with noindex, so it is not listed.
  for (const u of await q(`SELECT u.handle, GREATEST((SELECT max(created_at) FROM returns r WHERE r.user_id = u.id), (SELECT max(created_at) FROM reviews v WHERE v.user_id = u.id)) AS lastmod FROM users u
      WHERE EXISTS (SELECT 1 FROM returns r WHERE r.user_id = u.id) OR EXISTS (SELECT 1 FROM reviews v WHERE v.user_id = u.id) ORDER BY u.id`)) urls.push({ loc: `/@${u.handle}`, lastmod: u.lastmod });
  return urls;
}

/** The sitemap as absolute url -> lastmod day, for IndexNow's change check. */
export async function sitemapSnapshot(): Promise<Map<string, string>> {
  return new Map((await sitemapUrls()).slice(0, MAX_URLS).map((u) => [loc(u.loc), day(u.lastmod) ?? ""]));
}

// The sitemap and every page's lastmod come from one copy, built from the database and held for ten minutes (served stale while
// it rebuilds), so the sitemap, a page's Last-Modified and its dateModified always name the same day.
type SitemapState = { at: number; xml: string; byPath: Map<string, string>; newest?: string };
let cached: SitemapState | null = null, building: Promise<SitemapState> | null = null;
async function buildState(): Promise<SitemapState> {
  const urls = (await sitemapUrls()).slice(0, MAX_URLS), byPath = new Map<string, string>();
  for (const u of urls) { const d = day(u.lastmod); if (d) byPath.set(loc(u.loc).slice(BASE().length) || "/", d); }
  return { at: Date.now(), byPath, newest: [...byPath.values()].sort().at(-1),
    xml: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${xmlEsc(loc(u.loc))}</loc>${day(u.lastmod) ? `<lastmod>${day(u.lastmod)}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n` };
}
export async function sitemapState(): Promise<SitemapState> {
  if (cached && Date.now() - cached.at <= TTL_MS) return cached;
  if (!building) building = buildState().then((s) => (cached = s)).finally(() => { building = null; });
  if (cached) { building.catch((e) => console.error("sitemap rebuild:", e?.message ?? e)); return cached; }
  return building;
}
/** A listed page's lastmod day (the sitemap's), by its path as the sitemap writes it. */
export async function lastmodOf(path: string): Promise<string | undefined> {
  try { return (await sitemapState()).byPath.get(path); } catch { return undefined; }
}

seo.get("/sitemap.xml", async (_req, res, next) => {
  try { res.type("application/xml").set("Cache-Control", "public, max-age=600").send((await sitemapState()).xml); } catch (e) { next(e); }
});

// What moves on a page without a content change, taken out before its ETag is hashed. None today: the site renders no
// re-check date, countdown, nonce or build stamp (record "Checked" columns are static data from known-results.json).
const STRIP: Strip = [];

/** ETag and Last-Modified on every HTML page and on the sitemap, and 304 to a matching If-None-Match or If-Modified-Since
 * (mba ask 7134, rules #r2374, #r2390). Last-Modified is the page's sitemap lastmod (the sitemap's: the newest it lists); a page the
 * sitemap does not list gets the ETag alone. Mounted first, so its send sees the final body after every other wrapper
 * (project nav, page cache, home-path redaction), and a cache hit gets the same headers. */
export async function pageValidators(req: Request, res: Response, next: NextFunction): Promise<void> {
  // The path is read here: inside a router mounted on /projects/:slug, req.path at send time is the router's own remainder.
  const path = req.path, isMap = path === "/sitemap.xml";
  if ((req.method !== "GET" && req.method !== "HEAD") || !(isMap || wantsHtml(req))) return next();
  let state: SitemapState | null = null;
  try { state = await sitemapState(); } catch (e: any) { console.error("validators:", e?.message ?? e); }
  const send = res.send.bind(res);
  res.send = ((body: any) => {
    const type = String(res.get("Content-Type") ?? "");
    if (res.statusCode === 200 && (typeof body === "string" || Buffer.isBuffer(body)) && (isMap ? type.includes("xml") : type.startsWith("text/html"))) {
      const lastmod = isMap ? state?.newest : state?.byPath.get(path);
      const etag = etagOf(body, STRIP);
      res.setHeader("ETag", etag);
      if (lastmod) res.setHeader("Last-Modified", httpDate(lastmod));
      if (notModified(req.headers, etag, lastmod)) {
        for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) res.removeHeader(h);
        res.status(304).end();
        return res;
      }
    }
    return send(body);
  }) as any;
  next();
}
