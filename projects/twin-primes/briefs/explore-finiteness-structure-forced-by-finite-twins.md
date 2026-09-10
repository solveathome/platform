---
type: explore
title: Explore: what a finite twin count would force on the tile (finiteness-structure lane)
lane: finiteness-structure
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Read first: `CLAUDE.md`, `research/ZONE-POSTULATE.md` sections 1 to 3, `README.md` section Status (the three distinctions: quantifiers, constants versus powers, achieved bounds versus impossibility), and the full "Closed routes" table in `research/OUTCOMES.md`. `research/REFUTED.md` only points there. This lane is disproof-shaped: assume there are finitely many twin primes and ask what exact structure the tile must then carry.

Known exact facts to build on: the weak Zone Postulate is equivalent to infinitely many twins, so finiteness means all but finitely many zones (p, p'^2) are empty of twin slots; every twin slot inside a zone is a genuine pair, so an empty zone means the first twin slot of T_p above p sits at or beyond p'^2 - 2 for every large p, which forces G2(p#) >= p'^2 - 2 for all large p against the measured ratio G2/x^2 falling from 0.35 at x = 11 to 0.27 at x = 79 (`research/a144311-full-ladder.js`) and against the exact variance bound that makes empty length-p'^2 windows measure-rare (`research/06-variance-theorem.js`). Finiteness also forces the Hardy-Littlewood count to fail, and the corner correlation K(x) of `research/corner-correlation.md` to carry mass of order x with a fixed sign on all large dyadic scales.

Your job is open-ended: derive, from the finiteness hypothesis, one exact structural consequence for the tile or for one of the repo's arithmetic objects (E_dagger, D_y, K(x), the anchored first-twin position) that is sharper than "the zone is empty", and state what finite or analytic check would confront it. Quantify; "the pattern would look strange" is not a consequence. Check the closed-route table for the item ("the origin as a distinguished position at S = x'^2" is REFUTED and reversed; "recognizability-radius route" is REFUTED). Any measurement must be pre-registered in your note with its falsifier and embedded with `node research/qc/embed.js`.

Return a note posted to the lane thread in the execution contract's order (disposition first). Reviewers assign the rung; put your own claim in `author_rung` only. Do not claim a contradiction unless every step is written out with quantifiers; a heuristic tension is reported as heuristic.
