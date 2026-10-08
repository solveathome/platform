# Local acceptance-policy handoff

The patch permits one authenticated trusted contributor execution, including an approved author using the same model family, while retaining cross-family Tier 1/high statement and mathematical correctness review. It does not deploy anything, execute Lean, produce a proof, invoke a model, or promote historical receipts.

Base: `ee1f006bd9de106ac4c0cb3d71e111bc6d7922aa`, branch `codex/lean-trusted-execution`. All source work is confined to this checkout. The worker was requested as OpenAI `gpt-6.1-sol`/high; its served-model identity was not independently authenticated here.

## Scope

- `src/db/schema.sql`: additive nullable `verification_runs.execution_attestation`; eligibility, authority, immutable receipt/assignment snapshot and current-provenance predicates. Existing cross-family review predicates stay intact.
- `src/lib/verification.ts`: explicit versioned intake, authenticated ingress binding, artifact references, controls and limits; separate truthful `independent`, `execution_eligible` and `trusted_execution`; completion, reuse, conflict state, unable retry accounting and summaries consume eligibility. Legacy/unattested unable observations cannot suppress new authenticated checks or same-handle assignment. Substantive final correctness sufficiency is required for checked status.
- `src/lib/scheduler.ts`: approved same-human/same-family check eligibility; current provenance for completed-check judgment priority. Correctness review still requires another family.
- `src/lib/research.ts`: board completion/reuse timing metrics use the same Lean eligibility predicate. Raw historical observation totals remain historical totals.
- `src/lib/lean-verification.ts`: checked status requires current trusted execution plus substantive cross-family judgment; guidance requires both genuine Tier 1/high families to assess claim match, mathematical reasoning and assumptions.
- `src/routes/job.ts`: passes authenticated account/session context, rejects inadequate final proof sufficiency, refreshes review guidance through brief version 16.
- `src/lib/dump.ts`: exports current trusted execution state and screens attestation prose. Server attestations contain no session credential or attempt ID.
- `docs/research-process.md`: documents the separate execution contract, same-human operation, review obligations and invalidation. Generated receipt labels change; no frontend layout or publication flow changes.
- Tests: `tests/lean-same-user.test.mjs`, `tests/lean-verification.test.mjs`, `tests/paper-lean-list.test.mjs`, `tests/research-process.test.mjs`, `tests/research-format.test.mjs`, and new synthetic fixture `tests/fixtures/lean-execution.mjs`.

## Versioning and invalidation

New Lean check submissions explicitly require `check_receipt.execution_policy:"authenticated-contributor-v1"` and substantive `attestation_md`. The server creates its provenance record only after authenticating the account/session against its completed check assignment, current project authority and receipt contents. Completed observations also require uploaded structured Lean audit/axiom/proof evidence, itemised negative controls and explicit limits. Unable observations attest the blocker, not a run.

The mathematical `lean-comparator-v1` profile, statement binding, axiom allowlist and semantic package fingerprint remain unchanged. Execution provenance is separately versioned receipt evidence. An unchanged frozen package can receive a genuinely new receipt; changing its mathematical/executable content still requires a new fingerprint and the existing statement-review gates.

The nullable migration has **no backfill**. Historical observations and ordinary decisions remain recorded, but old receipts cannot become trusted executions just because their user gains approval or a reviewer accepts them. Old cross-family metadata can truthfully remain `independent:true` while `execution_eligible:false`. A new same-family authenticated run can instead be `trusted_execution:true`, `execution_eligible:true`, `independent:false`.

Bound receipt edits, changed assignment/model/effort, withdrawn returns, unavailable artifact references, revoked or replaced trust grants, reopened statement/correctness review and changed manuscript hashes remove the relevant eligibility. Exact original data restored under its still-current original authority can match its original snapshot again. Historical failures remain on the record; only currently eligible receipts participate in the current automatic execution conflict state, and reviewers must inspect excluded historical observations too.

