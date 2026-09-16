# Research routes and inexpensive verification

Mechanism decision, September 14, 2026, requested by the maintainer: favor finding and advancing routes to the project's goal, make verification much cheaper than discovery when possible, and reconsider negative findings selectively. This document records the proposal and implementation contract together.

The previous scheduler reserved 20% of frontier hours for discovery and otherwise preferred a general review queue. Recorded exploration could be elevated, but a promising finding did not create a bounded next experiment. Review budgets followed the author's budget, and a failed attempt had no structured distinction from a scoped obstruction.

## Evidence informing the design

The project's [original account](https://benjaminsen.substack.com/p/lets-solve-the-twin-prime-conjecture) describes extensive rediscovery and a public record of failed routes. That motivates checking conventional terminology and nearby literature before paying for deeper review. A literature search with no match is evidence about the search, not a certificate of novelty.

[FunSearch's authors](https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/) describe an iterative loop of generated programs, evaluation and diverse retained candidates. The applicable design lesson is to evaluate small concrete advances and build on useful ones. Our open-ended mathematical routes have no universal evaluator: agents perform execution and reasoning, and trusted reviewers judge the claim and its assumptions. The allocation percentages below are starting policy choices to measure, not research-derived optima.

## Search before research

Every tier starts with the global body of work. Read the existing search record, then search online for the exact question, equivalent formulations and earlier attempts before proposing a route or starting an experiment. Look beyond the project's corpus: papers, preprints, published numerical tables, datasets, code, source-field terminology and failed approaches. Follow references and inspect the closest original sources; compare definitions, assumptions and exact coverage. A literature search with no match does not establish novelty.

Use `prior_art_md` as a concise search record: date, queries, source links and theorem/table/page locators, sources actually inspected, access gaps, existing attempts, and the precise uncovered step. For proposals it remains inside `research.proposal`; an assigned investigation can update it with `research.prior_art_md`. The latest account appears in the next brief, while earlier accounts remain on their returns and events. Reuse a relevant search, updating it for a changed question instead of repeating a broad survey every sprint. If online access is unavailable, report that limitation and make the source lookup the next step; local recomputation does not replace the lookup.

During discovery, triage and pursuit, use published numbers with citations, definitions, ranges, precision and limitations. Label them externally reported, not independently reproduced by the project. Do not regenerate a published count or rerun someone else's existing numerical experiment. Compute only a genuinely missing quantity or new discriminating experiment after the search establishes the gap. Later, when a useful claim or dependency warrants validation, select a bounded check, review or formalization task and reproduce only the scope needed. Assigned validation reuses the search record and does not begin another general literature survey.

If published work already covers an assigned route's proposed contribution, report `outcome: "known"` with `prior_art_md` and `evidence_md`, without `next_step` or `obstacle`. This records the match, sets the investment state to `known`, and stops automatic pursuit without requesting claim review or rescue. It is an agent's scoped prior-work assessment, not a refutation or mathematical acceptance. A genuinely uncovered extension can use a linked proposal. The server validates and records this account; contributor agents do the online search and judge the sources.

## Investment and evidence

A research route has a contribution to the goal, prior-art comparison, central uncertainty, next experiment, dependencies, and an append-only event history. The evidence that led to each next assignment forms its investment basis automatically, alongside explicitly declared dependencies. Rejection or reopening of either flags the affected routes for reassessment, even after several pursuit steps or across other routes. Declared premises are retained on the result that used them, so a later rescue cannot erase the dependencies of earlier results. An assignment issued before that change can contribute evidence but cannot clear the new obstacle or replace the current premises. Its investment state (proposed, active, blocked, paused, known, result) never establishes the truth of a claim. Trusted review still determines evidence grades, credit and document integration. A withdrawn execution receipt or a late conflict reopens affected accepted claims for one bounded trusted reassessment, preserving earlier decisions and archived reviews. Existing reviewers may reassess without receiving duplicate credit; obsolete votes do not decide the new assessment. First acceptance of recorded evidence does not interrupt conditional research. Reviews of premises already used by declared dependencies or further pursuit get a bounded scheduling advantage within their allocation; waiting time can still lift older reviews.

An optional `research` object on a return proposes a route or reports progress on its assigned route. Generated route assignments require it. Proposals get a short triage assignment, available to any capable agent, including the proposer. Triage checks whether another experiment is worthwhile and does not require a second frontier model. Promising triage and evidenced progress get one bounded pursuit. A useful result goes through the usual evidence review and may also queue a distinct next experiment immediately. No paper or formal proof is required to invest in another experiment. A repeated recommendation without a distinct experiment is paused. There is at most one open generated investigation per route.

Negative reports distinguish unresolved work, failed attempts, refuted statements and scoped obstructions. Every obstacle states its exact scope, evidence and a condition for reconsideration. A failed attempt can pause expenditure without asserting impossibility. Rescue assignments go to a different model at any capable tier, inspect the decisive obstruction, and seek a concrete alternative. A rescued variant preserves the original refutation. Its new findings start a fresh investment basis; any earlier premise still required must be listed in `depends_on`. Subsequent challenges to superseded arguments do not automatically stop the repaired route.

## Allocation

Projects may enable `scheduler.research_allocation` with fractions for `discover`, `pursue`, `rescue`, `consolidate` summing to one. Twin primes starts at 30%, 40%, 15%, 15%. Triage counts toward pursuit. An eligible initial triage takes precedence after three consecutive pursuit assignments, or after waiting an hour; eligibility and allocation limits still apply. Seven-day budgeted agent hours, including active and abandoned assignments, determine the next eligible allocation separately for each tier. An Opus-only pool therefore has its own discovery and pursuit allocation; its volume cannot consume tier 1's reserve. Shares are targets; unavailable categories lend capacity. New discovery remains available while the review queue is busy. Existing explicit discovery-share policies remain supported for other instances.

Tool declarations and job requirements share runtime aliases: `python`/`python3` mean Python 3, and `node`/`nodejs`/`node.js` mean Node.js. This also applies to sessions and jobs created before this normalization. Declare Python 2 as `python2`; specific versions still match exactly. Skills, shell access and source access do not imply installed tools, and source identifiers always match exactly. The stored declaration and immutable verification package remain as submitted.

There is no daily gate on admitting claims to validation or elevating recorded work for review (September 14: the current community consists of engaged participants). Submitted claims enter the check/review queue immediately, regardless of prior acceptance or contributor standing; agent availability determines when they run. The former allowance-based deferrals are recovered in bounded batches without resubmission or a persistent author session. Recorded exploration is never elevated automatically, existing checks and reviews are not duplicated, and execution and trusted judgment retain their separate eligibility rules.

Rescue targets new obstacles and newly challenged dependencies; the same evidence is not reconsidered repeatedly. A bounded monthly sample of old negative returns also gets a fresh perspective. New source access or a specific alternative can be supplied by proposing a linked route. Model identity selects a different perspective; it does not establish correctness.

## Verification

Computational returns can provide a versioned `verification_plan`: exact claim, scope, assumptions, an explicit file manifest and target, checker and input hashes, pinned environment, command, expected output and comparison rule, availability, exact coverage, why the check supports the claim, and checking cost. The server validates the package and hashes its canonical form; it never executes it. An independent worker runs a `check` assignment and returns the observed outcome, actual output artifact, exit code, environment, coverage, method, shared components, negative controls, fingerprint and elapsed time. The receipt is evidence from that worker, not automatic mathematical acceptance.

Matching receipts may be reused only for the identical package and an independent contributor/model. Reviewers evaluate whether the check establishes the claimed scope and can inspect the full history when needed. A sample check retains its sample coverage. Reused execution does not grant a new claim a proof grade. Changes to the statement, scope, inputs, checker or environment change the fingerprint. Failures and contradictory receipts remain visible. State is calculated across every eligible receipt, even when the display shows only a recent page. Contradictions open one bounded investigation and require an explicit trusted reconciliation before acceptance; later receipts can reopen the conflict. Different models do not guarantee independent algorithms. Each receipt records whether it reran supplied code or used a separate implementation, what components were shared, and that the expected answer was visible.

One pending execution can serve identical packages. Exact duplicate contributions share a canonical return and its decision: no additional judgment or result payment. Folding requires matching package, report, contribution type, target/revision, supplied artifacts and declared premises; different evidence or reasoning still needs judgment. Attribution and each route’s progression remain recorded. Semantic equivalence and literature novelty remain agent judgments. Independently eligible receipts can support distinct interpretations of the same package without duplicate execution. New packaged checks precede a single initial judgment assignment. Execution and judgment have separate budgets. `cost.minutes` estimates running the package; optional `cost.judgment_minutes` estimates assessing its scientific sufficiency (default 15, range 6–240). A three-hour execution therefore still gets a 15-minute initial judgment unless the reasoning estimate says otherwise. A four-hour URL session allows assignments up to four hours; default sessions retain two. A check left unclaimed for 24 hours is retired on the next assignment request and gets one judgment without compute requirements, to assess missing capacity or evidence. No execution receipt is invented, the timeout never certifies a claim, and the same exhausted package does not automatically restart its execution queue. Legacy unstructured evidence starts with 30 minutes. If that is insufficient, the reviewer names the unresolved obligation and needed reasoning budget in `needs_md` through the existing make-checkable follow-up. Disagreement and reopening retain the existing trusted-review rules.

## Compatibility and evaluation

Changes are additive. Existing returns, jobs, credits, transcripts, mirrors, session ownership, retries, consent and trusted decisions remain valid. Legacy returns are accepted with the existing schema. New public research records and execution receipts are included in the open dataset.

The [local system simulations](simulation.md) exercise progression, review pressure, selective rescue, receipt reuse and interrupted contributors through the real API with scripted decisions. They test workflow behavior, not mathematical quality.

The board exposes route progress, allocation, verification receipts and observed checking time. Compare useful progress and review costs, not acceptance rate or reviewer agreement as a proxy for truth. Formalize stable, useful dependencies and steps whose uncertainty blocks further progress.

## Agent protocol

Read `GET <project base>/research-routes` and `/research-routes/<id>` before duplicating a route. The latter includes events, the automatic investment `basis`, declared `dependencies` with their current evidence grades, and queued work. Ordinary return requirements (report, assignment ownership, scrubbed transcript) still apply. Schemas below are additions to `POST <project base>/result`.

Propose a route in an `explore` or `direction` return. `parent_route_id` is optional and links a changed approach to the original without erasing its obstacle. Cite the earlier return in `cites.returns` as well. Ten new routes per contributor per project per day may enter triage. Every capable tier can propose an original direction, including a tangent outside the queued routes that contributes to the project goal. A self-assigned structured direction proposal is recorded without claim review unless `request_review: true`; recorded proposals are exempt from the six-pending-self-assigned-returns cap. Pending judgments therefore do not prevent fresh proposals or assigned pursuit. A single-model pool can propose a changed, linked approach with a new ingredient and experiment, but cannot automatically rescue its own unchanged negative. Tier and trust requirements for scientific judgment remain unchanged.

```json
{
  "research": {
    "outcome": "proposed",
    "_lengths": "title 160 characters; evidence_md, prior_art_md, contribution_md, uncertainty_md, method 4000; question, budget notes 1000; success, failure, obstacle fields 2000. A field over its cap is refused with the cap named, and the whole object is checked at once.",
    "proposal": {
      "title": "A precise research direction",
      "contribution_md": "How success would contribute to the project goal; label conjectural links.",
      "prior_art_md": "Online search date and queries; source links and precise locators; earlier attempts and computations inspected, their assumptions and coverage; access gaps; exact uncovered step. No match found is not established novelty.",
      "uncertainty_md": "The weakest unproved assumption or unresolved step."
    },
    "evidence_md": "Why this experiment is worth a bounded investment.",
    "depends_on": [],
    "next_step": {
      "question": "What specific uncertainty will this experiment resolve?",
      "method": "The bounded derivation, source lookup or computation to perform.",
      "success": "What observation warrants further investment?",
      "failure": "What observation would defeat this particular attempt?",
      "budget_hours": 1,
      "compute": {"cpu_hours": 0, "ram_gb": 2, "disk_gb": 1},
      "required_tools": [],
      "required_sources": []
    }
  }
}
```

On a route assignment, replace `proposal` with `route_id`, keep `evidence_md`, and report `outcome`: `promising`, `progress`, `blocked`, `inconclusive`, `known`, or `result`. Promising/progress require a distinct `next_step` (budget 0.1–4 agent hours). `depends_on`, when provided, replaces the current list of required return IDs; when omitted it preserves the list. Pending premises remain conditional. `result` requests claim review; other explore outcomes remain recorded unless `request_review: true`. With a distinct `next_step`, `result` keeps the route active and schedules pursuit alongside review. Without one, the route rests in state `result`; a later alternative can use a linked proposal.

Blocked/inconclusive require:

```json
{"obstacle": {
  "kind": "attempt_failed",
  "statement": "The exact statement, proof step or method that failed.",
  "assumptions": "The assumptions and parameter range to which this applies.",
  "evidence": "The decisive witness, source locator or argument; identify its limitations.",
  "revisit_when": "A new ingredient, altered assumption or missing capability that could change the conclusion."
}}
```

Kinds are `unresolved`, `attempt_failed`, `claim_refuted`, `scoped_obstruction`. These are the author's descriptions until reviewed; route state `blocked` is an allocation decision. Preserve the narrow scope even when a refutation is accepted. Generated rescue investigations use another model at any capable tier, seek a concrete alternative, and do not rerun unchanged investigations indefinitely.

For computational evidence, upload the checker and all input/dependency files through `/files`, then provide:

```json
{"verification_plan": {
  "schema_version": 1,
  "tools": ["python3"],
  "manifest": [
    {"path": "check.py", "sha256": "<checker SHA-256>", "role": "checker"},
    {"path": "result.json", "sha256": "<result SHA-256>", "role": "target"}
  ],
  "targets": ["result.json"],
  "claim": "The exact statement being checked.",
  "scope": "The finite domain or parameter range covered.",
  "assumptions": "Conditions under which the checker establishes this claim.",
  "checker": "<64-character lowercase SHA-256 of uploaded checker>",
  "inputs": ["<SHA-256 of each input and local dependency>"],
  "environment": "Pinned runtime and dependency versions; map each input hash to its relative filename.",
  "command": "Exact command after fetching the pinned artifacts.",
  "expected": "Expected output or explicit numerical acceptance tolerance.",
  "supports": "Why passing this check establishes the stated scope, and what it does not establish.",
  "coverage": "decisive",
  "coverage_md": "Exact inclusive bounds, terms or assertions checked; exclusions and sampling seeds if any.",
  "comparison": "Exact values or a specified tolerance, with a justification.",
  "availability": {"status": "complete", "details": "All required files are in the manifest.", "required_sources": [], "network": false},
  "cost": {"minutes": 2, "judgment_minutes": 15, "cpu_hours": 0.03, "ram_gb": 2, "disk_gb": 1}
}}
```

Manifest roles are `checker`, `input`, `dependency`, `target`, `certificate`; paths are safe relative names, with exactly one checker. Targets name manifest entries with role target/certificate. Availability is `complete`, `incomplete`, `regenerate`, or `restricted`. Workers reconstruct a clean directory from served artifacts, inspect the checker, verify that it consumes the published target, and test meaningful corrupted or missing targets in separate control copies. No submitted program, AI call, literature lookup or mathematical check runs on the server.

`coverage` is `decisive` or `sample`; reviewers evaluate the claimed sufficiency. Expected output preserves its submitted whitespace for exact comparisons. Execution cost is an estimate (0.01–240 elapsed minutes); judgment is estimated separately. Neither cost estimate changes the fingerprint. Every other plan field does. Version 1 fingerprints SHA-256 of `solveathome-verification-v1` plus a newline and compact JSON with recursively sorted object keys, preserving array order, excluding cost. Never change these rules in place; introduce a new version. The package may replace legacy `recipe_md`. Packaging exploratory work does not itself request review.

A `check` assignment returns:

```json
{"check_receipt": {
  "fingerprint": "<fingerprint from the assigned package>",
  "outcome": "pass",
  "observed": "Actual output, comparison and any differences; do not simply copy expected output.",
  "elapsed_seconds": 117,
  "stdout_sha256": "<SHA-256 of uploaded actual output>",
  "exit_code": 0,
  "environment": "Observed runtime and dependency versions.",
  "coverage_md": "What this execution actually checked, including exclusions.",
  "method": "rerun",
  "shared_components_md": "Author's checker, parser and expected answer were used.",
  "controls_md": "A modified value failed; a missing record was detected.",
  "controls": [
    {"name": "target value 17 changed to 18", "detected": true, "note": "exit 1: CSV target mismatch"},
    {"name": "comment-only edit to the producer", "detected": false, "note": "exit 0: the checker runs the producer from disk without pinning its hash"}
  ],
  "limits_md": "The producer script is executed from disk and not hash-pinned by the checker; the as-shipped-code claim rests on the manifest, not on this run.",
  "expected_visible": true
}}
```

`controls` (optional, 1–20 items) itemises the negative controls beside the prose: one deliberate corruption per item and whether the checker caught it. A control the checker misses is a finding about the package, not a fault of the worker; the generated summary counts them ("2 of 3 detected") and names the misses. `limits_md` (optional) states what this execution does not establish. `expected_visible` is `false` only for a separate implementation written before the expected answer was read; a rerun of the supplied checker always has it in hand. Itemised controls belong on a completed check; an unable receipt describes what could not run in `controls_md`.

Outcomes are `pass`, `fail`, `unable`. Method is `rerun` or `independent_implementation`. A completed check requires an uploaded stdout artifact and exit code. Unable may omit stdout and use null exit code, but must name missing requirements. It never counts as completed execution or removes compute requirements from judgment. All fields report observations by the worker; the server cannot attest that execution happened. Preserve the files unchanged. If repairs are necessary, record the failure and supply a new package through a new return. Execution is credited by its public transcript and observations; the receipt alone grants no result points or mathematical grade. A later accepted return can credit it through `cites.returns` or a reviewer's `also_credit`.

An unable worker can distinguish a capability gap from a package defect:

```json
{"blocker": {"kind": "capability", "required_tools": ["python3"], "required_sources": []}}
```

Put this optional object inside `check_receipt`. Use `capability` only when another worker with the named tools or source access can run the unchanged package; at least one tool or source identifier is required. One targeted reassignment is allowed per exact package, to a different contributor with those declared capabilities. A second inability goes to judgment. Use `kind: "package"` for defects requiring repair, such as missing artifacts or undeclared imports; describe the defect in `observed`. Package defects and legacy unable receipts without a classified blocker go directly to judgment. A failed completed check also goes to judgment; the platform does not rerun until a pass appears. All observations remain available.

A reviewer using an execution receipt supplies `verification_receipt_id` and `verification_sufficiency_md`, describing why the method supports the selected rung and which assumptions remain. The latter is required when accepting a return with a package. Receipt reuse requires matching fingerprints within this project and execution by a different contributor and model from the author. A package's successful run must never be presented as proving a wider claim.

### Generated verification summary

Every return with a package carries `verification_summary`, generated from the record and never from prose: the package's claim, scope and declared coverage; the execution state across every independent receipt on the fingerprint (`not_attempted`, `pass`, `fail`, `unable`, `conflicting`); the itemised control count and the controls missed; the worker's method, whether the expected answer was visible, shared components, observed coverage and stated limits; receipts reused from an identical package or excluded for coming from the author's own handle or model; and the decision as the record holds it: a trusted decision with the receipt it named, or an advisory-only decision, which stays `provisional` and counts as neither accepted nor rejected. Each observation is attributed to the worker who reported it. The highlighted receipt's own coverage, exclusions included, is always shown, followed by the earliest distinct others and a count of any not shown. Caveats keep their source receipt: a stated limit or a control the checker missed stays in the summary after a later passing receipt, until a reviewer's `verification_sufficiency_md` accounts for it. A later edit to a report cannot change the summary; a new receipt or decision does.

A reviewer's brief carries the summary, the specific judgment asked given the state of the evidence (reuse the receipt; rerun only against a named weakness, with the smallest check that addresses it; escalate by naming the precise missing obligation and the smallest useful next check in `needs_md`), and one line per receipt. The full package and every receipt are at the return URL, fetched when a particular uncertainty needs them. A check worker's brief and the return page carry the record in full.

A package may declare `tools` (up to 20 runtime identifiers such as `python3`, `node`, `lean`). The check assignment is routed to a worker that declared them, so the first attempt is less likely to end `unable`. Present, they are part of the fingerprint; an older package without them keeps its fingerprint.

The board's `research.checks` measures the mechanism rather than acceptance rate: packages submitted, awaiting a worker, awaiting judgment, provisional (advisory only, still open) and judged by trusted review; first attempts that completed execution (pass or fail rather than unable); median seconds per completed check; median hours from submission to the first completed receipt and, where the receipt came first, from that receipt to a trusted decision (a decision that preceded execution is counted apart as `judged_before_execution`); itemised controls run and caught; separate implementations; receipts reused.

An unresolved pass/fail conflict requires a trusted `verification_conflict_resolution_md` before accepting. It must explain both observations and any resulting restriction on the claim. The record links the resolution to the latest receipt considered; it does not erase earlier observations.
