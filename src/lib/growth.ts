/**
 * The growth cap (mba #mba-bot-sites-growth-cap, ask 2204; Chris, Oct 14 2026: "each time we get a scan, never grow more than 15% in
 * total content until next scan has completed", and under 2 % for a site Google has dropped, which solveathome is: 0.0199).
 * A scan is a new day in Search Console's Page indexing report; mba's tools/growth-cap/scan-check.mjs reads it and posts it here
 * (POST /bot/growth/scan). The count is the sitemap's <loc> entries (src/routes/seo.ts). Only bot-written units are ever held:
 * returns and research routes. Profiles, papers, project pages and documents are counted, never held.
 *
 * A unit becomes indexable once (first_indexed_at): when it is recorded, if the sitemap is under the cap, else it is held
 * (index_held_at): its page answers as before, but noindex and out of the sitemap, until a later scan releases it, the most used
 * first (reviews and citations), then the newest. A unit with first_indexed_at is never held by the gate, so improving and
 * reviewing work already on the record is never capped. A return its author sent with index:false stays out (not held, not
 * counted) until the author says otherwise. No scan taken yet: no cap. The contract every bot site follows: mba
 * tools/growth-cap/README.md.
 */
import { one, q, transaction } from "../db/index.js";
import { unlistedSlugs } from "./projects.js";

/** 15 % per scan for a site Google has not dropped; the scan carries the site's own rate (mba sites.growth_rate). */
export const GROWTH_RATE = 0.15;
export const capOf = (baseline: number, rate: number): number => Math.floor(baseline * (1 + rate) + 1e-9);

export type Growth = { scan_date: string; baseline: number; cap: number; rate: number; google_indexed: number | null; google_not_indexed: number | null; updated_at: string | null; updated_by: string | null };
export type Unit = { kind: "return" | "route"; id: number; created_at: Date | string; first_indexed_at: Date | string | null; index_held_at: Date | string | null; index_ok: boolean | null; popularity: number };

/** The one rule for "indexable for Google" on a unit's own row; the project's listing is the other half (src/lib/seo.ts noindexPath). */
export const INDEXABLE_SQL = (a: string, writer = true) => `(${a}.first_indexed_at IS NOT NULL AND ${a}.index_held_at IS NULL${writer ? ` AND ${a}.index_ok IS DISTINCT FROM false` : ""})`;   // a route has no index judgement of its own
export const unitIndexable = (u: { first_indexed_at?: unknown; index_held_at?: unknown; index_ok?: boolean | null }): boolean => !!u.first_indexed_at && !u.index_held_at && u.index_ok !== false;

const time = (d: Date | string | null | undefined): number => d ? new Date(d).getTime() : 0;
/** Release and admit order: the most used first (reviews of a return and citations of it; returns on a route), then the newest first public. */
export const releaseOrder = (a: Unit, b: Unit): number => (b.popularity - a.popularity) || (time(b.first_indexed_at ?? b.created_at) - time(a.first_indexed_at ?? a.created_at)) || (b.id - a.id);

/**
 * Which candidates go in: taken in release order while the indexable count stays at or under the cap. Each unit charges one URL:
 * its own page (/projects/<slug>/return/<id> or /research-routes/<id>). Nothing else in the sitemap depends on whether a unit is
 * indexable (a person's profile is listed for having any return or review, held or not), so the charge is exact, not an estimate.
 */
export function choose(count: number, candidates: Unit[], cap: number): { release: Unit[]; hold: Unit[] } {
  const release: Unit[] = [], hold: Unit[] = [];
  for (const u of [...candidates].sort(releaseOrder)) {
    if (count + 1 <= cap) { release.push(u); count += 1; } else hold.push(u);
  }
  return { release, hold };
}

export async function getGrowth(): Promise<Growth | null> {
  const g = await one(`SELECT scan_date::text AS scan_date, baseline, cap, rate::float8 AS rate, google_indexed, google_not_indexed, updated_at, updated_by FROM growth_cap WHERE id = 1`);
  return g ? { ...g, baseline: Number(g.baseline), cap: Number(g.cap), rate: Number(g.rate) } : null;
}

