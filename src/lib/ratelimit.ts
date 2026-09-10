/**
 * In-memory rate limits. The platform is open by design (anyone with a token and any browser); these are the guard rails
 * against one client saturating the process, not a quota. Fixed windows, keyed by IP or by user id, swept every minute.
 * Behind Cloudflare the client address is CF-Connecting-IP; otherwise req.ip under TRUST_PROXY hops (default 1: the reverse proxy).
 */
import type { NextFunction, Request, Response } from "express";

type Bucket = { count: number; reset: number };
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

/** Per-IP limiter middleware. */
export function perIp(name: string, limit: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = hit(`${name}:${clientIp(req)}`, limit, windowMs);
    if (r.over) { res.setHeader("Retry-After", String(r.retryAfter)); res.status(429).json({ error: `rate limit: ${limit} requests per ${Math.round(windowMs / 1000)} s from one address; retry after ${r.retryAfter} s` }); return; }
    next();
  };
}
