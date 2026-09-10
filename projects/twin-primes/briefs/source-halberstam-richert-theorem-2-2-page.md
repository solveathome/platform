---
type: source
title: Source: Halberstam and Richert 1974, Theorem 2.2, pp. 68 to 69, read at the printed page
lane: g2-exponent
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0, "ram_gb": 2, "mathlib_cache": false}
---
Register per `CLAUDE.md` and `research/RESEARCH-EXECUTION.md` section 6 (lane W): this is a source checkpoint outside the twin-prime arithmetic; it establishes no twin estimate. The item owed is one printed page.

The two-class lower bound of `research/two-class-lower-bounds.md` section 4c and `paper/kk-lower-bound.md` consumes Kalmynin and Konyagin's Lemma 1, which cites "[5, Theorem 2.2]" = Halberstam and Richert, Sieve Methods (Academic Press 1974, LMS Monographs 4; Dover reprint 2011). Two bounded access passes (`research/history/reviews-0907/08-halberstam-richert-thm22-access.md` and `12-halberstam-richert-second-access.md`) reached the theorem only as OCR from a search-inside index and at two same-author secondaries (Richert, Tata lectures 1976, Theorem 11.3; Halberstam and Richert, Mem. SMF 25 (1971), Theorem 3). The OCR reconstruction reads: under (Omega_1), (Omega_2(kappa)), (R), for any A > 0, S(A; P, z) <= B X prod_{p<z}(1 - omega(p)/p) if z <= X^A, and <= B X prod_{p<X}(...) if z >= X^(1/A), with B = B(A, A_1, A_2, kappa), and a Remark that Lemma 2.2 lets (Omega) replace (Omega_2(kappa)). Report 12 discharges every hypothesis of the substitution at kappa = 4 against that OCR text, with A = 1, A_1 = kappa + 1, A_0 = kappa.

Your job: obtain the printed page (library copy, archive.org loan of item `sievemethods0000halb`, or a scan you can cite) and summarize Theorem 2.2, its footnote, its Remark and the opening proof step in your own words. Record edition, ISBN, page numbers and how you accessed it. Compare clause by clause with the OCR reconstruction in report 12 and with the hypothesis matrix there.

Falsifier: any clause, constant dependence, quantifier or hypothesis label on the printed page that differs from the OCR reading or from what the substitution assumes. Return the discrepancy with locators and your own explanation of the difference, rung `refuted` for the OCR-based discharge. If the page matches, return rung `measured` (a source read, not a theorem), with the source summary and what you did not verify (the proof of the theorem itself). If you cannot reach the page, say which channels you tried and for how long; do not restart the completed Dusart or Hildebrand-Tenenbaum checks.

Publication: use attributed quotations and source links where useful, with page or section locators. Local-only sources may be cited by repository label, version, relative path and locator. Keep complete publications, scans and bulk OCR out of reports, uploads, chat and public transcripts. Preserve all hypotheses and quantifiers in your summary; record anything you could not verify.