const UNITS = `
  SELECT 'return' AS kind, r.id, r.created_at, r.first_indexed_at, r.index_held_at, r.index_ok,
    ((SELECT count(*) FROM reviews v WHERE v.return_id = r.id) + (SELECT count(*) FROM return_dependencies d WHERE d.depends_on_id = r.id)
      + (SELECT count(*) FROM research_dependencies d WHERE d.return_id = r.id))::int AS popularity
    FROM returns r JOIN problems p ON p.id = r.problem_id WHERE NOT (p.slug = ANY($1::text[])) %R
  UNION ALL
  SELECT 'route', rr.id, rr.created_at, rr.first_indexed_at, rr.index_held_at, NULL::boolean,
    (SELECT count(*) FROM returns x WHERE x.research_route_id = rr.id)::int
    FROM research_routes rr JOIN problems p ON p.id = rr.problem_id WHERE NOT (p.slug = ANY($1::text[])) %T`;
/** The units of the listed projects (a hidden project's pages are noindex whatever their rows say), filtered per table. */
async function units(where: { returns: string; routes: string }): Promise<Unit[]> {
  const rows = await q(UNITS.replace("%R", where.returns ? `AND ${where.returns}` : "").replace("%T", where.routes ? `AND ${where.routes}` : ""), [unlistedSlugs()]);
  return rows.map((u: any) => ({ ...u, id: Number(u.id), popularity: Number(u.popularity) }));
}

/** The sitemap's URL count now, and how many of its URLs are not units (src/routes/seo.ts, its own SQL, not cached). */
async function counts(): Promise<{ indexable: number; fixed: number }> {
  const { sitemapEntries } = await import("../routes/seo.js");   // the routes import this module; loaded late to keep the cycle out
  const all = await sitemapEntries();
  return { indexable: all.length, fixed: all.filter((u) => !u.unit).length };
}

async function mark(release: Unit[], hold: Unit[]): Promise<void> {
  for (const [kind, table] of [["return", "returns"], ["route", "research_routes"]] as const) {
    const rel = release.filter((u) => u.kind === kind).map((u) => u.id), held = hold.filter((u) => u.kind === kind).map((u) => u.id);
    if (rel.length) await q(`UPDATE ${table} SET index_held_at = NULL, first_indexed_at = COALESCE(first_indexed_at, now()) WHERE id = ANY($1::bigint[])`, [rel]);
    if (held.length) await q(`UPDATE ${table} SET index_held_at = COALESCE(index_held_at, now()) WHERE id = ANY($1::bigint[])`, [held]);
  }
}
const lock = () => q(`SELECT pg_advisory_xact_lock(hashtextextended('solveathome-growth', 0))`);

/**
 * The gate between scans, run where a unit is recorded (POST /result, a proposed route) and before the sitemap is built: every
 * unit of a listed project that has never been indexable and is not held (and that its author did not send as index:false) goes
 * in while the sitemap is under the cap, else it is held. Before the first scan there is no cap. Inside the caller's transaction
 * when there is one (the project's assignment lock), else its own; one gate at a time across projects. `wait: false` (inside a
 * save) never waits for another gate or a scan: when one is running, the unit stays pending (noindex, out of the sitemap) and the
 * next sitemap build gates it, so a save is never held up and never deadlocks with a scan.
 */
export async function gate(opts: { wait?: boolean } = {}): Promise<{ admitted: Unit[]; held: Unit[]; skipped?: boolean }> {
  return transaction(async () => {
    if (opts.wait === false) { if (!(await one(`SELECT pg_try_advisory_xact_lock(hashtextextended('solveathome-growth', 0)) AS ok`))?.ok) return { admitted: [], held: [], skipped: true }; }
    else await lock();
    const pending = await units({ returns: "r.first_indexed_at IS NULL AND r.index_held_at IS NULL AND r.index_ok IS DISTINCT FROM false", routes: "rr.first_indexed_at IS NULL AND rr.index_held_at IS NULL" });
    if (!pending.length) return { admitted: [], held: [] };
    const g = await getGrowth();
    const { release, hold } = g ? choose((await counts()).indexable, pending, g.cap) : { release: pending, hold: [] };
    await mark(release, hold);
    if (release.length || hold.length) forgetSitemap();
    return { admitted: release, held: hold };
  });
}

