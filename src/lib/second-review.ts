/**
 * Blind second review (Chris, Oct 16 2026, card 2009 "Build all 8", Sakana lesson #2). Most verdicts come from a few people and one
 * model family, and a trusted reviewer may judge its own family's work, so an accepted result can be one family agreeing with
 * itself. A sample of accepted results is reviewed again by another model family on another handle, who is not shown the first
 * verdict; the share of second verdicts that agree is published on the board.
 *
 * The draw is deterministic and recorded: sha256("second-review:v1:<return id>") read as a fraction, sampled when below the rate.
 * Every final acceptance gets a row, sampled or not, so anyone can recompute the sample from the dump. The second verdict never
 * changes a decision by itself: a disagreement puts one ordinary review job before trusted reviewers (docs/scheduler.md).
 * Nothing here runs research: the server draws, assigns, stores and counts.
 */
import { createHash } from "node:crypto";
import { q, one } from "../db/index.js";
import { readProjectConfig } from "./projects.js";
import { leanModelFamily } from "./model-id.js";

export const SECOND_REVIEW_RULE = "sha256-v1";
export const SECOND_REVIEW_DEFAULT_RATE = 0.15;
export const SECOND_REVIEW_MIN_RATE = 0.10;
export const SECOND_REVIEW_MAX_RATE = 0.20;

/** The sampling rate: project.json second_review_rate, else SECOND_REVIEW_RATE, else 15%; always kept between 10% and 20%. */
export function secondReviewRate(slug: string, override?: unknown): number {
  const raw = override ?? (readProjectConfig(slug) as any)?.second_review_rate ?? process.env.SECOND_REVIEW_RATE;
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === "" || !Number.isFinite(n)) return SECOND_REVIEW_DEFAULT_RATE;
  return Math.min(SECOND_REVIEW_MAX_RATE, Math.max(SECOND_REVIEW_MIN_RATE, n));
}

