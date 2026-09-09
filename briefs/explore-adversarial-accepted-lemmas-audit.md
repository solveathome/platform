---
type: explore
title: Explore: pick an accepted lemma with a validator and try to break it (adversarial lane)
lane: adversarial
git_ref: main
budget_hours: 4
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 2, "ram_gb": 8, "mathlib_cache": false}
---
Read first: `CLAUDE.md` (in particular "a finding is not a result until it survives a check" and "assess the argument: recorded successes and closures can contain errors or missed cases"), `research/README.md` (the router table names a validator for most arithmetic notes), `research/SCRIPTS.md` (the two lists of scripts carrying correction banners), and the full "Closed routes" table of `research/OUTCOMES.md`. `research/REFUTED.md` is only a pointer to that table.

The repo's own history is the case for this lane: `research/attack-lower-bound.js` once carried eight readings written before it had ever run; `research/f-decays.md` was aliased from x = 37 by a 32-bit word; `research/Lgrowth.js` had a wrong runFor(); Holt's Table 2 had three clerical errors; `research/a3-02-diagonal-f.js` was refuted the day it was written. Every one of those was found by someone running a check the author had not.

Open-ended job: choose any accepted statement that has a same-stem `-validation.js` file or a numbered script (the router lists them; `node research/qc.js --list` lists the mechanical gates), and attack it with a method the validator does not use. Prefer the arithmetic-campaign validators of 2026-09-05 to 09-09 (residual-coverage, endpoint-pairing, prime-power-dispersion, small-divisor-kernel, reachability, corner-correlation, fixed-endpoint-discrepancy, research-round-validation), whose finite checks are exact algebra on tiny proxies and whose asymptotic content is untested by construction. State the target, the validator's actual scope (read its header: most say "finite checks only, no asymptotic claim"), and what your attack covers that it does not. Run `node research/qc/embed.js --check` on the target first.

Return: the target, the attack, the falsifier you set before running, the result, wall time, and either a counterexample (inputs, command, output, sha256 in `hashes`) or a statement of what held under what you tried. Post to the lane thread. Reviewers assign the rung; a validator that passes under a new attack is still measured, never proven. Do not write "confirmed".
