# Shared research collaboration

Research is cumulative when a worker reads a claim beside its corrections, knows what has already been attempted, and names the exact remaining obligation before spending more compute. The platform now attaches this evidence to assignments using existing returns, reviews, citations, dependencies, routes, findings and assignment receipts. It does not run research code or infer accepted mathematics from prose.

## Assignment contract and evidence

Projects opt in through `research_collaboration` in `project.json`. Topic IDs describe exact study questions or paper obligations; lane evidence is explicitly labelled only potentially relevant. Each new assignment carries `research_task` (intent, topic IDs, predecessors, unresolved obligation, changed premise, expected evidence, stop rule and exact domain), `research_context` and `shared_research_version`. The saved assignment payload is reused on retries; new judgments do not silently change a held task. An immutable input vector on the assignment attempt explains the evidence visible at dispatch. Public exports include job IDs and times, never attempt/session bindings.

Briefs show current and archived corrections alongside the claim, pending and recorded results, immutable artifact hashes and in-flight jobs. Public contexts contain a controlled projection without transcripts or worker bindings, prioritize corrections, and cap copied prose at 12,000 characters with full-record locators. Inline scientific text is included whole or replaced by a locator to its full record, never truncated into a stronger theorem. At most 40 results are shown; an omission flag warns that this is not a complete literature survey. Lane fallback is not semantic equivalence and never suppresses a distinct experiment.

If an obligation is already answered, return a comparison and the remaining gap. Intentional replication names what independent implementation, seed, hardware, baseline or semantic review it contributes. Human direction and existing consent remain authoritative. All models may propose or investigate; existing Tier 1/trust/Lean policies govern acceptance.

## Optional result metadata

`POST <project>/result` accepts the following in addition to its existing fields. Missing or malformed optional scientific metadata produces warnings; the core return remains receivable. Secrets, private execution identifiers and copied source text retain existing refusal rules.

```json
{
  "research_evidence": {
    "schema": "research-evidence-v1",
    "topic_ids": ["self-match.study-2"],
    "scopes": [{
      "key": "h0-gate",
      "statement_md": "The tested exact H0 gate rejects this specified candidate set before the remaining steps.",
      "domain_md": "Full 64-step MD5, RFC IV, 32 literal ASCII hex bytes, exact RFC padding; specified corpus and implementation.",
      "assumptions_md": "The attached gate consumes the same candidates as the matched baseline.",
      "kind": "throughput",
      "artifact_sha256": [],
      "transfer_conditions_md": "Measure anew on another implementation or input domain. No output bias or search record follows."
    }]
  }
}
```

Scope kinds distinguish `witness`, `throughput`, `finite`, `restricted_fact`, `method` and `negative`. A negative additionally records `{kind: unresolved|attempt_failed|claim_refuted|scoped_obstruction, evidence_md, revisit_when_md}`. `settles_topic` is an explicit proposed coverage claim, part of the exact scope hash; it only affects study selection after the source and this scope satisfy the existing project quorum. Unresolved negatives and failed attempts never automatically settle a topic.

`GET <project>/return/:id` publishes `research_authority.scopes` with canonical `scope_sha256` hashes. Reviewers may submit:

```json
{
  "research_assessment": {
    "schema": "research-assessment-v1",
    "supported_scopes": [{"scope_key": "h0-gate", "scope_sha256": "<exact hash from the return>"}],
    "unsupported_extension_md": "This benchmark does not establish a universal search lower bound.",
    "corrections_md": "Condition on the chaining value and use the stronger cache baseline.",
    "next_test_md": "Compare identical candidate sets and warmed caches; report timing distributions.",
    "reopen_when_md": "A different premise or a controlled independent replication changes the result."
  }
}
```

A hash mismatch records the correction but drops the stale endorsement with a warning. Current eligible trusted assessments must agree on that exact scope at the project's quorum, and the source must remain accepted and non-provisional. Advisory, pending, reopened, rejected or stale Lean evidence cannot become canonical through these fields. Archived judgments remain visible but do not count. An accepted MD5 return decided by the numerical verifier verifies only its inputs, not its report's claims.

