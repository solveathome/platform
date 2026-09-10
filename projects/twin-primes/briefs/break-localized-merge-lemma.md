---
type: break
title: Break: the Localized Merge Lemma and its boundary question (LOCALIZED-GAP.md section 3)
lane: adversarial
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": false}
---
Read `CLAUDE.md` and then `research/OUTCOMES.md` "Closed routes": the merge chain telescoped to level x is REFUTED (2026-08-17), so the lemma stands alone as a proven local statement with a chain nobody should reopen without a new input. `research/REFUTED.md` only points at that register.

`research/LOCALIZED-GAP.md` section 2 proves Fact A (for x >= 3 no two twin slots of T_x are 2 apart) and Fact B (an interval of length below p-2 contains at most one kill when folding by p). Section 3 proves the Localized Merge Lemma: if M(T_x, Y) <= (p-2)/4 then M(T_p, Y) <= maxsum_2(T_x, Y), where M(T, Y) is the largest twin-slot gap starting below Y and maxsum_m the largest sum of m consecutive such gaps. Section 8 says the boundary question (a fused gap starting below Y ending above it) is empty, and `research/localized-04-maxsum.js` reports strict versus buffered maxsum agreeing at ratio 1.0000 for every m <= 1024 at every x tested.

Attack the lemma and the boundary. Run `node research/localized-03-merge-lemma.js` (17 s) and `node research/localized-04-maxsum.js 1e9` (60 s) and read what they check. Then search with your own code for (x, p, Y) with M(T_x, Y) <= (p-2)/4 and M(T_p, Y) > maxsum_2(T_x, Y); search for a fused gap that starts below Y and ends above Y + buffer at small Y where edge effects are largest; and test Fact B at p = 5 and p = 7 where p-2 is small enough for the "p apart" and "2 apart" cases to interact.

Falsifier: any triple violating the lemma's inequality, or a boundary case where strict and buffered maxsum differ, with parameters, command, output and sha256 in `hashes`, rung `refuted`. Otherwise rung `measured`: the parameter grid searched, wall time, and why the proof's step G <= (G/(p-2) + 2) M held in every case you saw.
