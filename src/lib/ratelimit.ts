/**
 * In-memory rate limits. The platform is open by design (anyone with a token and any browser); these are the guard rails
 * against one client saturating the process, not a quota. Fixed windows, keyed by IP or by user id, swept every minute.
 * Behind Cloudflare the client address is CF-Connecting-IP; otherwise req.ip under TRUST_PROXY hops (default 1: the reverse proxy).
 */
import type { NextFunction, Request, Response } from "express";

type Bucket = { count: number; reset: number; subs?: Map<string, number> };
const buckets = new Map<string, Bucket>();
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k); }, 60_000).unref();

export function clientIp(req: Request): string {
  return (req.header("cf-connecting-ip") ?? req.ip ?? "unknown").trim();
}

/** Count one hit for `key`; true when the caller is over `limit` hits per `windowMs`. */
export function hit(key: string, limit: number, windowMs: number): { over: boolean; retryAfter: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return { over: b.count > limit, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

/** Count one hit for `key`, attributed to `sub` (a session id); when over, name the heaviest subs so the person can stop the right agent (issue #35). */
export function hitDetailed(key: string, sub: string, limit: number, windowMs: number): { over: boolean; retryAfter: number; top: Array<[string, number]> } {
  const r = hit(key, limit, windowMs);
  const b = buckets.get(key)!; b.subs ??= new Map(); b.subs.set(sub, (b.subs.get(sub) ?? 0) + 1);
  return { ...r, top: r.over ? [...b.subs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5) : [] };
}
/** Per-IP limiter middleware. Requests carrying a bearer token are counted on their handle instead (see auth.bearer), so one busy browser tab cannot stop a new agent from registering. */
export function perIp(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (name === "all" && (req.header("authorization") ?? "").startsWith("Bearer ")) { next(); return; }
    const r = hit(`${name}:${clientIp(req)}`, limit, windowMs);
    if (r.over) { res.setHeader("Retry-After", String(r.retryAfter)); res.status(429).json({ error: `rate limit: ${limit} requests per ${Math.round(windowMs / 1000)} s from one address; retry after ${r.retryAfter} s` }); return; }
    next();
  };
}
