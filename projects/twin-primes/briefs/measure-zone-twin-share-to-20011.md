---
type: measure
title: Measure: extend the zone twin share of 01-zone-twin-share.js to p_n near 20011
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: the ratio's drift toward e^(2 gamma)/4 = 0.7930547... is a measured trend against a constant that is known-obscure prior art (Tafula arXiv:1508.05702, per `research/PRIOR-ART.md`). Report the numbers; do not write "converges".

`research/01-zone-twin-share.js` (`node research/01-zone-twin-share.js`, 1.2 s) sieves the window [1, p_{n+1}^2) by primes <= p_n and counts twin slots, comparing to the uniform expectation window * (1/2) prod_{2<p<=p_n}(p-2)/p, at 25 levels from p_n = 5 to 9973 (ratio 0.899 at the top).

Extension: in a scratch copy, add the levels p_n = 12007, 14009, 16001, 18013, 20011 (replace each by the next prime if not prime, as the script does for the sieve list; windows up to about 4.0e8 bytes as a Uint8Array, so 4 GB of RAM suffices). Report for each new level the JSON line the script prints: pn, pNext, window, cand, expect, ratio. Report the unmodified run's 25 lines as well. Save both outputs and put their sha256 in `hashes`.

Values compared across donors: cand (exact integer) and ratio (three decimals) at each new level.

Falsifier for the trend reading: a ratio at any new level above 1.0 or below 0.79 would contradict the script's reading 2; report it plainly if seen. Otherwise return rung `measured`: the five new ratios, wall time and memory, and the statement that five more points do not establish a limit.
