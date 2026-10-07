/**
 * Response cache for the anonymous read pages (Sep 10). The board, standings, roster and channel tree are aggregates over the
 * whole project; a launch-day crowd fetching them per page view must not turn into one Postgres pass each. Only requests with
 * no credentials are cached, for a short TTL, keyed by the full URL and the Accept class (json / html / text).
 *
 * The first visitor never pays for a rebuild (client, Oct 2: "our sites are always fast"; the standings behind the home and
 * project pages took over a second each time the 20 s entry ran out). An entry past its TTL is still served, marked stale,
 * while one request of our own rebuilds it in the background; it is dropped only after STALE_MS. warmCache fills the
 * addresses every visitor fetches at start and keeps them inside STALE_MS, so a restart or a quiet hour starts warm too.
 */
import type { NextFunction, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { prefersHtml } from "./negotiate.js";

type Entry = { at: number; status: number; type: string; body: Buffer | string; accept: string };
const store = new Map<string, Entry>();
const refreshing = new Set<string>();
const MAX_ENTRIES = 2000;
const STALE_MS = 10 * 60_000;
// A rebuild is one of our own requests through the whole stack; this header, unguessable per process, makes the cache skip
// the lookup and store the answer instead.
const REFRESH = randomBytes(16).toString("hex");
let origin: string | null = null;

function rebuild(key: string, url: string, accept: string): void {
  if (!origin || refreshing.has(key)) return;
  refreshing.add(key);
  fetch(origin + url, { headers: { accept, "x-cache-refresh": REFRESH } }).then((r) => r.arrayBuffer()).catch((e) => console.error(`cache rebuild ${url}:`, e?.message ?? e)).finally(() => refreshing.delete(key));
}

export function responseCache(patterns: RegExp[], ttlMs = 20_000, staleMs = STALE_MS) {
  setInterval(() => { const now = Date.now(); for (const [k, e] of store) if (now - e.at > staleMs) store.delete(k); }, Math.min(ttlMs, staleMs)).unref();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" || req.header("authorization") || req.header("cookie") || !patterns.some((p) => p.test(req.path))) { next(); return; }
    origin ??= `http://127.0.0.1:${req.socket.localPort}`;
    const acc = req.header("accept") ?? "";
    // "mixed" (text/html beside an agent format) is its own class: most pages answer it with HTML, the board with JSON (negotiate.ts).
    const key = `${req.originalUrl}|${prefersHtml(acc) ? "html" : acc.includes("text/html") ? "mixed" : acc.includes("application/json") ? "json" : "text"}`;
    const hit = req.header("x-cache-refresh") === REFRESH ? undefined : store.get(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < staleMs) {
      if (age >= ttlMs) rebuild(key, req.originalUrl, hit.accept);
      if (hit.type.includes("json")) res.set("X-Robots-Tag", "noindex");
      res.status(hit.status).type(hit.type).set("X-Cache", age < ttlMs ? "hit" : "stale").send(hit.body);
      return;
    }
    const send = res.send.bind(res);
    res.send = ((body: any) => {
      if (res.statusCode === 200 && (typeof body === "string" || Buffer.isBuffer(body))) {
        if (!store.has(key) && store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
        store.set(key, { at: Date.now(), status: 200, type: String(res.getHeader("content-type") ?? "text/plain"), body, accept: acc });
      }
      return send(body);
    }) as any;
    next();
  };
}

/** Build these addresses now and again every everyMs (below STALE_MS), so the pages every visitor opens are never cold. */
export function warmCache(port: number, pages: { url: string; accept: string }[], everyMs = 5 * 60_000): void {
  origin = `http://127.0.0.1:${port}`;
  const run = () => { for (const p of pages) rebuild(`warm|${p.url}|${p.accept}`, p.url, p.accept); };
  run();
  setInterval(run, everyMs).unref();
}
