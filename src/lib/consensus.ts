/**
 * Reputation-weighted consensus (scope Q5, Q23).
 *
 * A return is decided by the reviews of it:
 *   - at least MIN_REVIEWS reviews from at least MIN_PROVIDERS distinct providers
 *   - weighted accept share >= ACCEPT_SHARE  -> accepted
 *   - weighted accept share <= REJECT_SHARE  -> rejected
 *   - otherwise: request more reviews, up to MAX_REVIEWS; still split -> contested
 * Weights are reviewer reputation at review time. Seeded reviewers start high.
 */
export const MIN_REVIEWS = 3;
export const MIN_PROVIDERS = 2;
export const MAX_REVIEWS = 7;
export const ACCEPT_SHARE = 0.7;
export const REJECT_SHARE = 0.3;

export type ReviewVote = { verdict: "accept" | "reject"; weight: number; provider: string; rung?: string | null };
export type Decision =
  | { status: "accepted" | "rejected"; share: number; rung: string | null }
  | { status: "contested"; share: number; rung: null }
  | { status: "pending"; share: number; needMore: boolean; reason: string };

export function decide(votes: ReviewVote[]): Decision {
  const total = votes.reduce((s, v) => s + Math.max(v.weight, 0.01), 0);
  const acc = votes.filter((v) => v.verdict === "accept").reduce((s, v) => s + Math.max(v.weight, 0.01), 0);
  const share = total > 0 ? acc / total : 0;
  const providers = new Set(votes.map((v) => v.provider)).size;

  if (votes.length < MIN_REVIEWS) return { status: "pending", share, needMore: true, reason: `need ${MIN_REVIEWS} reviews, have ${votes.length}` };
  if (providers < MIN_PROVIDERS) return { status: "pending", share, needMore: true, reason: `need ${MIN_PROVIDERS} providers, have ${providers}` };
  if (share >= ACCEPT_SHARE) return { status: "accepted", share, rung: consensusRung(votes.filter((v) => v.verdict === "accept")) };
  if (share <= REJECT_SHARE) return { status: "rejected", share, rung: null };
  if (votes.length < MAX_REVIEWS) return { status: "pending", share, needMore: true, reason: "split, escalating" };
  return { status: "contested", share, rung: null };
}

/** Lowest rung among accepting reviewers wins: "when unsure pick the lower rung". */
const LADDER = ["refuted", "conjectured", "heuristic", "measured", "proven"];
export function consensusRung(accepting: ReviewVote[]): string | null {
  const rungs = accepting.map((v) => v.rung).filter((r): r is string => !!r && LADDER.includes(r));
  if (!rungs.length) return null;
  return rungs.sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b))[0];
}
