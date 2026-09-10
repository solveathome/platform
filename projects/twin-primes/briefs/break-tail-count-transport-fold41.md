---
type: break
title: Break: the Tail-Count Transport inequality at fold 41 (attack-foldL-03-transport.js)
lane: g2-exponent
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 3, "ram_gb": 16, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`. The inequality is graded PROVEN (2026-08-19) and exact at folds 11 through 37; the fold recursion it lives in is CLOSED as a chained route in `research/OUTCOMES.md` ("chaining the Tail-Count Transport on the tile"). This brief attacks the inequality, not the closed chain.

`research/U-FRAME.md` section 11 states: folding T_x by q, the count of new windows with gap sum >= theta satisfies N_new(theta) <= (q-2) N(theta) + 2 sum_{L>=1} Q_L(theta), where Q_L(theta) counts old windows of L+1 gaps with sum >= theta whose L-1 interior gaps admit a legal walk on a 2-set mod q. The producer is `research/attack-foldL-03-transport.js`, run as `node research/attack-foldL-03-transport.js 23` (39 s, old tile up to 23). The note records the margin max N_new/RHS rising 0.888 to 0.948 across folds 17..37 and names fold 41 as "the cheap check" that has not run.

Do the check and try to break it. Build the gap word of T_37 (217,929,355,875 gaps; the segmented method of `research/verify-ladder-big.js` or the shard driver `research/scanstat-t37-04-run.js` shows how to stream it) or, if that is beyond your budget, T_31 (6.2e9 gaps), and evaluate both sides at fold 41 for a range of theta including theta = G2(41#) = 546. Also test the inequality at non-consecutive folds (T_23 folded by 31 or 37), which the transport statement does not restrict to the next prime.

Falsifier: any (x, q, theta) with N_new(theta) > (q-2) N(theta) + 2 sum Q_L(theta). Return the triple, both sides, your command, the output and its sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: the folds and theta ranges evaluated, the margin N_new/RHS at each, wall time and memory, and whether the margin trend continued.
