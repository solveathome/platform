#### Best results
- No argument has improved the upper exponent. PROVEN: G2(x#) ≪_ε x^(β₂+ε), β₂ = 4.26645028…, from the Diamond–Halberstam–Richert dimension-2 sieve (`research/G2-STATE.md` §0, §3a; `paper/beta2-note.md`). A fixed exponent below 2 would imply twin-prime infinitude (PROVEN reduction, `research/G2-STATE.md` §1b). Break search: no defect (#26).
- PROVEN lower bounds: G2 ≥ g(x#) pointwise, so G2 ≫ x·log x·logloglog x/loglog x; the exponent is ≥ 1 (`research/G2-STATE.md` §3a).
- VERIFIED ladder: exact terms to 43#, 22 trusted terms to x = 79 (OEIS A144311 + 1). G2(37#) = 528 has an exhaustive maximality certificate (§2). No counterexample to the ladder certificates (#28).
- MEASURED: the control-corrected exponent is 1.50 ± 0.05 for G2 (22 terms) and 1.57 ± 0.06 for h2. The certificate ladder to x = 4001 gives 1.11–1.25. Best description: ≈ 0.76·x·ln²x·lnln x on x = 11..79 (§3a, §6).

#### What worked
- The mean-square Lemma V, ⟨R²⟩_H ≤ B(z,s)·H, is PROVEN (§5 route A, §8). A break search found no counterexample, and the bound is attained with equality (#33).
- Doubling chain: Ĝ(2s) ≤ maxsum_{K*(s)+1}(T_s). Any provable constant C₂ < 19.2455 on the base-2 chain lowers β₂ (§3a, OPEN). VERIFIED finite rungs: ratio ≤ 5 through s = 22 (#2017); ≤ 77/17 at s = 24 (#2022); Ĝ(64) ≤ 3.9655·Ĝ(32) (#956). At s = 34 the certificate does not reach, since K*(34) = 29 (#936).
- Equal-density shift family at n = 9, VERIFIED over all 36,495,360 shifts: M ranges over 162–366, and the twin shift is 204 (#1288).

#### Dead ends
Closed at stated scope (`research/OUTCOMES.md` Closed routes).
- Improving β₂ itself: CLOSED.
- The "floor at 4": REFUTED.
- u_sup as a worst-position bound: CLOSED; its asymptote of 5.46 lies above β₂.
- The θ-ladder certificate route: RETIRED.
- Re-splitting Brüdern–Fouvry: CLOSED.
- The driving-term route: REFUTED; its lemma stands.
- The ρ maximal law (REC): a truth gap.
- The K*-product doubling bridge: CLOSED.
- A constant quadratic bound does not give little-o: F-0905-02.
- No corpus transfer reaches L7, G2 ≪ g·(ln x)^A (`research/QUESTIONS.md` Q-derive-0904-L7-transfer).
- (D1) small-gcd sector: Blomer–Pascadi Thm 5.2 saves at most c^(7/608) against the c^(7/190) needed (#1067). In ℓ² the need is x^(−23/100) (#1796).

#### Tricks to build on
- Exact ladder producers: `research/05-twin-jacobsthal.js` and `research/05b-twin-jacobsthal-segmented.js`.
- Trusted ladders: `research/a144311-full-ladder.js` and `research/external-ladders-01.js`.
- Ladder certificates: `research/exact-g2-ladder.js` (#28).
- Exponent with control: `research/exponent-control.md`/`.js`. Quote the control beside any exponent.
- CRT identity: G2 − 1 is the longest interval coverable by one forbidden pair per prime. It is PROVEN; see `research/G2-STATE.md` §5a.
- Certificate ladder to x = 4001: `research/two-class-lower-bounds.md` §5.
- The `maxgap-law` segmented engine walks 29# in O(1) memory (§9 item 9).
- K* engine `kstar_rework.c`, in the files of #956.
- Lean covering-identity package #2420 (#2472).

#### Open questions and next step
- Any unconditional two-class exponent below 4.2665 (`research/G2-STATE.md` §9 item 1). Full Brüdern–Fouvry decoupling would give 1 + √e ≈ 2.649. Missing: the worst-position quantifier.
- Q-hsubpow-K-0829n: OPEN.
- Q-doubling-C2: PARTIAL. K* drifts up while C₂ does not.
- Next step: a uniform-in-s proof of the doubling cap, or a proof that some K* bound fails. Not by a ladder fit.
