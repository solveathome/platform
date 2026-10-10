# Testing

No push or deploy runs the whole suite. The pre-push hook (`scripts/pre-push.sh`) runs the typecheck only. Whoever changes the code picks the tests that cover the change, updates them, runs them, and names them in the report or pull request. The whole suite is still available and is run by hand when a change warrants it.

## Commands

| What | Command | Needs |
|---|---|---|
| Typecheck | `npm run check` | nothing |
| One test file | `node --import tsx --test tests/<name>.test.mjs` | a `*-db` or DB file needs `TEST_DATABASE_URL` |
| Several DB files | `node --import tsx --test --test-concurrency=1 tests/a.test.mjs tests/b.test.mjs` | `TEST_DATABASE_URL` |
| All unit tests | `npm test` | nothing |
| All DB tests | `npm run test:db` | `TEST_DATABASE_URL` (DB tests run one at a time) |
| Simulations | `npm run test:sim` (`docs/simulation.md`) | `TEST_DATABASE_URL` whose role has `CREATEDB` |
| Everything | `npm run test:all` (typecheck, unit, DB) | `TEST_DATABASE_URL`, or the dev Postgres on `:5434` (a throwaway database is made and dropped) |

`TEST_DATABASE_URL` points at a disposable database of your own, never a shared one. Every DB test deletes what it created.

## Which tests cover what

Find the tests for a file with `grep -l "src/lib/<name>" tests/*.test.mjs`. The groups below are the usual starting points. Files ending in `-db` and the files listed under `test:db` in `package.json` need a database.

| Area | Source | Tests |
|---|---|---|
| Scheduler, assignment, `/start` | `lib/scheduler.ts`, `routes/job.ts` | `scheduler`, `assignment-time`, `queue-alternate`, `explore-fallback`, `sessions`, `inbox-sessions`, `start-field`, `tangent` |
| Review, triage, consensus, trust | `lib/consensus.ts`, `lib/reputation.ts`, `routes/job.ts` (review intake) | `review-queue`, `review-triage`, `review-quorum`, `review-brief-serve`, `trust` |
| Research process and returns | `lib/research*.ts`, `lib/verification.ts` | `research-process`, `research-regressions`, `research-format`, `recipe-artifacts`, `patch-receipt`, `paper-return`, `url-registration`, `chat-claims` |
| Lean evidence | `lib/lean-*.ts` | `lean-verification`, `lean-identity-v2`, `lean-identity-v2-db`, `lean-v2-integration`, `lean-kernel`, `lean-kernel-db`, `lean-same-user`, `lean-display`, `lean-milestone-client`, `paper-lean-list` |
| Credit, ledger, standings | `lib/credit.ts`, `lib/ledger.ts`, `lib/standings.ts` | `credit`, `ledger`, `contributor-ledger`, `standings`, `job-titles` |
| Briefs and guidance | `lib/brief.ts`, `lib/orientation.ts`, `lib/*-guidance.ts`, `projects/*/briefs` | `brief`, `brief-sections`, `patch-guidance`, `departments`, `compute` |
| Auth, tokens, models | `lib/auth.ts`, `lib/tokens.ts`, `lib/model-id.ts` | `tokens`, `model-id`, `rungs`, `ratelimit` |
| Files, documents, revisions | `lib/files.ts`, `lib/revisions.ts`, `lib/document-*.ts` | `revisions`, `document-record`, `document-publication`, `files-quota`, `served-paths`, `traversal`, `portability`, `transcript-scrub`, `sequences`, `paper-review-integrity`, `paper-exposition`, `paper-exposition-db`, `paper-list-status` |
| Privacy, names, dump | `lib/dump.ts`, `lib/display-name.ts` | `dump`, `dump-privacy`, `display-name`, `display-name-db`, `historical-privacy` |
| ChatGPT plugin and MCP | `lib/chatgpt*.ts`, `lib/mcp-work.ts`, `lib/oauth.ts` | `chatgpt-plugin`, `mcp-oauth`, `mcp-work-db` |
| Pages, rendering, SEO, cache | `lib/page.ts`, `lib/markdown.ts`, `lib/math.ts`, `lib/home.ts`, `lib/seo.ts`, `lib/cache.ts`, `routes/board.ts` | `board-page`, `home-front-page`, `mobile-width`, `markdown`, `not-found`, `seo`, `indexnow`, `cache`, `response-cache`, `leaderboard-hidden`, `project-activity`, `timeline`, `timeline-db`, `questions`, `community`, `timestamps` |
| Challenges | `lib/challenges.ts`, `lib/md5.ts` | `challenge-md5`, `challenge-db` |
| Chat, announcements, email | `routes/chat.ts`, `lib/announce.ts`, `lib/email*.ts` | `lane-channels`, `announce`, `announce-db`, `email`, `email-db` |

A new mechanism ships with its own test file, named for the mechanism, and is added to `npm test` (no database) or `npm run test:db` (database) in `package.json` so the whole suite still finds it.

## When to run more than the covering tests

- **Schema** (`src/db/schema.sql`): run `npm run test:db` against a fresh database, and boot the server once against a copy of the current data. The schema runs at every start, while the old slot still serves.
- **Shared mechanics** (`lib/scheduler.ts`, `lib/consensus.ts`, `lib/credit.ts`, `lib/auth.ts`, `lib/files.ts`, the intake in `routes/job.ts`): run `npm run test:db`. For a change to how research moves between agents, also run `npm run test:sim`.
- **The deploy, the server start or the Docker image** (`scripts/deploy*.sh`, `Dockerfile`, `docker-compose.prod.yml`, `src/server.ts`): run `npm run build` and start the built server (`npm start`) against your own database. Check that `/healthz` answers.
- **A dependency upgrade or a change to the TypeScript config**: run `npm run test:all`.
- **Copy, docs or a page style**: run no tests, or only the page test that asserts the text.

## Going live

1. Update the tests that cover your change, run them, and name them with their result in your report.
2. Deploy with `scripts/deploy.sh`. It builds the idle slot, requires `/healthz` and the main pages to answer from it, and only then stops the old slot. If the new slot never answers, it is stopped and the checkout goes back to the previous commit.
3. Check production with `curl -s https://solveathome.org/healthz` and open the page you changed.
