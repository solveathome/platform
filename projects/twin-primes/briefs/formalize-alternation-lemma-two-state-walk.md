---
type: formalize
title: Formalize: the Alternation Lemma for adjacent-kill runs (kappa-not-L.md)
lane: formalize
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Calibration per `CLAUDE.md`. The lemma is PROVEN in `research/kappa-not-L.md`; its language family is prior art (the B = 1 charge constraint, Marcus-Roth-Siegel section 2.3, per `research/SEARCH-CONVENTIONS.md` section 3). The route that used it is closed (L "has no law of its own", 2026-08-19). A Lean proof settles the rung of the lemma only.

Setting (`research/a3-08-adjacent-pairs.js` header and `research/kappa-not-L.md`). Fold a tile by the prime p: the kills are exactly the slots whose residue mod p lies in {0, -2}. Two consecutive slots at distance g are both killed iff both residues lie in {0, -2}, which forces g = 0, +2 or -2 (mod p). A run is a maximal sequence of consecutive killed slots. Alternation Lemma: along a run, read each gap's class in {0, +2, -2} mod p; from residue 0 only gaps of class 0 or -2 are legal and from residue -2 only 0 or +2, so the nonzero classes strictly alternate. Consequences the note draws: since gaps are multiples of 6 here (twin slots are 11, 17, 29 mod 30 for x >= 5), a class +2 gap and a class -2 gap are 2p -+ 2 and 4p +- 2 modulo 6p in some order and sum to 6p; L >= 3 forces some gap >= 4p - 2.

Formalize the core lemma abstractly: given a finite sequence of residues each in {0, -2} mod p and the differences between consecutive terms, the differences that are nonzero mod p alternate in sign (+2, -2, +2, ...). This is a statement about sequences in ZMod p with p >= 5 and needs no tile at all; prove it that way and say so. Then, if budget allows, prove the corollary about the minimum size of a class -2 or +2 gap that is also 0 mod 6, with the exact constants; if the constants in the note need adjusting, report the adjustment first.

Return the `.lean` file, toolchain, build output and sha256 in `hashes`. Grade `conjectured` if sorries remain.
