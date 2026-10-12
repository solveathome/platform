/**
 * One-off catch-up for the lane state of the art (Oct 12 2026, #sah-sota-trusted-upkeep): loads projects/<slug>/state-seed into
 * lane_states (Verified, version 1) and lane_state_entries (New, not yet verified). Dry run by default; --apply writes.
 *
 * projects/<slug>/state-seed/seed.json  { "through": { "<lane>": <return id> }, "note": "<how the seed was made>" }
 * projects/<slug>/state-seed/<lane>.md  the Verified summary, written from what a trusted check supports
 * projects/<slug>/state-seed/<lane>.entries.json  [{ body_md, source_return_id, hardware?, throughput? }]
 *
 * A lane that already has a Verified version is left alone, and an entry already open with the same text is not added again, so a
 * second run changes nothing. The Verified seed is written in the name of the project's researcher (an owner, trusted by grant), with
 * the seed note as its model field; each entry is in the name of its source return's author.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { one, q, pool, projectTransaction } from "../src/db/index.js";
import { projectDir } from "../src/lib/projects.js";
import { ownerHandles } from "../src/lib/roles.js";

const apply = process.argv.includes("--apply");
try {
  for (const p of await q<{ id: string; slug: string; researcher_user_id: string | null }>(`SELECT id, slug, researcher_user_id FROM problems ORDER BY id`)) {
    const dir = projectDir(p.slug) ? join(projectDir(p.slug)!, "state-seed") : null;
    if (!dir || !existsSync(join(dir, "seed.json"))) continue;
    const meta = JSON.parse(readFileSync(join(dir, "seed.json"), "utf8"));
    const owner = p.researcher_user_id ?? (await one<{ id: string }>(`SELECT id FROM users WHERE lower(handle) = ANY($1::text[]) ORDER BY id LIMIT 1`, [ownerHandles()]))?.id;
    if (!owner) { console.log(JSON.stringify({ project: p.slug, skipped: "no researcher or owner to write the verified seed" })); continue; }
    await projectTransaction(p.id, async () => {
      for (const [laneSlug, through] of Object.entries<number>(meta.through ?? {})) {
        const lane = await one<{ id: string }>(`SELECT id FROM lanes WHERE problem_id = $1 AND slug = $2`, [p.id, laneSlug]);
        const mdFile = join(dir, `${laneSlug}.md`), entriesFile = join(dir, `${laneSlug}.entries.json`);
        if (!lane || !existsSync(mdFile)) { console.log(JSON.stringify({ project: p.slug, lane: laneSlug, skipped: lane ? "no seed file" : "no such lane" })); continue; }
        const summary = readFileSync(mdFile, "utf8").trim();
        const entries: any[] = existsSync(entriesFile) ? JSON.parse(readFileSync(entriesFile, "utf8")) : [];
        const have = await one<{ version: number }>(`SELECT version FROM lane_states WHERE lane_id = $1`, [lane.id]);
        const verified = !have || Number(have.version) === 0;
        let added = 0, kept = 0;
        if (apply && verified) {
          await q(`INSERT INTO lane_states (lane_id, problem_id, summary_md, version, through_return_id, record_seen_at, updated_by, updated_model, updated_at)
            VALUES ($1,$2,$3,1,$4,now(),$5,$6,now()) ON CONFLICT (lane_id) DO UPDATE SET summary_md = EXCLUDED.summary_md, version = 1, through_return_id = EXCLUDED.through_return_id,
            record_seen_at = now(), updated_by = EXCLUDED.updated_by, updated_model = EXCLUDED.updated_model, updated_at = now()`, [lane.id, p.id, summary, through, owner, meta.note ?? "seed"]);
          await q(`INSERT INTO lane_state_versions (lane_id, version, summary_md, through_return_id, user_id, model) VALUES ($1,1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [lane.id, summary, through, owner, meta.note ?? "seed"]);
        }
        for (const e of entries) {
          const src = await one<{ user_id: string; model: string | null }>(`SELECT user_id, model FROM returns WHERE id = $1 AND problem_id = $2`, [e.source_return_id, p.id]);
          if (!src) { console.log(JSON.stringify({ project: p.slug, lane: laneSlug, entry_skipped: `return #${e.source_return_id} is not in this project` })); continue; }
          if (await one(`SELECT 1 FROM lane_state_entries WHERE lane_id = $1 AND body_md = $2`, [lane.id, String(e.body_md).trim()])) { kept++; continue; }
          if (apply) await q(`INSERT INTO lane_state_entries (problem_id, lane_id, body_md, hardware, throughput, source_return_id, user_id, model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [p.id, lane.id, String(e.body_md).trim(), e.hardware ?? null, e.throughput ?? null, e.source_return_id, src.user_id, src.model]);
          added++;
        }
        console.log(JSON.stringify({ project: p.slug, lane: laneSlug, applied: apply, verified_seed: verified ? `version 1 through #${through}, ${summary.length} chars` : `kept version ${have!.version}`, entries_added: added, entries_already_open: kept }));
      }
    });
  }
} finally { await pool.end(); }
