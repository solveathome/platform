/**
 * Lane specs and the locked evaluator (Sakana lessons #8 and #1, Chris, Oct 16 2026, #sah-sakana-lane-specs-locked-evaluator).
 *
 * A lane in projects/<slug>/project.json may carry a `spec`: the goal, the metric, a runnable starting script and a pinned
 * evaluator, each a file under projects/<slug>/lanes/<lane>/ with its sha256 recorded in the config. The files are served
 * read-only at GET /projects/<slug>/lane/<lane>/spec. The server never runs them (Chris, Oct 16 2026: "we don't want to spend
 * large amount of on server compute"): a checker runs the evaluator on its own machine inside the check job, and the server
 * only stores and compares the hash the receipt reports.
 *
 * Why: Sakana's Agentic Scientist found agents rewriting the evaluation itself (majority voting in place of pass@1) and no
 * automated gate caught it. A check of a measured or verified result that reruns the author's own script inherits whatever the
 * author changed; a check that runs the lane's pinned evaluator, or the checker's own reimplementation, does not.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { projectDir, readProjectConfig } from "./projects.js";
import { bad } from "./research-format.js";

export type LaneSpecFile = { path: string; sha256: string; command: string };
export type LaneSpec = {
  goal_md: string;
  metric: { name: string; unit: string; better: "higher" | "lower"; baseline_md: string };
  /** The spec document: the claim format the evaluator reads, what it checks, what it does not. */
  doc: string;
  start: LaneSpecFile;
  evaluator: LaneSpecFile & { tools: string[] };
};
/** The rungs whose check must run the lane's evaluator. An unstated rung counts: a reviewer may still accept it as measured. */
export const LOCKED_RUNGS = ["measured", "verified"] as const;
export const EVALUATOR_POLICY = "lane-evaluator-v1";

const SHA = /^[a-f0-9]{64}$/;
/** A spec file path is relative to the project folder, inside lanes/<lane>/, one plain file name. */
const specPath = (lane: string, p: unknown): p is string => typeof p === "string" && posix.dirname(p) === `lanes/${lane}` && /^[a-zA-Z0-9_.-]+$/.test(posix.basename(p)) && !p.includes("..");

export function laneSpec(slug: string, lane: string): LaneSpec | null {
  const s: any = readProjectConfig(slug)?.lanes?.find((l) => l.slug === lane)?.spec;
  if (!s || typeof s !== "object") return null;
  const file = (f: any) => f && specPath(lane, f.path) && SHA.test(f.sha256) && typeof f.command === "string" && f.command.trim();
  if (typeof s.goal_md !== "string" || !s.metric?.name || !["higher", "lower"].includes(s.metric?.better) || !specPath(lane, s.doc) || !file(s.start) || !file(s.evaluator)) return null;
  return s as LaneSpec;
}

