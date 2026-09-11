/**
 * Consensus (scope Q5, Q23; trusted reviewers Sep 10).
 *
 * Trusted reviewers are the authority: the first trusted verdicts decide a return outright, one vote per person.
 * A tie among trusted reviewers waits for one more. Without any trusted review, advisory reviews can decide a return
 * *provisionally* (shown as such, nothing paid or integrated) under the older rule:
 *   - at least MIN_REVIEWS reviews from at least MIN_PROVIDERS distinct providers
 *   - weighted accept share >= ACCEPT_SHARE -> accepted; <= REJECT_SHARE -> rejected
 *   - otherwise more reviews, up to MAX_REVIEWS; still split -> contested
 * Weights are reviewer reputation at review time.
 */
const envInt = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
/** Launch values: 3 reviews, 2 providers (scope Q23) for the advisory rule. */
export const MIN_REVIEWS = envInt("CONSENSUS_MIN_REVIEWS", 3);
export const MIN_PROVIDERS = envInt("CONSENSUS_MIN_PROVIDERS", 2);
export const MAX_REVIEWS = Math.max(envInt("CONSENSUS_MAX_REVIEWS", 7), MIN_REVIEWS);
export const ACCEPT_SHARE = 0.7;
export const REJECT_SHARE = 0.3;

export type ReviewVote = { verdict: "accept" | "reject"; weight: number; provider: string; rung?: string | null; trusted?: boolean };
export type Decision =
  | { status: "accepted" | "rejected"; share: number; rung: string | null; provisional: boolean; by: "trusted" | "advisory" }
  | { status: "contested"; share: number; rung: null; provisional: true; by: "advisory" }
  | { status: "pending"; share: number; needMore: boolean; reason: string };

export function decide(votes: ReviewVote[]): Decision {
  const trusted = votes.filter((v) => v.trusted);
  if (trusted.length) {
    const acc = trusted.filter((v) => v.verdict === "accept").length, rej = trusted.length - acc;
    const share = acc / trusted.length;
    if (acc > rej) return { status: "accepted", share, rung: consensusRung(trusted.filter((v) => v.verdict === "accept")), provisional: false, by: "trusted" };
    if (rej > acc) return { status: "rejected", share, rung: null, provisional: false, by: "trusted" };
    return { status: "pending", share, needMore: true, reason: `trusted reviewers split ${acc}-${rej}; one more trusted review decides` };
  }
  const total = votes.reduce((s, v) => s + Math.max(v.weight, 0.01), 0);
  const acc = votes.filter((v) => v.verdict === "accept").reduce((s, v) => s + Math.max(v.weight, 0.01), 0);
  const share = total > 0 ? acc / total : 0;
  const providers = new Set(votes.map((v) => v.provider)).size;
  if (votes.length < MIN_REVIEWS) return { status: "pending", share, needMore: true, reason: `no trusted review yet; advisory: need ${MIN_REVIEWS} reviews, have ${votes.length}` };
  if (providers < MIN_PROVIDERS) return { status: "pending", share, needMore: true, reason: `no trusted review yet; advisory: need ${MIN_PROVIDERS} providers, have ${providers}` };
  if (share >= ACCEPT_SHARE) return { status: "accepted", share, rung: consensusRung(votes.filter((v) => v.verdict === "accept")), provisional: true, by: "advisory" };
  if (share <= REJECT_SHARE) return { status: "rejected", share, rung: null, provisional: true, by: "advisory" };
  if (votes.length < MAX_REVIEWS) return { status: "pending", share, needMore: true, reason: "no trusted review yet; advisory split, escalating" };
  return { status: "contested", share, rung: null, provisional: true, by: "advisory" };
}

/** Lowest rung among accepting reviewers wins: "when unsure pick the lower rung". */
import { LADDER as RUNG_LADDER } from "./rungs.js";
const LADDER: readonly string[] = RUNG_LADDER;
export function consensusRung(accepting: ReviewVote[]): string | null {
  const rungs = accepting.map((v) => v.rung).filter((r): r is string => !!r && LADDER.includes(r));
  if (!rungs.length) return null;
  return rungs.sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b))[0];
}
