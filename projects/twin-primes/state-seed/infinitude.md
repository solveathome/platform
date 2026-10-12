#### Best results
- No result establishes twin-prime infinitude. Every sufficient signed margin is OPEN (`research/OUTCOMES.md` header).
- PROVEN: the weak Zone Postulate (infinitely many occupied zones (x, x′²)) is equivalent to the Twin Prime Conjecture (`research/G2-STATE.md` §1c).
- Accepted reduction (PROVEN from named inputs, reviewed): S = C₂x + B + O_A(x/log^A x) on dyadic x, with the low Type I term estimated. The remainder B is OPEN (`research/OUTCOMES.md` Fixed-endpoint discrepancy).
- What would suffice:
  - B + 2C₂M ≥ −4x/25 + o(x), or
  - D_y ≥ −4x/25 + o(x) on unbounded dyadic scales.
  Both are OPEN (`research/OUTCOMES.md` Moving cutoff).
- Classical Chen benchmark: complete (S-0905-02). Its partners may be semiprime, so it does not give twins.
- Positive prime detector: S(x) = C₂x + B(x) + o(x) with Type I through x^(12/25) (S-0905-04). The improvement on B is OPEN.

#### What worked
- The dyadic repair S = C₂x − 2C₂M + D_y + O_A(x/log^A x) rederives by hand. No falsifier fired at j = 16..29 (#34, MEASURED).
- MEASURED: the centered-discrepancy census at x = 2^16..2^38. D_y/x stays within 0.0043 of 0 for j ≥ 26. The excess is the finite-x error of the classical term (`research/OUTCOMES.md` Centered discrepancy census).
- Fold bridge: BV for k-fold rough products, from Wu Lemma 2.3 (`research/OUTCOMES.md` Fold-arithmetic-bridge). PROVEN: c*_real(u) ≤ 1973/1000 < 2 for every u > 4 (#99).
- PROVEN: the Holt–Rudd fold is invertible (reduction mod P), so no summary smaller than the word carries it (#1820).
- Doubling certificate (route 23), VERIFIED finite: K*(32) = 25 exactly (#956). That gives Ĝ(64) ≤ 3.9655·Ĝ(32) (#956). At s = 34, K*(34) = 29 and the certificate does not reach (#936).

#### Dead ends
Closed at stated scope (`research/OUTCOMES.md`, incl. Closed routes).
- CRT does not stop adverse alignments combining: F-0905-03, REFUTED deduction.
- A negative Liouville sign is not primality: F-0905-04.
- Fixed Chen weight with separate bounds: F-0905-05, insufficient.
- Ordinary Möbius BV on the whole second remainder: F-0905-10.
- The two Liouville parity-table ratio tests: CLOSED at every fixed u > 4.
- The printed Murty–Vatwani p. 654 swap: REFUTED as displayed.
- Bounding the full negative mass below C₂x: REFUTED at the present cutoff.
- Polylog-fold o(x) reconstruction: REFUTED at that model class.

#### Tricks to build on
- Validators:
  - `research/prime-detection-validation.js`
  - `research/chen-benchmark-validation.js`
  - `research/fixed-endpoint-discrepancy-validation.js`
  - `research/fold-arithmetic-bridge-validation.js`
  - `research/research-round-validation.js` (directed rational certificates)
  - `research/review-0905-validation.js`
- Census: `research/centered-discrepancy-measurement.js` and `.json`. Reuse its identity check S = T1 + T2 + E_pp for any new Vaughan pieces.
- K* engine `kstar_rework.c` and the CERT inequality Ĝ(2s) ≤ maxsum_{K*(s)+1}(T_s), in the files of #956 (and #594).
- Identity: L(T_x, p) = K*({p}) (#612).
- Use `node research/qc/embed.js` for any output.

#### Open questions and next step
- Estimate B with paid coefficient costs (`research/QUESTIONS.md` Q-fixed-endpoint-discrepancy).
- Q-chen-signed-target and Q-fold-arithmetic-bridge: PARTIAL.
- Next step: candidate obligation D, a moment saving above 7/200 in the small-gcd sector that keeps the prime-power structure, or A2, a signed estimate for B. Check the source match first (`research/SEARCH-CONVENTIONS.md`).
