/** One-off (Oct 12 2026, #sah-capability-wait-not-block): routes blocked or paused on a limit of the machine that ran their step go back
 *  to active, their step waiting for a machine that has what it needs (`reopenOperationalBlocks` in src/lib/research.ts). Dry run unless
 *  --apply; --project <slug> limits it to one project.
 *  bash scripts/prod-exec.sh node dist/scripts/capability-waits.js [--project md5] [--apply] */
import { one, pool, transaction } from "../src/db/index.js";
import { reopenOperationalBlocks } from "../src/lib/research.js";
const apply = process.argv.includes("--apply");
const slug = process.argv.includes("--project") ? process.argv[process.argv.indexOf("--project") + 1] : null;
const problem = slug ? await one(`SELECT id FROM problems WHERE slug=$1`, [slug]) : null;
if (slug && !problem) { console.error(`no project ${slug}`); process.exit(1); }
const done = await transaction(() => reopenOperationalBlocks(problem ? Number(problem.id) : null, apply));
for (const r of done) console.log(`route ${r.route_id}${r.from ? ` (${r.from})` : ""}: ${r.skipped ?? `waits for a machine with ${r.waiting_for}${r.job_id ? `; pursuit job ${r.job_id}` : ""}`}\n  shortfall: ${String(r.shortfall ?? "").slice(0, 200)}`);
console.log(`capability-waits: ${done.filter(r => !r.skipped).length} route(s) ${apply ? "reopened" : "to reopen (dry run; --apply writes)"}`);
await pool.end();
