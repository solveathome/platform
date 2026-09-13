/** Issue #57: repair outstanding file-fix jobs and preserve uploads mentioned on release.
 * Dry run by default; --apply updates only queued/assigned jobs under the project lock.
 * Never manufactures a return, transcript, review or credit. Existing uploads remain their authors'.
 */
import { q, pool, projectTransaction } from "../src/db/index.js";
import { FILE_FIX_TITLE } from "../src/routes/job.js";

const apply = process.argv.includes("--apply");
const marker = "## Previously uploaded repairs";
try {
  const projects = await q<{ problem_id: string }>(`SELECT DISTINCT problem_id FROM jobs WHERE title LIKE $1 AND follow_up_of IS NOT NULL AND status IN ('queued','assigned')`, [`${FILE_FIX_TITLE}%`]);
  for (const p of projects) await projectTransaction(p.problem_id, async () => {
    const jobs = await q(`SELECT j.id, j.type, j.brief_md, r.file_notes FROM jobs j JOIN returns r ON r.id = j.follow_up_of
      WHERE j.problem_id = $1 AND j.title LIKE $2 AND j.status IN ('queued','assigned') ORDER BY j.id`, [p.problem_id, `${FILE_FIX_TITLE}%`]);
    for (const j of jobs) {
      const names = (Array.isArray(j.file_notes) ? j.file_notes : []).filter((n: any) => !n.fixed_by).map((n: any) => n.name);
      // Only a file owned by the releasing person, explicitly named in their release and matching a requested file.
      const uploads = await q(`SELECT DISTINCT f.sha256, f.name, u.handle FROM messages m
        JOIN files f ON f.user_id = m.user_id AND strpos(m.body_md, f.sha256) > 0
        JOIN users u ON u.id = f.user_id
        WHERE m.job_id = $1 AND m.kind = 'done' AND m.body_md LIKE 'Released job #%'
          AND f.name = ANY($2::text[]) AND f.deleted_at IS NULL ORDER BY u.handle, f.name, f.sha256`, [j.id, names]);
      const brief = String(j.brief_md).split(`\n\n${marker}\n`)[0] + (uploads.length ? `\n\n${marker}\n\nEarlier contributors uploaded these repairs before releasing this assignment. The old file-fix type could require a manuscript and block submission (platform issue #57). These uploads have not been accepted as results. Check the relevant copies and reuse them if correct; do not repeat the repair. Cite each reused sha in \`cites.files\` so its uploader receives attribution and citation credit on acceptance. Submit this assignment as measure work with files, recipe_md and the assignment's transcript; no paper manuscript is needed.\n\n${uploads.map(f => `- @${f.handle}: ${f.name}, GET /files/${f.sha256}`).join("\n")}` : "");
      const changed = j.type !== "measure" || brief !== j.brief_md;
      console.log(JSON.stringify({ job: Number(j.id), previous_type: j.type, type: "measure", uploads, changed, applied: apply && changed }));
      if (apply && changed) {
        await q(`UPDATE jobs SET type = 'measure', min_tier = 99, brief_md = $2 WHERE id = $1`, [j.id, brief]);
        for (const f of uploads) await q(`INSERT INTO file_refs (file_sha, ref_type, ref_id) VALUES ($1,'job',$2) ON CONFLICT DO NOTHING`, [f.sha256, j.id]);
      }
    }
  });
} finally { await pool.end(); }
