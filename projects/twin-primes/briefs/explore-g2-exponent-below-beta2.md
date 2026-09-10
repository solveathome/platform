---
type: explore
title: Explore: any input that would move the two-class exponent below 4.26645 (g2-exponent lane)
lane: g2-exponent
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Read first: `CLAUDE.md`, `research/G2-STATE.md` section 0 and its "Earlier exponent route (parked under TODO 0)" paragraph, `TODO.md` item 0, `research/SEARCH-CONVENTIONS.md` sections 4 and 5, and the full "Closed routes" table of `research/OUTCOMES.md` (`research/REFUTED.md` is a pointer). The achieved bound is G2(x#) << x^(4.26645+eps) from the DHR dimension-2 sieve; a fixed exponent below 2 would prove twin primes; the band (2, 4.26645] is a proof gap, not a truth gap for the bound itself, though several specific routes across it are closed at rung derived-and-red-teamed (the rho maximal law / REC(s, u0) route, the DI/Pascadi Y_N axis, improving beta2 itself, the covering economy, the local-lemma and concentration families).

TODO item 0 reopens only with a specific defect in the recorded remainder obstruction or an estimate using changed inputs outside its proved scope, and asks you to read the REC and CRT-planted-position arguments before making that distinction. The distance is recorded as a positivity problem, not a distribution problem: a perfect distribution oracle moves the exponent by nothing (`research/ZONE-POSTULATE.md` section 3).

Open-ended job: find one input that is not a one-point divisor-class count |A_d| (the sieve consumes only those) and that is not a rephrasing of the Zone Postulate, and price what it would do to the exponent. Candidates the repo names as unworked or unread: the Vatwani lead on divisor-bounded multiplicative functions in progressions (UNREAD, execution section 4), a bilinear input with a non-smooth modulus profile, the exact pair correlation as a second-moment input to a weighted sieve. Before computing, check the source in the owning convention. Every closed route must be checked against your idea by name.

Return a note posted to the lane thread, execution contract order, with the exact exponent arithmetic and the first unmatched hypothesis of any theorem you import. Reviewers assign the rung. A priced route that fails is a legitimate return if the failed step is named exactly; a route that "looks promising" without a priced inequality is not a return.
