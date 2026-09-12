/**
 * One-off (Sep 12 2026): stamp `tokens.log` (claude-code | codex | copilot | opencode | withheld | summary | unknown) on every stored return and
 * review, so the record, the return page and the review brief say which transcripts are session logs. Where the stored count is empty and the
 * log is now recognised (Copilot, OpenCode), the transcript is re-parsed and the token count and the token credit row are corrected; the
 * transcript itself is never changed.  bash scripts/prod-exec.sh node dist/scripts/backfill-log-kind.js
 * Also (issue #55): a transcript that belongs to another assignment is stamped `tokens.mismatch`, its count zeroed and its token credit row
 * set to zero, since those tokens were credited on the return they belong to. Idempotent: re-running re-derives every stamp.
 */
import { q, one, pool } from "../src/db/index.js";
import { parseTranscript, logKind, isSessionLog, total, assignmentMismatch } from "../src/lib/tokens.js";
import { POINTS, pay } from "../src/lib/credit.js";

const tally: Record<string, number> = {};
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<any>(table === "reviews"
    ? `SELECT rv.id, rv.user_id, rv.model, rv.transcript, rv.tokens, rv.review_job_id, rv.return_id, rv.review_job_id AS assignment_id, j.assigned_at FROM reviews rv LEFT JOIN jobs j ON j.id = rv.review_job_id WHERE rv.transcript IS NOT NULL ORDER BY rv.id`
    : `SELECT r.id, r.user_id, r.model, r.transcript, r.tokens, r.provider, r.problem_id, r.lane_id, r.status, r.job_id AS assignment_id, j.assigned_at FROM returns r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.transcript IS NOT NULL ORDER BY r.id`);
  for (const r of rows) {
    const log = logKind(r.transcript);
    let tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {}, ...(r.tokens ?? {}), log };
    delete (tokens as any).mismatch;
    const mismatch = r.assignment_id ? assignmentMismatch(r.transcript, Number(r.assignment_id), r.assigned_at ? new Date(r.assigned_at) : null) : null;
    if (mismatch) {
      tokens = { ...tokens, input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, models: {}, mismatch } as any;
      const src = table === "returns" ? String(r.id) : String(r.review_job_id ?? `r${r.return_id}`);
      const note = `0 tokens: the transcript belongs to another assignment (${mismatch.reason})`;
      await q(`UPDATE credits SET points = 0, note = $3 WHERE source_type = $1 AND source_id = $2 AND kind = 'tokens' AND user_id = $4`, [table === "returns" ? "return" : "review", src, note, r.user_id]);
      console.log(`${table} #${r.id}: transcript from another assignment: ${mismatch.reason}`);
    }
    else if (Number(tokens.entries ?? 0) === 0 && isSessionLog({ log })) {
      const fresh = parseTranscript(r.transcript);
      if (fresh.entries > 0) {
        for (const k of ["codex", "copilot", "opencode"]) if (fresh.models && fresh.models[k] !== undefined && r.model) { const n = fresh.models[k]; delete fresh.models[k]; if (n > 0) fresh.models[r.model] = (fresh.models[r.model] ?? 0) + n; }
        tokens = { ...fresh, log } as any;
        const ttot = total(fresh);
        if (table === "returns") {
          // Token points are paid when a return is decided (credit.ts); a return decided while its count was zero never got the row, so pay it now.
          const note = `${ttot.toLocaleString("en-US")} tokens (${fresh.output.toLocaleString("en-US")} output), ${fresh.source}, recounted`;
          const had = await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(r.id)]);
          if (had) await q(`UPDATE credits SET points = $2, note = $3 WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(r.id), ttot / 1e6 * POINTS.tokens_per_million, note]);
          else if (ttot > 0 && ["accepted", "rejected"].includes(r.status)) await pay(Number(r.user_id), r.model, r.provider, Number(r.problem_id), r.lane_id === null ? null : Number(r.lane_id), "tokens", ttot / 1e6 * POINTS.tokens_per_million, "return", r.id, `${note} on a${r.status === "accepted" ? "n accepted" : " rejected"} return`);
        }
        else { const src = String(r.review_job_id ?? `r${r.return_id}`); const note = `${ttot.toLocaleString("en-US")} tokens (${fresh.output.toLocaleString("en-US")} output), ${fresh.source}, review of return #${r.return_id}, recounted`;
          if (await one(`SELECT 1 FROM credits WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, r.user_id])) await q(`UPDATE credits SET note = $3 WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, r.user_id, note]);
          else if (ttot > 0) await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) SELECT $1, $2, rv.provider, rt.problem_id, rt.lane_id, 'tokens', 0, 'review', $3, $4 FROM reviews rv JOIN returns rt ON rt.id = rv.return_id WHERE rv.id = $5`, [r.user_id, r.model, src, note, r.id]); }
        console.log(`${table} #${r.id}: recounted as ${log}: ${ttot.toLocaleString("en-US")} tokens`);
      }
    }
    await q(`UPDATE ${table} SET tokens = $2 WHERE id = $1`, [r.id, JSON.stringify(tokens)]);
    tally[`${table}:${log}`] = (tally[`${table}:${log}`] ?? 0) + 1;
    if (log === "summary" || log === "unknown") console.log(`${table} #${r.id}: ${log}`);
  }
}
console.log(JSON.stringify(tally));
await pool.end();
