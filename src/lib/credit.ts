/**
 * Attribution (scope Q40). Points are public and revisable by PR; the ledger is append-only.
 * Everyone in an accepted outcome's chain is paid: the author, the model, cited message/return/file authors,
 * the lane's origin, agreeing reviewers, and compute donors.
 */
import { q, one } from "../db/index.js";

export const POINTS = {
  result: { formalize: 100, break: 60, measure: 20, source: 15, explore: 40, direction: 60, curate: 10, consolidate: 50, review: 0 } as Record<string, number>,
  breakthrough: { refuted: 150, proven: 300 } as Record<string, number>,   // a break that refutes; a formalization that proves
  insight_cited_message: 10,        // your chat message was cited by an accepted return
  cited_return: 15,                 // your earlier return was built on
  cited_file: 5,                    // your file was used
  cited_handle: 10,                 // named as a source of an idea
  lane_origin_share: 0.10,          // the Direction author gets this share of every accepted result in their lane
  review_agreed: 5,
  review_also_credit_bonus: 3,      // a reviewer who restored missing attribution
  compute_per_cpu_hour: 1,
  max_cites_paid_per_return: 10,
};

type Cites = { messages?: unknown[]; returns?: unknown[]; files?: unknown[]; handles?: unknown[] };

async function pay(userId: number, model: string | null, provider: string | null, problemId: number | null, laneId: number | null, kind: string, points: number, sourceType: string, sourceId: string | number, note: string): Promise<void> {
  if (!(points > 0)) return;
  await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [userId, model, provider, problemId, laneId, kind, points, sourceType, String(sourceId), note]);
}

/** Pay the chain for an accepted return. Idempotent per return. */
export async function payAcceptedReturn(ret: any, reviews: Array<{ user_id: number; verdict: string; model: string; provider: string; also_credit?: Cites | null }>): Promise<void> {
  const already = await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(ret.id)]);
  if (already) return;
  const pid = ret.problem_id, lid = ret.lane_id, rid = ret.id;
  const base = POINTS.result[ret.type] ?? 20;
  await pay(ret.user_id, ret.model, ret.provider, pid, lid, "result", base, "return", rid, `${ret.type} accepted`);
  if (ret.type === "break" && ret.final_rung === "refuted") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "breakthrough", POINTS.breakthrough.refuted, "return", rid, "counterexample refuted a claim");
  if (ret.type === "formalize" && ret.final_rung === "proven") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "breakthrough", POINTS.breakthrough.proven, "return", rid, "lemma formalized and proven");
  if (ret.type === "formalize") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "formalize", 0, "return", rid, "");
  if (Number(ret.cpu_hours) > 0) await pay(ret.user_id, null, null, pid, lid, "compute", Number(ret.cpu_hours) * POINTS.compute_per_cpu_hour, "return", rid, `${Number(ret.cpu_hours).toFixed(2)} CPU hours`);
  if (ret.type === "direction") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "direction", 0, "return", rid, "");
  // lane origin share
  if (lid) {
    const lane = await one<{ origin_user_id: number | null }>(`SELECT origin_user_id FROM lanes WHERE id = $1`, [lid]);
    if (lane?.origin_user_id && Number(lane.origin_user_id) !== Number(ret.user_id))
      await pay(Number(lane.origin_user_id), null, null, pid, lid, "direction", base * POINTS.lane_origin_share, "return", rid, "share as the lane's origin");
  }
  // citations from the author, plus attribution restored by accepting reviewers
  const cites: Cites[] = [ret.cites ?? {}, ...reviews.filter((r) => r.verdict === "accept" && r.also_credit).map((r) => r.also_credit as Cites)];
  await payCites(cites, pid, lid, rid, Number(ret.user_id));
  for (const r of reviews) {
    if (r.verdict === (ret.status === "accepted" ? "accept" : "reject")) await pay(r.user_id, r.model, r.provider, pid, lid, "review", POINTS.review_agreed, "return", rid, "review agreed with outcome");
    if (r.verdict === "accept" && r.also_credit && Object.values(r.also_credit).some((v) => Array.isArray(v) && v.length)) await pay(r.user_id, r.model, r.provider, pid, lid, "review", POINTS.review_also_credit_bonus, "return", rid, "restored missing attribution");
  }
}

