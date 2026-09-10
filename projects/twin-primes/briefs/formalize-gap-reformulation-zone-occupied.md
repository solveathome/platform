---
type: formalize
title: Formalize: G2(p#) < p'^2 - 2 implies a twin prime pair in the zone (p, p'^2)
lane: formalize
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Calibration per `CLAUDE.md`: the Gap Reformulation is a PROVEN reduction (`research/ZONE-POSTULATE.md` section 3). Its hypothesis G2(p#) < p'^2 - 2 is OPEN for large p; the proven exponent is 4.26645 against the needed 2. Formalizing the implication proves nothing about the hypothesis.

Statement, in the repo's notation. Let P = p# and call r a twin slot mod P if gcd(r(r+2), P) = 1. Let G2(P) be the largest cyclic gap between consecutive twin slots in [0, P). Facts used (section 1 of the note): (i) every hole of T_p (integer coprime to P) other than 1 exceeds p; (ii) an integer coprime to P is composite only if it is at least p'^2, where p' is the next prime after p; (iii) P - 1 and P + 1 are both coprime to P, so 1 and P-1 are twin slots at the edge (the repo's Seam Lemma edge case). Claim: if G2(P) < p'^2 - 2 then there exist r with p < r, r+2 < p'^2, and r, r+2 both prime.

Proof sketch from the note: reading forward from the edge twin slot, the first twin slot r > 1 lies within G2 of it, so r + 2 < p'^2; r > p by (i), and by (ii) both r and r+2 are prime.

Write a Lean 4 file against Mathlib. Define G2 as a maximum over a finite set and check it agrees with the cyclic convention (the wrap-around gap counts). The note's edge slot needs care: slot 1 is a twin slot only if gcd(3, P) = 1, which fails for p >= 3, so the edge pair must be r = P-1 with r+2 = P+1 = 1 (mod P); check what the repo means, reformulate if needed, and report the reformulation first.

Return the `.lean` file, toolchain, build output and sha256 in `hashes`; list sorried lemmas if any and grade the file `conjectured` in that case, `proven` otherwise.
