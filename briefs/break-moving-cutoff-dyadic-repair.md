---
type: break
title: Break: the dyadic repair S = C2 x - 2 C2 M + D_y + O_A(x/log^A x) (moving-cutoff-validation.js)
lane: infinitude
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: the repaired identity is DERIVED and checked; the sufficient estimate D_y >= -4x/25 + o(x) on unbounded dyadic scales is OPEN and nothing here supplies it. A finite census to 2^38 (`research/centered-discrepancy-measurement.md`) refutes neither sufficient form. Read `research/OUTCOMES.md` "Closed routes" before proposing anything.

`research/moving-cutoff-parity.md` reads Murty and Vatwani (JNT 180, 2017), finds that the printed p. 654 divisor swap omits the condition n+h > ey, verifies the failure of that displayed equality with an exact finite counterexample, and derives a dyadic repair keeping the moving boundary: S(x) = C2 x - 2 C2 M(x) + D_y(x) + O_A(x/log^A x) with y = ceil(x^(12/25)), Q = floor(x/y), and a tolerance argument using C2 (1 - A2) > 33/200. `research/moving-cutoff-validation.js` (`node research/moving-cutoff-validation.js`, 1.2 s) checks the algebra as rational polynomials in formal prime logarithms.

Attack the repair. Rederive identity (12) of the note by hand and check every piece the measurement script `research/centered-discrepancy-measurement.js` prints as "IDENTITY (12) PIECES" (the residual r(x) must tend to 0; the embedded table has it at 9e-3 at j = 16 and falling). Verify the constant 33/200 from C2 = 0.66016... and A2 = 0.74791... and check which direction the inequality must run for -4x/25 to suffice. Run the validator with a deliberately wrong endpoint (drop n+h > ey) and confirm it fails; if it still passes, that is a finding.

Falsifier: an algebraic error in (12), a wrong constant, a validator control that does not fire, or a finite x where the exact pieces do not sum to S. Return it with command, output and sha256 in `hashes`, rung `refuted` for the stated identity. Otherwise rung `measured`: what you rederived, which controls you added, and wall time. Do not report the OPEN estimate as anything other than open.
