import {createHash} from "node:crypto";
import {readFileSync, realpathSync, statSync} from "node:fs";
import {join, relative, sep} from "node:path";

export const BOOK_SOURCE = "https://doi.org/10.1017/CBO9780511542909";
export const PUBLICATION_FILE = "PUBLICATION.json";
export type Publication = {version: 1; generated_at: string; files: Record<string, {sha256: string; mode: "project" | "source-links"}>};
export const sha256 = (body: string | Buffer) => createHash("sha256").update(body).digest("hex");

// Explicitly limit the portfolio to project text/code/data and timestamp digests.
// A suffix is not evidence of ownership: copied-text screening also runs at preparation.
const EXTENSIONS = new Set(["md", "js", "ts", "c", "py", "sh", "html", "json", "jsonl", "csv", "tsv", "txt", "log", "lean", "tex", "bib", "ots", "sha256"]);
export function permittedDocumentPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || /^(node_modules|vendor|third[-_]party|downloads?|source[-_]copies|book-ch5-6)$/i.test(p))) return false;
  if (parts.at(-1) === "human_notes_not_for_ai.txt" || path === PUBLICATION_FILE) return false;
  if (/(?:^|\/)(?:screenshot|scan|scanned)[\s._-]/i.test(path)) return false;
  return EXTENSIONS.has(path.split(".").at(-1)!.toLowerCase());
}

export function externalSources(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(/\b10\.\d{4,9}\/[-._;()/:a-z\d]+/gi)) {
    urls.add("https://doi.org/" + match[0].replace(/[),.;]+$/, ""));
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const raw = match[0].replace(/[),.;\]}*]+$/, "");
    try {
      const url = new URL(raw);
      if (url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|0\.)/i.test(url.hostname) || /\.(local|internal)$/.test(url.hostname)) continue;
      urls.add(url.href);
    } catch { /* A malformed citation is not a usable public link. */ }
  }
  if (/attestation\/|Diamond.{0,30}Halberstam|Cambridge Tracts\s*177/i.test(text)) urls.add(BOOK_SOURCE);
  return [...urls];
}

/** Explicit source-copy markers only. Quotations, citations and copyright notices are not publication bans. */
export function containsSourceReproduction(text: string): boolean {
  if (/^\s*(?:%PDF-\d|data:application\/pdf;base64,)/i.test(text)) return true;
  return /^\s*(?:#{1,6}\s*)?(?:BEGIN\s+(?:THIRD[- ]PARTY\s+SOURCE|FULL\s+(?:BOOK|PAPER|ARTICLE|PUBLICATION))|(?:FULL|COMPLETE)\s+(?:TEXT|TRANSCRIPTION|OCR)\s+(?:OF|FROM)\b)/im.test(text);
}

/** Inspect actual string values in JSON/JSONL, not JSON's structural quotation marks. */
export function needsSourceReview(content: string): boolean {
  const inspect = (value: unknown): boolean => typeof value === "string" ? containsSourceReproduction(value)
    : Array.isArray(value) ? value.some(inspect)
    : value !== null && typeof value === "object" ? Object.values(value).some(inspect) : false;
  try { return inspect(JSON.parse(content)); } catch { /* Plain text or JSONL. */ }
  const lines = content.split("\n").filter(line => line.trim());
  if (lines.length && lines.every(line => /^\s*[{[]/.test(line))) {
    try { return lines.map(line => JSON.parse(line)).some(inspect); } catch { /* Plain text. */ }
  }
  return containsSourceReproduction(content);
}

/** The first line that trips the source-reproduction check, for the error message. */
export function sourceReviewHit(content: string): string | null {
  for (const line of content.split("\n")) if (line.trim() && containsSourceReproduction(line)) return line.trim().slice(0, 160);
  return /^\s*(?:%PDF-\d|data:application\/pdf;base64,)/i.test(content) ? "(PDF or base64 PDF content)" : null;
}
export const SOURCE_REVIEW_MESSAGE = "This public submission appears to contain a full source reproduction. Attributed quotations, citations and links are welcome. Keep complete books, papers, scans and bulk OCR in your local source repository; publish your analysis and relevant quotations with source locators. Remove full source payloads from public transcripts while retaining reasoning, usage metadata and omission notes.";

export function readPublication(root: string): Publication | null {
  try {
    const data = JSON.parse(readFileSync(join(root, PUBLICATION_FILE), "utf8"));
    return data.version === 1 && data.files && typeof data.files === "object" ? data : null;
  } catch { return null; }
}

/** No unlisted files, changed bytes, or symlinks into private working material. */
export function publishedDocument(root: string, path: string, publication: Publication | null): boolean {
  if (!publication || !permittedDocumentPath(path) || !publication.files[path]) return false;
  try {
    const full = join(root, path), canonical = realpathSync(full);
    if (canonical !== join(realpathSync(root), path) || relative(realpathSync(root), canonical).startsWith(".." + sep)) return false;
    return statSync(full).isFile() && sha256(readFileSync(full)) === publication.files[path].sha256;
  } catch { return false; }
}
