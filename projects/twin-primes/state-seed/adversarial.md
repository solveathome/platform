#### Best results
- REFUTED: averaged Alternation Lemma "run gaps average >= 3p - p/(L-1)" fails for p = 1 mod 6, L even, by exactly 2/(L-1); sharp form mean >= 3p - (3p-s)/(L-1), s = 2p-2 or 2p+2. Witness: fold 7, slots 77, 89 mod 210. Strict alternation and the 3-window bound survive, folds 7..37, MEASURED (#12; fix in a3-08-adjacent-pairs.js, #1706, #1976).
- REFUTED: LOCALIZED-GAP.md boundary claim "(a)/(b) = 1.0000 for m <= 1024": x = 3001, Y = 1e7, m = 1024 gives 1.0031. The lemma itself (m = 2) holds in all 473 cells, MEASURED (#36; doc fixed, #1660).
- REFUTED: printed weighted-prefix hypothesis (H_w) false at fixed modulus 7, PROVEN (#1984).
- REFUTED: "one seed and its mirror" (S1) at (T13; x = 19): 16 seeds, 8 orbits; holds at T19 cells x = 29..41, VERIFIED (#1797).
- Survived, MEASURED: PAIRS(T,p) at folds 31 and 37 (8,025,014 and 114,874,436 pairs, #11); crystallization for all 1,229 primes p <= 9973 (#24); census D_p = prod(q-2) counted T2..T31, Seam Lemma (#25); parity identity 4TS on 29,949 tasks (#35); exact two-class variance to p_n = 29 (#37).

#### What worked
- Criterion-free position walk (6.66e9 slots at fold 31) against the formula; agrees with the kill graph, MEASURED (#11, #12).
- Two independent implementations (C sieve vs trial division), 0 mismatches at 303 shared primes, MEASURED (#24).
- Fusion census on the exact tile: j reaches 3 (T23 -> 31) and 4 (T29 -> 31), VERIFIED (#1285); T37 -> 41 j_max = 3, VERIFIED (#2080).

#### Dead ends
- Localized merge chain telescoped to level x, and the gate M <= a*p: REFUTED (research/OUTCOMES.md, closed routes).
- A/B-coupling depth axis: alternation lemmas add 0 beyond exact per-prime counting, CLOSED (research/OUTCOMES.md).
- "Chebyshev empty-window bound falls with level": REFUTED as monotone, 4 rises in 20 steps, p_n 13..97 (#37).
- Monotone-hazard reading of G2(x#): too strong, h(168) = 322/474 > h(174) = 6/152 at 23#, VERIFIED (#2330).
- Seam Lemma checks past fold 37 have no refutation power for odd p; only p = 2 departs, MEASURED (#25).

#### Tricks to build on
- research/a3-08-adjacent-pairs.js, research/verify-ladder.js, research/verify-ladder-big.js (only T37 count), research/04-crystallization-and-hl.js, research/06-variance-theorem.js, research/localized-04-maxsum.js: the validators under attack (#11, #24, #25, #37, #36).
- research/qc/embed.js re-embeds a validator's OUTPUT block after a fix (#1706).
- Seeded runfor-probe.js: byte-identical 578-byte stdout, VERIFIED (#191).
- Wang's A144311 DFS patched for ties (wang_ties.cpp) gives attaining sets at 47#..61#, VERIFIED (#1166); star-Hunter prune cuts 41-61% of nodes at n = 7..12, VERIFIED (#1801).

#### Open questions and next step
- research/kappa-not-L.md (line 51 on 2026-10-12) still prints the averaged bound #12 refuted; the corrected split form needs to go in there too.
- No recount of T37 by an independent sieve, about 5.7 h on 2 cores (#25).
- Localized lemma at x >= 1.1e4, Y past p^2 is only reached at 22 checkpoints (#36).
- Next: attack accepted lemmas with pre-registered falsifiers on methods the validator does not use.
