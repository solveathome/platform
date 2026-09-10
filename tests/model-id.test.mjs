import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalModel } from "../src/lib/model-id.ts";

test("variants of one model collapse to one id", () => {
  const cases = {
    "claude-opus-5": "claude-opus-5",
    "claude-opus-5[1m]": "claude-opus-5",
    "Claude-Opus-5 [1m]": "claude-opus-5",
    "claude-opus-5[1m][thinking]": "claude-opus-5",
    "anthropic/claude-opus-5": "claude-opus-5",
    "us.anthropic.claude-opus-5-v1:0": "claude-opus-5",
    "claude-opus-5@20260901": "claude-opus-5",
    "claude-opus-5:latest": "claude-opus-5",
    "claude-opus-5-latest": "claude-opus-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
    "claude-fable-5-1": "claude-fable-5-1",
    "gpt-6-astra": "gpt-6-astra",
    "openai/gpt-6-astra": "gpt-6-astra",
    "codex": "codex",
    "  ": "",
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(canonicalModel(raw), want, raw);
});

import { providerFromModel, defaultTier } from "../src/lib/model-id.ts";
test("provider and default tier come from the family, not a list", () => {
  assert.equal(providerFromModel("claude-opus-5"), "anthropic");
  assert.equal(providerFromModel("gpt-6-astra"), "openai");
  assert.equal(providerFromModel("gemini-3-pro"), "google");
  assert.equal(providerFromModel("llama-5-70b"), "meta");
  assert.equal(providerFromModel("something-new"), "unknown");
  assert.equal(defaultTier("claude-fable-5-1").tier, 1);
  assert.equal(defaultTier("gpt-6-astra").tier, 1);
  assert.equal(defaultTier("claude-opus-5").tier, 2);
  assert.equal(defaultTier("claude-sonnet-5").tier, 3);
  assert.equal(defaultTier("claude-haiku-4-5").tier, 4);
  assert.equal(defaultTier("gpt-5-mini").tier, 4);
  assert.equal(defaultTier("gemini-3-flash").tier, 4);
  assert.equal(defaultTier("something-new").tier, 3);
  assert.equal(defaultTier("something-new").rule, "unknown family");
});

import { parseTranscript } from "../src/lib/tokens.ts";
test("a [1m] header matches a plain model in the JSONL (agent feedback, Sep 10)", () => {
  const jsonl = JSON.stringify({ message: { id: "m1", model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 5 } } });
  const observed = Object.keys(parseTranscript(jsonl).models);
  const declared = canonicalModel("claude-opus-5[1m]");
  assert.deepEqual(observed, ["claude-opus-5"]);
  assert.ok(observed.some((m) => m === declared));
});
