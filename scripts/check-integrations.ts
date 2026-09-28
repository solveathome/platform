/**
 * Integrated revisions the served text no longer carries (#mba-sah-bot-feedback-fixes, fix 4): a document whose served text is not its
 * latest recorded version lost the accepted edits after the version it equals. Read-only.
 * Run on the server: bash scripts/prod-exec.sh node dist/scripts/check-integrations.js [slug]. Exits 1 when a document drifted.
 */
import { one, pool } from "../src/db/index.js";
import { featuredProject } from "../src/lib/projects.js";
import { servedDrift } from "../src/lib/revisions.js";

const slug = process.argv[2] ?? (await featuredProject())?.slug ?? "";
const p = await one<{ id: number }>(`SELECT id FROM problems WHERE slug = $1`, [slug]);
if (!p) throw new Error(`unknown project ${slug}`);
const drift = await servedDrift(Number(p.id), slug);
for (const d of drift) console.log(`${d.path}: served ${d.served_version ? `version ${d.served_version}` : `a text of no recorded version (${String(d.served_sha).slice(0, 12)})`}, latest is version ${d.latest}; integrated returns not served: ${d.lost_returns.map((id) => `#${id}`).join(", ") || "none"}`);
console.log(`${drift.length} document(s) of ${slug} serve a text other than their latest version`);
await pool.end();
process.exitCode = drift.length ? 1 : 0;
