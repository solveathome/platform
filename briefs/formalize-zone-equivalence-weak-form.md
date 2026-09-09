---
type: formalize
title: Formalize: the weak Zone Postulate is equivalent to infinitely many twin primes
lane: formalize
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Register per `CLAUDE.md` and `research/PRIOR-ART.md`: this biconditional is "possibly novel as stated, logically lightweight" and is to be presented as a framing device, not a result. Formalizing it proves an elementary equivalence; it says nothing about whether either side is true.

Statement (`research/ZONE-POSTULATE.md` sections 1 and 2). For a prime p let p' be the next prime. The zone of p is the open interval (p, p'^2). Say the zone of p is occupied if there is a twin prime pair (r, r+2), both prime, with p < r and r+2 < p'^2. Weak Zone Postulate: infinitely many primes p have an occupied zone. Claim: the weak form holds iff there are infinitely many twin primes.

Forward: occupied zones give pairs above p, and p ranges over an infinite set, so the pairs are unbounded. Backward: given a twin pair (r, r+2) with r > 3, let p be the largest prime below r; then p' = r and r^2 > r+2, so the pair lies in the zone of p; infinitely many pairs give infinitely many distinct p.

Write a Lean 4 file against Mathlib proving both directions. You will need `Nat.exists_infinite_primes` or `Nat.nth` for the next prime, and a definition of "next prime after p"; state your definition explicitly and note if the repo's p' (next prime) differs from Mathlib's conventions. Watch the small cases: the note excludes r <= 3, and the backward direction must handle the pair (3, 5) or exclude it explicitly. The claim "infinitely many" should be formalized as `Set.Infinite` or `∀ N, ∃ p > N, ...`; say which.

Return the `.lean` file, the toolchain, the build command and output, and the sha256 in `hashes`. If any step is sorried, list it and claim rung `conjectured` for the file; otherwise `proven` for the equivalence only. Do not describe this as progress on the conjecture.
