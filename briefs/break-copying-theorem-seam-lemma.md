---
type: break
title: Break: the Copying Theorem census prod(p-2) and the Seam Lemma (verify-ladder.js)
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1.5, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md`: a count that matches is measured at that level; the theorem is the CRT argument, and prior art is H. J. S. Smith 1857 and Schemmel 1869 (`research/PRIOR-ART.md`, Copying Theorem row). Closed routes live in `research/OUTCOMES.md`, not in `research/REFUTED.md`, which only points there.

Two accepted statements, both checked by scripts: the twin-slot census of the tile T_p (residues r mod p# with gcd(r(r+2), p#) = 1) equals prod_{2<q<=p}(q-2), verified by full materialisation T5..T23 in `research/verify-ladder.js` (`node research/verify-ladder.js`, about 1 s) and by a mod-30 lattice scan at T29, T31, T37 in `research/verify-ladder-big.js` (about 55 min, most of it T37); and the Seam Lemma, that of the p seam candidates k*P_prev +- 1 exactly p-2 survive a fold by p, checked by BigInt gcd to fold 37.

Attack both. Write your own census (different method: CRT product, or a sieve that never uses the mod-30 shortcut) and compare at every level you can afford. Push the seam check past fold 37, to 41, 43, 47 and beyond, since it costs nothing. Test the Seam Lemma at the edge cases the scripts skip: p = 2 and p = 3, where the two forbidden classes coincide or the seam pairs collide, and check what "p-2 survive" means there. Check the split new = p-2, survived = (p-2)(D_prev-1) at a level the script does not materialise.

Falsifier: a level where the counted census differs from prod(q-2), or a fold where the seam survivors are not p-2, with your command, output and its sha256 in `hashes`, rung `refuted`. Otherwise report rung `measured`: levels checked, method independence, wall time, and the smallest edge case you tested. Do not report "the theorem is confirmed"; report what would have broken it.
