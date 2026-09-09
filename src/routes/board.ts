import { Router } from "express";
import { q, one } from "../db/index.js";

export const board = Router();

/** The public board, JSON. Research status first, contributors last (scope Q20). */
board.get("/api/board", async (_req, res) => {
  const problem = await one(`SELECT slug, name, repo_url, status_md FROM problems ORDER BY id LIMIT 1`);
  const rungs = await q(`SELECT final_rung AS rung, count(*) AS n FROM returns WHERE status = 'accepted' GROUP BY final_rung`);
  const lanes = await q(`SELECT slug, title, variant, status FROM lanes ORDER BY id`);
  const queue = await q(`SELECT type, status, count(*) AS n FROM jobs GROUP BY type, status ORDER BY type, status`);
  const recent = await q(`SELECT r.id, r.type, r.status, r.final_rung, u.handle, r.created_at FROM returns r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 50`);
  const health = await one(`
    SELECT
      (SELECT count(*) FROM returns WHERE status IN ('accepted','rejected')) AS decided,
      (SELECT count(*) FROM returns WHERE status = 'contested') AS contested,
      (SELECT count(*) FROM returns WHERE status = 'pending') AS pending,
      (SELECT count(*) FROM jobs WHERE status = 'queued') AS queued,
      (SELECT round(avg(CASE WHEN agreed_with_outcome THEN 1 ELSE 0 END)::numeric, 3) FROM reviews WHERE agreed_with_outcome IS NOT NULL) AS reviewer_agreement`);
  const contributors = await q(`
    SELECT u.handle, rp.score, rp.accepted, rp.rejected, rp.review_agree, rp.review_disagree, rp.cpu_hours, rp.directions_accepted
    FROM reputation rp JOIN users u ON u.id = rp.user_id ORDER BY rp.accepted DESC, rp.cpu_hours DESC LIMIT 200`);
  res.json({ problem, rungs, lanes, queue, health, recent, contributors });
});

board.get("/healthz", async (_req, res) => { await q("SELECT 1"); res.json({ ok: true }); });
