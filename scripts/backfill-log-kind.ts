/**
 * Re-derive the token record of every stored return and review (Sep 12 2026); idempotent, run after a deploy that changes how transcripts
 * are read:  bash scripts/prod-exec.sh node dist/scripts/backfill-log-kind.js
 * - `tokens.log` (claude-code | codex | copilot | opencode | custom | withheld | summary | unknown) is stamped on every row.
 * - A transcript from another assignment (issue #55) is stamped `tokens.mismatch`, its count zeroed and its token credit row set to zero.
 * - A usage entry counts once per person (Chris: "clean up the highscore"): `counted_entries` is rebuilt in submission order, entries already
 *   on record for the handle are skipped (`tokens.already_counted`), and the count and the credit row follow.
 * - Where the count changed, the credit row is corrected; a decided return that never got one is paid now. The transcript is never changed.
 */
import { q, one, pool } from "../src/db/index.js";
import { parseTranscriptWithKeys, logKind, total, assignmentMismatch } from "../src/lib/tokens.js";
import { POINTS, pay } from "../src/lib/credit.js";

const tally: Record<string, number> = {};
const sum = (t: any) => Number(t?.input ?? 0) + Number(t?.output ?? 0) + Number(t?.cache_read ?? 0) + Number(t?.cache_write ?? 0);
await q(`DELETE FROM counted_entries`);
const rows = await q<any>(
  `SELECT 'returns' AS tbl, r.id, r.user_id, r.model, r.transcript, r.tokens, r.provider, r.problem_id, r.lane_id, r.status, NULL::bigint AS review_job_id, NULL::bigint AS return_id, r.job_id AS assignment_id, j.assigned_at, r.created_at
     FROM returns r LEFT JOIN jobs j ON j.id = r.job_id WHERE r.transcript IS NOT NULL
   UNION ALL
   SELECT 'reviews', rv.id, rv.user_id, rv.model, rv.transcript, rv.tokens, rv.provider, NULL::bigint, NULL::bigint, NULL::text, rv.review_job_id, rv.return_id, rv.review_job_id, j.assigned_at, rv.created_at
     FROM reviews rv LEFT JOIN jobs j ON j.id = rv.review_job_id WHERE rv.transcript IS NOT NULL
   ORDER BY created_at, id`);
for (const r of rows) {
  const table: "returns" | "reviews" = r.tbl;
  const log = logKind(r.transcript);
  const stored = r.tokens ?? {};
  let tokens: any;
  let why = "";
  const mismatch = r.assignment_id ? assignmentMismatch(r.transcript, Number(r.assignment_id), r.assigned_at ? new Date(r.assigned_at) : null) : null;
  if (mismatch) {
    tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: stored.source ?? "none", models: {}, log, mismatch };
    why = `the transcript belongs to another assignment (${mismatch.reason})`;
  } else {
    const probe = parseTranscriptWithKeys(r.transcript);
    const prior = probe.keys.length ? await q<{ key: string; source_type: string; source_id: string }>(`SELECT key, source_type, source_id FROM counted_entries WHERE user_id = $1 AND key = ANY($2::text[])`, [r.user_id, probe.keys]) : [];
    const exclude = new Set(prior.map((p) => p.key));
    const res = exclude.size ? parseTranscriptWithKeys(r.transcript, undefined, exclude) : probe;
    if (res.keys.length === 0 && exclude.size === 0) {
      // Nothing parses (withheld, summary, unknown, or a self-reported count from before transcripts were parsed): the stored numbers stand.
      tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {}, ...stored, log };
      delete tokens.mismatch; delete tokens.already_counted;
    } else {
      tokens = { ...res.tokens, log };
      for (const k of ["codex", "copilot", "opencode"]) if (tokens.models && tokens.models[k] !== undefined && r.model) { const n = tokens.models[k]; delete tokens.models[k]; if (n > 0) tokens.models[r.model] = (tokens.models[r.model] ?? 0) + n; }
      if (exclude.size) { tokens.already_counted = { entries: exclude.size, of: probe.keys.length, on: [...new Set(prior.map((p) => `${p.source_type} #${p.source_id}`))].sort() }; why = `${exclude.size} of ${probe.keys.length} usage entries already counted on ${tokens.already_counted.on.join(", ")}`; }
      if (res.keys.length) await q(`INSERT INTO counted_entries (user_id, key, source_type, source_id) SELECT $1, unnest($2::text[]), $3, $4 ON CONFLICT DO NOTHING`, [r.user_id, res.keys, table === "returns" ? "return" : "review", r.id]);
    }
  }
  const ttot = total(tokens);
  if (ttot !== sum(stored) || mismatch) {
    const shown = `${ttot.toLocaleString("en-US")} tokens (${Number(tokens.output ?? 0).toLocaleString("en-US")} output), ${tokens.source}`;
    if (table === "returns") {
      const note = why ? `${shown}: ${why}` : `${shown}, recounted`;
      const had = await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(r.id)]);
      if (had) await q(`UPDATE credits SET points = $2, note = $3 WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(r.id), ttot / 1e6 * POINTS.tokens_per_million, note]);
      else if (ttot > 0 && ["accepted", "rejected"].includes(r.status)) await pay(Number(r.user_id), r.model, r.provider, Number(r.problem_id), r.lane_id === null ? null : Number(r.lane_id), "tokens", ttot / 1e6 * POINTS.tokens_per_million, "return", r.id, `${note} on a${r.status === "accepted" ? "n accepted" : " rejected"} return`);
    } else {
      const src = String(r.review_job_id ?? `r${r.return_id}`); const note = `${shown}, review of return #${r.return_id}${why ? `: ${why}` : ", recounted"}`;
      if (await one(`SELECT 1 FROM credits WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, r.user_id])) await q(`UPDATE credits SET note = $3 WHERE source_type = 'review' AND source_id = $1 AND kind = 'tokens' AND user_id = $2`, [src, r.user_id, note]);
      else if (ttot > 0) await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) SELECT $1, $2, rv.provider, rt.problem_id, rt.lane_id, 'tokens', 0, 'review', $3, $4 FROM reviews rv JOIN returns rt ON rt.id = rv.return_id WHERE rv.id = $5`, [r.user_id, r.model, src, note, r.id]);
    }
    console.log(`${table} #${r.id}: ${sum(stored).toLocaleString("en-US")} → ${ttot.toLocaleString("en-US")} tokens${why ? `: ${why}` : ""}`);
  }
  await q(`UPDATE ${table} SET tokens = $2 WHERE id = $1`, [r.id, JSON.stringify(tokens)]);
  tally[`${table}:${log}`] = (tally[`${table}:${log}`] ?? 0) + 1;
  if (log === "summary" || log === "unknown") console.log(`${table} #${r.id}: ${log}`);
}
console.log(JSON.stringify(tally));
await pool.end();
