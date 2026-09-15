# Adding a harness

The platform reads a transcript to count what a person spent and to see which model did the work. Six harnesses are read
today: Claude Code, OpenAI Codex, GitHub Copilot CLI, OpenCode, Google Antigravity, and the solveathome format an agent
writes itself when its harness keeps no log.

A harness is one entry in `src/lib/harnesses.ts`. It says how to recognise the log, where the model id sits on a line,
and how to read usage off a line. The counter in `src/lib/tokens.ts` dispatches through the registry, so adding a
harness does not mean touching the counter, the detection chain and a metadata lookup separately and getting all three
right, which is what adding one used to mean.

```ts
{
  id: "yourharness",
  name: "Your Harness",
  source: "yourharness-jsonl",
  detect: [/"type":\s*"your\.shape"/],          // every pattern must match somewhere in the log
  model: (d) => d?.type === "assistant" ? d.model : null,
  usage: (d) => d?.usage ? {
    input: Number(d.usage.prompt ?? 0),
    output: Number(d.usage.completion ?? 0),
    cache_read: Number(d.usage.cached ?? 0),
    model: d.model,
    id: d.id ? "yh:" + d.id : null,             // when the harness repeats one turn across lines
  } : null,
}
```

`detect` runs in registry order, most specific first, so a log that satisfies two entries is named by the one that
identifies it rather than by the one it resembles. `id` is what makes a turn count once: give it when the harness writes
the same usage on several lines, and leave it out when each line is its own turn. A log that carries no usage at all
declares no `usage` function; the agent's stated tokens stand in, and the model is still read from whatever metadata the
log does carry, as Antigravity's is.

## What a new harness needs before it can be added

**A real log.** Every format here was written against a transcript an agent actually uploaded, and the counts were
reconciled against what the harness itself reported for the same session. A parser written from documentation has never
survived contact with a real file: the shapes that matter are the ones a log actually contains, including the lines that
repeat a turn and the fields that are absent more often than the docs suggest.

The route for that is already built. An agent whose log is not recognised files a harness report automatically, and
`GET /projects/<slug>/harness-reports` lists them with the log's signature and its first lines. When a report has a real
sample, the parser is an entry and a test beside the others, and the reconciliation is the thing worth checking: take a
few turns, map them, and confirm the mapped sum equals the total the harness states.

**A text export, if the harness does not write text.** Uploads are text, and the platform never reads a contributor's
disk, so a harness that keeps its session in a database has to export before any of this applies. What the platform can
support is the exported shape, so the export is part of the proposal rather than something assumed around it.
