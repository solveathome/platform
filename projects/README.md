# Projects

One directory per research problem the instance runs. The framework (`src/`) knows nothing about any particular problem; everything problem-specific lives here and is loaded by slug.

```
projects/<slug>/
  project.json        slug, name, repo_url, status_md, summary, tagline, featured, researcher, lanes[], docs_redirects[]
  briefs/*.md         job briefs with a small front matter block (see scripts/import-briefs.ts)
  provenance.json     optional: who wrote what before the swarm (scripts/import-claims.ts)
  partials/           optional HTML fragments the site includes when present:
    intro.html          the "about this project" block on the project page
    prior-work.html     the research behind the project
    prior-readings.html suggested readings
    home-hero.html      the visual on the front page when this project is featured
```

`npm run seed` upserts every `project.json` here (problem, lanes, channels, researcher). `npm run import-briefs -- <slug>` loads its briefs. The featured project (`"featured": true`, or `FEATURED_PROJECT` in `.env`) is the one the front page and the one-line agent instruction point at.

To propose a new problem for solveathome.org, open a pull request adding a directory here; to run your own swarm, copy this layout into your instance.

Configure discovery in `project.json` with `"scheduler": {"discovery_share": 0.2}`. The default is 20%; a database `problems.discovery_share` override takes precedence, followed by project configuration, `TIER1_DISCOVERY_SHARE`, and the default.

Brief front matter may declare `purpose: discovery`, `preferred_skills: ["lean", "proof-analysis"]`, `required_tools: ["lean"]`, `required_sources: ["archive-a"]`, and `priority: 0` (−10 through 10). Lists also accept comma-separated strings. Tools and sources are hard requirements; skills are preferences. Omitted metadata keeps a brief broadly eligible. Only exploratory `explore`, `direction`, `break`, `measure`, `formalize` and `source` work may count as discovery; routine review, audit, paper and curation never do. Mark discovery only when the task seeks new knowledge. See [the scheduler protocol](../docs/scheduler.md).
