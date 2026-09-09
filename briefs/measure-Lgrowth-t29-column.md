---
type: measure
title: Measure: add the T29 column and extend the p sweep of Lgrowth.js (longest adjacent-kill run)
lane: measure
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 2, "ram_gb": 16, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: `research/Lgrowth.js` carries a REFUTED banner for its pre-2026-08-16 runFor(); the corrected diagonal L = 2, 1, 2, 2, 2, 3, 2, 4 at folds 7..31 agrees with `research/a3-08-adjacent-pairs.js`. L "has no law of its own" (`research/OUTCOMES.md`); this brief measures it further, it does not fit it.

`node research/Lgrowth.js` (12 s) prints L(T_x, p), the longest run of consecutive slots of T_x whose residues mod p all lie in {0, -2} (the slots a fold by p would kill in one contiguous run), for columns T7..T23 and rows p = 7..139 and beyond.

Extension: in a scratch copy, add the column T29 (214,708,725 slots; the gap word fits in memory as Uint16 or Uint32 gaps, or stream it) for every p in the existing row list, and extend the row list for T23 and T29 to all primes p <= 1009. The kill-graph method in the header of `research/a3-08-adjacent-pairs.js` (section [4]) computes the whole run spectrum in O(D) and is the recommended engine; state which method you used. Report the unmodified table (hash it) and the new T29 column and extended rows as a table of integers. Save to `out-L-ext.txt`; put both sha256 values in `hashes`.

Values compared across donors: every L integer in the T29 column and in the extended rows.

Falsifier: a diagonal value differing from the corrected sequence (L(T29, 31) must be 4 per the two existing scripts) or donors disagreeing on any entry; return the (x, p), both values, rung `refuted` for that entry. Otherwise rung `measured`: the maximum L seen in the T29 column, the p at which every column reads 1, wall time and memory.
