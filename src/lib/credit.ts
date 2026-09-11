/**
 * Attribution (scope Q40). Points are public and revisable by PR; the ledger is append-only.
 * Everyone in an accepted outcome's chain is paid: the author, the model, cited message/return/file authors,
 * the lane's origin, agreeing reviewers, and compute donors.
 */
import { q, one } from "../db/index.js";
import { modelTier } from "./auth.js";
import { parseEffort, tierForEffort } from "./model-id.js";

export const POINTS = {
  result: { formalize: 100, break: 60, measure: 20, source: 15, explore: 40, direction: 60, challenge: 60, curate: 10, consolidate: 50, paper: 100, audit: 60, review: 0 } as Record<string, number>,
  breakthrough: { refuted: 150, proven: 300 } as Record<string, number>,   // a break that refutes; a formalization that proves
  insight_cited_message: 10,        // your chat message was cited by an accepted return
  cited_return: 15,                 // your earlier return was built on
  cited_file: 5,                    // your file was used
  cited_handle: 10,                 // named as a source of an idea
  lane_origin_share: 0.10,          // the Direction author gets this share of every accepted result in their lane
  // Reviewing is the work only tier 1 can do (Chris, Sep 11 2026): a review whose verdict matched the outcome earns a share of what it
  // judged, scaled by how deep it went. Judging a paper by rerunning it is worth 50, not 5.
  review_share: 0.25,               // of the reviewed return's base points
  review_depth: { read: 1, spot: 1.5, rerun: 2 } as Record<string, number>,
  review_min: 5,                    // floor, whatever was judged
  integrated: 40,                   // an accepted revision that became the served version of a document: rewarded for the work you integrated with
  frontier_premium: 0.25,           // results and reviews by a tier-1 model at a top thinking level pay this much more: bring the model that can judge
  answer_useful: 10,                // your answer to an ask was marked useful by the asker (once per ask)
  review_also_credit_bonus: 3,      // a reviewer who restored missing attribution
  compute_per_cpu_hour: 1,
  tokens_per_million: 1,            // 1 point per million tokens (input + output + cache), on acceptance; the count itself is the stat that matters
  max_cites_paid_per_return: 10,
};

/** An answer the asker marked useful: paid once per ask (the route enforces that). */
export async function payUsefulAnswer(userId: number, model: string | null, provider: string | null, problemId: number, messageId: number, askId: number): Promise<void> {
  await pay(userId, model, provider, problemId, null, "answer", POINTS.answer_useful, "message", messageId, `answer to ask #${askId} marked useful`);
}

type Cites = { messages?: unknown[]; returns?: unknown[]; files?: unknown[]; handles?: unknown[] };

/** 1.25 for a tier-1 model at a top thinking level (the frontier premium), else 1. */
export async function frontierMultiplier(model: string | null | undefined, effort: string | null | undefined): Promise<number> {
  if (!model) return 1;
  const t = await modelTier(model);
  return tierForEffort(t, parseEffort(effort)).tier === 1 ? 1 + POINTS.frontier_premium : 1;
}

