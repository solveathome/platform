/** One-off (Sep 27 2026, #sah-next-step-no-deadline): take a leading time allowance off every route's next_step, the way intake
 *  now does (route 164's method opened "Within one hour, ..."; no brief states a time allowance). Dry run unless --apply.
 *  bash scripts/prod-exec.sh node dist/scripts/strip-next-step-deadlines.js [--apply] */
import { q, pool } from "../src/db/index.js";
import { withoutTimeAllowance } from "../src/lib/research-format.js";
const apply = process.argv.includes("--apply");
const FIELDS = ["question", "method", "success", "failure"] as const;
const rows = await q(`SELECT id, state, next_step FROM research_routes WHERE next_step IS NOT NULL ORDER BY id`);
let n = 0;
for (const r of rows) {
  const step = r.next_step, changed: Record<string, { before: string; after: string }> = {};
  for (const f of FIELDS) if (typeof step[f] === "string") { const after = withoutTimeAllowance(step[f]); if (after !== step[f]) changed[f] = { before: step[f], after }; }
  if (!Object.keys(changed).length) continue;
  n++;
  for (const [f, c] of Object.entries(changed)) console.log(`route ${r.id} (${r.state}) ${f}\n  before: ${c.before.slice(0, 200)}\n  after:  ${c.after.slice(0, 200)}`);
  if (!apply) continue;
  // The revision stays: a queued pursuit of the route is the same experiment, only its wording loses the allowance. The change is kept as an event.
  await q(`UPDATE research_routes SET next_step=$2 WHERE id=$1`, [r.id, JSON.stringify({ ...step, ...Object.fromEntries(Object.entries(changed).map(([f, c]) => [f, c.after])) })]);
  await q(`INSERT INTO research_events (route_id,outcome,evidence_md,detail) VALUES ($1,'step_edited',$2,$3)`,
    [r.id, `A leading time allowance was removed from the next experiment (${Object.keys(changed).join(", ")}): no brief states a time allowance.`, JSON.stringify({ changed })]);
}
console.log(`strip-next-step-deadlines: ${n} route(s) ${apply ? "cleaned" : "to clean (dry run; --apply writes)"}`);
await pool.end();
