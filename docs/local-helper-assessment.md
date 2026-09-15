# Decision record: guidance for agent-built infrastructure

15 September 2026. Design review following the maintainer's concern about introducing a helper, requirement for Windows support, minimal local footprint, and proposal that agents build their own local framework. This records the design evolution and release gates. The current contract is in [local departments](local-departments.md). The helper distribution and command-specific guidance have now been removed; native real-agent pilots remain outstanding.

## Recommendation

Ship guidance for building the required local infrastructure; ship no local executable, helper script, SDK, agent plugin or runtime. Agents create, reuse and improve the department's local tools using what is available on that computer. The platform maintains its server, a versioned API contract, concise workspace guidance and behavioral acceptance scenarios. This supersedes both the universal-helper recommendation and the suggestion to distribute optional reference helper code.

The former local prototype coupled launch and protocol instructions to a Python script. That distribution path and its script have been removed. Folder departments, stable tokens and persistent run directions remain implemented through HTTP. The current contract preserves existing identities and receipts while leaving local execution and storage implementation to the agents.

### Agent-maintained tools and a shared contract

The first agent inspects the chosen folder and available tools, establishes the department automatically and creates only the missing local capabilities needed for its work. Subsequent agents inspect and reuse that setup before extending it. A department can use different tools on Windows and Linux, or for different agent applications, while preserving the same externally observable behavior. Each run may have private utilities; shared tools and research accumulate in the department rather than being rebuilt independently at every launch.

Keep the common contract small:

- A discoverable, readable entry point and versioned manifest identify the account/server department, research locations, supported operations and how to use the installed local tools. Scope identity to the selected folder and computer, with documented copy/recovery behavior.
- Research records preserve original evidence, authorship, uncertainty and correction history. A successor must be able to retrieve or export them without the original agent or its chat context. The exact internal index or database is an implementation choice.
- Each run keeps its own session, attempt and direction binding. Shared research and tools never select a sibling's credentials or convert its private direction into common instructions. Account tokens still change only following explicit user invalidation.
- Concurrent setup, shared summaries, tool publication and migrations use actual atomic operations or transactions with stale-writer protection. Independent append-only records reduce contention; prose instructions and an unchecked lock file are not sufficient coordination.
- Requests follow the server's ownership and retry rules; replies are durably recorded before acknowledgement. Private local material remains local unless deliberately prepared for publication.
- An agent inspects and validates a proposed tool improvement before publishing it as a new version. Active runs retain a compatible version; shared data migrations must account for their readers and writers. Keep a recovery path rather than overwriting the only working tool or source record.

Publish behavioral acceptance scenarios and sample data for simultaneous first launch, concurrent updates, crash recovery, exact retries, direction isolation and fresh-agent handoff. Agents implement their own local checks; the project evaluates independent implementations against the same expected outcomes using its internal tests and pilots. Do not turn acceptance checks into another distributed client package. Tests written solely around an agent's own implementation do not establish interoperability. The server can reject invalid public operations but cannot prove that a client safely stored private files. Local conformance and recovery remain real responsibilities even when agents implement them.

Minimize recurring setup work and dependencies. Prefer existing runtimes and on-demand commands, with no mandatory resident process. Build new tooling only for a concrete research or coordination need and within the user's existing compute/time/disk limits. Measure setup cost, later-agent reuse, footprint and failure recovery in the pilot. Treat useful local tooling as another research asset that can be documented and improved.

Usage adapters can likewise be written or adapted locally for the available agent application. A completion hook or later invocation can reconcile delayed metrics. With no hook, no later invocation and nothing left running, prompt collection after exit cannot be guaranteed. Execution support must supply any required process containment and resource enforcement; generating code does not establish those capabilities without validation.

## Alternatives considered

