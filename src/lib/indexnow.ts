/**
 * IndexNow (Oct 9 2026, #sah-bing-indexnow): Bing had never indexed the site, which also kept it out of DuckDuckGo and Copilot.
 * The site serves its key at /<key>.txt and pings api.indexnow.org with the sitemap's URLs when a container starts (every deploy)
 * and with the URLs that are new or changed whenever the sitemap moves. The key is public by design: it only proves that whoever
 * pings owns the host, and the URLs pinged must be on it. It is INDEXNOW_KEY or, unset, derived from BASE_URL, so an instance
 * needs no configuration. Nothing is pinged from a localhost or plain-http BASE_URL; INDEXNOW_ENABLED=0 stops it everywhere.
 * Each ping logs its HTTP status: 200 or 202 is accepted.
 * What was accepted is kept in indexnow_pings (Oct 16 2026, #sah-bing-index-week-check): the first week sent Bing 213.5K urls for a
 * 4.1K-url sitemap, because every deploy started a container that pinged the whole sitemap again. A start now sends only what is new or
 * changed since the last accepted ping, whichever container sent it; an instance whose table is empty sends everything once.
 * Bulk rules (Chris, 11 Nov 2026, #r2532, mba ask 7870; horrorgamestoplay was demoted hours after one deploy re-dated and pinged
 * 1,317 urls): one run sends at most max(25, 10 %) of the sitemap, the newest first, and leaves the rest for later runs; a url whose
 * lastmod moved back, or to a day before the previous run, is never sent; once anything was pinged, the whole sitemap never is.
 * SEARCH_DEMOTED stops every ping (#r633).
 */
import { createHash } from "node:crypto";
import { BASE } from "./seo.js";
import { q } from "../db/index.js";

export const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH = 10_000;   // the protocol's limit per request
const EVERY_MS = 10 * 60_000;

/** Off for solveathome.org. On (true, or SEARCH_DEMOTED=1 in the container's env) while mba notes/demoted/solveathome.org.md
 *  exists: a demoted site sends search engines nothing until the marker is removed (#r633). Server01 has no mba checkout, so the
 *  marker is mirrored here by hand. */
export const SEARCH_DEMOTED = false;
export const searchDemoted = () => SEARCH_DEMOTED || process.env.SEARCH_DEMOTED === "1";

/** The most urls one run sends (#r2532): max(25, 10 % of the sitemap). */
export const runCap = (sitemapSize: number) => Math.max(25, Math.ceil(sitemapSize * 0.1));

export const indexNowKey = () => {
  const k = (process.env.INDEXNOW_KEY ?? "").trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(k) ? k : createHash("sha256").update(`indexnow:${BASE()}`).digest("hex").slice(0, 32);
};

export function indexNowEnabled(): boolean {
  if (process.env.INDEXNOW_ENABLED === "0") return false;
  try { const u = new URL(BASE()); return u.protocol === "https:" && !/^(localhost|127\.|\[?::1)/.test(u.hostname); } catch { return false; }
}

/** What changed between two sitemap snapshots (url -> lastmod): every url that is new or whose lastmod moved. */
export function changedUrls(prev: Map<string, string> | null, next: Map<string, string>): string[] {
  if (!prev) return [...next.keys()];
  return [...next].filter(([u, m]) => prev.get(u) !== m).map(([u]) => u);
}

export async function ping(urls: string[], fetchImpl: typeof fetch = fetch): Promise<number[]> {
  const host = new URL(BASE()).host, key = indexNowKey(), statuses: number[] = [];
  for (let i = 0; i < urls.length; i += BATCH) {
    const urlList = urls.slice(i, i + BATCH);
    try {
      const r = await fetchImpl(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify({ host, key, keyLocation: `${BASE()}/${key}.txt`, urlList }), signal: AbortSignal.timeout(30_000) });
      statuses.push(r.status);
      console.log(`indexnow: ${urlList.length} url(s) -> HTTP ${r.status}${r.status === 200 || r.status === 202 ? " (accepted)" : ` ${(await r.text().catch(() => "")).slice(0, 200)}`}`);
    } catch (e: any) { statuses.push(0); console.error(`indexnow: ${urlList.length} url(s) not sent: ${e?.message ?? e}`); }
  }
  return statuses;
}

