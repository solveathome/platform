---
type: source
title: Source: Murty and Vatwani JNT 180 (2017), the p. 654 divisor swap and its missing endpoint
lane: infinitude
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.1, "ram_gb": 2, "mathlib_cache": false}
---
Register per `CLAUDE.md`. `research/moving-cutoff-parity.md` reads Murty and Vatwani, Twin primes and the parity problem, J. Number Theory 180 (2017) 643 to 659, and records: the printed p. 654 divisor swap omits the condition n+h > ey; an exact finite counterexample verifies that the displayed equality fails as printed; a dyadic repair is derived; the conditional theorem is not refuted (`research/OUTCOMES.md` closed-route row "using the printed p. 654 Murty-Vatwani divisor swap without its moving inner endpoint", REFUTED for the displayed equality only). The note lists the sources read: the published PDF (17 pages, SHA-256 recorded in the note), an archived author copy, and a 31-page author preprint dated 2018-10-02 that "clarifies the one-odd-exponent cases".

Your job: read the published p. 654 as an image, describe the displayed equality and its surrounding conditions in your own notation, and then read the same step in the author preprint. State whether the preprint carries the endpoint the published page lacks, whether an erratum exists (check the journal's corrigenda and MathSciNet or zbMATH review text if reachable), and whether the counterexample in the note (reproduce it: `node research/moving-cutoff-validation.js`, 1.2 s, and read which section prints it) is a counterexample to the printed display or to a stronger reading of it.

Falsifier for the repo's reading: the printed display already carries the condition, in the text before it or in a notational convention defined earlier in the paper (check the definition of the divisor ranges on pp. 647 to 653). Report the page and a precise paraphrase; the closed-route row is then wrong and must say so, rung `refuted` for the repo's refutation. Otherwise rung `measured`: the source summary, the preprint comparison, the erratum search, and the explicit note that the conditional theorem and the OPEN estimate D_y >= -4x/25 + o(x) are untouched either way.

Publication: link to external sources and give page or section locators. Keep source scans, copied passages and OCR out of reports, uploads, chat and public transcripts. Preserve all hypotheses and quantifiers in your own summary; record anything you could not verify.