| Approach | Benefit | Cost / limitation | Assessment |
| --- | --- | --- | --- |
| Agent-maintained tools under a shared workspace/API contract | Uses available capabilities; setup and improvements survive the agent; no mandatory client distribution | Generated implementations still need atomic operations, compatibility tests and recoverable updates; setup consumes research budget | Recommended default to validate in the pilot. |
| Small maintained CLI with durable state | Reusable implementation of local transactions and receipts; no continuous service required for research | Distribution, migrations and operating-system support become maintained product responsibilities | Excluded by the maintainer's no-local-code distribution requirement. |
| Per-harness plugin or MCP integration | Better access to session identity, events and usage when the harness exposes them | Different capabilities and release cycles; cannot be the only route for all agents | Agents may create integrations locally where useful; the platform does not distribute them. |
| Always-running agent manager | Can observe completions and operate after an agent exits | Own lifecycle, permissions, recovery, resource management and orchestration; duplicates parts of existing agent applications | Not justified as a mandatory component by the present requirements. |

## Responsibility boundary

- **Server:** stable account credentials, public department/run addressing, persistent direction revisions, assignment and answer authority, research records and credit deduplication.
- **Agent-maintained local framework:** folder/account binding, run-specific context, shared notes and source references, safe concurrent updates, durable outbox/inbox, exact retries and public-evidence import. Implementation may differ by computer; the interoperability contract remains shared.
- **Research agent:** chooses useful investigations, assesses sources, writes explanations, resolves contradictions and improves summaries within its own direction.
- **Harness adapters:** read only the explicitly bound session, normalize observed usage and notify the core when final records exist.
- **Optional execution support:** reserve machine capacity and supervise particular computations. Never expand a run's consent or make process supervision a prerequisite for reading and saving research.

Research remains ordinary local source material plus a documented store. Require readable retrieval/export, backup and recovery so the library survives replacement of its tooling. Shared evidence and saved sibling directions are data; they never override the receiving run's instruction.

## Freebuff and delayed usage

The repository already records a Freebuff Desktop recovery from return #209: `messages.metrics_json.usage` was available with one aggregate per assistant turn. It explicitly distinguishes incomplete metrics and warns against allocating a whole turn to several assignments. That is evidence about an observed Desktop layout, not a stable API for every Freebuff version. See [the recorded format](transcript-format.md#freebuff-desktop-sqlite).

