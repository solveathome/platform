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

export type ReviewVote = { verdict: "accept" | "reject"; weight: number; provider: string; rung?: string | null; trusted?: boolean; family?: string | null; tier1?: boolean; negative_result?: boolean | null };
export type Decision =
  | { status: "accepted" | "rejected"; share: number; rung: string | null; provisional: boolean; by: "trusted" | "advisory" }
  | { status: "contested"; share: number; rung: null; provisional: true; by: "advisory" }
  | { status: "pending"; share: number; needMore: boolean; reason: string };

/**
 * `quorum` is the project's review_quorum (project.json, default 1: the rule above, unchanged). Above 1 (Chris, Oct 9 2026, the MD5
 * project: "we need two tier 1 models to agree from a trusted reviewer"), a decision needs that many trusted verdicts from tier-1
 * sessions of different model families on the same side, and more families on that side than on the other. One approved trusted person
 * may give two of them with two different families, as for Lean. Short of that the return waits for another trusted tier-1 family.
 * `families` keeps that counting (tier-1 sessions, one verdict per family) at a quorum of 1: the negative-result rule below.
 */
export function decide(votes: ReviewVote[], quorum = 1, families = quorum > 1): Decision {
  const trusted = votes.filter((v) => v.trusted);
  if ((quorum > 1 || families) && trusted.length) {
    const eligible = trusted.filter((v) => v.tier1 && v.family);
    const families = (verdict: string) => new Set(eligible.filter((v) => v.verdict === verdict).map((v) => v.family)).size;
    const acc = families("accept"), rej = families("reject");
    const share = acc + rej ? acc / (acc + rej) : 0;
    if (acc >= quorum && acc > rej) return { status: "accepted", share, rung: consensusRung(eligible.filter((v) => v.verdict === "accept")), provisional: false, by: "trusted" };
    if (rej >= quorum && rej > acc) return { status: "rejected", share, rung: null, provisional: false, by: "trusted" };
    return { status: "pending", share, needMore: true, reason: `${quorum} trusted tier-1 verdicts from different model families must agree; ${acc} family(ies) accept, ${rej} reject so far` };
  }
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

/** The one definition of a negative result, served to authors and reviewers alike. */
export const NEGATIVE_RESULT_MEANING = "A negative result reports that an attempt established nothing new to build on: the approach did not work, the search found nothing, the question stays open, or an idea is ruled out for the scope stated. It offers no collision, record, candidate, bound, proof, method, artefact or speed-up, and no measurement as evidence that something works.";

/**
 * The quorum one return is decided under (Chris, Oct 13 2026: "a negative result needs less verification than a positive"). A project
 * with a review quorum above 1 may set negative_review_quorum below it (the MD5 project: 1). It applies to a return only when all of
 * this holds: intake admitted the author's declaration that the return is a negative result; at least one trusted tier-1 verdict of a
 * known family is on record; every such verdict says negative_result true; and no trusted review of any tier says false. The class is
 * the author's claim and the reviewer's judgment, never read from the report by the server. Everything else fails closed to the
 * project quorum: no declaration, a reviewer who does not state the class, one who overrides it, a later trusted review that
 * disagrees with the class (the decision is then recomputed at the full quorum and reopens). The lower quorum keeps the family
 * counting, so a tier-2 or unknown-family verdict never decides a negative either.
 */
export function quorumFor(o: { quorum: number; negativeQuorum: number | null; declaredNegative: boolean; votes: ReviewVote[] }): { quorum: number; families: boolean; negative: boolean } {
  const full = { quorum: o.quorum, families: o.quorum > 1, negative: false };
  if (o.quorum <= 1 || o.negativeQuorum === null || o.negativeQuorum >= o.quorum || !o.declaredNegative) return full;
  const trusted = o.votes.filter((v) => v.trusted), counted = trusted.filter((v) => v.tier1 && v.family);
  if (!counted.length || counted.some((v) => v.negative_result !== true) || trusted.some((v) => v.negative_result === false)) return full;
  return { quorum: o.negativeQuorum, families: true, negative: true };
}

/** Lowest rung among accepting reviewers wins: "when unsure pick the lower rung". */
import { LADDER as RUNG_LADDER } from "./rungs.js";
const LADDER: readonly string[] = RUNG_LADDER;
export function consensusRung(accepting: ReviewVote[]): string | null {
  const rungs = accepting.map((v) => v.rung).filter((r): r is string => !!r && LADDER.includes(r));
  if (!rungs.length) return null;
  return rungs.sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b))[0];
}
