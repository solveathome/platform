---
type: break
title: Break: the two-sided parity identity 4TS = 4 P_odd P'_odd + (CS - AB) - 4 N_odd3 S (lane E)
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`. Lane E's two aggregate-constant-4 tests are CLOSED at every fixed u > 4 (`research/OUTCOMES.md`, 2026-09-08); the identity underneath them is exact and is what this brief attacks. No twin-prime conclusion follows from the identity either way.

`research/fold-arithmetic-bridge.md` (line 81) states, on a dyadic interval (X, 2X] with y = floor(X^(1/u)) and S the set of n with n(n+2) free of prime factors <= y: writing S = #S_X, A = sum lambda(n), B = sum lambda(n+2), C = sum lambda(n) lambda(n+2), T = number of twin primes, P_odd = #{Omega(n) odd}, P'_odd = #{Omega(n+2) odd}, N_odd3 = #{both Omega odd, max >= 3}, all over n in S_X, the denominator-free identity 4 T S = 4 P_odd P'_odd + (C S - A B) - 4 N_odd3 S holds, also at S = 0. `research/fold-arithmetic-bridge-validation.js` (`node research/fold-arithmetic-bridge-validation.js`, 1.2 s) checks it in BigInt on finite intervals; the note records that at u = 3 on (64, 128] the convention needs care.

Attack the conventions. Rederive the identity from lambda(n) = (-1)^Omega(n) and the definitions, and find where it needs T to count pairs with both n and n+2 prime and both in S_X (a prime in S_X must exceed y; what about n = 1 or n+2 = 2). Test with your own code at many (X, u), with y floor versus ceil, with the interval closed versus open at both ends, and at X so small that S_X contains n = 1. Check the claim "valid also at S = 0".

Falsifier: an (X, u, convention) where the identity fails with the definitions exactly as the note states them. Return the counts, command, output and sha256 in `hashes`, rung `refuted` for the stated form. If it fails only under a convention the note does not state, report that as a scope finding, rung `measured`, and say which convention is required. Otherwise rung `measured`: the (X, u) grid, wall time, and the edge cases tried.
