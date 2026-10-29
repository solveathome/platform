/**
 * The weekly progress post from the host (src/lib/weekly.ts). The server builds and posts on its own schedule; this is for the owner's
 * decisions passed on from elsewhere, for checking a week, and for corrections.
 * Run: bash scripts/prod-exec.sh node dist/scripts/weekly-digest.js <command> ...
 *   status  <project>                                   every week: status, summary, publish and post times
 *   show    <project> <last day>                        one week's post text, numbers and dropped lines
 *   build   <project> <first day> <last day> [--dry]    count a week; --dry prints it and stores nothing
 *   approve <project> <last day> --as "<who, where>"    a held week posts on the server's next pass (within a minute)
 *   suppress <project> <last day> --as "<who>"          a week that has not gone out never will
 *   rebuild <project> <last day>                        numbers and record again for a week not yet posted
 *   correct <project> <last day> "<reason>" < text.md   edit the posted message in place (never a second post); the old text is kept
 *   delete  <project> <last day>                        remove a week that was never posted (a test row)
 * The schema is not run here: the live container ran it at its start.
 */
import { readFileSync } from "node:fs";
import { one, q, pool } from "../src/db/index.js";
import { approveWeek, buildWeek, composeWeek, correctWeek, rebuildWeek, suppressWeek } from "../src/lib/weekly.js";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const bool = (n: string) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
const as = flag("--as"), dry = bool("--dry");
const [cmd, slug, a, b] = args;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (m: string): never => { console.error(m); process.exit(2); };
if (!cmd || !slug) fail("usage: weekly-digest <status|show|build|approve|suppress|rebuild|correct|delete> <project> ... (see the head of scripts/weekly-digest.ts)");
const p = await one<{ id: string }>(`SELECT id FROM problems WHERE slug = $1`, [slug]); if (!p) fail(`unknown project ${slug}`);
const week = async (end: string) => {
  if (!DATE.test(end ?? "")) fail("give the week's last day as YYYY-MM-DD");
  const d = await one<any>(`SELECT * FROM weekly_digests WHERE problem_id = $1 AND week_end = $2::date`, [p!.id, end]);
  return d ?? fail(`no week of ${slug} ends on ${end}`);
};

if (cmd === "status") {
  const rows = await q<any>(`SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, to_char(week_end, 'YYYY-MM-DD') AS week_end, status, needs_approval, approved_at, approved_by,
    summary_status, jsonb_array_length(summary) AS lines, jsonb_array_length(summary_dropped) AS dropped, publish_at, posted_at, discord_message_id IS NOT NULL AS has_message, jsonb_array_length(corrections) AS corrections
    FROM weekly_digests WHERE problem_id = $1 ORDER BY week_start`, [p!.id]);
  console.log(JSON.stringify(rows, null, 1));
} else if (cmd === "show") {
  const d = await week(a);
  console.log(d.text_md, "\n\n", JSON.stringify({ status: d.status, summary_status: d.summary_status, numbers: d.numbers, summary: d.summary, dropped: d.summary_dropped }, null, 1));
} else if (cmd === "build") {
  if (!DATE.test(a ?? "") || !DATE.test(b ?? "") || a > b) fail("give the first and last day as YYYY-MM-DD");
  if (dry) { const w = await composeWeek(slug, a, b); console.log(w.text, "\n\n", JSON.stringify(w.numbers, null, 1)); }
  else console.log(JSON.stringify(await buildWeek(slug, a, b)));
} else if (cmd === "approve" || cmd === "suppress") {
  if (!as) fail(`${cmd} needs --as "<who, where>": it is recorded on the week`);
  const d = await week(a);
  const ok = cmd === "approve" ? await approveWeek(Number(d.id), as!) : await suppressWeek(Number(d.id), as!);
  console.log(ok ? `${cmd}d: week ending ${a}` : `not ${cmd}d: the week is ${d.status}`); if (!ok) process.exitCode = 1;
} else if (cmd === "rebuild") {
  const d = await week(a);
  const ok = await rebuildWeek(Number(d.id)); console.log(ok ? "rebuilt" : `not rebuilt: the week is ${d.status}; correct a posted week instead`); if (!ok) process.exitCode = 1;
} else if (cmd === "correct") {
  const d = await week(a);
  const text = readFileSync(0, "utf8").trim(); if (!text) fail("the corrected text comes on stdin");
  const r = await correctWeek(Number(d.id), text, b ?? ""); console.log(JSON.stringify(r)); if ("error" in r) process.exitCode = 1;
} else if (cmd === "delete") {
  const d = await week(a);
  if (d.posted_at || d.status === "posted") fail("a posted week stays on record; correct it instead");
  await q(`DELETE FROM weekly_digests WHERE id = $1 AND posted_at IS NULL`, [d.id]); console.log(`deleted week ending ${a}`);
} else fail(`unknown command ${cmd}`);
await pool.end();