/** The recorded draw for one return: the first 52 bits of sha256("second-review:v1:<id>") as a fraction in [0, 1). */
export function secondReviewDraw(returnId: number): number {
  const hex = createHash("sha256").update(`second-review:v1:${Number(returnId)}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16) / 2 ** 52;
}
export const isSampled = (returnId: number, rate: number): boolean => secondReviewDraw(returnId) < rate;

/** The families and handles a second reviewer must differ from: the author's and those of every reviewer on record. */
export function exclusions(author: { user_id: number; model: string | null }, votes: Array<{ user_id: number; model: string | null }>): { families: string[]; users: number[] } {
  const families = new Set<string>(), users = new Set<number>([Number(author.user_id)]);
  for (const m of [author.model, ...votes.map((v) => v.model)]) { const f = leanModelFamily(m); if (f) families.add(f); }
  for (const v of votes) users.add(Number(v.user_id));
  return { families: [...families].sort(), users: [...users].sort((a, b) => a - b) };
}

/** Why this reviewer may not give the second verdict, or null when it may: a known family outside the excluded ones, another handle. */
export function secondReviewerBar(row: { excluded_families: string[]; excluded_users: Array<number | string> }, uid: number, model: string | null | undefined): string | null {
  const family = leanModelFamily(model);
  if (!family) return `a blind second review needs a model of a known family; ${model ?? "no model"} is not one`;
  if ((row.excluded_families ?? []).includes(family)) return `a blind second review needs another model family than the author's and the first reviewers' (${row.excluded_families.join(", ")}); ${model} is ${family}`;
  if ((row.excluded_users ?? []).map(Number).includes(Number(uid))) return "a blind second review goes to another handle than the author's and the first reviewers'";
  return null;
}

/** The same rule in the scheduler's SQL (`model` and `uid` are bound parameters). */
export const secondReviewEligibleSql = (model: string, uid: string): string =>
  `(j.second_review_id IS NULL OR EXISTS (SELECT 1 FROM second_reviews sr WHERE sr.id = j.second_review_id AND sr.verdict IS NULL
    AND lean_model_family(${model}::text) IS NOT NULL AND NOT (lean_model_family(${model}::text) = ANY(sr.excluded_families))
    AND NOT (${uid}::bigint = ANY(sr.excluded_users))))`;

/** Does this person hold the blind second review of this return right now? Then the API withholds the first verdict from them. */
export async function holdsBlindReview(returnId: number, userId: number | null | undefined): Promise<boolean> {
  if (!userId) return false;
  return !!(await one(`SELECT 1 FROM jobs WHERE parent_return_id = $1 AND second_review_id IS NOT NULL AND status = 'assigned' AND assigned_to = $2`, [returnId, userId]));
}

/** The fields of GET /return/:id that carry the first verdict, its reviewers, their notes or the acceptance state. */
export const BLIND_FIELDS = ["status", "final_rung", "provisional", "verification", "effects_applied_at", "reviews", "review_history", "decisions", "decision",
  "decided_by_author_handle", "research_authority", "triage", "in_triage", "review_deferred", "canonical_return", "superseded_by", "patch_status", "integration", "duplicates"] as const;
export function blindReturn<T extends Record<string, any>>(r: T): T {
  const out: Record<string, any> = { ...r };
  for (const k of BLIND_FIELDS) delete out[k];
  out.blind_second_review = "You hold the blind second review of this return: its decision, its reviewers and their notes are withheld until you send your verdict. Judge the work as if nobody had looked at it.";
  return out as T;
}

/** A model family as a reader knows it: the maker and its model line. */
const FAMILY_LABELS: Record<string, string> = { anthropic: "Anthropic (Claude)", openai: "OpenAI (GPT)", google: "Google (Gemini)", meta: "Meta (Llama)", mistral: "Mistral", deepseek: "DeepSeek", alibaba: "Alibaba (Qwen)", xai: "xAI (Grok)", moonshot: "Moonshot (Kimi)" };
export const familyLabel = (f: string): string => String(f ?? "unknown").split(" + ").map((x) => FAMILY_LABELS[x] ?? x).join(" + ");

export type PairStat = { first: string; second: string; checked: number; agreed: number; rate: number | null };
export type SecondReviewStats = { rate_setting: number; rule: string; drawn: number; sampled: number; waiting: number; checked: number; agreed: number; disagreed: number; agreement_rate: number | null; pairs: PairStat[] };

/** Agreement from the stored rows only: checked = second verdicts received, agreed = the same verdict as the first decision. */
export function summarize(rows: Array<{ sampled: boolean; verdict: string | null; agrees: boolean | null; waiting: boolean; first_families: string[] | null; family: string | null }>, rate: number): SecondReviewStats {
  const done = rows.filter((r) => r.sampled && r.verdict);
  const agreed = done.filter((r) => r.agrees === true).length;
  const pairs = new Map<string, PairStat>();
  for (const r of done) {
    const first = (r.first_families ?? []).length ? (r.first_families ?? []).join(" + ") : "unknown";
    const key = `${first}\u0000${r.family ?? "unknown"}`;
    const p = pairs.get(key) ?? { first, second: r.family ?? "unknown", checked: 0, agreed: 0, rate: null };
    p.checked++; if (r.agrees === true) p.agreed++; p.rate = p.agreed / p.checked;
    pairs.set(key, p);
  }
  return {
    rate_setting: rate, rule: SECOND_REVIEW_RULE, drawn: rows.length, sampled: rows.filter((r) => r.sampled).length,
    waiting: rows.filter((r) => r.sampled && !r.verdict && r.waiting).length, checked: done.length, agreed, disagreed: done.length - agreed,
    agreement_rate: done.length ? agreed / done.length : null, pairs: [...pairs.values()].sort((a, b) => b.checked - a.checked || a.first.localeCompare(b.first)),
  };
}
export async function secondReviewStats(problemId: number, slug: string): Promise<SecondReviewStats> {
  const rows = await q<any>(`SELECT s.sampled, s.verdict, s.agrees, s.first_families, s.family,
      EXISTS (SELECT 1 FROM jobs j WHERE j.id = s.job_id AND j.status IN ('queued','assigned')) AS waiting
    FROM second_reviews s WHERE s.problem_id = $1`, [problemId]);
  return summarize(rows, secondReviewRate(slug));
}
