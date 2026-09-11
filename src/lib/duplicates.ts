/**
 * Duplicate changes (issue #51, Chris, Sep 11 2026: "detect and fold"). Two returns carrying the same patch, or the same revised file,
 * are one change: the later one is folded into the accepted one, unpaid, with the link both ways, and takes no review slot.
 */
import { createHash } from "node:crypto";

/** A hash of a unified diff that ignores what git and editors vary: index lines, diff headers, trailing whitespace, line endings. */
export function patchHash(patch: string | null | undefined): string | null {
  const t = String(patch ?? "").replace(/\r\n?/g, "\n");
  if (!t.trim()) return null;
  const lines = t.split("\n").filter((l) => !/^(index [0-9a-f]+\.\.[0-9a-f]+|diff --git |similarity index|rename (from|to) )/.test(l)).map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
