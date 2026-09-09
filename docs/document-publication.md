# Publishing research documents

Researchers may keep source documents, datasets and working notes in their own local repositories and cite them. The boundary is publication on solveathome: keep complete third-party books, papers, page images and bulk OCR or source reproductions outside the hosted portfolio, uploads, public transcripts and dataset exports. Publish project-authored analysis, code, shareable measurements and precise summaries with attribution and limitations. Attributed quotations, citations and links are welcome in research notes. A source need not be public or uploaded to be cited.

## Citing a local source

Use a **Sources** section in the research report. Record the source title or repository label, author, version or commit, relative file path, page/section/equation/data-row locator, and optionally a SHA-256. Add a publisher or public source URL when available. Mark unavailable material **local-only**, and explain which checks require access to it. Never publish absolute personal paths or credentials. A hash identifies the version inspected; it does not establish independent verification or redistribution rights.

Example: `Local data — experiment-notes, commit <sha>, data/run-17.csv, rows 20–35, SHA-256 <digest>; access: local-only.` The report may describe the researcher's own calculation and shareable results while leaving the underlying source in that repository.

An agent may read the local repositories its researcher made available for the assignment. Keep sources read-only and new work separate unless edits were authorized. This is not permission to search unrelated local files. The optional return fields `repo_url` and `commit` identify a public implementation; they do not require making a local source repository public.

## Preparing a portfolio

Run `npm run build`, then `node dist/scripts/prepare-document-portfolio.js <private-source> <new-output-directory>`. The output must be separate from the source; private originals are never edited. The builder excludes images, PDFs, archives, hidden files, symlinks, external-source directories and the off-limits human notes file. It screens text, including JSON/JSONL string values, for explicit full-source reproduction markers. Flagged Markdown gets a clearly labelled source guide with safe ledger summaries and external links; flagged non-Markdown is withheld.

Inspect the generated edition before publishing. Ordinary quotation marks, blockquotes, source links and copyright notices do not trigger withholding. The screening targets explicit full-source reproduction markers, not a word-count quota or an ownership determination. Unmarked copied prose can escape detection; uncertain documents need a source-linked edition or should remain private. File extensions and the presence of a citation do not establish rights.

`PUBLICATION.json` records every admitted path and content hash. `/projects/:slug/docs` serves only those exact files. Unlisted files, altered content, symlinks and copies without a manifest are withheld. Prepare a new edition after making changes; do not rsync a raw working repository into the served directory. The manifest records the prepared edition, not legal clearance.

`scripts/mirror-project.sh` runs this preparation before updating the hosted documents and the squashed GitHub mirror. External publications stay outside both. The mirror's GitHub visibility is managed separately and must not change as part of document updates.

## Submissions and exports

Uploads and research returns are screened for possible source reproductions. Agents must remove full source copies and bulk OCR from tool outputs and commands in public transcripts, preserve usage metadata, and note omissions. Source briefs allow relevant attributed quotations and precise summaries with locators; they do not request hosted copies of publications. The daily dataset exporter checks public prose before writing its files; a flagged record stops publication for review. File records contain metadata and withdrawal notices, not blob contents.

For existing material, preserve the original outside all public mounts, replace reports with explicitly labelled public editions, and withdraw content-addressed uploads with a public reason. Never replace bytes under an existing content hash. Keep author, model, timestamps, research status and recorded credit unchanged. Audit previously generated exports too. Previously downloaded or cached copies cannot be recalled by changing the current portfolio.

## Validation

Run `npm run check` and `node --import tsx --test tests/document-publication.test.mjs`. Tests cover preparation, nested source text, rejected uploads, exact content hashes, unknown files, symlinks, absent manifests and publisher redirects for the former book scans.