/** Where the last accepted url -> lastmod survives a restart; lastRun is the day (YYYY-MM-DD) of the newest accepted ping. */
export type PingStore = { load(): Promise<Map<string, string>>; save(sent: Map<string, string>): Promise<void>; lastRun?(): Promise<string | undefined> };
export const dbStore: PingStore = {
  lastRun: async () => (await q<{ d: string | null }>(`SELECT to_char(max(pinged_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM indexnow_pings`))[0]?.d ?? undefined,
  load: async () => new Map((await q<{ url: string; lastmod: string }>(`SELECT url, lastmod FROM indexnow_pings`)).map((r) => [r.url, r.lastmod])),
  save: async (sent) => { const e = [...sent]; for (let i = 0; i < e.length; i += 1000) { const b = e.slice(i, i + 1000); await q(`INSERT INTO indexnow_pings (url, lastmod, pinged_at) SELECT u, m, now() FROM unnest($1::text[], $2::text[]) AS t(u, m) ON CONFLICT (url) DO UPDATE SET lastmod = EXCLUDED.lastmod, pinged_at = now()`, [b.map(([u]) => u), b.map(([, m]) => m)]); } },
};

/** What one run may send (#r2532): of the changed urls, none whose lastmod moved back or to a day before the previous run, never
 *  the whole sitemap once anything was pinged, and at most runCap of them, newest lastmod first. The rest wait for later runs. */
export function allowedUrls(prev: Map<string, string>, next: Map<string, string>, lastRun: string | undefined, changed: string[]): { send: string[]; held: string[]; refused: string[] } {
  const refused: string[] = [], ok: string[] = [];
  for (const u of changed) {
    const was = prev.get(u), now = next.get(u) ?? "";
    // A url pinged before whose day went back, or to a day older than the previous run, is a re-dating, not a change.
    if (was !== undefined && (now < was || (lastRun !== undefined && now < lastRun))) refused.push(u); else ok.push(u);
  }
  if (prev.size > 0 && ok.length >= next.size) return { send: [], held: ok, refused };
  ok.sort((a, b) => (next.get(b) ?? "").localeCompare(next.get(a) ?? "") || a.localeCompare(b));
  const cap = runCap(next.size);
  return { send: ok.slice(0, cap), held: ok.slice(cap), refused };
}

/** One check: ping what is new or changed since the last accepted ping, within the bulk rules, and record it once accepted. */
export async function indexNowTick(snapshot: () => Promise<Map<string, string>>, store: PingStore, pingImpl: (urls: string[]) => Promise<number[]> = ping): Promise<string[]> {
  if (searchDemoted()) { console.log("indexnow: the site is demoted (SEARCH_DEMOTED, #r633): nothing sent"); return []; }
  const next = await snapshot(), prev = await store.load();
  const { send: urls, held, refused } = allowedUrls(prev, next, await store.lastRun?.(), changedUrls(prev.size ? prev : null, next));
  if (held.length || refused.length) console.log(`indexnow (#r2532): sending ${urls.length}, ${held.length} left for later runs, ${refused.length} back-dated not sent`);
  // Recorded only once accepted, so a refused or failed ping is sent again at the next tick.
  if (urls.length && (await pingImpl(urls)).every((s) => s === 200 || s === 202)) await store.save(new Map(urls.map((u) => [u, next.get(u)!])));
  return urls;
}

/** A minute after start, then every ten minutes: pings whatever in the sitemap is new or changed since the last accepted ping. */
export function startIndexNow(snapshot: () => Promise<Map<string, string>>, store: PingStore = dbStore): void {
  if (!indexNowEnabled()) return;
  if (searchDemoted()) { console.log("indexnow: the site is demoted (SEARCH_DEMOTED, #r633): nothing will be sent"); return; }
  const tick = () => indexNowTick(snapshot, store);
  // A minute in, so the new slot is the one serving the key file when Bing fetches it.
  setTimeout(() => { tick().catch((e) => console.error("indexnow:", e)); setInterval(() => { tick().catch((e) => console.error("indexnow:", e)); }, EVERY_MS).unref(); }, 60_000).unref();
}
