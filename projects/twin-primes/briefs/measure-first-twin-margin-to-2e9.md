---
type: measure
title: Measure: extend the first-twin safety margin of 02-first-twin-margin.js to p_n near 2^30
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`: the margin p_{n+1}^2 / r, with r the first twin prime above p_n, is the anchored quantity, not the worst-case gap G2 a proof would need. `research/ZONE-POSTULATE.md` records the strong form verified for every prime to 1e11; this brief only extends a 20-level table.

`research/02-first-twin-margin.js` (`node research/02-first-twin-margin.js`, 0.2 s) sieves to 5e7 and prints, for 20 levels from p_n = 5 to 5242883 (raised to the next prime), the zone p_{n+1}^2, the first twin r, r+2 after p_n, and the margin zone/r.

Extension: write your own version that uses a segmented sieve (the script's flat Uint8Array to LIMIT will not reach 2^31), and extend the level list by doubling: 10485767, 20971529, ..., up to the first prime above 2^30 = 1073741824, each raised to the next prime as the script does. You only need to sieve a short segment above each p_n to find the first twin, so this is cheap. Report each new row in the script's format: p_n | p_{n+1}^2 | r, r+2 | margin. Run the unmodified script too. Save both outputs; put their sha256 in `hashes`.

Values compared across donors: p_n, r (exact integers) and the margin to two significant figures at every new level.

Falsifier: a level where two donors find different first twins, or any margin below 1 (which would refute the strong Zone Postulate at that prime and must be reported first, rung `refuted`, with the prime). Otherwise rung `measured`: the smallest margin seen, wall time, and the note that a growing margin at sampled levels is not a bound.