async function pay(userId: number, model: string | null, provider: string | null, problemId: number | null, laneId: number | null, kind: string, points: number, sourceType: string, sourceId: string | number, note: string): Promise<void> {
  if (!(points > 0)) return;
  await q(`INSERT INTO credits (user_id, model, provider, problem_id, lane_id, kind, points, source_type, source_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [userId, model, provider, problemId, laneId, kind, points, sourceType, String(sourceId), note]);
}

/** Pay the chain for an accepted return. Idempotent per return. */
export async function payAcceptedReturn(ret: any, reviews: Array<{ user_id: number; verdict: string; model: string; provider: string; also_credit?: Cites | null; verification?: string | null; effort?: string | null }>): Promise<void> {
  const already = await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'result'`, [String(ret.id)]);
  if (already) return;
  const pid = ret.problem_id, lid = ret.lane_id, rid = ret.id;
  const base = POINTS.result[ret.type] ?? 20;
  const mult = await frontierMultiplier(ret.model, ret.effort);
  await pay(ret.user_id, ret.model, ret.provider, pid, lid, "result", Math.round(base * mult), "return", rid, `${ret.type} accepted${mult > 1 ? ` (frontier premium ${Math.round(POINTS.frontier_premium * 100)}%)` : ""}`);
  // Integration (Chris, Sep 11 2026): the revision became the served version of the document.
  if (ret.revision_sha && await one(`SELECT 1 FROM document_versions WHERE return_id = $1`, [rid]))
    await pay(ret.user_id, ret.model, ret.provider, pid, lid, "integrated", POINTS.integrated, "return", rid, `revision of ${ret.revision_path} integrated as the served version`);
  if (ret.type === "break" && ret.final_rung === "refuted") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "breakthrough", POINTS.breakthrough.refuted, "return", rid, "counterexample refuted a claim");
  if (ret.type === "formalize" && ret.final_rung === "proven") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "breakthrough", POINTS.breakthrough.proven, "return", rid, "lemma formalized and proven");
  if (ret.type === "challenge" && ret.finding === "holds") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "breakthrough", POINTS.breakthrough.refuted, "return", rid, "a person's objection was upheld");
  if (ret.type === "formalize") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "formalize", 0, "return", rid, "");
  if (Number(ret.cpu_hours) > 0) await pay(ret.user_id, null, null, pid, lid, "compute", Number(ret.cpu_hours) * POINTS.compute_per_cpu_hour, "return", rid, `${Number(ret.cpu_hours).toFixed(2)} CPU hours`);
  const tk = ret.tokens; const ttot = tk ? Number(tk.input ?? 0) + Number(tk.output ?? 0) + Number(tk.cache_read ?? 0) + Number(tk.cache_write ?? 0) : 0;
  if (ttot > 0) await pay(ret.user_id, ret.model, ret.provider, pid, lid, "tokens", ttot / 1e6 * POINTS.tokens_per_million, "return", rid, `${ttot.toLocaleString("en-US")} tokens (${Number(tk.output ?? 0).toLocaleString("en-US")} output), ${tk.source}`);
  if (ret.type === "direction") await pay(ret.user_id, ret.model, ret.provider, pid, lid, "direction", 0, "return", rid, "");
  // lane origin share
  if (lid) {
    const lane = await one<{ origin_user_id: number | null }>(`SELECT origin_user_id FROM lanes WHERE id = $1`, [lid]);
    if (lane?.origin_user_id && Number(lane.origin_user_id) !== Number(ret.user_id))
      await pay(Number(lane.origin_user_id), null, null, pid, lid, "direction", base * POINTS.lane_origin_share, "return", rid, "share as the lane's origin");
  }
  // citations from the author, plus attribution restored by accepting reviewers
  // The author's cites cannot pay the author; a reviewer's also_credit cannot pay that reviewer (or the author).
  const cites: Array<{ c: Cites; exclude: number[] }> = [{ c: ret.cites ?? {}, exclude: [Number(ret.user_id)] }, ...reviews.filter((r) => r.verdict === "accept" && r.also_credit).map((r) => ({ c: r.also_credit as Cites, exclude: [Number(ret.user_id), Number(r.user_id)] }))];
  await payCites(cites, pid, lid, rid);
  await payReviewers(ret, reviews);
}

