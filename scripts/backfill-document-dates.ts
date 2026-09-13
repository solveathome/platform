/** Add source evidence to an existing edition only where the prepared public bytes match exactly.
 * Usage: backfill-document-dates <dated-PUBLICATION.json> <slug>. No document bodies are changed. */
import {readFileSync, writeFileSync, renameSync} from "node:fs";
import {join} from "node:path";
import {migrate, one, pool} from "../src/db/index.js";
import {ROOT} from "../src/lib/paths.js";
import {readPublication, publishedDocument, PUBLICATION_FILE, type Publication} from "../src/lib/document-publication.js";
import {recordPublication} from "../src/lib/document-record.js";
import {SLUG} from "../src/lib/guards.js";

const [input, slug, output] = process.argv.slice(2);
if (!input || !slug || !SLUG.test(slug)) throw new Error("Usage: backfill-document-dates <dated-PUBLICATION.json> <slug>");
const evidence: Publication = JSON.parse(readFileSync(input, "utf8"));
if (evidence.version !== 1 || !evidence.files) throw new Error("Invalid dated publication manifest");
const root = join(process.env.DOCS_DIR ?? join(ROOT, "data", "repos"), slug);
const publication = readPublication(root);
if (!publication) throw new Error("No published edition for this project");
await migrate();
const p = await one(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error("Unknown project");
await recordPublication(slug, Number(p.id));
let matched = 0, unmatched = 0;
for (const [path, entry] of Object.entries(publication.files)) {
  const source = evidence.files[path];
  if (entry.source?.created_at) continue;
  if (!source?.source?.created_at || source.sha256 !== entry.sha256 || !publishedDocument(root, path, publication)) { unmatched++; continue; }
  entry.source = source.source;
  matched++;
}
if (matched) {
  // Read-only production mounts can write a prepared manifest elsewhere for an atomic host-side install.
  const destination = output ?? join(root, PUBLICATION_FILE);
  const temp = `${destination}.pending-${process.pid}`;
  writeFileSync(temp, JSON.stringify(publication, null, 2) + "\n");
  renameSync(temp, destination);
  if (!output) await recordPublication(slug, Number(p.id));
}
console.log(JSON.stringify({slug, matched, unmatched, note: "Document bytes and edition preparation date preserved; unmatched source dates remain unknown."}));
await pool.end();
