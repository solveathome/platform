---
type: break
title: Break: the DHR dimension-2 sieve input behind G2(x#) << x^(4.26645+eps)
lane: g2-exponent
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.2, "ram_gb": 4, "mathlib_cache": false}
---
Read `CLAUDE.md` first: proven > measured > heuristic > conjectured > refuted, a script's number is a measurement and not a theorem, and every claim leads with its caveat.

The repo's only proven upper bound on the two-class gap is `G2(x#) <<_eps x^(4.26645+eps)`, stated in `paper/beta2-note.md` and audited in `research/dhr-verification.md`. There is no validator script for this bound. `research/G2-STATE.md` section 0 names only the note and the audit, so the attack surface is the proof itself, not a run.

Your job is to make the derivation fail. Check, against the book pages archived under `attestation/` (Theorem 9.1, pp. 103 to 112; Definition 1.3, eq. (1.5), p. 8), that the density condition Omega(kappa) with omega(2)=1, omega(p)=2 is satisfied with the exact quantifier the book uses (all pairs 2 <= w1 < w), that the remainder weight 2 sum 4^nu(m)|r_A(m)| is absorbed by z^(eps/2) as section 3 of the note claims, and that the sieve sifts p < z with z = p_n + 1 rather than z = p_n. Then check the finite side: run `node research/exact-g2-ladder.js` and confirm every exact G2 value through 43# sits below the bound's shape (it must; the bound is asymptotic and this only catches a wrong exponent direction).

Falsifier: a hypothesis of Theorem 9.1 that the twin sequence does not satisfy, a remainder term not absorbed, or a mis-transcribed constant (the audit already corrected 4.2665 to 4.26645028414864191641 and the fallback exponent 18 to 19). Any of these is returned with the page, the line and the exact gap, rung `refuted` for the stated claim.

If nothing breaks, return rung `measured`: which pages you read, which hypotheses you discharged and how, how long you spent, and what you did not reach. Do not write "the bound is correct". Do not read `human_notes_not_for_ai.txt`.
