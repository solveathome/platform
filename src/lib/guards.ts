/**
 * Request-path guards, applied before any router (Sep 10). Express decodes %2F and %2E in path parameters, so a raw URL
 * can carry ".." or "/" into a segment that a route treats as one name. Nothing on this server has a legitimate encoded
 * slash, dot-segment or dotfile in its path, so they are refused at the door, in addition to the per-route checks.
 */
import type { NextFunction, Request, Response } from "express";

const BAD_RAW = /%2f|%5c|%2e%2e|%00/i;                 // encoded slash, backslash, dot-dot, NUL
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;              // "." or ".." as a whole segment
const DOTFILE = /(^|\/)\.[^/]/;                         // any segment starting with a dot (.env, .git, .publication.json)

export function pathGuard(req: Request, res: Response, next: NextFunction): void {
  const raw = req.originalUrl.split("?")[0];
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { res.status(400).json({ error: "malformed path" }); return; }
  if (BAD_RAW.test(raw) || DOT_SEGMENT.test(decoded) || decoded.includes("\\") || DOTFILE.test(decoded)) { res.status(404).json({ error: "not found" }); return; }
  next();
}

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
