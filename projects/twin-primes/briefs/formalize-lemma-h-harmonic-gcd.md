---
type: formalize
title: Formalize: Lemma H of structured-dispersion-estimate.md (harmonic gcd average, prime-power factor)
lane: formalize
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 2, "ram_gb": 8, "mathlib_cache": true}
---
Calibration per `CLAUDE.md`. Lemma H is elementary, DERIVED in the repo, read by two readers and checked on 62832 finite configurations. It feeds a regional block bound (D1); it supplies no signed margin and no twin count. Formalizing it fixes the rung of one lemma.

Statement (`research/structured-dispersion-estimate.md` section 4, inequality (2)). Let q = p^k be a prime power, l_1, l_2 >= 1 coprime integers, A >= 1 real, H a subset of the integers in (A, 2A] or [A, 2A]. For h_1, h_2 in H put R = h_1 l_2 - h_2 l_1 and read gcd(0, q) = q. Then

sum_{h_1, h_2 in H} gcd(R, q)^(1/2) gcd(h_1, l_1)^(1/2) gcd(h_2, l_2)^(1/2) <= (k+1) tau(l_1) tau(l_2) [4 A^2 + 2^(3/2) A^(3/2) q^(1/2)],

where tau is the divisor-count function. The proof bounds gcd(R, q)^(1/2) by sum_{i <= k} p^(i/2) 1_{p^i | R}, similarly for the other gcds via divisors, then counts pairs (h_1, h_2) with d_1 | h_1, d_2 | h_2, p^i | R: since l_1 or l_2 is invertible mod p, h_2 lies in one class mod lcm(d_2, p^i) for each h_1, giving at most 2A/max(d_2, p^i) + 1 solutions.

Write a Lean 4 file against Mathlib. This is a real formalization job: square roots over ℝ, divisor sums, and an interval counting lemma. The constants 4 and 2^(3/2) come from crude bounds and you may find the proof gives something slightly different; if the stated constants do not follow from the stated proof, report that first, state what does follow, and prove that. State whether you took H as an arbitrary `Finset ℕ` inside the interval.

Return the `.lean` file, toolchain, build output and sha256 in `hashes`. If sorries remain, list them and grade the file `conjectured`.
