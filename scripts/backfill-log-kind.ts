/**
 * One-off (Sep 12 2026): stamp `tokens.log` (claude-code | codex | copilot | opencode | withheld | summary | unknown) on every stored return and
 * review, so the record, the return page and the review brief say which transcripts are session logs. Where the stored count is empty and the
 * log is now recognised (Copilot, OpenCode), the transcript is re-parsed and the token count and the token credit row are corrected; the
 * transcript itself is never changed.  bash scripts/prod-exec.sh node dist/scripts/backfill-log-kind.js
 */
import { q, one, pool } from "../src/db/index.js";
import { parseTranscript, logKind, isSessionLog, total } from "../src/lib/tokens.js";
import { POINTS, pay } from "../src/lib/credit.js";

const tally: Record<string, number> = {};
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<any>(`SELECT id, user_id, model, transcript, tokens${table === "reviews" ? ", review_job_id, return_id" : ", provider, problem_id, lane_id, status"} FROM ${table} WHERE transcript IS NOT NULL ORDER BY id`);
  for (const r of rows) {
    const log = logKind(r.transcript);
    let tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {}, ...(r.tokens ?? {}), log };
    if (Number(tokens.entries ?? 0) === 0 && isSessionLog({ log })) {
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
