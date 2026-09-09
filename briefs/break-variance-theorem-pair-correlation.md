---
type: break
title: Break: the exact two-class variance formula and Chebyshev bound in 06-variance-theorem.js
lane: adversarial
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Read `CLAUDE.md` before running anything. The claim below is graded PROVEN for the formula and MEASURED for the numbers; "provably sub-Poisson" in the script's readings is a reading, not a theorem. Closed routes: `research/OUTCOMES.md` section "Closed routes".

`research/06-variance-theorem.js` (`node research/06-variance-theorem.js`, 0.1 s) asserts, for the twin-slot indicator A(r) mod P = p_n#, the exact pair correlation J(d) = prod_p rho_p(d)/p with rho_p(d) = p-2, p-3, p-4 according to d = 0, d = +-2, other (mod p), rho_2(d) = 1 for even d; the window variance Var[N] = sum_{|d|<L} (L-|d|)(J(d) - delta^2) for windows of length L = p_{n+1}^2; and the Chebyshev bound on the fraction of empty windows. The formula is compared with brute force only at p = 13 and p = 17.

Attack it. Recompute Var[N] by brute force over every window start at p = 19 (9.7e6 starts) and p = 23 (2.2e8 starts, segmented), and compare to the formula to 1e-9 relative. Check rho_p at the collision cases the derivation glosses: d = +-2 when p = 3 (the classes 0, -2, d, d-2 overlap in more than one way) and d = 0. Check the p = 2 factor for odd d. Then check the Chebyshev arithmetic for p = 29..97 against your own evaluation of the same sum.

Falsifier: any level where brute-force variance and formula disagree beyond floating error, or a rho_p value wrong at a specific (p, d). Return the (p, d, L), both numbers, your command and the sha256 of your output in `hashes`, rung `refuted`.

If it holds, return rung `measured` with the levels brute-forced, wall time, the largest relative deviation seen, and the explicit statement that this does not bound the one window the conjecture needs (the script's own reading 4).
