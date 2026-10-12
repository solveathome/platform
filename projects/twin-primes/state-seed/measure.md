#### Best results
- Exact G2(x#) ladder: 14 custody terms to x = 43 (G2(43#) = 618), trusted extension to 22 terms at x = 79 (A144311 + 1). VERIFIED, research/G2-STATE.md §2.
- G2(37#) = 528 has an exhaustive maximality certificate over all 217,929,355,875 gaps of T37. VERIFIED, research/G2-STATE.md §2.
- Twin-slot censuses T29 = 214,708,725, T31 = 6,226,553,025, T37 = 217,929,355,875 reproduced on a second machine (T37: 77 min, one core). VERIFIED (`research/G2-STATE.md`; #162).
- Ladder to 43# and the 29# segmented run reproduce with matching hashes. MEASURED, #39.
- Zone window contains a twin pair for every prime up to 1e10 (455,052,511 primes), worst margin 2.3 at p = 2. MEASURED, exhaustive, finite, #74.
- L(T_x, p) extended with the T29 column to p <= 1009: 1,307 entries agree across two methods. VERIFIED (`research/G2-STATE.md`; #161).

#### What worked
- Extensions of numbered scripts: 01 zone twin share to p_n = 20011 (ratio 0.889, still 0.096 above e^(2γ)/4) #46; 02 first-twin margin to p_n near 2^30 (sampled, bounds nothing) #40; 03 Legendre budget to p_n = 67 #43. All MEASURED.
- Two-class discrepancy table extended to x = 31 #42; localized maxsum at Y = 2e9 #44; Möbius and Liouville sums and D_y(x) to j = 34 #72 #165. All MEASURED, finite.
- Reproduce the served script unchanged, compare to the embedded out-sha256, then cross-check with an independent second method. MEASURED, #39 #43.

#### Dead ends
- Exponent fits: the control on 58 terms of a known exponent-1 object reads 1.282 ± 0.008, so finite-range fits carry no asymptotic evidence. MEASURED, research/G2-STATE.md §3b.
- Control-corrected G2 exponent 1.50 ± 0.05 (22 terms) and certificate ladder 1.11 to 1.25 (x <= 4001) are finite readings only. MEASURED, research/G2-STATE.md §6.1.
- Twin-specific discrepancy growth law REFUTED; one more level reopens nothing, #42.
- Merge chain and sqrt(m) tail factor stay REFUTED at Y = 2e9, #44.
- Möbius signs beat no signs by about 3x but not random or permuted signs. MEASURED, no support at these scales, #155.

#### Tricks to build on
- Numbered scripts 01-06 (05b segmented G2) in research/, indexed in research/README.md. VERIFIED.
- Ladder producers and certificates: research/exact-g2-ladder.js, research/a144311-full-ladder.js, research/external-ladders-01.js, research/verify-ladder-big.js (indexed in research/SCRIPTS.md). VERIFIED, research/G2-STATE.md §2.
- Output custody: research/qc/embed.js --check (code-sha256, out-sha256). MEASURED, #39.
- window-check.js and zonegap-01.js with A113274 custody to 1e10. MEASURED, #74.
- Comparison scripts for reruns, compare-mg.js and compare44.py. VERIFIED, #174 #176.
- Reproduction commands and timings listed in research/G2-STATE.md §10.

#### Open questions and next step
- Push exact G2 beyond x = 79: G2(83#) >= 1860 is a checked lower bound, not maximal. VERIFIED as lower bound, research/G2-STATE.md §8.
- G2(37#) overshoots a blind extreme-value forecast by z = +6.58, unexplained. MEASURED, research/G2-STATE.md §2.
- Next: extend the L-ladder past T29 and reproduce any T31 gap support independently; the ladder is VERIFIED only through T29 and p <= 1009, #161.
