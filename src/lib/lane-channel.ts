import { q, one } from "../db/index.js";

/**
 * A lane's channel exists from its first message, not from the lane (Chris, Sep 25 2026: seven accepted directions left seven
 * empty channels in the discussion list). The project root channel is made on demand; a lane channel is made here, by whoever
 * posts to it first, and only while the lane is open.
 */
export const LANE_PURPOSE = "Lane channel. Claim what you take, post what you find, spawn a sub-channel to split off.";

export async function ensureRootChannel(problemId: number): Promise<{ id: number; path: string }> {
  await q(`INSERT INTO channels (problem_id, path, title, purpose) VALUES ($1, '', 'project', 'Whole-project channel. Announce yourself, ask where help is needed, link sub-channels.')
           ON CONFLICT (problem_id, path) DO NOTHING`, [problemId]);
  return (await one<{ id: number; path: string }>(`SELECT id, path FROM channels WHERE problem_id = $1 AND path = ''`, [problemId]))!;
}

/** The lane's channel, made now if the lane is open and has none; null for a closed lane without one. */
export async function ensureLaneChannel(laneId: number): Promise<{ id: number; path: string } | null> {
  const have = await one<{ id: number; path: string }>(`SELECT id, path FROM channels WHERE lane_id = $1 AND parent_id IS NOT NULL ORDER BY id LIMIT 1`, [laneId]);
  if (have) return have;
  const l = await one<{ problem_id: number; slug: string; title: string }>(`SELECT problem_id, slug, title FROM lanes WHERE id = $1 AND status = 'open'`, [laneId]);
  if (!l) return null;
  const root = await ensureRootChannel(Number(l.problem_id));
  return (await one<{ id: number; path: string }>(`INSERT INTO channels (problem_id, parent_id, lane_id, path, title, purpose) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (problem_id, path) DO UPDATE SET path = EXCLUDED.path RETURNING id, path`, [l.problem_id, root.id, laneId, l.slug, l.title, LANE_PURPOSE])) ?? null;
}

/** Where the server posts a notice about lane work: the lane's channel, else the project root. */
export async function noticeChannel(problemId: number, laneId: number | string | null | undefined): Promise<{ id: number; path: string }> {
  return (laneId ? await ensureLaneChannel(Number(laneId)) : null) ?? await ensureRootChannel(Number(problemId));
}
