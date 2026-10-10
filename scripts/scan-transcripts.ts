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
import pg from "pg";
import { pool } from "../src/db/index.js";
import { findHarnessId, findHomePath, redactHarnessIds, redactHomePaths } from "../src/lib/files.js";

const backup = process.argv.includes("--backup"), dryRun = backup || process.argv.includes("--dry-run");
const log = (s: string) => (backup ? console.error : console.log)(s);
const PATTERN = String.raw`"(atis|ownerAccountUuid|ownerOrganizationUuid|bridgeSessionId|accountUuid|organizationUuid)"\s*:\s*"(v1\.[0-9a-f]{16}\.|[0-9a-f]{8}-[0-9a-f]{4}-)`;
// A cheap superset of what redactHomePaths replaces, as substring tests (chr(92) is the backslash of C:\Users) (a second regex over every transcript passed the 15 s
// statement timeout on Oct 10 2026); the function decides.
const HOME = `strpos(r.transcript, '/Users/') > 0 OR strpos(r.transcript, '/home/') > 0 OR strpos(r.transcript, 'Users' || chr(92)) > 0`;
const IDS = new RegExp(PATTERN);
// A batch reads every stored transcript (about a gigabyte on Oct 10 2026): one connection of its own, with five minutes instead of the
// web pool's 15 s statement timeout, which the nightly run passed once home paths were added.
const batch = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, statement_timeout: 300_000, query_timeout: 310_000 });
const q = async <T = any>(text: string, values: unknown[] = []): Promise<T[]> => (await batch.query(text, values)).rows as T[];
let changed = 0, homes = 0, still = 0;
for (const table of ["returns", "reviews"] as const) {
  const rows = await q<{ id: string; transcript: string; slug: string | null; ids_hit: boolean }>(
    table === "returns"
      ? `SELECT r.id, r.transcript, p.slug, false AS ids_hit FROM returns r JOIN problems p ON p.id = r.problem_id WHERE r.transcript ~ $1 OR ${HOME} ORDER BY r.id`
      : `SELECT v.id, v.transcript, NULL AS slug, true AS ids_hit FROM reviews v WHERE v.transcript ~ $1 ORDER BY v.id`, [PATTERN]);
  for (const r of rows) {
    // Harness values only on the rows their own pattern selects, as before; a row the home pattern brings in keeps them as stored
    // (the pages and the dump redact them when they serve).
    const ids = r.ids_hit || IDS.test(r.transcript) ? redactHarnessIds(r.transcript) : { text: r.transcript, n: 0 };
    if (ids.n && findHarnessId(ids.text)) log(`${table} #${r.id}: still flagged after redaction: ${findHarnessId(ids.text)}`);
    // Only a published return's transcript is public; reviews keep theirs as stored.
    const home = table === "returns" ? redactHomePaths(ids.text) : { text: ids.text, n: 0 };
    // What the intake's own detector still sees after the pass, with the name masked: the check that none remain.
    const left = table === "returns" ? findHomePath(home.text) : null;
    if (left) { still++; log(`${table} #${r.id}: home path still found: ${left.replace(/((?:Users|home)[\/\\]+)[^\/\\\s]+/, "$1<name>").slice(0, 60)}`); }
    if (!ids.n && !home.n) continue;
    if (backup) console.log(JSON.stringify({ table, id: Number(r.id), transcript: r.transcript }));
    if (!dryRun) await q(`UPDATE ${table} SET transcript = $2 WHERE id = $1`, [r.id, home.text]);
    changed++; if (home.n) homes++;
    log(`${table} #${r.id}: ${ids.n} harness value(s), ${home.n} home path(s)${dryRun ? " (dry run)" : " redacted"}${r.slug ? `; purge https://solveathome.org/projects/${r.slug}/return/${r.id}/transcript` : ""}`);
  }
}
log(`scan-transcripts: ${changed} transcript(s) ${dryRun ? "would change" : "changed"}, ${homes} with home paths; ${still} return(s) where a home path is still found`);
await batch.end(); await pool.end();