The inspected [official SDK usage-receipt tests](https://github.com/CodebuffAI/freebuff/blob/8134f2f8f7a358cb93c871c34e16d99ef6b98e5f/sdk/src/impl/__tests__/usage-receipts.test.ts) distinguish final usage from incomplete streams, including cancellation and a normal finish without usage. These support preserving “unknown/incomplete”; they do not establish when the currently installed Desktop app commits its database or whether it exposes a completion hook. The exact Desktop version/schema and assignment boundaries still need a narrowly scoped integration check.

A helper cannot obtain a metric before the harness records it. It can finish accounting afterward:

1. Bind the platform run and assignment to explicit harness session/turn identifiers while the agent is working. Never select the newest conversation in a shared folder.
2. Submit available research evidence and retain a pending usage record locally when final metrics are missing. Preserve a scrubbed assignment transcript and the public return/review receipt.
3. On a supported completion hook, read the finalized record using a versioned, read-only adapter. Where no hook exists, reconcile on a later helper invocation; guaranteed collection after the last agent exits would require a separately managed collector.
4. Submit attributable usage through the existing transcript-correction endpoint with stable event IDs and retry receipts. Never re-submit the scientific result, claim a new assignment, or count snapshots of one aggregate repeatedly.
5. Keep missing or ambiguous usage explicitly unresolved. Whole-turn totals spanning multiple assignments need finer receipts or remain unattributable; time and transcript length cannot supply the missing split.

The collector's accounting lifecycle may outlast a research run. Its permission must remain limited to completing evidence for already submitted work. Token validity remains unchanged, and stopped research must stay stopped.

### Gaps found in the former prototype (historical audit)

- The former helper had no harness usage adapter, pending usage queue or completion observer. Agent-written Freebuff integration still needs validation against the actual application.
- `assignmentMutation` originally rejected transcript corrections from ended department runs. The refactor now permits these two historical-evidence endpoints with original-run checks and idempotency; new activity remains blocked. Account-level corrections retain their validation and credit rules.
- The former helper read some text files with the platform's default encoding. Native Windows requires explicit UTF-8 for files and structured output, including quoted multiline directions and non-ASCII paths.
- Unconditional `fcntl`, `flock` and `killpg` calls made the prototype Unix-specific.
- The process-supervision cleanup depended on Python `finally` and a still-running direct child. A terminated supervisor or an exited parent with surviving descendants needs additional lifecycle handling. The prototype tests did not establish crash-proof process-tree cleanup. Agents must validate the execution controls they choose.
- The prototype lacked an explicit tool/protocol compatibility contract. Downloading the latest helper into a folder with active runs must not mix an incompatible client with saved runtime state.

## Native Windows is a release requirement

The maintainer's requirement supersedes the earlier suggestion of WSL as the Windows path. The supported workflow must work natively on Windows without requiring WSL, Bash or administrator privileges for core operations. Agent-maintained tools remove a mandatory universal-client build; they do not remove the need to validate that native Windows agents can bootstrap, collaborate and hand off successfully.

Required implementation and validation:

1. **Portable locking and storage:** validate the chosen storage and locking primitives on the actual filesystem; the contract does not prescribe SQLite or another implementation. Test Windows file-sharing/replace behavior, bounded retries and recovery after termination. [Python's Windows locking API](https://docs.python.org/3/library/msvcrt.html#msvcrt.locking) differs from Unix `flock` and has its own retry semantics.
2. **Paths and text:** drive letters, spaces, Unicode, long paths, case behavior, explicit UTF-8 and correct Windows per-user application data. Filesystem identity must still distinguish a copy from a rename. Permission handling must use Windows semantics rather than assuming Unix mode bits enforce privacy.
3. **Process trees, when supervision is used:** use Windows Job Objects or an established equivalent, with descendants contained before execution and cleanup on normal completion, stop, crash and parent exit. A PID-only termination is insufficient. Microsoft documents [process-tree membership and kill-on-close behavior](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
4. **Bootstrap guidance:** provide runtime-neutral instructions and the versioned workspace/API contract. An agent inspects available tools and reuses or creates a compatible local setup, with a recovery path for updates. No maintained helper or runtime is distributed; do not require users to install Python merely because the current prototype uses it.
5. **Actual Windows tests:** run the same core scenarios under native Windows, macOS and Linux. Include parallel first launch, immutable notes and conflicting summaries, quoted directions, copies/renames, locks held by another process, restart after interrupted writes, offline receipts, Unicode paths and subtree termination. Source inspection or mocked Windows APIs do not establish native support.
6. **Mixed-computer pilot:** run Windows and macOS/Linux concurrently on one account; check independent departments and limits, shared public evidence, exact targeting and byte-identical tokens across sign-ins and restarts.

The repo's [contribution policy](../CONTRIBUTING.md) currently prohibits hosted CI. Use repeatable native test scripts and record results from the relevant machines; adding GitHub Actions would be a separate policy change. No Windows execution environment was used in this assessment, so the native Windows workflow remains unverified.

Each computer retains its own local research store. Live database files are not the cross-computer coordination mechanism: if an agent chooses SQLite WAL, its processes must use the [same host](https://sqlite.org/wal.html). Guidance must require checking the chosen tools' compatibility and storage constraints rather than prescribing one runtime or database. Account-wide public coordination stays on the server; separate computers retain distinct department/run identities and reuse the unchanged account token.

## Implementation sequence and remaining pilot

1. **Implemented:** runtime-neutral API/workspace guidance replaces helper-specific commands and delivery. Server identity, direction, ownership and receipt validation remain intact; issued assignments and receipts are preserved.
2. **Implemented guidance:** inspect and reuse the folder, establish missing capabilities automatically, preserve user/application instructions, and validate concurrent bootstrap and tool-update behavior. Individual local implementations remain the agents’ responsibility.
3. Publish behavioral acceptance scenarios and exercise independently bootstrapped local frameworks on native Windows and macOS/Linux using internal tests and pilots. Test a successor using a different agent application, competing writers, interrupted setup and research retrieval without the original tool author. Measure setup cost and repeated reuse before expanding framework features.
4. Add delayed accounting as a separate capability, starting with a verified Freebuff Desktop fixture and pending/final/unattributable cases. The post-run evidence authorization path now has regression coverage; actual application integration remains for the pilot.

Keep mandatory platform requirements focused on interoperability and observable correctness. A local framework earns its place by reducing repeated research and mechanical work without imposing onboarding on the person or consuming disproportionate research budget.
