import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue #68: the questions table is mathematics, so an escaped bar in a cell is an absolute value, not a column separator.
// Splitting on every bar dropped three questions from the served table outright (Q-corner-measurement, Q-kernel-sign-control,
// Q-gap-spectrum) and cut seven verdicts short of their 300 characters, one of them at 147, losing the estimate and the open
// caveat that followed it. A dropped OPEN question is one the lead scheduler can never hand out.
const tmp = mkdtempSync(join(tmpdir(), "questions-"));
process.env.DOCS_DIR = tmp;
const slug = "q-fixture";
mkdirSync(join(tmp, slug, "research"), { recursive: true });
writeFileSync(join(tmp, slug, "research", "QUESTIONS.md"), [
  "| Item | Question | Status | Verdict | Sources |",
  "| --- | --- | --- | --- | --- |",
  "| C | `Q-plain` Does the bound hold? | OPEN | Nothing measured yet. | [a.md](a.md) |",
  "| C | `Q-bar-question` Does \\|K\\|/mass decay? | PARTIAL | No asymptotic claim. | [a.md](a.md) |",
  "| C | `Q-bar-verdict` Can a finite norm be bounded? | PARTIAL | We measured sum \\|G_L G_R\\|=O(x); the signed margin is OPEN. | [a.md](a.md) |",
  "| C | `Q-plain` A duplicate id is ignored. | OPEN | Second row. | [a.md](a.md) |",
  "| C | `Q-closed` Settled long ago. | CLOSED | Done. | [a.md](a.md) |",
  "| C | not-a-question-id | OPEN | Skipped. | [a.md](a.md) |",
  "Prose about `Q-not-in-a-table` that is not a row at all.",
].join("\n"));

const { questions, openQuestions, cells } = await import("../src/lib/questions.ts");
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

test("issue #68: an escaped bar is cell content, so the row is kept and the verdict is whole", () => {
  const byId = Object.fromEntries(questions(slug).map((q) => [q.id, q]));
  assert.ok(byId["Q-bar-question"], "a question containing |K| is no longer dropped");
  assert.equal(byId["Q-bar-question"].text, "Does |K|/mass decay?", "the escape is unwrapped: the reader sees the absolute value");
  assert.equal(byId["Q-bar-question"].status, "PARTIAL");
  assert.equal(byId["Q-bar-verdict"].verdict, "We measured sum |G_L G_R|=O(x); the signed margin is OPEN.",
    "the verdict keeps its estimate and the caveat after it, instead of stopping at the backslash");
});

test("the rest of the table parses as it did: ids, statuses, duplicates and non-rows", () => {
  const list = questions(slug);
  assert.deepEqual(list.map((q) => q.id), ["Q-plain", "Q-bar-question", "Q-bar-verdict", "Q-closed"], "OPEN and PARTIAL sort first; a duplicate id is taken once");
  assert.equal(list.find((q) => q.id === "Q-plain").verdict, "Nothing measured yet.");
  assert.equal(list.find((q) => q.id === "Q-plain").item, "C");
  assert.equal(questions(slug).find((q) => q.id === "Q-not-in-a-table"), undefined, "prose outside the table is not a question");
  assert.deepEqual(openQuestions(slug).map((q) => q.id), ["Q-plain", "Q-bar-question", "Q-bar-verdict"], "the escaped-bar question is available to the lead schedule");
  assert.deepEqual(questions("no-such-project"), []);
});

test("cells splits a row on unescaped bars only", () => {
  assert.deepEqual(cells("| a | b |"), ["", " a ", " b ", ""]);
  assert.deepEqual(cells("| a \\| b | c |"), ["", " a | b ", " c ", ""]);
  assert.deepEqual(cells("no bars here"), ["no bars here"]);
});
