/** Review triage for the returns already waiting (Chris, Sep 18 2026, #sah-review-only-meaningful).
 * For every pending return of a project with triage on whose review jobs are still queued (nobody holds one) and that
 * has no triage yet: the queued review jobs are expired ("replaced by triage") and one triage job is made, so the first
 * read happens before any trusted reviewer spends an hour on it. Left alone: returns whose review is assigned right now,
 * packaged returns with a completed independent check (the receipt is the first pass), duplicates, and returns already
 * triaged. Dry run by default; --apply does it under the project lock. Never manufactures a return, review or credit.
 *
 *   npx tsx scripts/triage-backlog.ts [--apply] [--project=twin-primes]
 */
import { q, one, pool, projectTransaction } from "../src/db/index.js";
import { reviewTriage } from "../src/lib/scheduler.js";
import { spawnTriage } from "../src/routes/job.js";
import { verificationRuns, isCompletedCheck } from "../src/lib/verification.js";

const apply = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--project="))?.slice("--project=".length);
try {
  const projects = await q<{ id: string; slug: string }>(`SELECT id, slug FROM problems ${only ? "WHERE slug = $1" : ""} ORDER BY id`, only ? [only] : []);
  for (const p of projects) {
    const cfg = reviewTriage(p.slug);
    if (!cfg) { console.log(JSON.stringify({ project: p.slug, triage: "off", skipped: true })); continue; }
    await projectTransaction(p.id, async () => {
      const waiting = await q(`SELECT r.* FROM returns r WHERE r.problem_id = $1 AND r.status = 'pending' AND NOT r.provisional AND r.duplicate_of IS NULL
          AND EXISTS (SELECT 1 FROM jobs j WHERE j.parent_return_id = r.id AND j.type = 'review' AND j.status = 'queued')
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.parent_return_id = r.id AND j.type IN ('review','triage') AND j.status = 'assigned')
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.parent_return_id = r.id AND j.type = 'triage')
          AND NOT EXISTS (SELECT 1 FROM triages t WHERE t.return_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.return_id = r.id AND rv.trusted AND NOT rv.needs_reassessment)
        ORDER BY r.created_at, r.id`, [p.id]);
      let converted = 0, checked = 0, reviewJobs = 0;
      for (const ret of waiting) {
        if (ret.verification_plan && (await verificationRuns(Number(ret.id))).some(isCompletedCheck)) { checked++; continue; }
        const jobs = await q<{ id: string }>(`SELECT id FROM jobs WHERE parent_return_id = $1 AND type = 'review' AND status = 'queued'`, [ret.id]);
        reviewJobs += jobs.length; converted++;
        if (!apply) continue;
        await q(`UPDATE jobs SET status = 'expired', last_release_note = 'replaced by review triage (Sep 2026): a first read decides whether a trusted verdict is sought' WHERE parent_return_id = $1 AND type = 'review' AND status = 'queued'`, [ret.id]);
        await q(`INSERT INTO return_decisions (return_id, status, final_rung, provisional, by, note) VALUES ($1,'pending',NULL,false,'triage',$2)`, [ret.id, `Put to triage first (review triage switched on): an agent that is not a trusted reviewer reads it and says whether a trusted verdict would change the record.`]);
        await spawnTriage(ret, cfg, jobs.length);
      }
      console.log(JSON.stringify({ project: p.slug, triage: cfg, pending_with_queued_reviews: waiting.length, converted, review_jobs_replaced: reviewJobs, left_for_judgment_checked: checked, applied: apply }));
    });
  }
} finally { await pool.end(); }