A future coordinated deployment must apply the schema before the code using its new functions/column, update callers to the explicit receipt policy and authenticated `X-Session` flow, and reassess old packages under the new computed status. This local work does not rewrite historical acceptance grades, automatically requeue every old accepted package, or deploy the migration.

## Validation

- TypeScript: `npm run check` and `npm run build` passed on the final code. Build output is local ignored `dist/`, never deployed. `git diff --check` passed.
- Final unit suite: **226/226 passed**.
- Full DB regression suite on the final functional implementation: **355/356 passed** before correcting one synthetic response-shape expectation for the additive eligibility count fields. The corrected exact test then passed **1/1**. The entire suite was not rerun after that expectation-only correction. No unresolved test failures remain.
- After the final legacy-unable retry/assignment correction: the Lean provenance/status and scheduler suites passed **47/47** in a fresh isolated database; the full unit suite again passed **226/226**. The full DB suite was not rerun after that narrow correction.
- Earlier full DB run: **356/356 passed** before the final independent/eligibility API separation. The affected API/review/provenance/publication suites also passed **75/75** at that stage.
- Initial DB failures were corrected: one SQL parameter/column ambiguity, plain-package wording expectations, a legacy Lean fixture missing the new policy/provenance fields, and a publication test requiring both `DATABASE_URL` and `TEST_DATABASE_URL`. The final unit fixture was updated to use explicit execution eligibility rather than independence as completion authority.

Regression coverage includes: one approved author/same-family execution; same-human cross-family correctness review; rejection of same-family semantic self-approval; missing/forged ingress context and unsupported policy; no legacy promotion; evidence edits/removal; low effort; withdrawal; grant revocation/replacement; exact-package reuse; no second-family replay requirement; authenticated pass/fail conflicts; board metrics; substantive correctness review; existing strict statement/axiom/partial/stale/rejected status behavior. All mathematical workflow fixtures are synthetic; no Lean run or theorem is asserted by these tests.

DB tests used only dedicated PostgreSQL 16 cached-image containers with tmpfs storage, a random loopback port, and bounded memory/CPU/processes. Both owned containers were removed after their tests. Existing containers and services were not modified. Installed dependencies were reused without an install or global update; temporary local setup was removed after checks.

Final narrow DB command: `DATABASE_URL=<isolated URL> TEST_DATABASE_URL=<same isolated URL> node --import tsx --test --test-concurrency=1 tests/lean-same-user.test.mjs tests/paper-lean-list.test.mjs tests/scheduler.test.mjs`. The corrected sole response-shape test used `--test-name-pattern="itemised controls, stated limits and declared tools" tests/research-process.test.mjs`.


## Deployment and rollback review

No migration/deployment/push/merge/public upload occurred. The added column and SQL functions are idempotent and leave history untouched. Deploy schema before the new code; retain the attestation column on any code rollback to preserve audit history. Reverting to old code also restores old execution acceptance semantics, so it cannot be presented as preserving this new provenance policy. A fail-closed rollback should pause Lean execution/status decisions until an explicitly reviewed compatible version is restored; dropping audit evidence or backfilling legacy receipts is unnecessary.

Authority follows the existing active-project-role/researcher policy. `project_roles` has a primary key on `(problem_id,user_id)`, so the authority lookup has at most one grant row. Grant snapshots bind `role` and `granted_at`; revocation or a genuinely replacement grant fails the old binding. Researcher ownership takes precedence: revoking a role alone does not remove a contributor who remains the current researcher. Researcher-based authority follows the current ownership field, not a separate grant generation history. Model trust alone never grants execution authority.

## Limits

The server authenticates account/session provenance and binds the contributor's attestation; it does not authenticate physical computation, inference identity or the truth of mathematical reasoning. Model/effort metadata and execution observations still require substantive cross-family review against real harness/runtime/artifact evidence. The prose length guards are completeness checks, not semantic verification. No cryptographic runner attestation or platform execution service is added. Genuine future execution/model-review evidence must still be obtained through the supported authenticated workflow.
