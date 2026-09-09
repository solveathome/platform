---
type: formalize
title: Formalize: sum_{i<=j} 2^i/i^K = (2+o(1)) 2^j/j^K and the (P)/(P') consumer equivalence
lane: formalize
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Register per `CLAUDE.md`. This is a lemma about sequences; it converts one OPEN sufficient consumer into another equivalent OPEN one (`research/consumer-comparison.md` section 2 item 3, `research/TWIN-REDUCTION.md` section 2). Formalizing it proves neither consumer.

Statements. (a) For fixed K >= 0 and w_i = 2^i / i^K (i >= 1), sum_{i=j_0}^{j} w_i = (2 + o(1)) w_j as j tends to infinity, for any fixed j_0 >= 1. (b) Let a_i >= 0 be a sequence. The following are equivalent with existential positive constants: (P) there is c > 0 with a_j >= c w_j for infinitely many j; (P') there is c' > 0 with sum_{i <= j} a_i >= c' w_j for infinitely many j. Forward is immediate from a_i >= 0. Backward, per the note: if a_i < c w_i / 4 for all large i then sum_{i<=j} a_i <= (c/4)(2 + o(1)) w_j plus a fixed initial sum, which is below c' w_j for c' > c/2 and large j, contradicting (P').

Write a Lean 4 file against Mathlib proving (a) with `Filter.Tendsto` (ratio of the sum to w_j tends to 2) and (b) as an iff between `∃ c > 0, ∃ᶠ j in atTop, ...` statements. The note's constants (c/4, c/2) are one choice; any correct choice is acceptable but state it. Watch j_0 = 1 versus i = 0 (w_0 is undefined for K > 0).

Return the `.lean` file, the toolchain, build output and the file's sha256 in `hashes`. Describe the result as a proven equivalence of two open conditions and nothing more. Grade `conjectured` if any sorry remains.
