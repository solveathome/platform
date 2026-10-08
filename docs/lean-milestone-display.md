# Main theorem display

The paper’s Lean panel names exactly which claims have current checked evidence, the immutable package fingerprint and manuscript/statement binding, and links the execution return, statement review and mathematical correctness judgment. Historical evidence remains visible without counting toward a current milestone. The project page uses the same resolver through the existing uncached paper JSON. Cached project HTML carries candidate paper slugs only, never a positive verdict. Each 30-second refresh clears earlier callouts, uses no-store reads with fresh request echoes, and rejects failed, stale or out-of-order responses. An unavailable refresh shows no verification badge. Removing config, revoking execution authority, or reopening or invalidating a review is re-evaluated by the next uncached read. A newly added candidate becomes visible when the cached project page refreshes. Existing assignment activity remains live/recent/stale according to actual session and assignment records; the board links recorded returns.

“Main theorem verified in Lean” requires an explicit main-claim designation in maintainer-controlled `projects/<slug>/project.json`, plus an accepted, nonprovisional package for the served manuscript, complete checked claim coverage with no declared assumptions, current authenticated trusted execution and current independent statement and substantive correctness/receipt reviews. A designation does not supply or grant any of those checks. Partial, conditional, helper-only, pending, revoked-execution, conflicting and stale evidence, or reopened or ineligible reviews, never produces the badge.

No project is configured by this change. Before activation, the maintainer must review the exact main-claim designation and its exclusions, then change project config through the normal platform review/release process. Contributor returns, manuscript text, registry grades, approval booleans and claimed approver IDs cannot create a designation. The server reads config from its deployed platform directory; contributor revisions write only the research overlay. The operator must keep that configuration under maintainer control.

The optional `lean_main_theorems` array contains entries with exactly these fields:

- `paper_slug`: registered paper slug.
- `manuscript_sha256`: exact served manuscript hash.
- `statement_binding`: exact reviewed Lean statement binding.
- `required_claim_ids`: nonempty unique list of approved main-claim IDs, all fully checked in one eligible accepted package.
- `unproved_claims`: explicit unique `{id, locator}` exclusions that the maintainer reviewed against the manuscript. No main ID may also appear here. Counts and mathematical obligations are never inferred from a title or declaration name.

Missing, malformed, ambiguous or version-mismatched designation fails closed. Any manuscript or statement-binding change needs a newly reviewed designation. Without an explicit designation, checked helpers remain ordinary scoped Lean evidence. Unmapped claims are not verified by a package; the manuscript remains the source for remaining obligations. A badge proves neither the entire paper nor the project’s overall conjecture. The server authenticates account/session attestation and eligibility, not physical computation or model reasoning.

This is a read-only display contract. It changes no proof policy, intake, scheduler, trust grants, review decision or execution gate; it requires no database migration. The supplemental receipt/review pointers are derived on each read and are not stored authority. Remove the optional config entry to withdraw a designation without erasing historical evidence.

Accepted review decisions and stored trusted flags retain the existing policy when a contributor grant is later revoked; the display does not erase every historical final review. Same-person cross-family review still requires current approved membership. Current execution authority and review reassessment/eligibility are resolved through the existing verification predicates.
