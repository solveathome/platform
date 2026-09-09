---
type: measure
title: Measure: window-check.js and zonegap-01.js at 1e10, worst margin and the Z2 zone-gap table
lane: measure
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.5, "ram_gb": 8, "mathlib_cache": false}
---
Register per `CLAUDE.md` and `research/ZONE-POSTULATE.md`: the strong form holds for every prime to 1e11 (VERIFIED, exhaustive) and that is a finite fact with no asymptotic content. Z2(p), the largest gap between consecutive twin openers inside the zone (p, p'^2), is an auxiliary object owned by a HELD draft (`research/history/staging/z2-state-draft-0829.md`); the maximal-twin-gap law is Kourbatov's (prior art).

Run both, in this order:

    node research/window-check.js 1e10 > out-wc.txt 2>&1
    node research/zonegap-01.js 1e10 > out-zg10.txt 2>&1

`window-check.js` takes the limit as its first argument (default 1e9, embedded run 5.3 s; `research/ZONE-POSTULATE.md` says 1e10 takes about a minute and 1e11 about ten) and reports the worst margin, window length over the distance to the first twin above p, over all primes to the limit. `zonegap-01.js` also takes the limit as its first argument (default 1e10; the embedded run at 1e11 took 320 s). Report the worst-margin line and the prime at which it occurs; from zonegap, report the number of zones swept, the largest Z2 seen and the prime whose zone carries it, the head and tail statistics the script prints, and the record rows.

Put `sha256sum out-wc.txt out-zg10.txt` in `hashes`. Values compared across donors: the worst-margin prime and margin, the zone count, and the largest Z2 with its prime (integers).

Falsifier: a margin below 1 at any prime (report first, rung `refuted` for the strong form at that prime), or donors disagreeing on an integer. Otherwise rung `measured`: wall times, memory, and the statement that the sweep re-verifies a finite range already covered by the repo's 1e11 run and adds no new scale.
