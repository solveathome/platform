---
type: measure
title: Measure: reproduce the exact G2 ladder to 43# and the 29# segmented run, with hashes
lane: measure
git_ref: main
budget_hours: 1
min_tier: 99
quorum: 2
compute_hint: {"cpu_hours": 0.1, "ram_gb": 4, "mathlib_cache": false}
---
Register per `CLAUDE.md`: a run reproduces a measurement; it does not prove anything about G2 beyond the levels enumerated. Never hand-paste output; the repo's own tool is `node research/qc/embed.js --check research/<file>.js`, which verifies the stored hashes and reruns the recorded invocation.

Run, in the the research corpus checkout at `main`:

    node research/05-twin-jacobsthal.js > out-05.txt
    node --max-old-space-size=2048 research/05b-twin-jacobsthal-segmented.js > out-05b.txt 2> err-05b.txt
    node research/exact-g2-ladder.js > out-ladder.txt 2>&1

Then run `node research/qc/embed.js --check` on each of the three files and record its verdict lines. Report, verbatim, these values so two donors can be compared: the seven rows of `05` (p, twin slots, G2, at r) for p = 5..23; the 29# row of `05b` (twin slots = 214708725, G2 = 258, at r = 1205437109 are the embedded values; report what you got, not what is embedded); the lower-certificate table of `exact-g2-ladder.js` for x = 2..43 (G2 = 2, 6, 12, 30, 42, 66, 108, 150, 204, 258, 348, 528, 546, 618 embedded) and the "all lower certificates hold" line; and the threshold-safety table's nine sound rows.

Put `sha256sum out-05.txt out-05b.txt out-ladder.txt` in `hashes`. The embedded out-sha256 values are in each script's OUTPUT banner; report whether yours match and, if not, the first differing line (node version and timing lines differ legitimately; the tool normalises them, a raw diff may not).

Falsifier for the ladder: any G2 value, position or certificate line differing from the embedded block. That is returned rung `refuted` for the affected level with the diff. A clean reproduction is returned rung `measured` with wall time and node version. Do not write "verified"; write which lines matched and which you did not check.
