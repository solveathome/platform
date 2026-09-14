/** Durable admission to validation, separate from the time a claim was submitted. */
import { one, q } from '../db/index.js';
import { isTrusted, type Agent } from './roles.js';

export const MAX_REVIEW_SPAWNS_PER_DAY = Number(process.env.MAX_REVIEW_SPAWNS_PER_DAY ?? 10);

/** Caller holds the project's transaction. The global lock also protects the
 * contributor's daily allowance across simultaneous requests in different projects. */
export async function admitReview(subject: { id: number | string }, agent?: Agent): Promise<boolean> {
  await q(`SELECT pg_advisory_xact_lock(hashtextextended('review-admission', 0))`);
  const ret = await one(`SELECT * FROM returns WHERE id=$1`, [subject.id]);
  if (!ret) throw new Error('no return to admit for review');
  if (ret.review_admitted_at) return true;
  const user = await one(`SELECT handle FROM users WHERE id=$1`, [ret.user_id]);
  const standing = await isTrusted(Number(ret.problem_id), Number(ret.user_id), user?.handle, agent)
    || !!await one(`SELECT 1 FROM returns WHERE user_id=$1 AND problem_id=$2 AND status='accepted' AND NOT provisional AND id<>$3`, [ret.user_id, ret.problem_id, ret.id]);
  if (!standing) {
    const used = await one(`SELECT count(*)::int AS n FROM returns WHERE user_id=$1 AND review_admitted_at>now()-interval '1 day'`, [ret.user_id]);
    if (used.n >= MAX_REVIEW_SPAWNS_PER_DAY) return false;
  }
  await q(`UPDATE returns SET review_admitted_at=now() WHERE id=$1`, [ret.id]);
  return true;
}
