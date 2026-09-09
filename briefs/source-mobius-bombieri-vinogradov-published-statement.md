---
type: source
title: Source: is a Mobius Bombieri-Vinogradov theorem stated in Iwaniec-Kowalski or Opera de Cribro
lane: infinitude
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0, "ram_gb": 2, "mathlib_cache": false}
---
Register per `CLAUDE.md`. The arithmetic reduction in `research/TWIN-REDUCTION.md` uses a Bombieri-Vinogradov estimate for the Mobius function in progressions at level x^(1/10). `research/mobius-bv-derivation.md` section 2 records that no published theorem statement of it was located in five channels on 2026-09-06, searched in the owning convention of `research/SEARCH-CONVENTIONS.md` section 1 ("Mobius function in arithmetic progressions", "Bombieri-Vinogradov", "Vaughan identity"), and derives it instead from four numbered results of Koukoulopoulos, GSM 203 (Corollary 13.4, Theorem 26.2, Theorem 26.6, equation (26.3)), read in the author's preliminary version whose numbering was not checked against the printed book. The two most likely published carriers were NOT REACHED: Iwaniec and Kowalski, Analytic Number Theory (AMS Colloq. 53, 2004) section 17.2 "Bilinear forms in arithmetic progressions" (the statement usually cited as Theorem 17.4, p. 421), and Friedlander and Iwaniec, Opera de Cribro (AMS Colloq. 57, 2010), Theorems 9.16 to 9.18. Granville and Shao (Adv. Math. 350, 2019, p. 2) assert the Mobius case is known and attach no locator.

Your job: open those two sources at the page. Transcribe the exact statement of the general bilinear-form theorem in IK 17.2 and of Opera de Cribro Theorems 9.16 to 9.18, with theorem numbers, page numbers and every hypothesis (coefficient class, ranges, level, uniformity). Then say, clause by clause, whether the Mobius case at level x^(1/10) with the maximum over y follows from one of them together with Vaughan's identity for mu, and whether the numbering of the four Koukoulopoulos results matches the printed GSM 203.

Falsifier for the repo's negative: a published statement that covers (M) as used. Report it with the locator, rung `measured` (a source match; the repo's derivation stays a derivation). If neither source covers it, report that as a scoped negative on the pages actually read, and never as proof that no statement exists. Record every channel tried and what you could not open.
