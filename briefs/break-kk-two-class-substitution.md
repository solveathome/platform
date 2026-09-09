---
type: break
title: Break: the Kalmynin-Konyagin substitution G2(P(y)) >> y (ln y)^3 (lnlnln y)^2/(lnln y)^4
lane: g2-exponent
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md`: this is DERIVED here from a published construction, adversarially checked, NOT refereed, and it does not move the Zone Postulate's margin (x^2/(x ln^3 x) tends to infinity). Its remaining source dependency, Halberstam and Richert 1974 Theorem 2.2, is UNREAD at the page (`research/history/reviews-0907/12-halberstam-richert-second-access.md`). A separate source brief owns that page; this brief attacks the derivation.

`research/two-class-lower-bounds.md` section 4c substitutes Omega_p = {a_p, a_p - 2} into Kalmynin and Konyagin (Izv. Math. 88:2 (2024), arXiv:2302.00459) and claims the two-class lower bound for y >= y_0 = 10^134.1 with A = 4.05 and every implied constant set to 1. The producers are `research/attack-kk-substitution.js` (0.3 s) and `research/verify-kk-substitution.js` (3.5 s), the latter a brute-force check of Case 1's hypothesis at y = 200000, z_1 = 300, with zero counterexamples at z_0 = 100, 60, 45 and hundreds at z_0 = 30, 20, 10. The full write-up is `paper/kk-lower-bound.md`.

Attack it. Rerun both scripts. Then check the parts the finite test cannot see: that the band-2 device with M(f) = 2 really contributes +1 to the exponent when h_f = 0 makes Omega^II empty (the note says Case 2 quantifies over an empty set; verify that this does not also empty something needed), the condition A > 4 versus a draft's A > 3, the claim that band 2 is empty at y = 4001 for every A > 4, and the six asymptotic hypotheses that fix y_0. Recompute y_0 from the stated inequalities with your own code.

Falsifier: a hypothesis of Lemma 1 or Corollary 1 at kappa = 4 not met by the two-class substitution, a wrong exponent in the log ledger of section 4c, or a y_0 that differs from 10^134.1 by more than rounding. Return it with the display, the line, your arithmetic and hashes, rung `refuted`. Otherwise rung `measured`: which displays you re-read at source, which conditions you recomputed, and what stays unread.