async function payCites(list: Cites[], pid: number, lid: number | null, rid: number, authorId: number): Promise<void> {
  let paid = 0; const seen = new Set<string>();
  const cap = POINTS.max_cites_paid_per_return;
  for (const c of list) {
    for (const mid of (c.messages ?? []).map(Number).filter(Number.isFinite)) {
      const key = `m${mid}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const m = await one<{ user_id: number; model: string | null }>(`SELECT user_id, model FROM messages WHERE id = $1`, [mid]);
      if (m && Number(m.user_id) !== authorId) { await pay(Number(m.user_id), m.model, null, pid, lid, "insight", POINTS.insight_cited_message, "message", mid, `message cited by return #${rid}`); paid++; }
    }
    for (const xid of (c.returns ?? []).map(Number).filter(Number.isFinite)) {
      const key = `r${xid}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const x = await one<{ user_id: number; model: string | null; provider: string | null }>(`SELECT user_id, model, provider FROM returns WHERE id = $1`, [xid]);
      if (x && Number(x.user_id) !== authorId) { await pay(Number(x.user_id), x.model, x.provider, pid, lid, "insight", POINTS.cited_return, "return", xid, `built on by return #${rid}`); paid++; }
    }
    for (const sha of (c.files ?? []).map(String)) {
      const key = `f${sha}`; if (seen.has(key) || paid >= cap || !/^[0-9a-f]{64}$/.test(sha)) continue; seen.add(key);
      const f = await one<{ user_id: number; model: string | null }>(`SELECT user_id, model FROM files WHERE sha256 = $1`, [sha]);
      if (f && Number(f.user_id) !== authorId) { await pay(Number(f.user_id), f.model, null, pid, lid, "file", POINTS.cited_file, "file", sha, `file used by return #${rid}`); paid++; }
    }
    for (const h of (c.handles ?? []).map(String)) {
      const key = `h${h.toLowerCase()}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [h.replace(/^@/, "")]);
      if (u && Number(u.id) !== authorId) { await pay(Number(u.id), null, null, pid, lid, "insight", POINTS.cited_handle, "return", rid, `named as a source by return #${rid}`); paid++; }
    }
  }
}

export type Window = "all" | "30d" | "7d";
const since = (w: Window) => w === "7d" ? "now() - interval '7 days'" : w === "30d" ? "now() - interval '30 days'" : "'epoch'::timestamptz";

/** Leaderboards: humans by handle, models by model id, each overall and per kind. */
export async function leaderboard(problemId: number | null, w: Window, limit = 50) {
  const where = `${problemId ? "c.problem_id = $1 AND" : ""} c.created_at >= ${since(w)}`;
  const params = problemId ? [problemId] : [];
  const humans = await q(`SELECT u.handle, sum(c.points) AS points,
      sum(c.points) FILTER (WHERE c.kind = 'insight') AS insight, sum(c.points) FILTER (WHERE c.kind = 'breakthrough') AS breakthrough,
      sum(c.points) FILTER (WHERE c.kind = 'result') AS result, sum(c.points) FILTER (WHERE c.kind = 'direction') AS direction,
      sum(c.points) FILTER (WHERE c.kind = 'review') AS review, sum(c.points) FILTER (WHERE c.kind = 'compute') AS compute
    FROM credits c JOIN users u ON u.id = c.user_id WHERE ${where} GROUP BY u.handle ORDER BY points DESC LIMIT ${limit}`, params);
  const models = await q(`SELECT c.model, c.provider, sum(c.points) AS points, count(DISTINCT c.user_id) AS donors,
      sum(c.points) FILTER (WHERE c.kind = 'breakthrough') AS breakthrough, sum(c.points) FILTER (WHERE c.kind = 'insight') AS insight, sum(c.points) FILTER (WHERE c.kind = 'review') AS review
    FROM credits c WHERE c.model IS NOT NULL AND ${where} GROUP BY c.model, c.provider ORDER BY points DESC LIMIT ${limit}`, params);
  const byKind: Record<string, any[]> = {};
  for (const kind of ["insight", "breakthrough", "result", "direction", "review", "compute"]) {
    byKind[kind] = await q(`SELECT u.handle, sum(c.points) AS points, count(*) AS events FROM credits c JOIN users u ON u.id = c.user_id WHERE c.kind = '${kind}' AND ${where} GROUP BY u.handle ORDER BY points DESC LIMIT 10`, params);
  }
  return { window: w, humans, models, by_kind: byKind, points: POINTS };
}
