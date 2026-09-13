import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {sha256} from "../src/lib/document-publication.js";
import {isoTime, type SourceDates} from "../src/lib/timestamps.js";

/** Only dates and object IDs leave the source repository, never commit messages or identities.
 * Git dates are repository evidence, not independently certified discovery dates. */
export function sourceDates(root: string, path: string, published: string | Buffer): SourceDates {
  const unavailable: SourceDates = {created_at: null, modified_at: null, first_commit: null, last_commit: null, state: "unavailable", public_edition: false};
  const git = (args: string[], input?: Buffer) => execFileSync("git", ["-C", root, "--literal-pathspecs", ...args], {encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], timeout: 10000, maxBuffer: 8 * 1024 * 1024}).trim();
  try {
    const original = readFileSync(join(root, path));
    const rows = git(["log", "--follow", "--format=%H%x09%cI", "--", path]).split("\n").filter(Boolean).map(line => line.split("\t"));
    if (!rows.length) return {...unavailable, state: "uncommitted"};
    const last = rows[0], first = rows.at(-1)!;
    const committed = git(["rev-parse", `HEAD:./${path}`]) === git(["hash-object", "--stdin"], original);
    const complete = git(["rev-parse", "--is-shallow-repository"]) === "false";
    return {created_at: complete ? isoTime(first[1]) : null, modified_at: committed ? isoTime(last[1]) : null,
      first_commit: complete ? first[0] : null, last_commit: last[0], state: committed ? "committed" : "uncommitted", public_edition: sha256(original) !== sha256(published)};
  } catch { return unavailable; }
}
