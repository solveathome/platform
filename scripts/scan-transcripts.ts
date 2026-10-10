/**
 * Nightly: find stored transcripts (returns and reviews) that still carry a harness identifier (Claude Code's signed `atis` value,
 * account / organisation / bridge ids) and redact the values in place. The intake refuses new ones; this catches anything that was
 * stored before the check existed or slips past a future key. Prints what it changed and the transcript URLs to purge from the edge.
 * Run in the live slot before the daily dump:  bash scripts/prod-exec.sh node dist/scripts/scan-transcripts.js
 *
 * Home paths (Chris, Oct 10 2026, card 1255: "scrub those home paths but otherwise not do anything"): a published return's transcript
 * that still names a home folder (/Users/<name>, /home/<name>, C:\Users\<name>) gets the prefix replaced by ~, nothing else.
 *   --dry-run   change nothing; print what would change
 *   --backup    change nothing; write the affected rows as JSON lines ({table, id, transcript}) to stdout, logs to stderr
 */
import { q, pool } from "../src/db/index.js";
import { findHarnessId, redactHarnessIds, redactHomePaths } from "../src/lib/files.js";

const backup = process.argv.includes("--backup"), dryRun = backup || process.argv.includes("--dry-run");
const log = (s: string) => (backup ? console.error : console.log)(s);
const PATTERN = String.raw`"(atis|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|accountUuid|organizationUuid)"\s*:\s*"(v1\.[0-9a-f]{16}\.|[0-9a-f]{8}-[0-9a-f]{4}-)`;
// A cheap superset of what redactHomePaths replaces; the function decides.
const HOME = String.raw`(/Users|/home)/[A-Za-z0-9._-]|[A-Za-z]:\\+Users\\+`;
let changed = 0, homes = 0;
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<{ id: string; transcript: string; slug: string | null }>(
    table === "returns"
      ? `SELECT r.id, r.transcript, p.slug FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.transcript ~ $1 OR r.transcript ~ $2 ORDER BY r.id`
      : `SELECT v.id, v.transcript, NULL AS slug FROM reviews v WHERE v.transcript ~ $1 ORDER BY v.id`, table === "returns" ? [PATTERN, HOME] : [PATTERN]);
  for (const r of rows) {
    const ids = redactHarnessIds(r.transcript);
    if (ids.n && findHarnessId(ids.text)) log(`${table} #${r.id}: still flagged after redaction: ${findHarnessId(ids.text)}`);
    // Only a published return's transcript is public; reviews keep theirs as stored.
    const home = table === "returns" ? redactHomePaths(ids.text) : { text: ids.text, n: 0 };
    if (!ids.n && !home.n) continue;
    if (backup) console.log(JSON.stringify({ table, id: Number(r.id), transcript: r.transcript }));
    if (!dryRun) await q(`UPDATE ${table} SET transcript = $2 WHERE id = $1`, [r.id, home.text]);
    changed++; if (home.n) homes++;
    log(`${table} #${r.id}: ${ids.n} harness value(s), ${home.n} home path(s)${dryRun ? " (dry run)" : " redacted"}${r.slug ? `; purge https://solveathome.org/projects/${r.slug}/return/${r.id}/transcript` : ""}`);
  }
}
log(`scan-transcripts: ${changed} transcript(s) ${dryRun ? "would change" : "changed"}, ${homes} with home paths`);
await pool.end();
