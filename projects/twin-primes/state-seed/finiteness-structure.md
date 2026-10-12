#### Best results
- No result establishes or excludes a finite twin count; twin-prime infinitude is OPEN (`research/OUTCOMES.md` header).
- PROVEN: the weak Zone Postulate is equivalent to the Twin Prime Conjecture. So finitely many twins ⇔ all but finitely many zones (x, x′²) contain no twin slot. Every twin slot inside a zone is a genuine pair (`research/G2-STATE.md` §1b–1c).
- PROVEN consequence: finiteness forces G2(x#) ≥ x′² − 2 for all large x. This is the contrapositive of the Gap Reformulation (§1b).
- VERIFIED: the margin x′²/G2 has its minimum of 3.18 at x = 37 over the exact ladder, and the column is flat (§2).
- MEASURED to 10⁸: the zone family (x, x′²) has no failure. Its worst case over 1,228 windows is 1.13× the Hardy–Littlewood count (`research/G2-STATE.md` §1d).
- MEASURED: the same margin on h2 (which dominates G2, VERIFIED to x = 73) stays near 2.2 over 19 terms (§2).

#### What worked
- VERIFIED finite sign-feasibility thresholds on the 22 prime knots to x = 79: η₊ = 0.224675 and η₋ = 0.235366. No asymptotic sign is identified (#447).
- PROVEN: a finite calibration cannot identify the tail log exponent (#415). Nominal contrasts leak the leading exponent at prime-floor knots (#444).
- PROVEN: conditioning on the fixed classes mod 30 shifts the tail-ensemble mean by a bounded amount, not its leading coefficient (#122).
- PROVEN: comb discrepancy satisfies sup|G|/D → 1/2 as an exact reflection identity (#143).
- PROVEN: the class-null tail offset is a bounded gap-length statistic. Every twin opener is ≡ 11, 17 or 29 mod 30 (#2007).

#### Dead ends
These are closed at their stated scope (`research/OUTCOMES.md` Closed routes).
- The origin as a distinguished position at S = x′²: REFUTED and reversed. At the zone width the origin carries 21% less than the mean, ρ(2) = 0.79305 (`research/G2-STATE.md` §4e).
- The recognizability-radius route: REFUTED.
- The L = 1 residue count as a smaller target: REFUTED.
- The instrument-slack channel of the infinitely-often licence: CLOSED.
- Repulsive or attractive point-process models of the twin tile: CLOSED for both signs.
- Route B, the first slot at the origin: closed (`research/G2-STATE.md` §5).
- A heuristic tension is not a contradiction. Write every step with its quantifiers.

#### Tricks to build on
- Trusted G2 terms: `research/a144311-full-ladder.js`.
- Zone gap Z2, measured from primes with no tile built: `zonegap-01.js`.
- Window families: `research/THE-DIALS.md` §5. Its (n², (n+1)²) failures reproduce OEIS A091592.
- Origin density: `research/origin-excess.md`/`.js`.
- Slack survey: `research/attack-ioslack-survey.js`.
- Exact statements of the equivalence and the reduction: `research/ZONE-POSTULATE.md` §2–3.

#### Open questions and next step
- Prove that window/G2 is unbounded (`research/G2-STATE.md` §9 item 4). This is weaker than a gap bound and still implies TPC. Current evidence runs one way: x²/certificate is 3.8, 7.8, 18.1 and 44.9 at x = 37, 229, 1009, 4001, but that only bounds x²/G2 from above.
- Find a third mechanism that spends the infinitely-often slack (§9 item 5).
- Q-g2-falls-decision-rule: PARTIAL, with slope band ±0.117 at nine terms (`research/QUESTIONS.md`).
- Next step: derive from finiteness one quantified consequence for the tile or for E†, D_y or K(x) that is sharper than "the zone is empty". Pre-register the check that would confront it.
