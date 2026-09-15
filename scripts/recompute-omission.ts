/**
 * Re-derive `returns.transcript_omitted` from every stored transcript (Sep 15 2026, platform issues #62 and #70); idempotent,
 * run after a deploy that changes how omission notes are counted:  bash scripts/prod-exec.sh node dist/scripts/recompute-omission.js
 *
 * The old count matched a bracketed "omitted" anywhere in the raw JSONL, so a scrubber's own template quoted in a displayed
 * helper, a note written in the report, and the same native record echoed twice all counted, and the numerator and the
 * denominator counted different things. Returns were told they had replaced 7 of 3 outputs, or 8 of 13 that were all present,
 * and the reviewer-facing "transcript mostly omitted" label went with it. The transcript itself is never touched.
 */
import { q, one, pool } from "../src/db/index.js";
import { omissionShare } from "../src/lib/tokens.js";

const MOSTLY = (o: { omitted: number; share: number }) => o.omitted >= 3 && o.share >= 0.5;

const rows = await q<{ id: string; transcript: string; transcript_omitted: any }>(
  `SELECT id, transcript, transcript_omitted FROM returns WHERE transcript IS NOT NULL ORDER BY id`);
let changed = 0, labelled = 0, unlabelled = 0;
for (const r of rows) {
  const before = r.transcript_omitted ?? null;
  const after = omissionShare(String(r.transcript));
  if (before && Number(before.outputs) === after.outputs && Number(before.omitted) === after.omitted) continue;
  await q(`UPDATE returns SET transcript_omitted = $2 WHERE id = $1`, [r.id, JSON.stringify(after)]);
  changed++;
  const was = before ? MOSTLY({ omitted: Number(before.omitted), share: Number(before.share) }) : false;
  if (was && !MOSTLY(after)) unlabelled++;
  if (!was && MOSTLY(after)) labelled++;
  console.log(`#${r.id}  ${before ? `${before.omitted}/${before.outputs}` : "none"} -> ${after.omitted}/${after.outputs}${was !== MOSTLY(after) ? (MOSTLY(after) ? "  now labelled mostly omitted" : "  label removed") : ""}`);
}
const still = await one<{ n: string }>(
  `SELECT count(*) AS n FROM returns WHERE (transcript_omitted->>'omitted')::int >= 3 AND (transcript_omitted->>'share')::numeric >= 0.5`);
console.log(`\n${rows.length} transcripts read, ${changed} records corrected, ${unlabelled} labels removed, ${labelled} added; ${still?.n} returns are labelled mostly omitted now.`);
await pool.end();
