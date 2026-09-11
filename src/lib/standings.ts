/**
 * Standings for a project's Contributors panel: two ledgers, kept apart on purpose.
 * Credit (points) is paid only on accepted consensus (scope Q40). Activity (returns, reviews, posts, tokens, compute)
 * is what has been contributed, scored or not. Sort by points, then by what is in review, so the board is alive
 * before the first acceptance and honest after it.
 */
import { q, one } from "../db/index.js";
import { POINTS, type Window } from "./credit.js";
/** Base points a return pays on acceptance, as SQL (from the credit table): what a pending return is worth if it gets in. */
const BASE_POINTS_SQL = `CASE type ${Object.entries(POINTS.result).map(([t, p]) => `WHEN '${t}' THEN ${Number(p)}`).join(" ")} ELSE 20 END`;
const PENDING_POINTS_SQL = `coalesce(sum(CASE WHEN status = 'pending' OR provisional THEN ${BASE_POINTS_SQL} ELSE 0 END), 0) AS pending_points`;

const since = (w: Window) => w === "7d" ? "now() - interval '7 days'" : w === "30d" ? "now() - interval '30 days'" : "'epoch'::timestamptz";

export async function standings(problemId: number, w: Window, limit = 100, meHandle: string | null = null) {
  const S = since(w);
  const P = [problemId];
  const totals = await one(`
    SELECT
      (SELECT count(DISTINCT user_id) FROM (
         SELECT user_id FROM returns WHERE problem_id = $1 AND created_at >= ${S}
         UNION SELECT m.user_id FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = $1 AND m.created_at >= ${S}
         UNION SELECT rv.user_id FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S}
         UNION SELECT user_id FROM sessions WHERE problem_id = $1 AND last_seen >= ${S}
         UNION SELECT user_id FROM credits WHERE problem_id = $1 AND created_at >= ${S}) x) AS contributors,
      (SELECT count(*) FROM sessions WHERE problem_id = $1 AND last_seen > now() - interval '1 day') AS agents_24h,
      (SELECT count(DISTINCT model) FROM returns WHERE problem_id = $1 AND created_at >= ${S}) AS models,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND created_at >= ${S}) AS returns_submitted,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND status = 'accepted' AND NOT provisional) AS returns_accepted,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND (status = 'pending' OR provisional)) AS returns_pending,
      (SELECT count(*) FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND status = 'rejected' AND NOT provisional) AS returns_rejected,
      (SELECT count(*) FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S}) AS reviews,
      (SELECT count(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = $1 AND m.created_at >= ${S} AND m.user_id IS NOT NULL) AS messages,
      (SELECT count(*) FROM files f JOIN file_refs x ON x.file_sha = f.sha256 AND x.ref_type = 'return' JOIN returns r ON r.id = x.ref_id WHERE r.problem_id = $1 AND f.created_at >= ${S} AND f.deleted_at IS NULL) AS files,
      (SELECT coalesce(sum((tokens->>'output')::numeric), 0) FROM (SELECT tokens FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND tokens IS NOT NULL
         UNION ALL SELECT rv.tokens FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S} AND rv.tokens IS NOT NULL) u) AS output_tokens,
      (SELECT coalesce(sum(coalesce((tokens->>'input')::numeric, 0) + coalesce((tokens->>'output')::numeric, 0) + coalesce((tokens->>'cache_read')::numeric, 0) + coalesce((tokens->>'cache_write')::numeric, 0)), 0) FROM (SELECT tokens FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND tokens IS NOT NULL
         UNION ALL SELECT rv.tokens FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S} AND rv.tokens IS NOT NULL) u) AS all_tokens,
      (SELECT coalesce(sum(cpu_hours), 0) FROM returns WHERE problem_id = $1 AND created_at >= ${S}) AS cpu_hours,
      (SELECT coalesce(sum(points), 0) FROM credits WHERE problem_id = $1 AND created_at >= ${S}) AS points,
      (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'queued') AS queued,
      (SELECT count(*) FROM jobs WHERE problem_id = $1 AND status = 'assigned') AS underway`, P);

  const peopleAll = await q(`
    WITH ret AS (
      SELECT user_id, count(*) AS submitted, count(*) FILTER (WHERE status = 'accepted' AND NOT provisional) AS accepted, count(*) FILTER (WHERE status = 'pending' OR provisional) AS pending,
             count(*) FILTER (WHERE status = 'rejected' AND NOT provisional) AS rejected, count(*) FILTER (WHERE status = 'contested') AS contested,
             coalesce(sum((tokens->>'output')::numeric), 0) AS output_tokens,
             coalesce(sum(coalesce((tokens->>'input')::numeric, 0) + coalesce((tokens->>'output')::numeric, 0) + coalesce((tokens->>'cache_read')::numeric, 0) + coalesce((tokens->>'cache_write')::numeric, 0)), 0) AS all_tokens,
             coalesce(sum(cpu_hours), 0) AS cpu_hours, max(created_at) AS last_return, min(created_at) AS first_return, ${PENDING_POINTS_SQL},
             jsonb_object_agg(type, n) FILTER (WHERE type IS NOT NULL) AS types, array_agg(DISTINCT model) FILTER (WHERE model IS NOT NULL) AS models
      FROM (SELECT r.*, count(*) OVER (PARTITION BY r.user_id, r.type) AS n FROM returns r WHERE r.problem_id = $1 AND r.created_at >= ${S}) t
      GROUP BY user_id),
    rev AS (
      SELECT rv.user_id, count(*) AS reviews, count(*) FILTER (WHERE rv.agreed_with_outcome) AS reviews_agreed, count(*) FILTER (WHERE rv.agreed_with_outcome IS NOT NULL) AS reviews_scored, max(rv.created_at) AS last_review,
             coalesce(sum((rv.tokens->>'output')::numeric), 0) AS rev_output_tokens, coalesce(sum(coalesce((rv.tokens->>'input')::numeric, 0) + coalesce((rv.tokens->>'output')::numeric, 0) + coalesce((rv.tokens->>'cache_read')::numeric, 0) + coalesce((rv.tokens->>'cache_write')::numeric, 0)), 0) AS rev_all_tokens
      FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S} GROUP BY rv.user_id),
    msg AS (
      SELECT m.user_id, count(*) AS messages, count(*) FILTER (WHERE m.kind = 'found') AS found, max(m.created_at) AS last_message
      FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = $1 AND m.created_at >= ${S} AND m.user_id IS NOT NULL GROUP BY m.user_id),
    cr AS (
      SELECT user_id, sum(points) AS points,
             sum(points) FILTER (WHERE kind = 'result') AS result, sum(points) FILTER (WHERE kind = 'breakthrough') AS breakthrough,
             sum(points) FILTER (WHERE kind = 'insight') AS insight, sum(points) FILTER (WHERE kind = 'direction') AS direction, sum(points) FILTER (WHERE kind = 'integrated') AS integrated,
             sum(points) FILTER (WHERE kind = 'review') AS review, sum(points) FILTER (WHERE kind = 'compute') AS compute, sum(points) FILTER (WHERE kind = 'tokens') AS tokens
      FROM credits WHERE problem_id = $1 AND created_at >= ${S} GROUP BY user_id),
    seen AS (
      SELECT user_id, max(last_seen) AS last_seen,
        count(*) FILTER (WHERE ended_at IS NULL AND last_seen > now() - interval '1 hour') AS active_sessions
      FROM sessions WHERE problem_id = $1 AND last_seen >= ${S} GROUP BY user_id),
    lifetime AS (SELECT user_id, sum(points) AS points FROM credits WHERE problem_id = $1 GROUP BY user_id),
    ids AS (SELECT user_id FROM ret UNION SELECT user_id FROM rev UNION SELECT user_id FROM msg UNION SELECT user_id FROM cr UNION SELECT user_id FROM seen)
    SELECT u.handle, u.display_name, u.created_at AS joined,
      coalesce(lifetime.points, 0) AS all_time_points, coalesce(seen.active_sessions, 0) AS active_sessions,
      coalesce(cr.points, 0) AS points, coalesce(ret.pending_points, 0) AS pending_points, coalesce(cr.result, 0) AS result, coalesce(cr.breakthrough, 0) AS breakthrough, coalesce(cr.integrated, 0) AS integrated, coalesce(cr.insight, 0) AS insight,
      coalesce(cr.direction, 0) AS direction, coalesce(cr.review, 0) AS review_points, coalesce(cr.compute, 0) AS compute_points, coalesce(cr.tokens, 0) AS token_points,
      coalesce(ret.submitted, 0) AS submitted, coalesce(ret.accepted, 0) AS accepted, coalesce(ret.pending, 0) AS pending, coalesce(ret.rejected, 0) AS rejected, coalesce(ret.contested, 0) AS contested,
      coalesce(ret.output_tokens, 0) + coalesce(rev.rev_output_tokens, 0) AS output_tokens, coalesce(ret.all_tokens, 0) + coalesce(rev.rev_all_tokens, 0) AS all_tokens, coalesce(ret.cpu_hours, 0) AS cpu_hours,
      coalesce(ret.types, '{}'::jsonb) AS types, coalesce(ret.models, '{}') AS models,
      coalesce(rev.reviews, 0) AS reviews, coalesce(rev.reviews_agreed, 0) AS reviews_agreed, coalesce(rev.reviews_scored, 0) AS reviews_scored,
      coalesce(msg.messages, 0) AS messages, coalesce(msg.found, 0) AS found,
      greatest(ret.last_return, rev.last_review, msg.last_message, seen.last_seen) AS last_active,
      rp.score AS reputation, rp.seeded,
      (SELECT last_seen FROM pool WHERE pool.problem_id = $1 AND pool.user_id = u.id) AS pool_last_seen
    FROM ids JOIN users u ON u.id = ids.user_id
    LEFT JOIN ret ON ret.user_id = u.id LEFT JOIN rev ON rev.user_id = u.id LEFT JOIN msg ON msg.user_id = u.id LEFT JOIN cr ON cr.user_id = u.id
    LEFT JOIN seen ON seen.user_id = u.id LEFT JOIN lifetime ON lifetime.user_id = u.id
    LEFT JOIN reputation rp ON rp.user_id = u.id
    ORDER BY points DESC, accepted DESC, submitted DESC, reviews DESC, output_tokens DESC, messages DESC, last_active DESC NULLS LAST, u.handle`, P);
  peopleAll.forEach((r, i) => { r.rank = i + 1; });
  const people = peopleAll.slice(0, limit);
  // Credit can arrive long after a person stopped contributing. The front page explicitly features recent activity.
  const activePeople = peopleAll.filter(r => r.last_active != null).map((r, i) => ({ ...r, rank: i + 1 }));
  let me = meHandle ? peopleAll.find((r) => String(r.handle).toLowerCase() === meHandle.toLowerCase()) ?? null : null;

  // A returning contributor may have no activity in this window; keep their lifetime milestone available without inventing a rank.
  if (meHandle && !me) me = await one(`SELECT u.handle, u.display_name, NULL AS rank, 0 AS points,
    coalesce((SELECT sum(points) FROM credits WHERE problem_id = $1 AND user_id = u.id), 0) AS all_time_points
    FROM users u WHERE lower(u.handle) = lower($2)`, [problemId, meHandle]) ?? null;

  const agents = await q(`
    WITH ret AS (
      SELECT model, count(*) AS returns, count(*) FILTER (WHERE status = 'accepted' AND NOT provisional) AS accepted, count(*) FILTER (WHERE status = 'pending' OR provisional) AS pending,
             count(DISTINCT user_id) AS donors,
             coalesce(sum((tokens->>'output')::numeric), 0) AS output_tokens,
             coalesce(sum(coalesce((tokens->>'input')::numeric, 0) + coalesce((tokens->>'output')::numeric, 0) + coalesce((tokens->>'cache_read')::numeric, 0) + coalesce((tokens->>'cache_write')::numeric, 0)), 0) AS all_tokens,
             coalesce(sum(cpu_hours), 0) AS cpu_hours, max(created_at) AS last_return, ${PENDING_POINTS_SQL}
      FROM returns WHERE problem_id = $1 AND created_at >= ${S} AND model IS NOT NULL GROUP BY model),
    rev AS (SELECT rv.model, count(*) AS reviews, count(*) FILTER (WHERE rv.agreed_with_outcome) AS reviews_agreed, count(*) FILTER (WHERE rv.agreed_with_outcome IS NOT NULL) AS reviews_scored,
                   coalesce(sum((rv.tokens->>'output')::numeric), 0) AS rev_output_tokens, coalesce(sum(coalesce((rv.tokens->>'input')::numeric, 0) + coalesce((rv.tokens->>'output')::numeric, 0) + coalesce((rv.tokens->>'cache_read')::numeric, 0) + coalesce((rv.tokens->>'cache_write')::numeric, 0)), 0) AS rev_all_tokens
            FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S} AND rv.model IS NOT NULL GROUP BY rv.model),
    owners AS (SELECT model, user_id FROM returns WHERE problem_id = $1 AND created_at >= ${S}
      UNION SELECT rv.model, rv.user_id FROM reviews rv JOIN returns r ON r.id = rv.return_id WHERE r.problem_id = $1 AND rv.created_at >= ${S}
      UNION SELECT model, user_id FROM sessions WHERE problem_id = $1 AND last_seen >= ${S}),
    msg AS (SELECT m.model, count(*) AS messages FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.problem_id = $1 AND m.created_at >= ${S} AND m.model IS NOT NULL GROUP BY m.model),
    cr AS (SELECT model, sum(points) AS points, sum(points) FILTER (WHERE kind = 'breakthrough') AS breakthrough FROM credits WHERE problem_id = $1 AND created_at >= ${S} AND model IS NOT NULL GROUP BY model),
    ids AS (SELECT model FROM ret UNION SELECT model FROM rev UNION SELECT model FROM msg UNION SELECT model FROM cr UNION SELECT model FROM owners WHERE model IS NOT NULL)
    SELECT ids.model, mt.provider, mt.tier,
      coalesce(cr.points, 0) AS points, coalesce(ret.pending_points, 0) AS pending_points, coalesce(cr.breakthrough, 0) AS breakthrough,
      coalesce(ret.returns, 0) AS returns, coalesce(ret.accepted, 0) AS accepted, coalesce(ret.pending, 0) AS pending, (SELECT count(DISTINCT user_id) FROM owners WHERE owners.model = ids.model) AS donors,
      coalesce(ret.output_tokens, 0) + coalesce(rev.rev_output_tokens, 0) AS output_tokens, coalesce(ret.all_tokens, 0) + coalesce(rev.rev_all_tokens, 0) AS all_tokens, coalesce(ret.cpu_hours, 0) AS cpu_hours,
      coalesce(rev.reviews, 0) AS reviews, coalesce(rev.reviews_agreed, 0) AS reviews_agreed, coalesce(rev.reviews_scored, 0) AS reviews_scored,
      coalesce(msg.messages, 0) AS messages,
      (SELECT count(*) FROM sessions s WHERE s.problem_id = $1 AND s.model = ids.model AND s.last_seen > now() - interval '1 day') AS active_24h,
      ret.last_return AS last_active
    FROM ids LEFT JOIN model_tiers mt ON mt.model = ids.model
    LEFT JOIN ret ON ret.model = ids.model LEFT JOIN rev ON rev.model = ids.model LEFT JOIN msg ON msg.model = ids.model LEFT JOIN cr ON cr.model = ids.model
    ORDER BY points DESC, accepted DESC, returns DESC, output_tokens DESC, ids.model`, P);
  agents.forEach((r, i) => { r.rank = i + 1; });

  const kinds = ["result", "breakthrough", "integrated", "insight", "direction", "review", "compute", "tokens"];
  const kindLeaders = await q(`SELECT DISTINCT ON (c.kind) c.kind, u.handle, sum(c.points) AS points, count(*) AS events
    FROM credits c JOIN users u ON u.id = c.user_id
    WHERE c.problem_id = $1 AND c.kind = ANY($2) AND c.created_at >= ${S}
    GROUP BY c.kind, u.handle ORDER BY c.kind, points DESC, u.handle`, [problemId, kinds]);
  const leaders = Object.fromEntries(kinds.map(kind => [kind, kindLeaders.find(r => r.kind === kind) ?? null]));
  const most = (key: string) => { const best = [...peopleAll].sort((a, b) => Number(b[key]) - Number(a[key]))[0]; return best && Number(best[key]) > 0 ? { handle: best.handle, value: Number(best[key]) } : null; };
  const activity_leaders = { returns: most("submitted"), reviews: most("reviews"), posts: most("messages"), found: most("found"), output_tokens: most("output_tokens"), cpu_hours: most("cpu_hours") };

  const recent = await q(`
    SELECT r.id, r.type, r.status, r.provisional, r.final_rung, r.author_rung, r.created_at, u.handle, r.model, l.slug AS lane,
           (SELECT count(*) FROM reviews rv WHERE rv.return_id = r.id) AS reviews_in,
           (SELECT count(*) FROM jobs j WHERE j.parent_return_id = r.id AND j.status IN ('queued','assigned')) AS reviews_open
    FROM returns r JOIN users u ON u.id = r.user_id LEFT JOIN lanes l ON l.id = r.lane_id
    WHERE r.problem_id = $1 AND r.created_at >= ${S} ORDER BY r.id DESC LIMIT 12`, P);

  return { window: w, as_of: new Date().toISOString(), totals, people, people_total: peopleAll.length, active_people: activePeople.slice(0, limit), active_people_total: activePeople.length, me, agents: agents.slice(0, limit), agents_total: agents.length, leaders, activity_leaders, recent, points: POINTS };
}
