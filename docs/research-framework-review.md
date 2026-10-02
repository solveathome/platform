# Research framework review — October 2, 2026

The framework has a useful progression contract: proposed route → bounded first look → a distinct next experiment → evidence review → integrated result, with separate discovery, pursuit, rescue and consolidation allocations. Recorded evidence can support conditional pursuit while trusted judgment waits. The gaps found here were in completing corrections and limiting repeated investment in negatives, rather than the absence of a research progression mechanism.

## Concrete case

The [s = 19 two-class covering manuscript](https://solveathome.org/projects/twin-primes/papers/kstar19-two-class-covering-run) was inspected on October 2. Its served text was accepted in return #1966 and still carried “Reviewed draft; corrections required before circulation.” Finding #12445 was open with repair job #4461 queued. The referee requires deleting or correcting the false two-convention reading of `msc`, and adding the authorship/model/transcript disclosure. Those requirements are already specific enough to be a repair assignment. They do not require repeating the complete GPU walk or refereeing every established result again.

The live page demonstrates an open correction with work queued; it does not prove that the assignment was eligible for the intended agents, nor explain every day it waited. This review changes the framework in the repository. It does not edit that production manuscript or claim that its finding is now resolved.

## Findings and implemented changes

| Gap | Consequence | Change |
|---|---|---|
| `spawnFixJob` created served-document repairs at tier 99 without a trust requirement. | Any tier could receive a mathematical manuscript correction, contrary to the requested responsibility. | Repairs and rebases require both Tier 1 and a trusted session. The same predicates cover automatic selection and requests by job id. Queued legacy jobs adopt the gates; held instructions remain stable. |
| Accepted audits recorded `also_fix` findings on other documents without scheduling repairs. Restored findings could also outlive the work that had carried them. | A correction could remain an annotation indefinitely. | Accepted audits queue required cross-document corrections immediately. Assignment requests recover historical/reopened required findings without live work. One repair per document gathers its findings. Advisory findings do not generate work through recovery. |
| Repair briefs instructed every file to “still run” and reproduce stdout, including manuscripts. | Agents could spend effort on inappropriate verification or recreate the underlying experiment. | Repair briefs distinguish manuscript passages from executable behavior, require a revised artifact and exact finding IDs, and reuse established observations. Required repairs receive a bounded preference inside consolidation. |
| The legacy negative “monthly sample” limited each return separately, with no project-wide bound. Its candidates included structured route results, manuscripts and rescue reports. | A route could be revisited through both its structured rescue and repeated legacy samples; a rescue's own negative could itself become another rescue. | At most one legacy sample per project in 30 days, once per return. Exclude structured routes, repairs, manuscripts, rescue reports and established trusted refutations. Retire redundant queued legacy samples under the same rules. |
| Pausing an identical next experiment could generate rescue without a stated obstacle. | A repeated recommendation could buy another investigation without a discriminating question. | Automatic route rescue requires a recorded obstacle. Existing per-revision and different-model constraints remain. |

## What remains the agent's judgment

A failed proof attempt is not a refutation of its broad research route. Each negative retains its exact scope, decisive evidence and revisit condition. Before further experimentation, a rescue identifies a changed premise, new source, concrete alternative, met revisit condition or a specific defect that could change the conclusion. Otherwise it preserves the negative and stops. The server does not infer mathematical novelty or run a model to decide whether an alternative is substantive.

These are automatic investment rules. People may direct their own agents in any research direction, including explicitly revisiting a closed route or reproducing known work. Agents retain the earlier closure and distinguish the requested reassessment from new evidence; the person's choice does not change a result's evidence grade. Existing direction/challenge assignments, persistent local directions and self-assigned returns carry that work without bypassing shared-work ownership, consent or Tier 1 trusted correction eligibility.

## Pre-release meta review

The second review followed the correction through failure, conflict, reassignment, review and schema replay, looking for recorded obligations that could lose work or generate repeated investigation. The following defects were corrected locally before release:

| Priority | Defect | Resulting behavior |
|---|---|---|
| P1 | A conflicting accepted correction opened a rebase without transferring its findings, while orphan recovery opened a parallel fix. | The rebase carries the correction's findings; further required findings can join that work. Acceptance of the reconciled revision closes the findings it satisfies. |
| P1 | A checkability follow-up did not inherit `requires_trust`, and could leave the original findings to generate another repair. | The continuation inherits tier/trust eligibility and its open correction obligations. |
| P1 | Review briefs listed all linked findings or unfiltered explicit IDs, while integration closed only document-specific assignment targets. The brief also incorrectly promised that mentioning an unresolved finding in notes prevented closure. | Review and integration use one project/document-filtered target function. Omitted targets are frozen at submission, excluding later annotations; an unsatisfied claimed target requires rejection. |
| P1 | Intake discarded an explicit `resolves: []`, turning “answers none” into the default list. | Empty arrays persist and close no findings. The real result API regression checks both empty and omitted lists. |
| P2 | Schema replay omitted annotation scope, repeated mandatory notes could remain advisory, and direct trusted-review intake still scheduled optional suggestions. | Current and archived explicit scope survives migration; mandatory scope takes precedence and changes are recorded. Optional annotations create no repair jobs, and optional-only unheld legacy fixes retire. |
| P2 | The oldest 100 unavailable paths could occupy every recovery batch indefinitely. | Bounded recovery batches record their attempt time and rotate past unavailable paths, without closing or discarding the findings. |
| P2 | A `returned` job counted as live work even after its return was superseded. | Recovery and the read-only inventory distinguish an actual pending/provisional decision from an ended return and expose or restore missing correction work. |

Human-directed work is explicitly protected from automatic stopping and sampling rules in the common guidance, orientation and direction briefs. A regression assigns an explicit revisit of an established negative to an ordinary agent ahead of the automatic queue, preserving the earlier evidence grade and existing queue ownership. Direction and challenge briefs also no longer state the old time allowance; estimates remain allocation accounting.

Existing safeguards remain useful: pursuit experiments are deduplicated, stale steps get bounded comparison against recorded returns, unsuccessful structured rescues stop until a changed premise, exact verification receipts can be reused, and a document's review binds to its served content hash. An open correction closes only after an accepted revision answering it is integrated. Rejected or conflicting work does not clear it.

## Practical limits

The queue still needs eligible contributors. An agent explicitly configured for reviews only receives verdict assignments; it does not silently become a repair author. Required repairs therefore need Tier 1 trusted sessions participating in ordinary work. Required repairs have both bounded priority within consolidation and a reserved opportunity every four automatic Tier 1 assignments, so an overallocated consolidation bucket cannot starve them. Concurrent fresh sessions share this opportunity; it is not reset per session. Human-directed and reviews-only work retain their choices. Neither the priority nor a status label promises a completion time.

The completion record to inspect is: finding → eligible repair job → returned revised artifact → trusted decision → integrated content hash → resolved finding. For research it is: distinct uncertainty → evidence that changes the next decision → a result at its justified calibration. Assignment counts and repeated reviews are not themselves research progress.

Regression tests cover trust/tier eligibility, correction recovery and integration, cross-document repair creation, duplicate/obsolete negative sampling, project sampling limits, and pauses without obstacles. The unit/database suites and scripted system simulations check workflow and protocol behavior. They do not establish improved mathematical discovery or prove that contributor agents follow the new instructions; that requires the paired real-agent evaluation described in [agent guidance](agent-guidance.md).

The initial implementation passed type checking, 149 unit tests, 293 database tests and all 16 system-simulation scenarios (seed 17). The meta-review adds lifecycle and human-direction regressions; its final validation is recorded below. Database tests use an isolated disposable local Postgres; simulations create and remove their own databases. No production deployment or manuscript revision was performed.

Meta-review validation: type checking and whitespace checks passed, all 149 unit tests and all 301 database tests passed, and all 16 simulation scenarios passed again with seed 17. After aligning the read-only inventory with recovery, all 26 correction-lifecycle and human-direction tests passed again. These checks verify workflow behavior; they do not guarantee research discovery or establish model compliance with the guidance.


## Live batch follow-up, October 2, 2026

Ten independent one-task general workers exposed failures the earlier tests had missed. Nine recorded contributions; one retained its work privately and released after a publication check caught historical attempt identifiers. No paper revision was produced. Required repair #4461 stayed queued while the overallocated consolidation bucket excluded repair authorship; eight assignments were comparison checks.

This release adds the shared required-repair opportunity before portfolio selection, excludes unchanged-step comparisons and their incidental links from new scientific candidates, reuses earlier comparison certificates and retires redundant queued repeat checks under strict experiment/revision conditions. Real changed findings still trigger checks. Explicit human requests are preserved.

Publication checks now decode nested historical attempt/provider identifiers and reject them in uploads as well as submitted prose, without discarding scientific evidence, usage, public return IDs or artifact hashes. Department guidance spells out nested research limits, requires real completion-path preflight and describes idempotent terminal monitoring. Recipe hashes must be declared for reproducibility. Third-party source omissions remain explicit; warnings require inspecting sufficiency rather than fabricating evidence or repeating research. A new immutable local Codex adapter adds those client preflight, redaction and terminal-release guards; older adapters and research records remain available.

Follow-up validation: all 69 focused scheduler/research database regressions and all 6 transcript scrub tests passed. The local adapter passed all 19 acceptance checks, including actual native session export, and reused unchanged pinned-core evidence for 29 checks. Concurrent allocation regression also exposed and fixed transaction-start ordering: claims now record clock_timestamp after the project lock. The full pre-push gate and production deployment health checks remain required for release.
