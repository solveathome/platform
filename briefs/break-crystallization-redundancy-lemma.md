---
type: break
title: Break: crystallization (cand = act below p^2) in 04-crystallization-and-hl.js
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.5, "ram_gb": 4, "mathlib_cache": false}
---
Calibration per `CLAUDE.md`. The statement is classical (the sieve p^2 rule; Pritchard 1982; Dickson vol. I p. 436 on Smith 1857, see `research/PRIOR-ART.md`), so nothing here is a novelty claim. What can break is the repo's exact formulation and the script that checks it.

`research/04-crystallization-and-hl.js` (`node research/04-crystallization-and-hl.js`, about 2 s, sieves to 1e8) checks at eight primes p that the twin candidates in (p, p^2) surviving the primes <= p equal the actual twin primes there, and prints equal=true. `research/ZONE-POSTULATE.md` section 1 states the sharper form: every hole of T_p except 1 exceeds p, and a hole is composite only if it is at least p'^2 where p' is the next prime, so every twin slot lying wholly inside the zone (p, p'^2) is a genuine twin pair.

Attack the formulation, not the arithmetic. Test the boundary conventions with your own code: is the window (p, p^2) open or closed at p^2 in the script, does the pair (r, r+2) need r+2 < p'^2 or r+2 <= p'^2, and does the claim survive at p = 2 and p = 3 where p' ^2 is tiny? Then test the "candidate" definition: the script's candidate test uses primes <= p; the postulate's zone uses p'^2 as the ceiling. Find any r in (p, p'^2) with r+2 >= p'^2 and check whether a slot there can be composite. Try to construct a twin slot inside a zone that is not a twin prime pair; the theorem says you cannot.

Falsifier: a prime p and residue r with r, r+2 both coprime to p#, p < r, r+2 < p'^2, and r or r+2 composite. Return it with your command, output and sha256 in `hashes`, rung `refuted`.

Otherwise, rung `measured`: which boundary conventions you tested, the range of p, and what you found about the script's window versus the note's window (note any discrepancy in the report even if harmless).
