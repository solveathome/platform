/** Triage points for triages answered before they were paid (Chris, Sep 23 2026, #sah-triage-close-and-reward: "Pay each triage like a
 * read review of the return, whatever the answer (10 for an explore; each covered return at the floor of 5)"). For every triage row
 * without its payment: the return it read pays the read-review share, a return covered by a series answer pays the floor. Appends to the
 * ledger through credit.payTriage (once per triager per return), never rewrites it. Also settles returns a triage no recorded before
 * settleRecorded existed. Dry run by default; --apply does it under each project's lock.
 *
 *   npx tsx scripts/triage-credit-backfill.ts [--apply] [--project=twin-primes]
 */
import { q, pool, projectTransaction } from "../src/db/index.js";
import * as credit from "../src/lib/credit.js";
import { settleRecorded } from "../src/routes/job.js";

const apply = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--project="))?.slice("--project=".length);
try {
  const projects = await q<{ id: string; slug: string }>(`SELECT id, slug FROM problems ${only ? "WHERE slug = $1" : ""} ORDER BY id`, only ? [only] : []);
  for (const p of projects) {
    await projectTransaction(p.id, async () => {
      const unpaid = await q(`SELECT t.id AS triage_id, t.user_id AS t_user, t.model AS t_model, t.provider AS t_provider, t.effort AS t_effort, t.escalate, t.notes_md LIKE 'Covered by the triage of return #%' AS covered, r.*
          FROM triages t JOIN returns r ON r.id = t.return_id WHERE r.problem_id = $1
          AND NOT EXISTS (SELECT 1 FROM credits c WHERE c.source_type = 'return' AND c.source_id = r.id::text AND c.kind = 'review' AND c.user_id = t.user_id AND c.note LIKE 'triage%')
        ORDER BY t.id`, [p.id]);
      const unsettled = await q<{ id: string }>(`SELECT r.id FROM returns r WHERE r.problem_id = $1 AND r.status = 'recorded'
          AND EXISTS (SELECT 1 FROM return_decisions d WHERE d.return_id = r.id AND d.by = 'triage' AND d.status = 'recorded')
          AND (EXISTS (SELECT 1 FROM jobs j WHERE j.id = r.job_id AND j.status = 'returned') OR EXISTS (SELECT 1 FROM jobs j WHERE j.parent_return_id = r.id AND j.status IN ('queued','assigned')))`, [p.id]);
      if (apply) {
        for (const row of unpaid) await credit.payTriage(row, { user_id: Number(row.t_user), model: row.t_model, provider: row.t_provider, effort: row.t_effort }, !!row.covered, !!row.escalate);
        for (const r of unsettled) await settleRecorded(Number(r.id));
      }
      console.log(JSON.stringify({ project: p.slug, triages_to_pay: unpaid.map((r) => ({ triage: Number(r.triage_id), return: Number(r.id), type: r.type, covered: !!r.covered })), recorded_to_settle: unsettled.map((r) => Number(r.id)), applied: apply }));
    });
  }
} finally { await pool.end(); }
