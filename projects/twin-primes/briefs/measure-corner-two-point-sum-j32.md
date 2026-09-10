---
type: measure
title: Measure: reproduce the corner two-point sum K(x) through j = 32, five variants
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.3, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: `research/corner-measurement.md` records this as MEASURED at x <= 2^36 over 1.3e9 integers, |K|/mass falling no faster than the random-sign null in all four variants (largest deviation 1.4 s.e.), K never below -C2 x, and the actual right prime band holding at most one prime at every reachable x. That last fact is the reason the corner is nearly empty at these scales, and it is a limitation of the measurement, not a result.

The script takes JMAX as its first argument (`node research/corner-measurement.js`, default 36, embedded 1393 s). Run

    node research/corner-measurement.js 32 > out-corner32.txt 2>&1

Report, for each variant A-eta100, B-eta40, C-dyadic, D-scaled, E-empty and each j from 20 to 32, the columns pairs, count, mass, K, |K|/mass, K/(C2 x), randMean, randSd, theorySd. Compare against the embedded rows for the same j and list differences beyond the printed precision. Variant E is the control with the r band forcibly emptied; report that its K is 0 at every j.

Put `sha256sum out-corner32.txt` in `hashes`. Values compared across donors: pairs and count (integers) and K to the printed precision, at every (variant, j).

Falsifier: any integer disagreement, or K < -C2 x at some j (report that first, rung `refuted` for the note's "never below" statement at that scale). Otherwise rung `measured`: wall time, memory, and a one-line statement of why the empty rows at j = 20..22 and 32..33 in variant A occur (the prime band (Z, Z^(1+eta0)] holding no prime), read from the rband column, not inferred.
