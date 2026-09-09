/** Build a separate public edition. Never edit the private research checkout. */
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {BOOK_SOURCE, PUBLICATION_FILE, containsSourceExcerpts, needsSourceReview, externalSources, permittedDocumentPath, sha256, type Publication} from "../src/lib/document-publication.js";

const [input, output] = process.argv.slice(2);
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
const safeSummary = (value: string | undefined) => value && !containsSourceExcerpts(value) && !/[“"][^”"]{120,}[”"]/.test(value) ? value : "See the linked sources and the project's research records for the stated question and scope.";
const linkEdition = (path: string, text: string) => {
  const meta = Object.fromEntries((/<!--\s*ledger\s*\n([\s\S]*?)-->/.exec(text)?.[1] ?? "").split("\n").map(line => {const i = line.indexOf(":"); return i < 0 ? ["", ""] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];}));
  const title = /^#\s+(.+)$/m.exec(text)?.[1] || path.split("/").at(-1)!;
  const urls = externalSources(text);
  return `# ${title}\n\n## Public source guide\n\nThis working note includes quotations or source extracts. This public edition provides the project's summary and external references; the full working note is not redistributed. Consult the cited source for its original wording.\n\n${meta.question ? `**Research question:** ${safeSummary(meta.question)}\n\n` : ""}${meta.verdict ? `**Recorded assessment:** ${safeSummary(meta.verdict)}\n\n` : ""}This is a source guide, not the full derivation or an additional research result.\n\n## External sources\n\n${urls.length ? urls.map((url, i) => `${i + 1}. [${new URL(url).hostname.replace(/^www\./, "")} — source ${i + 1}](<${url}>)`).join("\n") : "No direct source URL was recorded. The full note is withheld from the public portfolio pending a source-linked edition."}\n`;
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
    const text = bytes.toString("utf8");
    if (path.endsWith(".md") && needsSourceReview(text)) { write(path, linkEdition(path, text), "source-links"); linked++; }
    else if (!path.endsWith(".ots") && needsSourceReview(text)) { excluded++; }
    else write(path, bytes, "project");
  }
};
visit(source);
write("attestation/EXTERNAL-SOURCES.md", `# External source material\n\nBook-page images and downloaded third-party publications are not hosted in this portfolio.\n\n- [Diamond and Halberstam, A Higher-Dimensional Sieve Method, Cambridge University Press (2008)](${BOOK_SOURCE}). Research references concern chapters 1, 5, 6 and 9.\n\nTimestamp proofs and hashes refer to the private research snapshot; they do not grant redistribution rights in its source material.\n`, "project");
write("PUBLICATION-POLICY.md", `# Document publication policy\n\nThis is a filtered public edition of the project's working material. Third-party books, papers, page images, downloads and source copies are linked externally, not redistributed. Notes that trigger quotation review are published as research summaries and source guides, not silently edited proofs. Private originals remain outside this portfolio.\n\nProject-authored text and research are shared under CC BY 4.0; code retains the project's code licence. These licences do not apply to the linked third-party sources.\n\nPUBLICATION.json records the exact files and hashes admitted to this edition. The document server rejects unlisted or modified files until a new filtered edition is prepared. Automated screening is conservative and is not a legal clearance of every passage; new external material must be kept out of the source mirror.\n`, "project");
mkdirSync(destination, {recursive: true});
writeFileSync(join(destination, PUBLICATION_FILE), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify({published: Object.keys(manifest.files).length, source_guides: linked, excluded, destination}));
