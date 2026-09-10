/** Build a separate public edition. Never edit the private research checkout. */
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {ROOT} from "../src/lib/paths.js";
import {BOOK_SOURCE, PUBLICATION_FILE, containsSourceReproduction, needsSourceReview, externalSources, permittedDocumentPath, sha256, type Publication} from "../src/lib/document-publication.js";

/**
 * Redaction before publication. Generic: home-directory paths become "~/" (they name the machine's user and layout).
 * Project-specific rules stay in the private research repo, never in this public code: <src>/.publication.json
 * { "replace": [["from", "to"], ...] } is applied verbatim (plain strings, all occurrences), e.g. a personal email or a name form.
 */
let RULES: Array<[string, string]> = [];
function loadRules(src: string): void {
  const f = join(src, ".publication.json");
  if (!existsSync(f)) return;
  try { const j = JSON.parse(readFileSync(f, "utf8")); RULES = Array.isArray(j.replace) ? j.replace.filter((r: unknown) => Array.isArray(r) && r.length === 2 && typeof r[0] === "string" && r[0]).map((r: any) => [String(r[0]), String(r[1])]) : []; }
  catch (e: any) { throw new Error(`.publication.json: ${e.message}`); }
}
function redact(text: string): string {
  let t = text.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//g, "~/");
  for (const [from, to] of RULES) t = t.split(from).join(to);
  return t;
}

const [input, output] = process.argv.slice(2);
if (input) loadRules(resolve(input));
if (!input || !output) throw new Error("Usage: prepare-document-portfolio <source> <new-output-directory>");
const source = resolve(input), destination = resolve(output);
if (destination === source || destination.startsWith(source + "/") || existsSync(destination)) throw new Error("Output must be a new directory outside the source tree.");
const manifest: Publication = {version: 1, generated_at: new Date().toISOString(), files: {}};
let excluded = 0, linked = 0;

