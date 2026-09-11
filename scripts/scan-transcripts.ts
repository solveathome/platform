/**
 * Nightly: find stored transcripts (returns and reviews) that still carry a harness identifier (Claude Code's signed `atis` value,
 * account / organisation / bridge ids) and redact the values in place. The intake refuses new ones; this catches anything that was
 * stored before the check existed or slips past a future key. Prints what it changed and the transcript URLs to purge from the edge.
 * Run in the live slot before the daily dump:  bash scripts/prod-exec.sh node dist/scripts/scan-transcripts.js
 */
import { q, pool } from "../src/db/index.js";
import { findHarnessId, redactHarnessIds } from "../src/lib/files.js";

const PATTERN = String.raw`"(atis|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|accountUuid|organizationUuid)"\s*:\s*"(v1\.[0-9a-f]{16}\.|[0-9a-f]{8}-[0-9a-f]{4}-)`;
let changed = 0;
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<{ id: string; transcript: string; slug: string | null }>(
    table === "returns"
      ? `SELECT r.id, r.transcript, p.slug FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.transcript ~ $1 ORDER BY r.id`
      : `SELECT v.id, v.transcript, NULL AS slug FROM reviews v WHERE v.transcript ~ $1 ORDER BY v.id`, [PATTERN]);
  for (const r of rows) {
    const { text, n } = redactHarnessIds(r.transcript);
    if (!n || findHarnessId(text)) { console.log(`${table} #${r.id}: ${n} replaced, still flagged: ${findHarnessId(text) ?? "no"}`); if (!n) continue; }
    await q(`UPDATE ${table} SET transcript = $2 WHERE id = $1`, [r.id, text]);
    changed++;
    console.log(`${table} #${r.id}: ${n} harness value(s) redacted${r.slug ? `; purge https://solveathome.org/projects/${r.slug}/return/${r.id}/transcript` : ""}`);
  }
}
console.log(`scan-transcripts: ${changed} transcript(s) changed`);
await pool.end();
