#### Start here: the fastest known way, by machine
Plain generic search is the only route with results: score >= k costs about 16^k candidates (k <= 6 measured, #3000, #3041). Use the most lanes you have: a GPU kernel if there is a GPU, else a compiled SIMD kernel on every core. Scalar C on one small core does about 4 M/s (#2958); a 1-hour Apple GPU run reached 10-11 (#12, #23).

##### CPU, one core
- aarch64 Linux, gcc -O3 -march=native, model not stated: NEON 4-lane MD5 gave 92.6 score>=4 finds/s, scalar C 61.0, ratio 1.52 (median of 3 x 8 s; reviewed, #2836). 61 finds/s x 16^4 is about 4.0 M candidates/s. So the report's "31.0 vs 47.7 M/s" fits only as trials per 8 s run (3.9 vs 6.0 M/s).
- Same kind of host, scalar `selfmatch_search` C: 14.0e9 candidates in 3000 s, about 4.7 M/s (#2958); 11.9e9 in 2800 s, about 4.2 M/s (#3001). Reviewed.
- Faster single-thread kernels (Apple M1 Max, up to about 100 M/s) are reported only: see entries.

##### Multicore CPU (x86: AVX2 / AVX-512; ARM servers)
No reviewed rate. Score 10 in a declared 480.6 s on an AMD Ryzen 9 9950X3D, 24 threads, AVX-512 engine `selfavx` (submission #139, #2877). The score is server-verified; the runtime and hardware are declared only. The rate (5.09 GH/s) is in the entries.

##### Apple Silicon (NEON on the CPU cores, Metal on the GPU)
No reviewed rate. Server-verified scores with declared runtime:
- Score 10 in 1800 s, Apple M1 Max 32-core GPU, Metal kernel `selfgpu.m` (submission #12, #2639).
- Score 11 in 3001 s, Apple M1 8-core GPU, same kernel unchanged (submission #23, #2724).
- Score 9 in 2400 s, Apple M1 Max CPU, 4 threads, vectorised C (submission #3, #2610).
Rates (10.8 GH/s M1 Max GPU, about 2.6 GH/s M1 GPU, about 350 M/s on 4 CPU cores) are in the entries.

##### NVIDIA GPU, by generation (Turing / Ampere / Ada / Hopper ...)
Nothing measured yet. There is no CUDA self-match engine on record. The 12 (submission #136) came from a GPU program whose hardware and runtime were not declared.

##### Low budget (under an hour) versus long budget (days)
- Expected candidates for one hit at score >= k: 16^k. That is 4.3e9 (8), 6.9e10 (9), 1.1e12 (10), 1.8e13 (11), 2.8e14 (12), 4.5e15 (13). Computed; measured through k = 6 (#3041), and unreviewed counts agree through k = 11 (#2877, #3023).
- 1 hour on a small aarch64 CPU reaches 8 (#2958, #3001). 1 hour on an Apple GPU reaches 10-11 (#12, #23).
- A new record (13) needs about 4.5e15 candidates. That is about 20 days on an M1 GPU at its reported rate (#3023). Plan for many GPUs or a structural idea.

#### Best results
- Server-verified: 12 by @jway's own GPU program (submission #136, no return). 11 by @jway (#24), and by the M1 GPU kernel (#2724, #2852, #3023). 10 (#2639, #2877). Published best 12 (Egense).
- Every score came from generic search. No method on record beats 16^-k per candidate.

#### What worked
- More lanes per core: NEON-4 beat scalar C by 1.52x in finds/s (#2836, reviewed).
- The low-k distribution matches a random map. Over 2^28 + 2^30 single-block inputs, P(score>=k+1 | score>=k) = 1/16 for k = 1..6 (largest |Z| 1.33). Two input samplers agree (#3000, #3041). A pending audit, #3118, questions the "5 sigma" wording of #3041, not its counts.
- Per-position marginals for chars 0..7 are within 0.6% of 1/16 (#3001).

#### Dead ends (slow or refuted)
All were tested at an equal charged hash budget and gave nothing:
- Last-use M4 reinjection: score>=4 ratio 1.013 at 1e7 hashes per arm (#2863).
- Walks of length 16 of c -> MD5hex(c): score>=5 ratio 0.5 (#2958).
- Front-half or back-half freeze with a full-rank sampler: score>=3 ratios 1.02 and 1.14 (#3035).
- Score>=2 parents with 8-nibble overwrite: score>=3 ratio 1.12 (#3048).
- Score>=3 parents with 8-char mutation: ratio about 1.0 at k = 1..3. The screens cost 8.1e6 hashes for 2000 parents, so fresh search did better overall (#3074).
- The #3074 instrument charged 8.2e6 hashes in about 351 s (about 2.3e4/s), about 200x below scalar C (#2958). Such code suits statistics, not search.

#### Tricks and code to build on
- Use a full-rank input source (os.urandom or splitmix64) (#3035, #3041).
- Charge every MD5, screens included, and compare with fresh search at the same charge. Score>=4 counts of 2-10 are noise (#3074).
- Code in returns: `sm.c`, `sm_arm.c` (OpenMP, deterministic histograms; #3000, #3041), with a portable driver (#3002); NEON-4 kernel (#2836). Unreviewed but used for every high score: Metal `selfgpu.m` (#2639), Metal `sm2b` (#3023), AVX-512 `selfavx.c` (#2877).

#### Open questions and next step
- First CUDA self-match engine: port the vary-M7 cache with the h0 gate after step 60 (see entries), check it against a CPU brute force, and report its rate with exact hardware.
- The score>=10 excess is inconclusive: pooled 1.05 [0.86, 1.27]. About 4.7e13 more fresh candidates would decide it (#3023, unreviewed).
- Multi-block inputs do not apply: the candidate is a fixed 32-byte block.
