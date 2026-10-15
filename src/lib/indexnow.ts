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
 */
import { createHash } from "node:crypto";
import { BASE } from "./seo.js";
import { q } from "../db/index.js";

export const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH = 10_000;   // the protocol's limit per request
const EVERY_MS = 10 * 60_000;

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

/** Where the last accepted url -> lastmod survives a restart. */
export type PingStore = { load(): Promise<Map<string, string>>; save(sent: Map<string, string>): Promise<void> };
export const dbStore: PingStore = {
  load: async () => new Map((await q<{ url: string; lastmod: string }>(`SELECT url, lastmod FROM indexnow_pings`)).map((r) => [r.url, r.lastmod])),
  save: async (sent) => { const e = [...sent]; for (let i = 0; i < e.length; i += 1000) { const b = e.slice(i, i + 1000); await q(`INSERT INTO indexnow_pings (url, lastmod, pinged_at) SELECT u, m, now() FROM unnest($1::text[], $2::text[]) AS t(u, m) ON CONFLICT (url) DO UPDATE SET lastmod = EXCLUDED.lastmod, pinged_at = now()`, [b.map(([u]) => u), b.map(([, m]) => m)]); } },
};

/** One check: ping what is new or changed since the last accepted ping, and record it once accepted. */
export async function indexNowTick(snapshot: () => Promise<Map<string, string>>, store: PingStore, pingImpl: (urls: string[]) => Promise<number[]> = ping): Promise<string[]> {
  const next = await snapshot(), urls = changedUrls(await store.load(), next);
  // Recorded only once accepted, so a refused or failed ping is sent again at the next tick.
  if (urls.length && (await pingImpl(urls)).every((s) => s === 200 || s === 202)) await store.save(new Map(urls.map((u) => [u, next.get(u)!])));
  return urls;
}

/** A minute after start, then every ten minutes: pings whatever in the sitemap is new or changed since the last accepted ping. */
export function startIndexNow(snapshot: () => Promise<Map<string, string>>, store: PingStore = dbStore): void {
  if (!indexNowEnabled()) return;
  const tick = () => indexNowTick(snapshot, store);
  // A minute in, so the new slot is the one serving the key file when Bing fetches it.
  setTimeout(() => { tick().catch((e) => console.error("indexnow:", e)); setInterval(() => { tick().catch((e) => console.error("indexnow:", e)); }, EVERY_MS).unref(); }, 60_000).unref();
}
