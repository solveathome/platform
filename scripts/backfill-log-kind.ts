/**
 * One-off (Sep 12 2026): stamp `tokens.log` (claude-code | codex | copilot | summary | unknown) on every stored return and review
 * whose tokens JSON predates the field, so the record, the return page and the review brief say which transcripts are session logs.
 * Counts nothing and changes no transcript.  bash scripts/prod-exec.sh node dist/scripts/backfill-log-kind.js
 */
import { q, pool } from "../src/db/index.js";
import { logKind } from "../src/lib/tokens.js";

const tally: Record<string, number> = {};
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<{ id: string; transcript: string; tokens: any }>(`SELECT id, transcript, tokens FROM ${table} WHERE transcript IS NOT NULL AND (tokens IS NULL OR tokens->>'log' IS NULL) ORDER BY id`);
  for (const r of rows) {
    const log = logKind(r.transcript);
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, entries: 0, source: "none", models: {}, ...(r.tokens ?? {}), log };
    await q(`UPDATE ${table} SET tokens = $2 WHERE id = $1`, [r.id, JSON.stringify(tokens)]);
    tally[`${table}:${log}`] = (tally[`${table}:${log}`] ?? 0) + 1;
    if (log === "summary" || log === "unknown") console.log(`${table} #${r.id}: ${log}`);
  }
}
console.log(JSON.stringify(tally));
await pool.end();
