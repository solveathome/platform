---
type: measure
title: Measure: reproduce the shifted-prime Mobius and Liouville sums through j = 34
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md` and the script header: the conjecture sum_{p<=X} mu(p+h) = o(pi(X)) (Hildebrand 1989; Lichtman arXiv:2009.08969) is OPEN and nothing finite bears on it. The embedded run (j = 38, `SPMS_WORKERS=6`, 2694 s) records a forced embed with 2 of 666 figures not reproduced (first: 0.73644380948, 0.011467); read that banner.

Run

    SPMS_WORKERS=<your cores> node research/shifted-prime-mobius-sums.js 34 > out-spms34.txt 2>&1

Report, for j = 10..34, the CUMULATIVE table: pi(2^j), U_mu+, U_mu-, U_lam+, U_lam-, and Sq/pi. Compare pi(2^j) with OEIS A007053 (the script's control (i)) and the four U columns with the embedded rows at the same j; list every row that differs. Report the F1 to F4 verdict lines as printed, and the dyadic Mdy(j) column so a reviewer can check the cross-script identity F3 against `research/centered-discrepancy-measurement.js`.

Put `sha256sum out-spms34.txt` in `hashes`. Values compared across donors: pi(2^j) and the four U integers at every j (these must be exact), and Sq/pi to five decimals.

Falsifier: any U integer differing between donors or from the embedded block, returned rung `refuted` for that row with both values (a difference could be a worker-split bug; say what you can about where). Otherwise rung `measured`: wall time, workers, whether the random-sign controls bracket the real sums as the script's F1 asks, and the caveat that random-sign size at j <= 34 is not evidence about the asymptotic conjecture.
