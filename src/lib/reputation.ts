import { q, one } from "../db/index.js";

export const SEED_SCORE = 5;
export const NEW_SCORE = 1;
export const MAX_SCORE = 10;
export const MIN_SCORE = 0.1;

export async function ensure(userId: number, seeded = false): Promise<void> {
  await q(
    `INSERT INTO reputation (user_id, score, seeded) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET seeded = reputation.seeded OR EXCLUDED.seeded,
       score = CASE WHEN EXCLUDED.seeded AND NOT reputation.seeded THEN $2 ELSE reputation.score END`,
    [userId, seeded ? SEED_SCORE : NEW_SCORE, seeded],
  );
}

export async function score(userId: number): Promise<number> {
  const r = await one<{ score: string }>(`SELECT score FROM reputation WHERE user_id = $1`, [userId]);
  return r ? Number(r.score) : NEW_SCORE;
}

/** Author outcome: accepted returns raise, rejected lower. Multiplicative, clamped. */
export async function onReturnResolved(userId: number, accepted: boolean): Promise<void> {
  await q(
    `UPDATE reputation SET
       accepted = accepted + $2::int, rejected = rejected + $3::int,
       score = LEAST($4, GREATEST($5, score * $6)), updated_at = now()
     WHERE user_id = $1`,
    [userId, accepted ? 1 : 0, accepted ? 0 : 1, MAX_SCORE, MIN_SCORE, accepted ? 1.1 : 0.9]   // ×1.1 on acceptance, ×0.9 on rejection (Chris, Sep 11 2026: an honest miss is not a cliff; was 0.8),
  );
}

/** Reviewer outcome: agreement with the eventual decision raises weight, disagreement lowers it. */
export async function onReviewScored(userId: number, agreed: boolean): Promise<void> {
  await q(
    `UPDATE reputation SET
       review_agree = review_agree + $2::int, review_disagree = review_disagree + $3::int,
       score = LEAST($4, GREATEST($5, score * $6)), updated_at = now()
     WHERE user_id = $1`,
    [userId, agreed ? 1 : 0, agreed ? 0 : 1, MAX_SCORE, MIN_SCORE, agreed ? 1.05 : 0.85],
  );
}

export async function addCpuHours(userId: number, hours: number): Promise<void> {
  await q(`UPDATE reputation SET cpu_hours = cpu_hours + $2 WHERE user_id = $1`, [userId, hours]);
}
