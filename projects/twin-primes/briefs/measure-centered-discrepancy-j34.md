---
type: measure
title: Measure: reproduce the centered prime-Mobius discrepancy D_y(x) through j = 34
lane: measure
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 2, "ram_gb": 8, "mathlib_cache": false}
---
Calibration per `CLAUDE.md` and the script's own header: this is a FINITE MEASUREMENT of D_y(x), M(x), W1(x) of `research/moving-cutoff-parity.md` (9), (13), (16) at x = 2^j; the sufficient estimate D_y >= -4x/25 + o(x) is OPEN and a finite table cannot support it, only refute it at a scale. The embedded run went to j = 38 in 8224 s with 8 workers; `research/RESEARCH-EXECUTION.md` section 4 says no further enumeration allocation exists in the repo's own campaign, so this donated run is outside that budget by construction.

Run

    node research/centered-discrepancy-measurement.js 34 > out-cdm34.txt 2>&1

(the embedded cumulative time to j = 34 is about 1600 s on 8 workers; the script fixes its worker count as min(8, cores - 2) with no environment override, so record your core count). Report, for every j from 16 to 34, the MAIN TABLE columns M/x, D_y/x, W1grid/x and Wend/x, and the IDENTITY (12) PIECES residual r(x), all to the printed precision. Report the pre-registered falsifier verdicts F1 to F4 the script prints. Compare each row with the embedded block (same j) and list any row that differs beyond the last printed digit.

Put `sha256sum out-cdm34.txt` in `hashes`. Values compared across donors: the support count and the number of odd squarefree e at each j (integers), and D_y/x to six decimals.

Falsifier for the OPEN form at these scales: D_y/x < -0.16 at any j >= 26 (the script's F1); report it first if seen. Falsifier for custody: an integer column differing between donors or from the embedded block. Otherwise rung `measured`: wall time, workers, memory, and the caveat that the D_y comparison is dominated by the classical term's slow convergence at these scales (`research/centered-discrepancy-measurement.md`).
