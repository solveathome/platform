/**
 * IndexNow (Oct 9 2026, #sah-bing-indexnow): Bing had never indexed the site, which also kept it out of DuckDuckGo and Copilot.
 * The site serves its key at /<key>.txt and pings api.indexnow.org with the sitemap's URLs when a container starts (every deploy)
 * and with the URLs that are new or changed whenever the sitemap moves. The key is public by design: it only proves that whoever
 * pings owns the host, and the URLs pinged must be on it. It is INDEXNOW_KEY or, unset, derived from BASE_URL, so an instance
 * needs no configuration. Nothing is pinged from a localhost or plain-http BASE_URL; INDEXNOW_ENABLED=0 stops it everywhere.
 * Each ping logs its HTTP status: 200 or 202 is accepted.
 */
import { createHash } from "node:crypto";
import { BASE } from "./seo.js";

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

/** Pings the whole sitemap once at start, then every ten minutes whatever in it is new or changed. */
export function startIndexNow(snapshot: () => Promise<Map<string, string>>): void {
  if (!indexNowEnabled()) return;
  let last: Map<string, string> | null = null;
  const tick = async () => {
    const next = await snapshot(), urls = changedUrls(last, next);
    // Kept only once accepted, so a refused or failed ping is sent again at the next tick.
    if (!urls.length || (await ping(urls)).every((s) => s === 200 || s === 202)) last = next;
  };
  // A minute in, so the new slot is the one serving the key file when Bing fetches it.
  setTimeout(() => { tick().catch((e) => console.error("indexnow:", e)); setInterval(() => { tick().catch((e) => console.error("indexnow:", e)); }, EVERY_MS).unref(); }, 60_000).unref();
}
