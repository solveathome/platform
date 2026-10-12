#### Best results
- PROVEN in Lean 4, 10 trusted-accepted lemmas, each sorry-free, axioms only propext/Classical.choice/Quot.sound, negative control fails to build: Alternation Lemma #76; twin-slot census = prod(p-2) #77; (P)<=>(P') consumer equivalence #79; window duality and cyclic Parseval #81; G2(p#) < p'^2-2 implies a twin pair in (p, p'^2) #89; Parseval L4 = h(e-h) #113; Lemma H #115; pair correlation J(d) = prod rho_p(d)/p #135; weak Zone Postulate <=> infinitely many twins #146; Fact A, Fact B, Localized Merge (buffered form) #150.
- PROVEN (lean-kernel-v1, 3 of 3 mapped claims checked): main theorem of paper kk-lower-bound, #2597. Its inputs O1-O7 are outside the check (#2597). No other of the 15 papers has Lean evidence.
- Scope: all are elementary or framing lemmas. #89 proves only the implication; its hypothesis is OPEN, proven exponent 4.26645 against 2 needed (#89, research/G2-STATE.md).

#### What worked
- Abstract statements: ZMod residues, Nat.card, CRT via ZMod.chineseRemainder (#77, reused in #135).
- Hypotheses weaker than the notes: D >= 1 only #81; A > 0, and a smaller constant 2A^2 in place of 4A^2, PROVEN #115; r > 3 not needed #146.
- #eval cross-check of a definition against an independent implementation: G2 at P = 2..30030 gives 2, 6, 12, 30, 42, 66, the ladder rows, VERIFIED on 6 moduli (#89).

#### Dead ends
- Exact Localized Merge (hypothesis on gaps below Y only): not proven; its boundary claim is MEASURED only. Lean needs a buffer to Y+p. Without the hypothesis the conclusion fails at (x,p,Y) = (5,7,500): 30 > 24 (#150).
- Script clause "equality iff delta = 0" REFUTED in Lean: g=2, H=1, delta=1, and the family g=2k, H=k(2j+1) (#113).
- Gap reformulation is false at p = 1, PROVEN (gap_reformulation_fails_at_one, #89).
- "Var(S_m)/m -> 0" is REFUTED by a permutation counterexample; it is not formalized (#81).

#### Tricks to build on
- Pins: leanprover/lean4:v4.33.1, Mathlib rev 0df444a360eaa60ab8c11dca51a86af692955474; about 1 min build with the Mathlib cache (#76, same pins #77-#150).
- Files, theorems: Alternation.lean, KappaNotL.alternation #76; Census.lean, TwinCensus.twinCount_prod #77; Growth.lean, consumer_equiv #79; ScanStatIdentities.lean, ScanStat.duality, parseval #81; Zone.lean, ZoneGap.gap_reformulation #89; ParsevalL4.lean, sum_F_nonzero, norm_Psi_le #113; LemmaH.lean, lemmaH, lemmaH_sharp #115; PairCorrelation.lean, pairCount_primorial #135; ZonePostulate.lean, weak_iff_twin, nextPrime via Nat.find #146; LocalizedGap.lean, factA, factB_sep, localized_merge #150.
- Audit: #print axioms on every main theorem; a negative control that must fail; definitions evaluated at small cases against the ladder (#89, #150).

#### Open questions and next step
- The 10 files in #76-#150 were accepted on reading. They carry no Lean statement binding or execution receipt (#76, #146).
- Unfinished parts: the "only if" equality converse is hand-proved and VERIFIED for g <= 16, H <= 40 (#113); Var[N] is not formalized (#135); (D1) is not formalized (#115).
- Third-party Erdos4Tilted.lean: build not reproduced (research/G2-STATE.md).
- Accepted PROVEN lemmas with no Lean file: the block formula H_new = sum c_L H_(L+1) (#192); large-q collapse G2(T_x fold q) = max(g_i+g_(i+1)) when 2q-2 > G2 (#1072); fold injectivity (#1251); tile-dial rise bound (#1365).
- Next step: formalize #1072 on Zone.lean/LocalizedGap.lean, then package one existing file under lean-kernel-v1 as #2597 did.
