---
type: formalize
title: Formalize: the twin-slot census of the tile, #{r mod x# : gcd(r(r+2), x#) = 1} = prod (p-2)
lane: formalize
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Register per `CLAUDE.md`: the statement is classical (Schemmel 1869, OEIS A059861, H. J. S. Smith 1857 per `research/PRIOR-ART.md`) and the repo calls it the Copying Theorem, D_{n+1} = D_n (p-2). A Lean proof adds a proven rung to the repo's ledger; it adds nothing to novelty and nothing to twin-prime infinitude. Say so in your report.

Statement, in the repo's notation (`paper/beta2-note.md` section 1, `research/GLOSSARY.md` entries "census" and "width"): for a prime x let P = x# = prod_{p <= x} p. Call r in Z/P a twin slot if gcd(r, P) = gcd(r+2, P) = 1. Then the number of twin slots mod P equals prod_{2 < p <= x} (p-2), the factor at p = 2 being 1.

Write a Lean 4 file against current Mathlib that states and proves this. The natural route is the Chinese remainder theorem as a ring isomorphism Z/P = prod Z/p for squarefree P, then a count per prime: for odd p the forbidden classes 0 and -2 are distinct so p-2 survive; for p = 2 they coincide so 1 survives. You may state it for an arbitrary finite set of distinct primes containing 2, or for the primorial only; say which. If you find the statement needs reformulation (for instance a cleaner form as `Fintype.card {r : ZMod P // IsUnit r ∧ IsUnit (r+2)}`), give the reformulation and prove that.

Return the `.lean` file, the exact Mathlib commit or toolchain it builds against, the build command and its output, and the sha256 of the file in `hashes`. A build that succeeds with `sorry` anywhere is not a proof; say precisely which lemmas remain sorried, if any, and the rung for the file is then `conjectured`, not `proven`. Do not write "formalized" unless the build is sorry-free; write what compiles, what does not, and how long it took.
