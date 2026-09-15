/**
 * A brief names documents by path. Some are not in the served snapshot (a publisher's pages that are only redirected, a file the
 * publication policy withheld, a typo). Saying so at the top of the brief saves the agent the search and states what a reviewer
 * can verify (platform issue #27). The check is generic: paths in backticks under the snapshot's top-level directories.
 *
 * The line is an instruction and agents obey it, so a false positive is far more expensive than a false negative: it steers an
 * agent away from served evidence and makes it write a disclosure that is not true (platform issue #86, where a brief called a
 * served red-team record unavailable and the agent lost the document that settled its job). Measured over every brief and
 * research route on 2026-09-15, 1341 texts in all, the check reported five distinct paths and every one of them was wrong:
 * two quoted relative to `research/` and served, `msc/C2` (a ratio in an inline code span, not a path), `alt22/` and
 * `src/lib/files.ts` (a path into this repository, not into the corpus). So a path is reported only when the snapshot is the
 * right place to look for it and it is genuinely not there; anything else is left for the agent to resolve by fetching it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPublication, type Publication } from "./document-publication.js";
import { REPOS, overlayPath } from "./revisions.js";
import { docsRedirect } from "./projects.js";

/** `outside`: the token is not a path into this snapshot, so the snapshot cannot say anything about it and the brief stays quiet. */
export type PathStatus = { path: string; status: "served" | "redirected" | "missing" | "outside"; to?: string };

/** Backticked paths that look like snapshot documents: a top-level directory, a slash, then a relative path (a trailing slash names a directory). */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/`((?:[a-z][a-z0-9_-]*\/)[A-Za-z0-9_.\/-]*)`/g)) { const p = m[1].replace(/^\/+/, ""); if (p.length <= 200 && !p.includes("..")) out.add(p); }
  return [...out];
}

export function classify(path: string, root: string, publication: Publication | null, slug: string): PathStatus {
  const to = docsRedirect(slug, path.replace(/\/$/, "")) ?? docsRedirect(slug, path);
  if (to) return { path, status: "redirected", to };
  const files = Object.keys(publication?.files ?? {});
  const base = path.replace(/\/+$/, "");
  const topLevel = new Set(files.map((f) => f.split("/")[0]));
  const known = topLevel.has(base.split("/")[0]);
  if (path.endsWith("/")) {
    if (files.some((f) => f.startsWith(base + "/"))) return { path, status: "served" };
    // A directory served one level down, named the way a document names it: `staging/` inside `research/history/`.
    if (files.some((f) => f.includes("/" + base + "/"))) return { path, status: "served" };
    return { path, status: known ? "missing" : "outside" };
  }
  if (publication?.files[path]) return { path, status: "served" };
  if (existsSync(overlayPath(slug, path))) return { path, status: "served" };
  // Prose inside a document names its neighbours relative to its own directory, and a brief quotes that prose verbatim: a
  // document that cites `history/staging/redteam.md` means `research/history/staging/redteam.md`, which is served.
  if (files.some((f) => f.endsWith("/" + base))) return { path, status: "served" };
  // Not a document path: an inline code span that happens to contain a slash (`msc/C2`), or a file in another repository.
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base) || !known) return { path, status: "outside" };
  return { path, status: "missing" };
}

/** Paths named in the text that a reader will not find at /docs: empty when the project has no snapshot to check against. */
export function unservedPaths(text: string, slug: string): PathStatus[] {
  const root = join(REPOS, slug);
  if (!existsSync(root)) return [];
  const publication = readPublication(root);
  if (!publication) return [];
  return namedPaths(text).map((p) => classify(p, root, publication, slug)).filter((s) => s.status === "missing" || s.status === "redirected");
}

/** One line for the top of a brief, or empty. */
export function unservedNote(text: string, slug: string, baseUrl: string): string {
  const bad = unservedPaths(text, slug);
  if (!bad.length) return "";
  const items = bad.map((b) => b.status === "redirected" ? `\`${b.path}\` (not hosted here; \`GET ${baseUrl}/docs/${b.path}\` redirects to ${b.to}; \`attestation/EXTERNAL-SOURCES.md\` lists the source)` : `\`${b.path}\` (not in the served snapshot)`);
  return `**Named in this brief but not served here:** ${items.join("; ")}. Fetch a path once to confirm before you work around it; if it is genuinely unavailable, work from what is served and from public statements of the source, and say so in your return.\n\n`;
}
