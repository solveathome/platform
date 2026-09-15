/**
 * A JSON client that misses a route gets JSON (platform issue #89). Express's default 404 is an HTML page, so a client that
 * parses every reply records a decode error where the fault is a wrong path, and its journal then says "bad JSON" instead of
 * "no such route" — which is the wrong answer to the question the journal exists to settle, retry this exactly or repair and
 * resend. The nearest real route is named, because this class of miss is a near-miss: `/returns/587` for `/return/587`.
 */
import type { RequestHandler, Router } from "express";
import { wantsHtml } from "./negotiate.js";

/** The first path segment of every route a router serves: `/return/:id` and `/return/:id/reopen` both give `return`. */
export function routeHeads(routers: unknown[]): string[] {
  const heads = new Set<string>();
  for (const router of routers) for (const layer of ((router as Router & { stack?: any[] })?.stack ?? [])) {
    const path = layer?.route?.path;
    for (const p of Array.isArray(path) ? path : path ? [path] : []) {
      const head = String(p).replace(/^\//, "").split("/")[0];
      if (head && !head.startsWith(":")) heads.add(head);
    }
  }
  return [...heads].sort();
}

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The route a wrong path most likely meant, when one is close enough to be a typo rather than a guess; null when none is. */
export function nearestRoute(pathname: string, heads: string[]): string | null {
  const m = /^\/projects\/([a-z0-9-]+)\/([^/?]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const [, slug, head, rest] = m;
  if (heads.includes(head)) return null;
  let best: string | null = null, bestScore = Infinity;
  for (const candidate of heads) {
    const score = editDistance(head.toLowerCase(), candidate.toLowerCase());
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  // One edit per three characters, at most two: "returns" reaches "return", "no-such-endpoint" reaches nothing.
  return best && bestScore <= Math.min(2, Math.ceil(head.length / 3)) ? `/projects/${slug}/${best}${rest ?? ""}` : null;
}

export function notFound(routers: unknown[]): RequestHandler {
  const heads = routeHeads(routers);
  return (req, res, next) => {
    if (res.headersSent || wantsHtml(req)) { next(); return; }   // a browser or a link preview still gets a page
    const pathname = String(req.originalUrl ?? req.url).split("?")[0];
    const near = nearestRoute(pathname, heads);
    res.status(404).json({ error: `no such route: ${req.method} ${pathname}`, method: req.method, path: pathname,
      ...(near ? { did_you_mean: near } : {}),
      report: "https://github.com/solveathome/platform/issues/new?template=bug.md" });
  };
}