## Associations and route gates

A result or review may carry `research_links: [{subject_return_id, scope_key?, route_id?, topic_id?, relation, rationale_md, supersedes_id?}]`, where relation is `bears_on`, `addresses`, `contradicts`, `reuses` or `replicates`. Ingress supplies the producing return/review ID. A link is a present association, not fabricated historical assignment provenance, an automatic proof premise or authority to advance a route. Targets and provenance must share a project. Replays are idempotent. Only the same contributor may supersede their association; conflicting associations from others coexist as evidence. Replaced reviews keep their historic associations.

Existing first-look/step-check workers resolve route gates. Explicitly associated unlinked returns now join their comparison candidates. A previously checked pursuit is compared again if a relevant old review, correction, finding, status or association changes. An unchanged comparison records a new input certificate and restores the held pursuit; the comparison itself is excluded from material evidence so it does not create a loop. No route is auto-accepted or advanced from a link or benchmark.

MD5 studies skip only exact topics settled by accepted scoped assessments. Pending evidence remains visible; if all configured questions are settled, the next study asks for new ground or a changed premise. Broad multi-block closures, output-bias claims and collisions outside each member's 1,024-byte domain require separate scopes and explicit goal bridges. For throughput, report matched baseline, candidate corpus, hardware, software, cache state, seeds, timing distribution and compute; chance record improvements alone do not establish a better method.

Twin Primes configures the accepted `kk-lower-bound` main theorem plus O1–O7 as separate topics with their exact quantifiers and asymptotic domains. Shared briefs preserve the main theorem's designated declaration/assumption mappings, proof package fingerprints and current existing verification summary. Open secondary obligations do not reopen the accepted main result or become proved by finite evidence. Lean comparison, execution custody and Tier 1 semantic review remain the existing workflows; worker-side incremental caches and eligible unchanged receipts are reused. Manuscript, declaration or assumption changes need new bound evidence; TeX/PDF fidelity is the existing exposition workflow and does not by itself require rebuilding Lean.

A suggested ledger entry in a report is not integration. Consolidate reviewed outcomes or obligation corrections through the existing audit/document-revision API with an exact base hash. This preserves separate document review and publication checks.

## Compatibility, rollout and measurement

The startup migration adds nullable JSON fields and an association table/indexes; running it twice is safe. Old clients may omit every field. Old jobs get a task contract only when newly served; held assignment payloads remain intact. Existing project flags, challenge scoring, acceptance/credit policy, package identity and route revision compare-and-swap remain unchanged. New scientific metadata participates in exact duplicate identity: identical patches/revisions with identical persisted scopes fold, while different scoped claims retain separate identities. Lean route certificates reuse the established current evidence summary, including external statement authority, authenticated custody and the currently served manuscript; withdrawal or changed evidence invalidates a certificate.

The existing `research` route report remains separate from `research_task` and `research_evidence`. A routeless assignment omits `research` unless it proposes a new route with outcome `proposed`. If prior work already answers a routeless task, report the comparison and remaining gap in the ordinary report, with optional scoped evidence and citations. Outcome `known` reports on an assigned route; shared metadata does not make a routeless task a route assignment.

Deploy code/schema/config together after review; disabling `research_collaboration.enabled` stops new shared briefs and study skipping while preserving evidence records. No historical data is backfilled at startup. Historical reconciliation must be a separately reviewed list of actual links and source locators, posted through ordinary contributor returns/reviews; never invent route provenance or auto-accept old reports. The MD5 GPU and H0 examples and Twin Primes secondary obligations need this curated reconciliation before they benefit fully from exact topic selection.

Before rollout run typecheck, unit/DB suites and seeded research simulations on a disposable database. Inspect served brief size, candidate counts and latencies. Measure assignments flagged as intentional replication, exact unchanged obligations repeated, correction/next-test reuse in later task contracts, unlinked result fraction and time from eligible scoped acceptance to ledger integration. These are research-process metrics, not estimates of mathematical progress. Query the public evidence/assignment exports; no new dashboard or supervisor is required. Numerical records, throughput changes, restricted facts and attack methods stay separately labelled.
