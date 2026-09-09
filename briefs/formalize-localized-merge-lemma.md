---
type: formalize
title: Formalize: Fact A, Fact B and the Localized Merge Lemma of LOCALIZED-GAP.md
lane: formalize
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Register per `CLAUDE.md`. The lemma is PROVEN; the chain built on it is REFUTED in `research/OUTCOMES.md` ("the localized merge chain, telescoped to level x", 2026-08-17). Formalizing the lemma does not reopen the chain and should not be described as doing so.

Statements (`research/LOCALIZED-GAP.md` sections 2 and 3). Fix a prime x >= 3 and let T_x be the set of twin slots: integers r with r and r+2 both x-rough (no prime factor <= x). Fact A: no two twin slots of T_x are 2 apart (s, s+2, s+4 all x-rough would cover every class mod 3). Fact B: folding T_x by a prime p > x deletes exactly the slots in the classes {0, -2} mod p; in an interval shorter than p-2, at most one slot is deleted. Localized Merge Lemma: write M(T_x, Y) for the largest gap between consecutive twin slots among gaps starting below Y, and maxsum_2(T_x, Y) for the largest sum of two consecutive such gaps; if M(T_x, Y) <= (p-2)/4 then M(T_p, Y) <= maxsum_2(T_x, Y), where T_p is T_x after folding by p (assume p is the next prime after x, or state the weaker hypothesis you use).

Write a Lean 4 file against Mathlib proving Fact A, Fact B and the lemma. The proof of the lemma is a counting argument: a new gap G fusing j+1 old gaps contains j kills, G <= (j+1)M; if G >= p-2, partition into ceil(G/(p-2)) subintervals shorter than p-2 to get j <= G/(p-2) + 1, then G(1 - M/(p-2)) <= 2M, contradiction with M <= (p-2)/4. Formalizing "consecutive gaps starting below Y" requires a definition of the sorted slot sequence; use `Nat.nth` on the predicate or a `Finset` sorted list, and state the boundary convention (the note's section 8 says a fused gap starting below Y never ends above it; you may need to assume or prove a version of this).

Return the `.lean` file, toolchain, build output and sha256 in `hashes`. If the statement needed reformulation, put the reformulation first. Grade `conjectured` if any sorry remains.
