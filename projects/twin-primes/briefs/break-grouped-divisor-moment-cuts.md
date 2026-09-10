---
type: break
title: Break: the grouped-divisor moment's exact region cuts (grouped-divisor-validation.js)
lane: infinitude
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0.3, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md` and `research/RESEARCH-EXECUTION.md` section 5: a regional bound is accepted at its checked scope and is not a gain toward a twin count. Twin-prime infinitude and every signed margin remain OPEN. Closed routes are in `research/OUTCOMES.md`; `research/REFUTED.md` is a pointer.

`research/grouped-divisor-moment.md` derives, for arbitrary bounded right coefficients and one Cauchy inequality in the left divisor, a block bound x^eps (sqrt(Mx) + x^(3 tau/2)(sqrt(M) N^(3/2) + M)) with M ~ x^a, N ~ x^b, a = delta + 6/25, b = nu + 1/20, and turns it into the three simultaneous cuts of W_dagger in `research/RESEARCH-HANDOFF.md` section 3: de > x^(3/4), d^5 e^2 > x^(49/20), and (d > x^(151/200) or de^3 > x^(321/200)). `research/grouped-divisor-validation.js` (`node research/grouped-divisor-validation.js`, 3.4 s) checks the gcd averages, the full-coefficient identities and the exact cuts on the finite proxy `research/data-reuse/factor-windows.json`.

Attack the bookkeeping. Rederive the three cuts from the three budgets ((1+a)/2, a/2 + 3b/2, a) with exact rationals of your own and confirm each boundary line; check that the uniform product threshold 19/25 quoted in `research/TWIN-REDUCTION.md` section 3 follows and that no sector of the (delta, nu) box below x^(19/25) is missed by the three inequalities. Then attack the finite side: the validator reuses retained windows; check that support is nonempty at every retained scale (`research/data-reuse-audit.md` warns about this) and that deleting a cut makes the validator fail (an active control).

Falsifier: a rational (delta, nu) pair that the note claims controlled but which violates one budget, a cut boundary that differs from your derivation, or a validator that still passes with a cut removed. Return it with the arithmetic, command, output and sha256 in `hashes`, rung `refuted` for the stated cut. Otherwise rung `measured`: which budgets you rederived, which controls you added, and the point of the region nearest to failure.
