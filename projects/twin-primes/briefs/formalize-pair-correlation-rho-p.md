---
type: formalize
title: Formalize: the exact two-class pair correlation J(d) = prod_p rho_p(d)/p (06-variance-theorem.js)
lane: formalize
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Calibration per `CLAUDE.md`: this identity is graded PROVEN in the repo by a CRT argument and VERIFIED numerically at p = 13 and 17; `research/PRIOR-ART.md` calls the resulting variance formula "possibly novel as stated, on an uncalibrated search" (one-class versions are Hausman-Shapiro 1973 and Montgomery-Vaughan 1986). A Lean proof settles the proven rung, not the novelty.

Statement (header of `research/06-variance-theorem.js`): let P = p_n# and let A(r) = 1 if r mod P is a twin slot, meaning r mod p is not in {0, p-2} for every prime p <= p_n. For an integer d, the number of r in Z/P with A(r) = A(r+d) = 1 equals prod_{p <= p_n} rho_p(d), where for odd p: rho_p(d) = p-2 if d = 0 (mod p), p-3 if d = +-2 (mod p), p-4 otherwise; and rho_2(d) = 1 if d is even, 0 if d is odd. Equivalently the density J(d) = prod rho_p(d)/p.

Write a Lean 4 file against Mathlib that states and proves the count. Route: CRT as a product decomposition, then a per-prime count of residues avoiding both {0, -2} and {-d, -d-2} mod p, with the case split on d mod p. Take care at p = 3 with d = +-2 (mod 3): the four classes 0, -2, -d, -d-2 collapse further than the generic count and you must check that p-3 = 0 is what the formula gives and what the count gives. If the repo's statement is wrong at some small prime, that is a finding: report the discrepancy first, at rung `refuted` for the stated formula, and prove the corrected statement.

Return the `.lean` file, toolchain, build command and output, and the file's sha256 in `hashes`. State plainly whether the build is sorry-free; if not, list the sorried lemmas and claim rung `conjectured` for the file.
