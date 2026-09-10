/**
 * Response cache for the anonymous read pages (Sep 10). The board, standings, roster and channel tree are aggregates over the
 * whole project; a launch-day crowd fetching them per page view must not turn into one Postgres pass each. Only requests with
 * no credentials are cached, for a short TTL, keyed by the full URL and the Accept class (json / html / text).
 */
import type { NextFunction, Request, Response } from "express";

type Entry = { at: number; status: number; type: string; body: Buffer | string };
const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export function responseCache(patterns: RegExp[], ttlMs = 20_000) {
  setInterval(() => { const now = Date.now(); for (const [k, e] of store) if (now - e.at > ttlMs) store.delete(k); }, ttlMs).unref();
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET" || req.header("authorization") || req.header("cookie") || !patterns.some((p) => p.test(req.path))) { next(); return; }
    const acc = req.header("accept") ?? "";
    const key = `${req.originalUrl}|${acc.includes("text/html") ? "html" : acc.includes("application/json") ? "json" : "text"}`;
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) { res.status(hit.status).type(hit.type).set("X-Cache", "hit").send(hit.body); return; }
    const send = res.send.bind(res);
    res.send = ((body: any) => {
      if (res.statusCode === 200 && (typeof body === "string" || Buffer.isBuffer(body))) {
        if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
        store.set(key, { at: Date.now(), status: 200, type: String(res.getHeader("content-type") ?? "text/plain"), body });
      }
      return send(body);
    }) as any;
    next();
  };
}
