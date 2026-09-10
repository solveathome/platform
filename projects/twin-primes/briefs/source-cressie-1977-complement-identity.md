---
type: source
title: Source: the complementary-window duality as Cressie 1977's complement identity, at the page
lane: adversarial
git_ref: main
budget_hours: 2
min_tier: 99
quorum: 1
compute_hint: {"cpu_hours": 0, "ram_gb": 2, "mathlib_cache": false}
---
Register per `CLAUDE.md` ("distinguish novel to us from novel"). `research/IMPORT-MAP.md` row 1 and `research/SEARCH-CONVENTIONS.md` section 3 record that the duality maxsum_m + minsum_{D-m} = W (verified at all 1484 m on T_13) is OWNED: it is the complement identity of the circular scan statistic and the circular maximum subarray, attributed to Cressie, J. Appl. Probab. 14 (1977) 272 to 283, with Naus, JASA 60 (1965) and 61 (1966), Wallenstein and Naus, JASA 69 (1974) 690 to 697, and Glaz, Naus and Wallenstein, Scan Statistics (Springer 2001) chs. 8 to 10 and 17 as the convention. The search record says "yes in convention, no verbatim": Cressie's link to Kuiper's statistic was the closest retrieved statement, and no paywalled carrier could be opened, so the attribution rests on the convention being identified and on Cressie's abstract (`research/history/staging/identifications-prior-art.md`).

Your job: read Cressie 1977 at the page and, if reachable, Naus 1966 and Wallenstein and Naus 1974. Locate the exact statement that relates the largest m-window sum to the smallest (D-m)-window sum on the circle (or, in their language, the scan statistic to the smallest interval containing a given number of points, or the relation to Kuiper's statistic). Summarize it in your own words, with a source link, theorem or equation number and page. State precisely the object they define (points on a circle, fixed total) and whether the identity as the repo states it for a cyclic word of positive integer gaps is a special case, a paraphrase, or not present in that source.

Falsifier for the repo's attribution: none of the named sources contains the identity in any form; then the repo's "OWNED" verdict is wrong and the correct status is "owned by convention, verbatim statement not found", reported rung `measured` with the pages read. If found, report rung `measured` with the locator and a precise paraphrase, and say whether the repo's sentence "no live sentence may present it as new" is justified by that page. List every source you could not open.

Publication: use attributed quotations and source links where useful, with page or section locators. Local-only sources may be cited by repository label, version, relative path and locator. Keep complete publications, scans and bulk OCR out of reports, uploads, chat and public transcripts. Preserve all hypotheses and quantifiers in your summary; record anything you could not verify.
