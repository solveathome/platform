---
type: measure
title: Measure: extend the two-class discrepancy table of discrepancy-two-class.js to x = 31
lane: measure
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md`. This script carries a correction banner (`research/SCRIPTS.md` lists it) and its Part A custody gate found two one-unit typos and one digit typo in Holt's Table 2 (arXiv:2308.07570), recorded in `research/PRIOR-ART.md`. Any twin-specific discrepancy law is REFUTED (`research/OUTCOMES.md`, 2026-08-17). This brief extends a table; it does not reopen the law.

`research/discrepancy-two-class.js` (`node research/discrepancy-two-class.js`, 13 s) reproduces Holt's one-class DeltaPhi extremes for x = 5..29 (Part A) and computes the two-class analogue DeltaPhi_2(y, x) = Psi(y, x) - (D_x/x#) y, with Psi the twin-slot count below y, for x = 5..29 (Part B): max, min, range, rising zeros and their share.

Run the unmodified script and record Part A's verdict line and the full Part B table. Then, in a scratch copy, add the level x = 31 (period 200,560,490,130) to Part B, using a segmented walk that carries the running count across segments (the repo's `research/verify-ladder-big.js` shows the mod-30 stride trick; the sign of DeltaPhi_2 needs the exact running Psi, so keep it in an integer or BigInt). Report the x = 31 row: x#, D_x, mu_2(x), max DPhi_2, min DPhi_2, range, rising zeros, share. Save both outputs; put their sha256 in `hashes`.

Values compared across donors: D_31 = 6226553025, the rising-zero count (integer), and max/min DPhi_2 to four decimals.

Falsifier: the unmodified run failing its own custody gate, or donors disagreeing on the x = 31 integers. Return the disagreement rung `refuted` for that row. Otherwise rung `measured`: the x = 31 row, wall time, memory, and the explicit statement that one more level does not change the refuted status of any growth law.
