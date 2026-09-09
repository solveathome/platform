# Publishing research documents

Keep third-party books, papers, page images, OCR and copied source passages outside the hosted document portfolio. Cite an external source URL and a page, equation or section locator instead. Publish project-authored analysis, code, measurements and precise summaries with their attribution and limitations. A research citation does not grant permission to redistribute its source.

## Preparing a portfolio

Run `npm run build`, then `node dist/scripts/prepare-document-portfolio.js <private-source> <new-output-directory>`. The output must be separate from the source; private originals are never edited. The builder excludes images, PDFs, archives, hidden files, symlinks, external-source directories and the off-limits human notes file. It screens text, including JSON/JSONL string values, for source-reproduction markers. Flagged Markdown gets a clearly labelled source guide with safe ledger summaries and external links; flagged non-Markdown is withheld.

Inspect the generated edition before publishing. Automated screening is a conservative aid, not an ownership determination or a word-count permission. Unmarked copied prose can escape detection; uncertain documents need a source-linked edition or should remain private. File extensions and the presence of a citation do not establish rights.

`PUBLICATION.json` records every admitted path and content hash. `/projects/:slug/docs` serves only those exact files. Unlisted files, altered content, symlinks and copies without a manifest are withheld. Prepare a new edition after making changes; do not rsync a raw working repository into the served directory. The manifest records the prepared edition, not legal clearance.

`scripts/mirror-project.sh` runs this preparation before updating the hosted documents and the squashed GitHub mirror. External publications stay outside both. The mirror's GitHub visibility is managed separately and must not change as part of document updates.

## Submissions and exports

Uploads and research returns are screened for possible source reproductions. Agents must remove copied material from tool outputs and commands in transcripts, preserve usage metadata, and note omissions. Source briefs request paraphrases and locators rather than copied pages. The daily dataset exporter checks public prose before writing its files; a flagged record stops publication for review. File records contain metadata and withdrawal notices, not blob contents.

For existing material, preserve the original outside all public mounts, replace reports with explicitly labelled public editions, and withdraw content-addressed uploads with a public reason. Never replace bytes under an existing content hash. Keep author, model, timestamps, research status and recorded credit unchanged. Audit previously generated exports too. Previously downloaded or cached copies cannot be recalled by changing the current portfolio.

## Validation

Run `npm run check` and `node --import tsx --test tests/document-publication.test.mjs`. Tests cover preparation, nested source text, rejected uploads, exact content hashes, unknown files, symlinks, absent manifests and publisher redirects for the former book scans.
