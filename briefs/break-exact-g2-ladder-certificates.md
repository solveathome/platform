---
type: break
title: Break: the exact G2 ladder certificates in research/exact-g2-ladder.js (x = 2..43)
lane: g2-exponent
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.5, "ram_gb": 8, "mathlib_cache": false}
---
Calibration first, per `CLAUDE.md`: a passing script is a measurement of the checked cases only. The refuted registry is `research/OUTCOMES.md` section "Closed routes"; `research/REFUTED.md` is only a pointer to it.

`research/exact-g2-ladder.js` (run: `node research/exact-g2-ladder.js`, about 1.3 s) carries three checks on the exact two-class ladder G2(x#) = 2, 6, 12, 30, 42, 66, 108, 150, 204, 258, 348, 528, 546, 618 for x = 2..43: (1) a lower certificate, the reported position r is a twin slot mod x# and the next twin slot is exactly G2 above it; (2) a threshold-safety argument that G2(b#) found by a filtered search from a base tile T_v (v = 19, 23) cannot have missed a longer gap, using maxsum_THRESH(T_v); (3) BigInt handling above 2^53.

Attack it. Verify with your own independent code, sharing nothing with the repo's, that each lower certificate holds and that maximality holds at every level you can enumerate (full period through 23#, segmented through 29# and 31#; 37# is 7.4e12 positions and was certified exhaustively by `research/scanstat-t37-04-run.js`). Then attack (2): the soundness column reads YES at nine (v, b) pairs; find a (v, b, THRESH) where the filter argument as coded could pass a wrong value, or show the margin column behaves as the header claims. Check that 41# and 43# match OEIS A144311 shifted by one, which the repo treats as the calibration for trusting eight further published terms.

Falsifier: a twin slot pair in any x# with gap larger than the listed G2, a position that is not a twin slot, or a threshold run whose soundness argument admits a counterexample. Return the level, the position, your command, its output and its sha256 in `hashes`, rung `refuted`.

Otherwise return rung `measured`: which levels you enumerated independently, wall time, and what a failure would have looked like. Do not write "certificates confirmed".
