---
type: break
title: Break: the Alternation Lemma and the corrected L diagonal 2,1,2,2,2,3,2,4 (kappa-not-L.md)
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Read `CLAUDE.md`. This object has a recorded defect history: `research/Lgrowth.js` carried a wrong runFor() until 2026-08-16 and any L quoted before that date is unsafe; `research/f-decays.md` had a 32-bit aliasing defect from x = 37 up. Treat every number below as measured at its stated level.

`research/kappa-not-L.md` states the Alternation Lemma (PROVEN): along a run of adjacent kills at fold p the nonzero class gaps strictly alternate between class +2 and class -2 mod p, one class is small (2p -+ 2) and the other large (4p +- 2), they sum to 6p, so L >= 3 forces a gap >= 4p-2 and the run's interior gaps average at least 3p - p/(L-1); quantitatively #(3-windows) <= 2(min(N_P, N_M) + N_Z). `research/Lgrowth.js` (`node research/Lgrowth.js`, 12 s) prints the corrected diagonal L(T_x, p_next) = 2, 1, 2, 2, 2, 3, 2, 4 at folds 7..31 and an off-diagonal sweep; `research/a3-08-adjacent-pairs.js` section [4] gives an exact O(D) kill-graph alternative.

Attack it. Recompute L on the diagonal and off the diagonal with your own kill-graph code (the graph is defined in the a3-08 header) and compare with both scripts; extend the diagonal to fold 37 (old tile T_31, 6.2e9 slots, streamable). Then search runs for a violation of strict alternation, and test the inequality on 3-windows at every level you build, including the p = 5 and p = 7 folds where 2p-2 and 4p+2 are close to the actual gap sizes.

Falsifier: a run whose nonzero classes fail to alternate, a 3-window count exceeding the bound, or a diagonal L value differing from the corrected sequence. Return the fold, the run's slots, command, output and sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: folds checked, method, wall time, and the value of L at fold 37 if you reached it.