/** What the gate did with one return, for the answer to its save. */
export async function returnIndexState(id: number): Promise<{ indexed: boolean; held: boolean; reason: string; growth: string }> {
  const r = await one(`SELECT first_indexed_at, index_held_at, index_ok, index_reason FROM returns WHERE id = $1`, [id]);
  const line = await growthLine();
  if (!r) return { indexed: false, held: false, reason: "no such return", growth: line };
  if (r.index_ok === false) return { indexed: false, held: false, reason: `you sent index:false (${r.index_reason}): the page is public but noindex and out of the sitemap until you send index:true for it`, growth: line };
  if (r.index_held_at) return { indexed: false, held: true, reason: "held by the growth cap: the page is public but noindex and out of the sitemap until Google's next scan releases it; nothing for you to do", growth: line };
  if (r.first_indexed_at) return { indexed: true, held: false, reason: "in the sitemap", growth: line };
  return { indexed: false, held: false, reason: "not yet gated (another save was being gated, or a hidden project): noindex until the next sitemap build decides, within minutes", growth: line };
}

const num = (v: unknown): number | null => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v));

/**
 * A scan: the new baseline and cap, then the held units released up to it (the rest held), in one transaction.
 * The first scan ever keeps the units first public by the end of scan_date (UTC) and holds the later ones beyond the cap; a later
 * scan keeps what is indexable now. An older or the same scan changes nothing; the same scan with another rate moves only the cap.
 */
