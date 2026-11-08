// HTTP validators from a page's true content date (mba ask 7134; rules #r2374, #r2390). A TypeScript port of mba
// tools/site-lastmod/validators.mjs.
//
// Last-Modified is the page's sitemap lastmod (the day its content last really changed), never the build, deploy or
// request time. The ETag is a hash of the served body after `strip` took out what moves without a content change. Weak
// (W/), so Caddy's and Cloudflare's compression keep it.
import { createHash } from "node:crypto";

export type Strip = [RegExp, string][];

export const httpDate = (lastmod: string) => new Date(`${String(lastmod).slice(0, 10)}T00:00:00Z`).toUTCString();

export function etagOf(body: string | Buffer, strip: Strip = []): string {
  let s = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  for (const [re, to] of strip) s = s.replace(re, to);
  return `W/"${createHash("sha1").update(s).digest("base64url").slice(0, 27)}"`;
}

const day = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };

/** True when the request's validators match: If-None-Match wins when sent (weak comparison), else If-Modified-Since on or after the lastmod day. */
export function notModified(headers: Record<string, string | string[] | undefined>, etag: string, lastmod?: string | null): boolean {
  const inm = headers["if-none-match"];
  if (typeof inm === "string" && inm) {
    if (inm.trim() === "*") return true;
    const bare = (t: string) => t.trim().replace(/^W\//, "");
    return inm.split(",").some((t) => bare(t) === bare(etag));
  }
  const ims = headers["if-modified-since"];
  if (typeof ims === "string" && ims && lastmod) { const d = day(ims); return d !== null && d >= String(lastmod).slice(0, 10); }
  return false;
}
