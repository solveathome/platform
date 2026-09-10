---
type: break
title: Break: Lemma H, the harmonic gcd average with a fixed prime-power factor (inequality (2))
lane: infinitude
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md`: Lemma H and the block bound (D1) are accepted at stated scope after two readings (2026-09-09, `research/research-round-validation.md` section 10). They control a strip of the residual domain; the target box stays at exponent 407/400 and the signed margin is OPEN. Nothing you find here changes that unless the lemma is false.

`research/structured-dispersion-estimate.md` section 4 states and proves: let q = p^k be a prime power, l_1, l_2 >= 1 coprime, A >= 1, H a subset of the integers in (A, 2A] or [A, 2A]; for h_1, h_2 in H put R = h_1 l_2 - h_2 l_1 and read (0, q) = q; then sum_{h_1, h_2 in H} (R, q)^(1/2) (h_1, l_1)^(1/2) (h_2, l_2)^(1/2) <= (k+1) tau(l_1) tau(l_2) [4 A^2 + 2^(3/2) A^(3/2) q^(1/2)]. The validator `research/structured-dispersion-estimate-validation.js` (`node research/structured-dispersion-estimate-validation.js`, 1.4 s) reports the lemma exact on 62832 configurations and six negative controls firing.

Attack it. Write an independent evaluator of the left side (exact integers, sqrt taken at the end) and search configurations the validator does not cover: A = 1 and A = 2 with H the full interval, q much larger than A^2 (where the second term should dominate), q = p with k = 1 versus q = p^k with large k, l_1 or l_2 divisible by p (the proof splits on this), and H a sparse subset chosen to concentrate h_2 in one residue class mod p^i. Track the ratio LHS/RHS and report its maximum.

Falsifier: any configuration with LHS > RHS. Return q, l_1, l_2, A, H, both sides, command, output and sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: the configuration grid, the largest ratio found and where, wall time, and which step of the proof (the count of h_2 in one class mod lcm(d_2, p^i)) you checked against enumeration.