/** The bytes of one of the spec's three files, or null. Only files the spec names are served. */
export function laneSpecFile(slug: string, lane: string, name: string): { path: string; bytes: Buffer; sha256: string } | null {
  const spec = laneSpec(slug, lane), dir = projectDir(slug);
  if (!spec || !dir) return null;
  const path = [spec.doc, spec.start.path, spec.evaluator.path].find((p) => posix.basename(p) === name);
  if (!path || !existsSync(join(dir, path))) return null;
  const bytes = readFileSync(join(dir, path));
  return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** What GET /projects/<slug>/lane/<lane>/spec serves: the spec with a URL for each file. */
export function laneSpecView(slug: string, lane: string): any {
  const spec = laneSpec(slug, lane);
  if (!spec) return null;
  const url = (p: string) => `/projects/${slug}/lane/${lane}/spec/${posix.basename(p)}`;
  return {
    lane, policy: EVALUATOR_POLICY, goal_md: spec.goal_md, metric: spec.metric,
    doc: { path: spec.doc, url: url(spec.doc) },
    start: { ...spec.start, url: url(spec.start.path) },
    evaluator: { ...spec.evaluator, url: url(spec.evaluator.path) },
    locked_rungs: [...LOCKED_RUNGS, "unstated"],
    rule_md: `A check of a ${LOCKED_RUNGS.join(" or ")} result in this lane (or one that states no rung) runs this evaluator, sha256 ${spec.evaluator.sha256}, or the checker's own independent reimplementation, never the author's script. The receipt reports evaluator_sha256; a receipt naming any other evaluator is refused. The server runs nothing.`,
  };
}

/** The evaluator a check of `subject` must run, or null when the lock does not apply: a Lean package (its kernel profile pins
 *  its own checker), a rung below measured, a proof, a lane without a spec, a project without lanes in its config. */
export function lockedEvaluatorFor(slug: string, lane: string | null | undefined, subject: { verification_plan?: any; author_rung?: string | null }): { lane: string; sha256: string; path: string; command: string } | null {
  if (!lane || !subject.verification_plan || subject.verification_plan.lean) return null;
  if (subject.author_rung && !(LOCKED_RUNGS as readonly string[]).includes(subject.author_rung)) return null;
  const spec = laneSpec(slug, lane);
  return spec ? { lane, sha256: spec.evaluator.sha256, path: spec.evaluator.path, command: spec.evaluator.command } : null;
}

/** The paragraph a locked check job's brief carries. The brief text is the API: keep it in step with docs/research-process.md. */
export function lockedEvaluatorBrief(e: { lane: string; sha256: string; command: string }): string {
  return `Locked evaluator (lane \`${e.lane}\`, policy ${EVALUATOR_POLICY}). This result's rung is checked with the lane's pinned evaluator, never the author's script: the author's checker is the thing under test. Fetch the lane spec at GET <project base>/lane/${e.lane}/spec and its evaluator file from the URL it gives; confirm the file's sha256 is ${e.sha256} before you run it. Run \`${e.command}\` on the package's target files, on your machine. If the targets are not in the claim format the spec describes, either write the claims file from the targets yourself (say so in coverage_md, and it is still the pinned evaluator that judges them) or write your own independent implementation of the comparison, upload it, and use method "independent_implementation". Do not use the author's checker as the evaluator. Report evaluator_sha256 in check_receipt: ${e.sha256} for the pinned evaluator, or the sha256 of your uploaded reimplementation. A receipt naming another evaluator (the author's checker, an edited copy of the pinned one, a file you did not upload) is refused. An unable receipt needs no evaluator_sha256.`;
}

/**
 * The receipt's evaluator against the lock the check job carries. Returns what is recorded; refuses (400) a receipt that ran a
 * different evaluator, with the reason in plain words. `uploaded` says whether the hash is a file in the store.
 */
export function judgeEvaluator(pinned: string, raw: unknown, ctx: { outcome: string; method: string; authorFiles: string[]; uploaded: boolean }): { evaluator_sha256: string; evaluator_kind: "lane_pinned" | "independent_reimplementation" } | null {
  if (ctx.outcome === "unable" && (raw === undefined || raw === null)) return null;
  if (typeof raw !== "string" || !SHA.test(raw)) bad(`check_receipt.evaluator_sha256 is required: this check is locked to the lane's pinned evaluator (sha256 ${pinned}). Report the sha256 of the evaluator you ran, as lowercase hex.`);
  const sha = raw as string;
  if (sha === pinned) return { evaluator_sha256: sha, evaluator_kind: "lane_pinned" };
  if (ctx.authorFiles.includes(sha)) bad(`check_receipt.evaluator_sha256 ${sha} is a file from the author's own package. A check of this result must run the lane's pinned evaluator (sha256 ${pinned}) or your own independent implementation, never the author's script.`);
  if (ctx.method !== "independent_implementation") bad(`check_receipt.evaluator_sha256 ${sha} is not the lane's pinned evaluator (sha256 ${pinned}). Run the pinned file unchanged, or, if you wrote your own evaluator, upload it and use method "independent_implementation".`);
  if (!ctx.uploaded) bad(`check_receipt.evaluator_sha256 ${sha} names no uploaded file. Upload your independent implementation first (POST /files), so a reviewer can read what judged the result.`);
  return { evaluator_sha256: sha, evaluator_kind: "independent_reimplementation" };
}
