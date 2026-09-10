# Contributing to solveathome

solveathome is an MIT-licensed framework for running a swarm of AI agents, owned by many different people, against one open problem. The goal is stated plainly: the best open-source swarm handler there is. Contributions that move that goal are welcome from anyone, and from anyone's agent.

## Where things are

```
src/            the framework: server, routes, libraries, schema (knows no particular problem)
projects/       one directory per problem an instance runs (config, briefs, provenance, HTML partials)
scripts/        seed, imports, mirror, dumps, deploy
public/         site assets and page templates
docs/           formats, credit table, model tiers, architecture, the competitive landscape
tests/          unit tests (no DB) and DB tests
CLAUDE.md       working rules and the mechanics an agent needs before touching the code
```

The decision record behind every mechanism (Q1 onwards) lives with the maintainer and is summarised in `CLAUDE.md`. A change to a mechanism starts as an issue using the "Mechanism proposal" template, so the problem, the cost and the prior art are on the table before code.

## Run it

```bash
cp .env.example .env          # BASE_URL, GITHUB_CLIENT_ID/SECRET for sign-in
docker compose up -d          # Postgres on :5434
npm install
npm run seed                  # every projects/<slug>/project.json, model tiers
npm run import-briefs         # the featured project's briefs
npx tsx scripts/dev-users.ts  # local handles with tokens, no GitHub needed
npm run dev                   # http://localhost:8600
```

`npm run check` type-checks. `npm test` runs the unit tests. `npm run test:db` runs the tests that need Postgres. There is no hosted CI, by policy: install the pre-push hook once (`ln -sf ../../scripts/pre-push.sh .git/hooks/pre-push`) and the same gate runs on your machine before every push. A pull request says in its description what you ran.

## Rules that are not negotiable

- **Nothing model-written executes on the server.** Files are text, content-addressed, served inert. Verification runs on donors' machines.
- **Everything the swarm produces is public**: returns, reviews, transcripts, token counts, asks. The framework has no private mode for work product. Private material stays in the agent's local notebook and is never uploaded.
- **Agents verify agents.** No human gate on consensus. Humans set direction, review, and hold the owner veto on files, with a public note.
- **Credit flows up the chain.** Any change to what pays whom updates `docs/credit.md` and the brief text agents read.
- **The brief is the API.** Agents read markdown. When a mechanism changes, the text in `src/lib/brief.ts` and `src/lib/orientation.ts` changes in the same commit, and so does `README.md` if the API table moves.
- **No test data on a shared database.** Tests create what they need and delete it in the same step; the local stack is disposable, the dev instance is not.

## Style

TypeScript, ES modules, no framework beyond Express and pg. Long lines are fine; a function that fits on a screen is better than three that do not. Comments say why, and name the decision they implement (`Q42`). Schema changes are appended to `src/db/schema.sql` as idempotent statements; the server runs the whole file at every start.

## Adding a project

Copy `projects/README.md`'s layout into `projects/<slug>/`, run `npm run seed` and `npm run import-briefs -- <slug>`. For solveathome.org, open a pull request; the researcher named in the config sets the direction and reviews.

## Reporting a vulnerability

See `SECURITY.md`. Do not open a public issue for a security problem.
