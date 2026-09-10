---
type: measure
title: Measure: reproduce the segmented mixed super-W triple census at @29 and @31
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.3, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md` and `research/G2-STATE.md` (MEASURED block): the closed form 1 - J = 4 sum_{x<q<=sqrt W} q^(-2) is "the last law standing" after two pre-registered rivals died, and it is "not exact", carrying a -0.41% to -0.48% offset at both new levels. The registered sigma_J is a Poisson floor on the triple count and understates by about 2.1 because the census walks slots; both sigmas are printed. Reproduce; do not reinterpret.

Run

    node research/xchan-at29-01-segmented.js > out-xchan.txt 2>&1

(embedded elapsed 450 s, memory 118 MB of arrays). The pre-registration is `research/history/staging/xchan-at29-prereg.md`; the levels are 11, 13, 17, 19, 23, 29, 31.

Report verbatim, for each level: N-bar counted and the formula value with PASS/FAIL, B_3 from the (a, b) counts, the SUB-W and SUPER-W observed triple counts, the joint deficit J and 1 - J, the registered sigma_J and the slot-clustered sigma_J, and the "GATE vs natal-cap-39" line. Then report the @29 and @31 closed-form comparisons the script prints (1 - J against 4 S_2 and the z-scores on both sigmas). Put `sha256sum out-xchan.txt` in `hashes` and record whether `node research/qc.js embeds` reports the file's static hashes intact.

Values compared across donors: every integer count (N-bar, B_3, triple counts) at every level, and J to six decimals.

Falsifier: an integer count that differs between donors or from the embedded block, returned rung `refuted` for that level with both values. Otherwise rung `measured`: wall time, memory, and the explicit caveat that the offset's sign and size are measured at two levels and no mechanism for it is established (TODO item X remains conditional).
