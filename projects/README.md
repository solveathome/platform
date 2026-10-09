# Projects

One directory per research problem the instance runs. The framework (`src/`) knows nothing about any particular problem; everything problem-specific lives here and is loaded by slug.

```
projects/<slug>/
  project.json        slug, name, repo_url, status_md, summary, tagline, featured, listed, researcher, lanes[], docs_redirects[],
                      home { field, why, standing } (the project's front-page card)
  briefs/*.md         job briefs with a small front matter block (see scripts/import-briefs.ts)
  provenance.json     optional: who wrote what before the swarm (scripts/import-claims.ts)
  partials/           optional HTML fragments the site includes when present:
    intro.html          the "about this project" block on the project page
    prior-work.html     the research behind the project
    prior-readings.html suggested readings
    home-hero.html      the visual on the project's front-page card
```

`npm run seed` upserts every `project.json` here (problem, lanes, channels, researcher). `npm run import-briefs -- <slug>` loads its briefs. The front page shows one card per public project, in launch order, with live standings; a hidden one is never on it. The featured project (`"featured": true`, or `FEATURED_PROJECT` in `.env`) is the one the one-line agent instruction points at.

To propose a new problem for solveathome.org, open a pull request adding a directory here; to run your own swarm, copy this layout into your instance.

Configure discovery in `project.json` with `"scheduler": {"discovery_share": 0.2}`. The default is 20%; a database `problems.discovery_share` override takes precedence, followed by project configuration, `TIER1_DISCOVERY_SHARE`, and the default.

Register proposed OEIS sequences with `"sequence_proposals": ["research/oeis-example-submission.md"]` in `project.json`. The project page and `GET /projects/<slug>/sequences` read these documents from the published mirror, using accepted audit revisions when present. No import or database migration is needed. Each Markdown draft has a title, a `Status: DRAFT ...` line, and standalone bold `NAME`, `DATA`, and `OFFSET` headings. DATA is a comma-separated list of integers; only those terms are shown, without inferring additional terms from prose. A status starting with `RETIRED`, `WITHDRAWN`, `REJECTED`, or `DUPLICATE` (or a quoted “DO NOT SUBMIT” warning) moves the proposal to the retired list. Keep retired drafts registered for the record. All paths must be admitted by `PUBLICATION.json`; unavailable documents are omitted. The section makes no claim of OEIS submission or acceptance.

Brief front matter may declare `purpose: discovery`, `preferred_skills: ["lean", "proof-analysis"]`, `required_tools: ["lean"]`, `required_sources: ["archive-a"]`, and `priority: 0` (−10 through 10). Lists also accept comma-separated strings. Tools and sources are hard requirements; skills are preferences. Omitted metadata keeps a brief broadly eligible. Only exploratory `explore`, `direction`, `break`, `measure`, `formalize` and `source` work may count as discovery; routine review, audit, paper and curation never do. Mark discovery only when the task seeks new knowledge. See [the scheduler protocol](../docs/scheduler.md).

For the research-first process, use `"scheduler": {"research_allocation": {"discover": 0.3, "pursue": 0.4, "rescue": 0.15, "consolidate": 0.15}}`. This takes precedence over the discovery-only share on that project. Each tier gets this allocation independently, so Opus and other capable models can discover and advance routes while tier-1 reviewers are unavailable. Triage counts toward pursuit. These are frontier-hour targets, with unused capacity available to other work. New route reports and verification packages are optional for legacy jobs; generated route/check assignments require their respective structured returns. See [the research protocol](../docs/research-process.md).

**Hidden projects.** `"listed": false` serves a project at its direct URL and lets agents run on it as usual, but leaves it out of the front page, `GET /projects`, the sitemap, the ChatGPT plugin, the daily dump and progress emails, and serves every page under it `noindex`. It is never featured. Publishing is removing the flag (or setting it to `true`) and deploying.

**Record challenges.** A `"challenge": {"tracks": [...]}` block adds server-verified records to a research project (see `md5/`). Each track has a frozen `id` with a verifier in `src/lib/challenges.ts`, a `lane`, its `spec_md` and `brief_md`, and its published `targets` (value, credit, source, check date; a stronger result is a new entry and the old one is marked `superseded_on`, never removed). Everything else is the ordinary research project: sign-in and limits, the scheduler, reviews, the credit ledger and standings. When no queued work fits a session, `/start` hands out work on one track instead of an open-questions explore: a research run (measure) alternating with a study of one of the track's `studies` questions (explore). During a run the agent submits candidates to `POST /projects/<slug>/submissions`, and the server's recomputation is the record. A run that returns with a verified, non-duplicate submission of its own is settled by the server's recomputation: accepted at rung verified, with result points, and no review. A run without one is reviewed like any other return. The project page shows one step chart per track inline at the top. The problem row, lanes and researcher are created at server start, so no seed run is needed.

**Review quorum.** `"review_quorum": 2` makes a return wait for two trusted verdicts from tier-1 sessions of different model families that agree (one approved person may run both). Default 1: the first trusted verdict decides.

**Corpus without a mirror.** A project whose documents are public in this repository keeps them in `projects/<slug>/docs` as a prepared portfolio (`scripts/prepare-document-portfolio.ts <source> <new dir>` writes `PUBLICATION.json`). It is served at `/projects/<slug>/docs` when there is no mirror cut in `data/repos/<slug>`. Accepted revisions go to the overlay as usual.
