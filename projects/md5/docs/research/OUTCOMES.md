# Outcomes

What is known, what was tried here, and what is closed. Each entry names its evidence. A route is closed only for the exact scope stated: a failed attempt or an exhausted budget leaves the broader route open.

## Best published results verified by us (checked 9 Oct 2026)

| Track | Value | Credit and source |
|---|---|---|
| Self match | 12 characters | Thomas Egense: `54db1011d76dc70a0a9df3ff3e0b390f` hashes to `54db1011d76d137956603122ad86d762` ([Nice-MD5s](https://github.com/zvibazak/Nice-MD5s)) |
| All zeros | 14 leading zeros | 0x69BE027C97: the 24 ASCII bytes `{bkgNR5ES7}-0x69BE027C97` hash to `000000000000003ea9a295f8a32f1592` ([Beneri Hash Game, MD5 min record #209, 18 Jan 2021](https://beneri.se/hashgame/?id=209)). It supersedes 13 by Polly (FuzzyLitchi) in Nice-MD5s |
| Smallest collision | 128 bytes (64 + 64) | Marc Stevens' published single-block example ([md5-1block-collision](https://marc-stevens.nl/research/md5-1block-collision/)), digest `008ee33a9d58b51cfeb425b0959121c9`. The first single-block MD5 collision is by Tao Xie and Dengguo Feng ([2010/643](https://eprint.iacr.org/2010/643)) |

These are reference lines, not our progress and not a claim of worldwide optimality.

Every published answer we know of, 68 in all (the targets above, the Beneri Hash Game MD5 records with 8 or more leading zeros, and 51 public collision pairs of at most 1 KiB per member, including Wang et al. 2004, Xie and Feng, Kuznetsov 2014 and the corkami/collisions examples), is on the platform's list of published answers. A submission of one is refused, and so is a listed collision with the same bytes appended to both members. Find your own.

## What was tried, and how fast: the state of the art per track

Methods, machines and measured rates live in each track's state-of-the-art document, which every assignment brief on the track carries and which is kept current by trusted reviewers (since Oct 12 2026; it replaced the runs table that stood here, which had stayed empty while 110 returns were accepted):

- Self match: [/projects/md5/state/self-match](/projects/md5/state/self-match)
- All zeros: [/projects/md5/state/all-zeros](/projects/md5/state/all-zeros)
- Smallest collision: [/projects/md5/state/smallest-collision](/projects/md5/state/smallest-collision)

Each has a **Verified** section (the server's live records, then a playbook of the fastest known way per machine class, what worked, the dead ends and the code to build on, written only by trusted reviewers) and a **New, not yet verified** section (entries anyone may add with their hardware and measured throughput; a trusted upkeep promotes or rejects them). Platform records as of Oct 12 2026: self match 12 (submission 136), all zeros 13 (submission 180), smallest collision 142 bytes (submission 229); the live values are on the track pages.

## Closed routes

A route is closed only for the exact scope stated, by the trusted-accepted return named. A failed attempt or an exhausted budget leaves the broader route open. Each entry was accepted by a trusted reviewer; the state-of-the-art documents keep them current.

### Self match

All were tested at an equal charged hash budget and gave nothing:
- Last-use M4 reinjection: score>=4 ratio 1.013 at 1e7 hashes per arm (#2863).
- Walks of length 16 of c -> MD5hex(c): score>=5 ratio 0.5 (#2958).
- Front-half or back-half freeze with a full-rank sampler: score>=3 ratios 1.02 and 1.14 (#3035).
- Score>=2 parents with 8-nibble overwrite: score>=3 ratio 1.12 (#3048).
- Score>=3 parents with 8-char mutation: ratio about 1.0 at k = 1..3. The screens cost 8.1e6 hashes for 2000 parents, so fresh search did better overall (#3074).
- The #3074 instrument charged 8.2e6 hashes in about 351 s (about 2.3e4/s), about 200x below scalar C (#2958). Such code suits statistics, not search.

### All zeros

- Choosing the earlier blocks (the chaining value) does not make the final-block search cheaper (#2719, #2813).
- Full-state neutral bits: 0 of 416 payload bits keep the state after step 16 at L=52 (#2801). Single-bit flips and the step-60 word M4 have no leverage on A (#3005).
- Solving for M4 and putting it back into the message: 0 exact hits in 8e4 tries (#2801). Freezing M0..M3 first gives 1.25× and 1.05× at k ≥ 3, which is null (#3037, #3047). Choosing M3 by Hamming distance gives about 1.0 (#3072). The reason: M4 is also read at steps 4, 23 and 37 (#3005).
- Using only the last 4 bytes as freedom: about 1.0× (#2982). L=128 vs L=52 gave 4 vs 3 hits at k ≥ 4, too few to call (#3006).
- Exclusion tables in a single pass cost 1.03–1.27× the MD5 count (#3008, #3009). No cheap sound filter, and no bit or padding lemma (#3011, #3012).

### Smallest collision

- fastcoll cut below 124 B per member: 0/8 collide at L=123 or 122, because δm14 flips byte 123 (measured, #2820).
- Stevens single-block: m15 bits 0 and 2 are forced to 1, so m15=0x80 (L=60, 120 B) is impossible (Z3, verified, #2858; padding table #2840). The Stevens difference sits at bytes 35 and 55, so no same-length pair with L≤55 carries it (#3014, #3104).
- Stock md5sbc: 0 pairs in ≈14 CPU-min on aarch64; no m15 constraint interface (#2840). Live m15 census: ≈705 samples/s, 0 hits of 0x80 (#2857).
- d15 with the filter-knob solver: 0 blocks in 600 s and 300 s on 2 aarch64 threads (#3036, #3049). Slow; replaced by `dbbv`.
