# Local research system simulations

`npm run test:sim` exercises the research workflow with scripted contributors against the real Express routes and PostgreSQL scheduler. It creates its own temporary database, starts a loopback HTTP service, runs the scenarios, and removes that database and its uploaded files. The database named by `TEST_DATABASE_URL` is only the connection from which it creates the temporary database; it is never migrated or cleared.

```sh
TEST_DATABASE_URL=postgres://solveathome:solveathome@localhost:5434/solveathome_research_test npm run test:sim
```

Use a local disposable Postgres instance and a role with `CREATEDB`. The normal Docker Compose database role supports this. No AI provider keys, model calls, deployment, or external research services are involved. The tiny finite checker runs in a simulated contributor's subprocess, outside application request handling. Application code still only validates, stores, schedules and serves.

The default run tests sixteen scenarios with seeds 17, 42 and 99:

| Scenario | What must hold |
|---|---|
| `ecosystem` | With a large review backlog, most frontier hours still go to discovery and pursuit. Promising routes advance, scripted prior-art and assumption failures stop early, one negative can be rescued, unchanged experiments stop, and useful results continue while awaiting review. Distinct finite results require distinct executions; an unchanged package is not executed twice. |
| `lateChallenge` | A trusted rejection of earlier feasibility evidence flags later pursuit. An interrupted investigation can return its evidence without clearing that flag. A fresh rescue can replace the failed argument without erasing history. |
| `verification` | Identical pending packages share execution. Exact duplicate claims share one judgment and result payment. One capability failure gets a targeted reassignment; a second inability stops retries. Missing execution retains compute needs. Receipt retries are idempotent, acceptance waits for judgment, and expensive execution does not inflate the independent judgment budget. |
| `interruptions` | Concurrent registration retries return one assignment. An abandoned worker's assignment is recovered through the normal expiry sweep. A late result cannot overwrite the replacement's work, and a session cannot reclaim work it released. |

Every round also checks that a route has at most one open investigation, a session holds at most one assignment, and accepted results have trusted review. Each assignment is checked against the simulated contributor's compute offer, declared tools and source access. Executions require another contributor and model. Assertions fail the command with a nonzero exit code. A failed scenario does not prevent the remaining scenarios from running.

The regression scenarios `transitiveEvidence`, `withdrawnReceipt`, `waitingCheck`, `duplicateClaims`, `freshProbe`, `lateConflict` and `firstAcceptance` cover the deep-review findings, including changed evidence after acceptance. They also run in the database test suite.

`opusResearch` runs only untrusted Opus agents, with six pending self-assigned claims and a large eligible mechanical backlog. They still get discovery capacity, propose new routes, probe and pursue successive results while judgment waits. It verifies separate tier budgets and preserves the pending cap for requests that require judgment. `opusRescue` checks that Opus can investigate a historical Astra negative, that an unchanged Opus negative does not get automatic same-model rescue, and that a changed linked approach is allowed. Both scenarios also run in the database suite.

`timedResearch` models overlapping task durations, eight successive distinct leads, a capability retry and an eight-hour outage of a two-model trusted reviewer pool. It checks that review backlog grows during the outage and drains after recovery. A local virtual clock moves only fixture timestamps relative to PostgreSQL; production has no test clock. Research, execution attempts, judgment and other work have separate scripted time totals. The report shows verification time per distinct accepted fixture claim. This is a test of an explicitly cheap-check workload, not an estimate of real AI savings.

`priorWorkFirst` scripts an external prior-art lookup that finds the proposed count already published. Triage and later pursuit can stop as `known`, with no computation, review or automatic rescue; a linked uncovered extension remains possible, and updated search records reach the next researcher. These source findings are fixtures: the simulation does not browse or establish actual novelty.

`guidanceDelivery` follows discovery, probe, pursuit, execution and judgment through the real assignment API. It checks task-specific instructions, online-first policy, persisted guidance versions, exact retry replay and one execution reused for judgment. This checks delivery and workflow, not model compliance or research quality; the [guidance record](agent-guidance.md) describes a separate live evaluation plan.

## Replay and inspect

```sh
npm run test:sim -- --seeds=42 --scenario=verification --out=data/simulations/verification-42
npm run test:sim -- --seeds=17,42,99 --rounds=60 --out=data/simulations/longer-run
```

Keep `TEST_DATABASE_URL` set for those commands. Seeds control the order of agent participation and finite input sizes. Concurrent requests deliberately retain real request races; generated IDs and measured process timings can differ between runs. `--rounds` controls the mixed ecosystem (30–80 rounds); the other scenarios stop at their explicit end conditions.

Each output directory contains:

- `report.md`: a readable pass/fail table with allocated research and consolidation hours.
- `report.json`: configuration, assertions that failed, and final counts for routes, jobs, returns, receipts and budgets.
- `<scenario>-<seed>.json`: a chronological event trace and final snapshot. Authentication tokens and session credentials are omitted.

Research and consolidation hours are assignment budgets, not observed AI time or money saved. Only the toy package's reconstruction, execution and negative-control time is measured on the worker. Novelty, scientific judgments and route outcomes are scripted assumptions. These simulations can expose workflow errors, starvation, wasted assignments and unsafe state transitions; they cannot establish that real agents will discover useful mathematics or that the allocation percentages are optimal.

## Extend the small harness

`tests/simulation/harness.mjs` contains database isolation, contributor clients, the fixed toy checker, observations and invariant checks. `tests/simulation/scenarios.mjs` exports ordinary async functions taking a world and run options. Add a function to its `scenarios` object to make it selectable through the command.

Drive work through `actor.start()`, `actor.submit()`, `actor.request()` and `world.read()`. `world.take()` advances the actual scheduler until the desired assignment appears, completing incidental work through the same API. It fails at a bounded limit rather than silently hanging.

SQL is reserved for initial world fixtures, observation and explicitly logged fault injection. Do not use it to bypass an inconvenient scheduler choice, manufacture a successful scientific result, or repair state after a failed assertion. Keep this harness out of the production server. Run it locally when changing research mechanics; the ordinary unit and database suites remain the fast pre-push gate, with no hosted CI.
