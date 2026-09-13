/** OEIS proposals are research documents: read their current edition, including accepted audit revisions. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.js";
import { readProjectConfig } from "./projects.js";
import { publishedDocument, readPublication, sha256 } from "./document-publication.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const OVERLAY = process.env.OVERLAY_DIR ?? join(ROOT, "data", "overlay");

export function parseSequenceProposal(text: string) {
  const visible = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  const field = (name: string) => new RegExp(`^\\*\\*${name}\\*\\*[ \\t]*\\n+([\\s\\S]*?)(?=^\\*\\*[A-Z]+\\*\\*[ \\t]*$|^#{1,6} |^---[ \\t]*$|(?![\\s\\S]))`, "m").exec(visible)?.[1].trim() ?? "";
  const compact = (s: string) => s.replace(/\s+/g, " ").trim();
  const definition = compact(field("NAME"));
  if (!definition) return null;
  const title = (/^#\s+(.+)$/m.exec(visible)?.[1] ?? definition).replace(/^OEIS submission draft:\s*/i, "");
  // Only the front matter describes the proposal's status. A retired draft may retain its old submission instructions below.
  const preamble = visible.split(/^\*\*NAME\*\*/m)[0];
  const statusNote = /^Status:\s*(.+)$/im.exec(preamble.replace(/\*\*/g, ""))?.[1].trim() ?? "";
  const retired = /^(?:RETIRED|WITHDRAWN|REJECTED|DUPLICATE)\b/i.test(statusNote) || /^>.*\bDO NOT SUBMIT\b/im.test(preamble);
  const status = retired ? "retired" : /^DRAFT\b/i.test(statusNote) ? "draft" : "proposed";
  const data = compact(field("DATA"));
  // Keep integers as strings: research terms can exceed JavaScript's safe integer range.
  const terms = /^[+-]?\d+(?:\s*,\s*[+-]?\d+)*$/.test(data) ? data.split(/\s*,\s*/) : [];
  const offset = compact(field("OFFSET"));
  return { title, definition, status, status_label: retired ? "Retired" : status === "draft" ? "Draft proposal" : "Proposed", status_note: statusNote, terms, offset: /^[+-]?\d+(?:\s*,\s*\d+)?$/.test(offset) ? offset : null };
}

export function sequenceProposals(slug: string, paths = readProjectConfig(slug)?.sequence_proposals ?? [], repos = REPOS, overlay = OVERLAY) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) return [];
  const root = join(repos, slug), publication = readPublication(root);
  return [...new Set(paths)].flatMap(path => {
    // Match /docs: the mirror must be admitted, even when an accepted revision supplies the current bytes.
    if (!path.endsWith(".md") || !publishedDocument(root, path, publication)) return [];
    const revised = join(overlay, slug, path);
    const content = readFileSync(existsSync(revised) ? revised : join(root, path), "utf8");
    const proposal = parseSequenceProposal(content);
    if (!proposal) return [];
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return [{ ...proposal, sha256: sha256(content), path, url: `/projects/${slug}/docs/${encoded}`, history_url: `/projects/${slug}/history/${encoded}` }];
  });
}