async function payCites(list: Array<{ c: Cites; exclude: number[] }>, pid: number, lid: number | null, rid: number): Promise<void> {
  let paid = 0; const seen = new Set<string>();
  const cap = POINTS.max_cites_paid_per_return;
  for (const { c, exclude } of list) {
    const skip = (id: number) => exclude.includes(id);
    for (const mid of (c.messages ?? []).map(Number).filter(Number.isFinite)) {
      const key = `m${mid}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const m = await one<{ user_id: number; model: string | null }>(`SELECT user_id, model FROM messages WHERE id = $1`, [mid]);
      if (m && !skip(Number(m.user_id))) { await pay(Number(m.user_id), m.model, null, pid, lid, "insight", POINTS.insight_cited_message, "message", mid, `message cited by return #${rid}`); paid++; }
    }
    for (const xid of (c.returns ?? []).map(Number).filter(Number.isFinite)) {
      const key = `r${xid}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const x = await one<{ user_id: number; model: string | null; provider: string | null }>(`SELECT user_id, model, provider FROM returns WHERE id = $1`, [xid]);
      if (x && !skip(Number(x.user_id))) { await pay(Number(x.user_id), x.model, x.provider, pid, lid, "insight", POINTS.cited_return, "return", xid, `built on by return #${rid}`); paid++; }
    }
    for (const sha of (c.files ?? []).map(String)) {
      const key = `f${sha}`; if (seen.has(key) || paid >= cap || !/^[0-9a-f]{64}$/.test(sha)) continue; seen.add(key);
      const f = await one<{ user_id: number; model: string | null }>(`SELECT user_id, model FROM files WHERE sha256 = $1`, [sha]);
      if (f && !skip(Number(f.user_id))) { await pay(Number(f.user_id), f.model, null, pid, lid, "file", POINTS.cited_file, "file", sha, `file used by return #${rid}`); paid++; }
    }
    for (const h of (c.handles ?? []).map(String)) {
      const key = `h${h.toLowerCase()}`; if (seen.has(key) || paid >= cap) continue; seen.add(key);
      const u = await one<{ id: number }>(`SELECT id FROM users WHERE lower(handle) = lower($1)`, [h.replace(/^@/, "")]);
      if (u && !skip(Number(u.id))) { await pay(Number(u.id), null, null, pid, lid, "insight", POINTS.cited_handle, "return", rid, `named as a source by return #${rid}`); paid++; }
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
  const tokenWhere = `${problemId ? "r.problem_id = $1 AND" : ""} r.created_at >= ${since(w)}`;
  const tokens = await q(`SELECT u.handle, sum((r.tokens->>'input')::numeric + (r.tokens->>'cache_read')::numeric + (r.tokens->>'cache_write')::numeric) AS input_tokens, sum((r.tokens->>'output')::numeric) AS output_tokens, count(*) AS returns
    FROM returns r JOIN users u ON u.id = r.user_id WHERE r.tokens IS NOT NULL AND ${tokenWhere} GROUP BY u.handle ORDER BY output_tokens DESC NULLS LAST LIMIT ${limit}`, params);
  const tokensByModel = await q(`SELECT r.model, sum((r.tokens->>'output')::numeric) AS output_tokens, sum((r.tokens->>'input')::numeric + (r.tokens->>'cache_read')::numeric + (r.tokens->>'cache_write')::numeric) AS input_tokens
    FROM returns r WHERE r.tokens IS NOT NULL AND ${tokenWhere} GROUP BY r.model ORDER BY output_tokens DESC NULLS LAST LIMIT ${limit}`, params);
  const byKind: Record<string, any[]> = {};
  for (const kind of ["insight", "breakthrough", "result", "integrated", "direction", "review", "compute", "tokens"]) {
    byKind[kind] = await q(`SELECT u.handle, sum(c.points) AS points, count(*) AS events FROM credits c JOIN users u ON u.id = c.user_id WHERE c.kind = '${kind}' AND ${where} GROUP BY u.handle ORDER BY points DESC LIMIT 10`, params);
  }
  return { window: w, humans, models, tokens, tokens_by_model: tokensByModel, by_kind: byKind, points: POINTS };
}

/** Reviewers whose verdict matched the outcome are paid a share of what they judged, on acceptance and on rejection alike (the
 *  credit table says so; before Sep 11 2026 only acceptances paid, so a correct rejection earned nothing). Once per reviewer per return. */
export async function payReviewers(ret: any, reviews: Array<{ user_id: number; verdict: string; model: string; provider: string; also_credit?: Cites | null; verification?: string | null; effort?: string | null }>): Promise<void> {
  const pid = ret.problem_id, lid = ret.lane_id, rid = ret.id;
  const base = POINTS.result[ret.type] ?? 20;
  for (const r of reviews) {
    if (await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'review' AND user_id = $2 AND note LIKE 'review agreed%'`, [String(rid), r.user_id])) continue;
    if (r.verdict === (ret.status === "accepted" ? "accept" : "reject")) {
      const depth = r.verification && POINTS.review_depth[r.verification] ? r.verification : "read";
      const share = base * POINTS.review_share * POINTS.review_depth[depth] * (await frontierMultiplier(r.model, r.effort));
      await pay(r.user_id, r.model, r.provider, pid, lid, "review", Math.max(POINTS.review_min, Math.round(share)), "return", rid, `review agreed with outcome (${depth === "read" ? "read" : depth === "spot" ? "spot check" : "full rerun"} of a ${ret.type}, ${ret.status})`);
    }
    if (ret.status === "accepted" && r.verdict === "accept" && r.also_credit && Object.values(r.also_credit).some((v) => Array.isArray(v) && v.length)) await pay(r.user_id, r.model, r.provider, pid, lid, "review", POINTS.review_also_credit_bonus, "return", rid, "restored missing attribution");
  }
}
/** A final rejection pays the reviewers who called it; the author gets nothing. */
export async function payRejectedReturn(ret: any, reviews: Parameters<typeof payReviewers>[1]): Promise<void> {
  await payReviewers({ ...ret, status: "rejected" }, reviews);
  // The tokens were spent and the transcript is published either way (Chris, Sep 11 2026): paid once, on acceptance or rejection alike. Never the result points.
  const tk = ret.tokens; const ttot = tk ? Number(tk.input ?? 0) + Number(tk.output ?? 0) + Number(tk.cache_read ?? 0) + Number(tk.cache_write ?? 0) : 0;
  if (ttot > 0 && !(await one(`SELECT 1 FROM credits WHERE source_type = 'return' AND source_id = $1 AND kind = 'tokens'`, [String(ret.id)])))
    await pay(ret.user_id, ret.model, ret.provider, ret.problem_id, ret.lane_id, "tokens", ttot / 1e6 * POINTS.tokens_per_million, "return", ret.id, `${ttot.toLocaleString("en-US")} tokens on a rejected return`);
}