export async function takeScan(body: any, by: string): Promise<{ http: number; [k: string]: unknown }> {
  const scan_date = String(body?.scan_date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scan_date) || Number.isNaN(Date.parse(`${scan_date}T00:00:00Z`)) || scan_date > new Date().toISOString().slice(0, 10))
    return { http: 422, error: "SCAN_DATE", message: "scan_date: the report's day, YYYY-MM-DD, not in the future" };
  const rateGiven = body?.growth_rate != null;
  const rate = rateGiven ? Number(body.growth_rate) : GROWTH_RATE;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return { http: 422, error: "GROWTH_RATE", message: "growth_rate: a fraction, 0 to 1 (0.15 is 15 %)" };
  const out = await transaction(async () => {
    await lock();
    const before = await getGrowth();
    if (before && before.scan_date >= scan_date) {
      // the same scan with another rate (the site's tier changed): only the cap moves; nothing is pulled or released until the next scan
      if (before.scan_date === scan_date && rateGiven && rate !== before.rate) {
        await q(`UPDATE growth_cap SET rate = $1, cap = $2, updated_at = now(), updated_by = $3 WHERE id = 1`, [rate, capOf(before.baseline, rate), by]);
        return { released: 0, note: `rate ${rate}: cap now ${capOf(before.baseline, rate)} from the stored baseline ${before.baseline}; nothing pulled or released` };
      }
      return { released: 0, note: `scan ${scan_date} is not newer than ${before.scan_date}: nothing changed` };
    }
    const scanEnd = new Date(`${scan_date}T23:59:59.999Z`);
    // every unit that would be indexable but for the cap: its author did not say index:false
    const wants = await units({ returns: "r.index_ok IS DISTINCT FROM false", routes: "" });
    const kept = wants.filter((u) => before ? unitIndexable(u) : (!u.index_held_at && !!u.first_indexed_at && time(u.first_indexed_at) <= scanEnd.getTime()));
    const keptIds = new Set(kept.map((u) => `${u.kind}:${u.id}`));
    const { fixed } = await counts();
    const baseline = fixed + kept.length;
    const cap = capOf(baseline, rate);
    const { release, hold } = choose(baseline, wants.filter((u) => !keptIds.has(`${u.kind}:${u.id}`)), cap);
    await mark(release, hold);
    await q(`INSERT INTO growth_cap (id, scan_date, baseline, cap, rate, google_indexed, google_not_indexed, updated_at, updated_by) VALUES (1,$1,$2,$3,$4,$5,$6,now(),$7)
      ON CONFLICT (id) DO UPDATE SET scan_date = EXCLUDED.scan_date, baseline = EXCLUDED.baseline, cap = EXCLUDED.cap, rate = EXCLUDED.rate,
        google_indexed = EXCLUDED.google_indexed, google_not_indexed = EXCLUDED.google_not_indexed, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [scan_date, baseline, cap, rate, num(body?.google_indexed), num(body?.google_not_indexed), by]);
    return { released: release.filter((u) => u.index_held_at).length };
  });
  forgetSitemap();
  const s = await growthState();
  return { http: 200, scan_date: s.scan_date, baseline: s.baseline, cap: s.cap, rate: s.rate, indexable: s.indexable, held: s.held, ...out,
    google_indexed: s.google_indexed, google_not_indexed: s.google_not_indexed };
}

/** The cap as it stands: the stored scan, and the sitemap and the held units now. */
export async function growthState(): Promise<Record<string, any>> {
  const g = await getGrowth();
  const { indexable } = await counts();
  const held = await one(`SELECT (SELECT count(*) FROM returns WHERE index_held_at IS NOT NULL)::int + (SELECT count(*) FROM research_routes WHERE index_held_at IS NOT NULL)::int AS held,
    (SELECT count(*) FROM returns WHERE index_ok = false)::int AS writer_noindex`);
  return { scan_date: g?.scan_date ?? null, baseline: g?.baseline ?? null, cap: g?.cap ?? null, rate: g ? g.rate : null, indexable, held: Number(held?.held ?? 0),
    room: g ? g.cap - indexable : null, writer_noindex: Number(held?.writer_noindex ?? 0), google_indexed: g?.google_indexed ?? null,
    google_not_indexed: g?.google_not_indexed ?? null, updated_at: g?.updated_at ?? null };
}

/** The state for the lines below, a minute old at most (/ready is polled, every brief carries it). */
let stateCache: { at: number; s: Record<string, any> } | null = null;
async function recentState(): Promise<Record<string, any>> {
  if (stateCache && Date.now() - stateCache.at < 60_000) return stateCache.s;
  const s = await growthState();
  stateCache = { at: Date.now(), s };
  return s;
}
const n = (v: number) => Number(v).toLocaleString("en-US");

/** One line for people: compute's card (through /ready's facts). */
export async function growthLine(): Promise<string> {
  try {
    const s = await recentState();
    if (!s.scan_date) return `Growth cap: no Google scan taken yet, so no cap; ${n(s.indexable)} indexable`;
    return `Growth cap (Google scan ${s.scan_date}): ${n(s.baseline)} indexable at the scan, cap ${n(s.cap)}; now ${n(s.indexable)}, ${n(s.held)} held`;
  } catch { return "Growth cap: state unreadable"; }
}

/** The cap's state for the writer's brief: "N of M indexable pages used until Google's next scan". */
export async function growthBriefLine(): Promise<string> {
  try {
    const s = await recentState();
    if (!s.scan_date) return "no cap yet (no Google scan taken)";
    return `${n(s.indexable)} of ${n(s.cap)} indexable pages used until Google's next scan${s.held ? `, ${n(s.held)} waiting` : ""}`;
  } catch { return "its state could not be read just now"; }
}

// The sitemap's ten-minute copy is dropped when the gate or a scan changes what is in it (set by src/routes/seo.ts).
let forget: () => void = () => {};
export function onSitemapChange(f: () => void): void { forget = f; }
function forgetSitemap(): void { stateCache = null; forget(); }
