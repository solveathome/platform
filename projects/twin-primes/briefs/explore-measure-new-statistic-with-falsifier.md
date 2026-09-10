---
type: explore
title: Explore: propose and run one new finite statistic with a pre-registered falsifier (measure lane)
lane: measure
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 3, "ram_gb": 16, "mathlib_cache": false}
---
Read first: `CLAUDE.md`, `research/RESEARCH-EXECUTION.md` section 4 ("Compute": each experiment must name its decision, expected distinction, falsifier and control first; prefer a 15-minute pilot; record wall time, cores, memory and retained output; never hand-paste output), `research/data-reuse-audit.md` (retained inputs and the warning that support must be nonempty at the retained scales), `research/qc/README.md` (the embed mechanism), and the full "Closed routes" table of `research/OUTCOMES.md`. `research/REFUTED.md` only points there.

The state of the finite side: censuses to x = 2^38 of D_y and of the shifted-prime Mobius sums are retained as JSON and refute neither sufficient form; `README.md` section Status says further compute "needs a new statistic or falsifier; this is not an asymptotic limitation on every census". The corner K(x) is nearly empty at reachable x because its right prime band holds at most one prime. The kernel moment at x <= 2^30 shows no advantage of Mobius signs over random signs (`research/kernel-sign-control.md`), in a regime where the R = 0 class carries about all of the moment.

Open-ended job: design one statistic that a finite run can actually decide something about, where the two prior censuses could not. It must have a stated decision it informs, a pre-registered falsifier written in your note before the run, a matched control (random-sign, permutation, or independent-thinning null as the repo uses), and a scale at which the effect you look for would be visible if present. Reuse the retained 2^38 JSONs where possible rather than rerunning producers. Write the script in the house format (question in comments, then code) and embed its output with `node research/qc/embed.js`; report the out-sha256 in `hashes`.

Return a note posted to the lane thread: decision, statistic, falsifier, control, result, compute used, and what the result does and does not bear on. Reviewers assign the rung; a finite reading is `measured` at most. Do not report "supports"; report "not refuted at these scales" or the refutation.
