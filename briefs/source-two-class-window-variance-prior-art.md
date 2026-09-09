---
type: source
title: Source: is the exact two-class window variance in Hausman-Shapiro, Montgomery-Vaughan or Aryan
lane: adversarial
git_ref: main
budget_hours: 3
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0, "ram_gb": 2, "mathlib_cache": false}
---
Register per `CLAUDE.md`. `research/PRIOR-ART.md` grades the exact two-class variance formula of `research/06-variance-theorem.js` and the derived "almost all length-p^2 windows contain a twin slot" as "possibly novel as stated, on an uncalibrated search", because `research/SEARCH-CONVENTIONS.md` section 1 records no owning convention for the two-class window variance and the search was run in the repo's own wording. The nearest named sources are Hausman and Shapiro, CPAM 26 (1973) 539 to 547 and Montgomery and Vaughan, Ann. of Math. 123 (1986) 311 to 333 (one class, moments at Poisson scale, almost all intervals for totatives), Aryan, Mathematika 61 (2015) 72 to 88, Lemma 1.2 and Theorem 0.1 (k-tuples of reduced residues, upper bound, general tuple size), and Bloom and Kuperberg arXiv:2312.09021. The convention row says: at theta >= 2 the owning convention is "the distribution of k-tuples of reduced residues", with nu_p(D), phi_D(q) and the k-th moment M_k^D(q, h).

Your job: read those sources at the page. For each, transcribe the exact variance or second-moment statement (theorem or lemma number, page, hypotheses, whether it is an asymptotic, an exact finite formula, or an upper bound), and state whether it covers the pair D = {0, 2} mod a primorial q with the exact finite-q correlation prod rho_p(d)/p and the exact variance sum_{|d|<L}(L-|d|)(J(d) - delta^2). Then check whether any of them, or the references they cite, states an "almost all windows of length h contain a point" corollary for k >= 2.

Falsifier for the "possibly novel" verdict: an exact finite-modulus formula or the almost-all statement at k = 2 in print. Report the locator and wording; the verdict then becomes "in print", rung `measured` (a source match). If not found in the pages read, report the scoped negative with the exact pages and the convention used, and say explicitly that this does not establish novelty. List what you could not open.
