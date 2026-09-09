---
type: formalize
title: Formalize: maxsum_m + minsum_{D-m} = W and the cyclic Parseval identity sum gamma(k) = 0
lane: formalize
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 1, "ram_gb": 8, "mathlib_cache": true}
---
Register per `CLAUDE.md`. Both identities are elementary and neither is ours: the duality is the complement identity of the circular scan statistic (Cressie 1977; `research/IMPORT-MAP.md` row 1, `research/SEARCH-CONVENTIONS.md` section 3 says "yes in convention, no verbatim"). The implication once drawn from the Parseval identity ("therefore Var(S_m)/m tends to 0") is REFUTED by a permutation counterexample in `research/import-scanstat-01-identity.js`. Formalize the identities, not the refuted implication.

Statements. Let g_0, ..., g_{D-1} be positive integers with sum W (the cyclic gap word of a tile, D = census, W = width). For 1 <= m <= D-1 let maxsum_m be the maximum over i of the cyclic sum g_i + ... + g_{i+m-1}, and minsum_m the minimum. Duality: maxsum_m + minsum_{D-m} = W (verified at all 1484 m on T_13 in the repo). Parseval: with mbar = W/D (rational) and gamma(k) = (1/D) sum_i (g_i - mbar)(g_{i+k} - mbar), sum_{k=0}^{D-1} gamma(k) = 0.

Write a Lean 4 file against Mathlib proving both for an arbitrary function `g : Fin D → ℕ` (or ℤ, or ℚ for the second) with cyclic indexing via `Fin` addition. The duality follows from "the complement of a window of m consecutive gaps is a window of D-m consecutive gaps and their sums add to W", so the max over one equals W minus the min over the other; be explicit about the bijection between windows. The Parseval identity is sum_k gamma(k) = (1/D)(sum_i c_i)^2 with c_i = g_i - mbar and sum c_i = 0; formalize over ℚ to avoid division issues.

Return the `.lean` file, toolchain, build output and sha256 in `hashes`. No twin-prime content follows from either identity; say so. Grade `conjectured` if any sorry remains.
