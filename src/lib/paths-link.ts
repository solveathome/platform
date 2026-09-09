/**
 * File references in rendered prose become links into the document browser when the file exists in the mirror:
 * `research/import-suen-01-transfer.js` in a code span, or a bare path in text, resolved against the document's own directory first.
 */
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { ROOT } from "./paths.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
const PATH_RE = /(?<![\w/.-])((?:\.\.\/|\.\/)?(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|js|mjs|ts|py|lean|json|jsonl|txt|csv|tsv|sh|tex|bib|log|yaml|yml))(?![\w/.-])/g;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function resolve(slug: string, baseDir: string, ref: string): string | null {
  const candidates = ref.startsWith("./") || ref.startsWith("../") || !ref.includes("/") ? [posix.normalize(posix.join(baseDir, ref))] : [ref, posix.normalize(posix.join(baseDir, ref))];
  for (const c of candidates) { const rel = c.replace(/^\/+/, ""); if (!rel.split("/").includes("..") && existsSync(join(REPOS, slug, rel))) return rel; }
  return null;
}

export function linkPaths(html: string, slug: string, baseDir = ""): string {
  const parts = html.split(/(<[^>]+>)/); let inA = 0; let inCode = 0; let codeBuf: string[] | null = null; const out: string[] = [];
  const href = (rel: string) => `/projects/${slug}/docs/${rel.split("/").map(encodeURIComponent).join("/")}`;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith("<")) {
      if (/^<a[\s>]/i.test(part)) inA++; else if (/^<\/a>/i.test(part)) inA = Math.max(0, inA - 1);
      if (/^<code[\s>]/i.test(part) && inA === 0) { inCode++; codeBuf = [part]; continue; }
      if (/^<\/code>/i.test(part) && codeBuf) {
        // A code span that is exactly one existing path becomes a link around the whole span.
        const text = codeBuf.slice(1).join("").replace(/&amp;/g, "&");
        const rel = /^[A-Za-z0-9_./-]+$/.test(text) ? resolve(slug, baseDir, text) : null;
        out.push(rel ? `<a href="${href(rel)}">${codeBuf.join("")}${part}</a>` : codeBuf.join("") + part);
        codeBuf = null; inCode = 0; continue;
      }
      if (codeBuf) { codeBuf.push(part); continue; }
      out.push(part); continue;
    }
    if (codeBuf) { codeBuf.push(part); continue; }
    if (inA > 0 || !part.includes(".")) { out.push(part); continue; }
    out.push(part.replace(PATH_RE, (m, ref) => { const rel = resolve(slug, baseDir, ref); return rel ? `<a href="${href(rel)}">${esc(m)}</a>` : m; }));
  }
  if (codeBuf) out.push(codeBuf.join(""));
  return out.join("");
}
