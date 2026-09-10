---
type: break
title: Break: the exact adjacent-kill pair count PAIRS(T,p) in a3-08-adjacent-pairs.js
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 2, "ram_gb": 16, "mathlib_cache": false}
---
Register per `CLAUDE.md`: exact counts that match at seven folds are verified at seven folds. The statement is PROVEN in the script's header by a one-line criterion plus a multiplicity argument; the operator it belongs to is prior art (Holt and Rudd 2014 section 5, per `research/U-FRAME.md` section 11).

`research/a3-08-adjacent-pairs.js` (`node research/a3-08-adjacent-pairs.js`, 90 s) asserts: folding T_x by p, consecutive new slots at distance g are both deleted iff g = 0 or +-2 (mod p); each old gap with g = 0 (mod p) is realised as a double kill in exactly two copies and each with g = +-2 (mod p) in exactly one; hence PAIRS(T, p) = 2 sum_{d = 0 mod p} count(d) + sum_{d = +-2 mod p} count(d) over the gap histogram of T. Predicted and enumerated agree at folds 7 through 29.

Attack it. Enumerate at fold 31 (old tile T_29, 214,708,725 gaps, streamable) with code that does not use the histogram formula, and compare. Then attack the multiplicity claim where it is weakest: p dividing W (impossible for the next prime, but test folding T_x by a prime q < x, where the copy residues r_i + k w do not run over all of Z/q) and small p where 0 and -2 coincide (p = 2) or where +2 = -2 (p = 4 is not prime; check p = 3 where -2 = 1). Also check the closed-form qualifying set (three progressions mod 6p) against the raw histogram criterion.

Falsifier: a fold where the predicted PAIRS differs from the enumerated count, or a (T, q) outside the header's hypotheses where the formula is applied without the hypothesis being stated. Return it with command, output and sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: folds enumerated, wall time, memory, and which hypothesis of the multiplicity argument you tested and how.
