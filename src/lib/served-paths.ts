/**
 * A brief names documents by path. Some are not in the served snapshot (a publisher's pages that are only redirected, a file the
 * publication policy withheld, a typo). Saying so at the top of the brief saves the agent the search and states what a reviewer
 * can verify (platform issue #27). The check is generic: paths in backticks under the snapshot's top-level directories.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readPublication, type Publication } from "./document-publication.js";
import { REPOS, overlayPath } from "./revisions.js";
import { docsRedirect } from "./projects.js";

export type PathStatus = { path: string; status: "served" | "redirected" | "missing"; to?: string };

/** Backticked paths that look like snapshot documents: a top-level directory, a slash, then a relative path (a trailing slash names a directory). */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? "").matchAll(/`((?:[a-z][a-z0-9_-]*\/)[A-Za-z0-9_.\/-]*)`/g)) { const p = m[1].replace(/^\/+/, ""); if (p.length <= 200 && !p.includes("..")) out.add(p); }
  return [...out];
}

export function classify(path: string, root: string, publication: Publication | null, slug: string): PathStatus {
  const to = docsRedirect(slug, path.replace(/\/$/, "")) ?? docsRedirect(slug, path);
  if (to) return { path, status: "redirected", to };
  if (path.endsWith("/")) {
    const dir = path.replace(/\/+$/, "");
    const any = Object.keys(publication?.files ?? {}).some((f) => f.startsWith(dir + "/"));
    return { path, status: any ? "served" : "missing" };
  }
  if (publication?.files[path]) return { path, status: "served" };
  if (existsSync(overlayPath(slug, path))) return { path, status: "served" };
  return { path, status: "missing" };
}

/** Paths named in the text that a reader will not find at /docs: empty when the project has no snapshot to check against. */
export function unservedPaths(text: string, slug: string): PathStatus[] {
  const root = join(REPOS, slug);
  if (!existsSync(root)) return [];
  const publication = readPublication(root);
  if (!publication) return [];
  return namedPaths(text).map((p) => classify(p, root, publication, slug)).filter((s) => s.status !== "served");
}

/** One line for the top of a brief, or empty. */
export function unservedNote(text: string, slug: string, baseUrl: string): string {
  const bad = unservedPaths(text, slug);
  if (!bad.length) return "";
  const items = bad.map((b) => b.status === "redirected" ? `\`${b.path}\` (not hosted here; \`GET ${baseUrl}/docs/${b.path}\` redirects to ${b.to}; \`attestation/EXTERNAL-SOURCES.md\` lists the source)` : `\`${b.path}\` (not in the served snapshot)`);
  return `**Named in this brief but not served here:** ${items.join("; ")}. Work from what is served and from public statements of the source; say so in your return.\n\n`;
}