const write = (path: string, body: string | Buffer, mode: "project" | "source-links") => {
  const target = join(destination, path);
  mkdirSync(resolve(target, ".."), {recursive: true});
  writeFileSync(target, body);
  manifest.files[path] = {sha256: sha256(body), mode};
};
const safeSummary = (value: string | undefined) => value && !containsSourceReproduction(value) && !/[“"][^”"]{120,}[”"]/.test(value) ? value : "See the linked sources and the project's research records for the stated question and scope.";
const linkEdition = (path: string, text: string) => {
  const meta = Object.fromEntries((/<!--\s*ledger\s*\n([\s\S]*?)-->/.exec(text)?.[1] ?? "").split("\n").map(line => {const i = line.indexOf(":"); return i < 0 ? ["", ""] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];}));
  const title = /^#\s+(.+)$/m.exec(text)?.[1] || path.split("/").at(-1)!;
  const urls = externalSources(text);
  return `# ${title}\n\n## Public source guide\n\nThis working note is flagged as including a full source reproduction. This public edition provides the project's summary and source references; the full working note stays in the local research repository. Researchers may consult and cite local sources without uploading them.\n\n${meta.question ? `**Research question:** ${safeSummary(meta.question)}\n\n` : ""}${meta.verdict ? `**Recorded assessment:** ${safeSummary(meta.verdict)}\n\n` : ""}This is a source guide, not the full derivation or an additional research result.\n\n## Local working-note reference\n\n- Repository: project research working material\n- Relative path: \`${path}\`\n- SHA-256 of the original working note: \`${sha256(text)}\`\n- Access: local-only; the original is not hosted here\n\nThis reference identifies the note used for this edition. It does not establish independent verification or rights to redistribute the sources it cites.\n\n## External sources\n\n${urls.length ? urls.map((url, i) => `${i + 1}. [${new URL(url).hostname.replace(/^www\./, "")} — source ${i + 1}](<${url}>)`).join("\n") : "No public source URL was recorded. The local working-note reference above remains a citation; checking its evidence requires access to that repository and its cited sources."}\n`;
};
/** Root guidance files carry repository-internal instructions (the publication moratorium, the off-limits notes file). The public edition drops those paragraphs and bullets and says so. */
const INTERNAL_ROOT = /moratorium|human_notes_not_for_ai/i;
const OFF_LIMITS = /human_notes_not_for_ai/i;
const publicEdition = (text: string, INTERNAL: RegExp = INTERNAL_ROOT) => {
  const out: string[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    if (lines.some(l => /^\s*[-*] /.test(l))) {
      const items: string[][] = [];
      for (const l of lines) { if (/^\s*[-*] /.test(l) || items.length === 0) items.push([l]); else items[items.length - 1].push(l); }
      const kept = items.filter(it => !INTERNAL.test(it.join("\n"))).map(it => it.join("\n"));
      if (kept.length) out.push(kept.join("\n"));
    } else if (!INTERNAL.test(block)) out.push(block);
  }
  let body = out.join("\n\n");
  body = body.replace(/^(#\s.+\n)/, "$1\n> Public mirror edition: repository-internal working instructions were removed. See MIRROR.md.\n");
  if (INTERNAL.test(body)) throw new Error("public edition still carries internal instructions");
  return body;
};
const visit = (dir: string, prefix = "") => {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".") || name === "human_notes_not_for_ai.txt" || /^(node_modules|vendor|third[-_]party|downloads?|source[-_]copies|book-ch5-6)$/i.test(name)) { excluded++; continue; }
    const path = prefix + name, full = join(dir, name), stat = lstatSync(full);
    if (stat.isSymbolicLink()) { excluded++; continue; }
    if (stat.isDirectory()) { visit(full, path + "/"); continue; }
    if (!permittedDocumentPath(path)) { excluded++; continue; }
    const bytes = readFileSync(full);
    if (/^%PDF-|^PK\x03\x04/.test(bytes.subarray(0, 8).toString("latin1")) || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { excluded++; continue; }
    const text = redact(bytes.toString("utf8"));
    if (path.endsWith(".md") && needsSourceReview(text)) { write(path, linkEdition(path, text), "source-links"); linked++; }
    else if (!path.endsWith(".ots") && needsSourceReview(text)) { excluded++; }
    else if (prefix === "" && /^(CLAUDE|AGENTS|README|TODO)\.md$/.test(name)) write(path, publicEdition(text), "project");
    else if (path.endsWith(".md") && OFF_LIMITS.test(text)) write(path, publicEdition(text, OFF_LIMITS), "project");
    // Text files are published redacted; only binary proofs (.ots) keep their exact bytes.
    else write(path, path.endsWith(".ots") || text.includes("\uFFFD") ? bytes : text, "project");
  }
};
visit(source);
write("attestation/EXTERNAL-SOURCES.md", `# External source material\n\nBook-page images and downloaded third-party publications are not hosted in this portfolio.\n\n- [Diamond and Halberstam, A Higher-Dimensional Sieve Method, Cambridge University Press (2008)](${BOOK_SOURCE}). Research references concern chapters 1, 5, 6 and 9.\n\nTimestamp proofs and hashes refer to the private research snapshot; they do not grant redistribution rights in its source material.\n`, "project");
// A license file GitHub detects: the project-authored content is CC BY 4.0 (the platform code is MIT, separately).
write("LICENSE", readFileSync(join(ROOT, "docs", "licenses-CC-BY-4.0.txt"), "utf8"), "project");
write("PUBLICATION-POLICY.md", `# Document publication policy\n\nResearchers may keep source documents, datasets and working notes in their own local repositories and cite them. The restriction is on publishing third-party source copies through solveathome, including its document portfolio, uploads, transcripts and dataset exports. Local research sources do not have to be uploaded or made public.\n\nCite the source title or repository label, author, version or commit, relative path and page, section, equation or data-row locator. Include a SHA-256 when useful and an external source URL when available. Mark material local-only when others cannot access it publicly, and state which checks require access. A citation or hash identifies evidence; it does not establish independent verification.\n\nPublish original analysis, derivations, code and shareable measurements with attribution and limitations. Attributed quotations, citations and links are welcome in original research notes. Complete third-party books, papers, page images, downloads and bulk source reproductions stay outside this portfolio. Replace full source payloads in public transcripts with citations and omission notes; preserve the researcher's reasoning and usage metadata.\n\nThis portfolio is a filtered edition. Notes that contain full source reproductions become clearly labelled summaries and source guides with a path and hash identifying the private working note. Project-authored text and research are shared under CC BY 4.0; code retains the project's code licence. These licences do not apply to cited third-party sources.\n\nPUBLICATION.json records the exact files and hashes admitted to this edition. The document server rejects unlisted or modified files until a new filtered edition is prepared. Automated screening is conservative and is not a legal clearance of every passage.\n`, "project");
mkdirSync(destination, {recursive: true});
writeFileSync(join(destination, PUBLICATION_FILE), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({published: Object.keys(manifest.files).length, source_guides: linked, excluded, destination}));
