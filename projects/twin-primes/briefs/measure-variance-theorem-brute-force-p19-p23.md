---
type: measure
title: Measure: brute-force the two-class window variance at p = 19 and 23 and extend Chebyshev to p = 199
lane: measure
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 2, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md`. Var/E[N] values are measured; the "4 to 5 times more uniform than random" reading in the script is a reading. The Chebyshev bound on empty windows is a per-level verifiable computation and says nothing about the one window the conjecture needs.

`research/06-variance-theorem.js` (`node research/06-variance-theorem.js`, 0.1 s) compares the exact variance formula Var[N] = sum_{|d|<L}(L-|d|)(J(d) - delta^2) with brute force over all window starts at p = 13, 17 only, then tabulates E[N], Var, Var/E[N] and the Chebyshev empty-window bound for p = 13..97 with L = p_next^2.

Extension: copy the script to your scratch space (do not edit the repo file) and (1) add brute-force rows at p = 19 (period 9,699,690) and p = 23 (223,092,870; use a segmented pass with a rolling window count), (2) extend the Chebyshev table to every prime p <= 199. Report, to the printed precision of the original: for p = 19 and 23 the brute variance, the formula variance and their relative difference; and for each new p in 101..199 the values L, E[N], Var, Var/E[N] and the empty-fraction bound. Save stdout to `out-06-ext.txt` and put its sha256 in `hashes`. Also run the unmodified script and hash its output for custody.

Values compared across donors: the brute variances at 19 and 23 (must agree to 1e-9 relative), the Var/E[N] column at p = 101..199 (to three decimals), and the bound column.

Falsifier: brute force and formula disagreeing beyond floating error at 19 or 23, returned rung `refuted` with both numbers. Otherwise rung `measured`, with wall time, the largest Var/E[N] seen and a one-line statement of what the extension does not show (asymptotics, or anything about the zone itself).
