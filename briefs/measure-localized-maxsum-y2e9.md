---
type: measure
title: Measure: localized-04-maxsum.js at Y = 2e9, the maxsum_m ladder and R(1)/lnD
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.5, "ram_gb": 8, "mathlib_cache": false}
---
Calibration per `CLAUDE.md` and `research/LOCALIZED-GAP.md`: the merge chain is REFUTED; what survives is the growth law of maxsum_m (section 6) and the boundary check at ratio 1.0000. The R(1) ~ lnD reading is a measured law with a stated range [0.736, 1.170] over three decades; the sqrt(m) tail factor was REFUTED at seven exact levels (`research/OUTCOMES.md`). Report numbers at the new Y; do not extrapolate.

`research/localized-04-maxsum.js` takes Y as its first argument (`node research/localized-04-maxsum.js 1e9`, 60 s, embedded) and prints, at checkpoints x = 61, 127, 251, 499, 997, the twin-slot count below Y, D(Y), mbar, M = maxsum_1, R(1) = M/mbar, the EV-model comparison and a table of maxsum_m, strict (b) and buffered (c) values, window counts and argmax slot for m = 1..12, 16, 20, 24, 32, 48, 64, 96, 128, 192. The bitset requires Y + BUF + 66 < 2^32.

Run the embedded invocation first (Y = 1e9) and then `node research/localized-04-maxsum.js 2e9`. Report, for both Y and every checkpoint: the twin-slot count, D(Y), M, R(1), lnD, R(1)/lnD, and the maxsum_m column for m = 1..12, with the strict/buffered agreement noted. Save both outputs and put their sha256 in `hashes`.

Values compared across donors: twin-slot counts and every maxsum_m entry (exact integers) at both Y.

Falsifier: strict (b) and buffered (c) disagreeing at any m (the boundary question would then be nonempty and must be reported first, rung `refuted` for section 8's claim), or integer disagreement between donors. Otherwise rung `measured`: R(1)/lnD at each checkpoint for Y = 2e9, wall time, memory, and whether the new values sit inside the recorded range.
