import {recordPublication} from "./document-record.js";
/**
 * Revisions (Chris, Sep 9): the swarm edits the body of work with a full record. An accepted audit or paper return carries a
 * revised document; integration writes it to the overlay the site serves on top of the read-only mirror, records the version
 * (who changed it, who verified it, the unified diff), and moves a paper's current version forward. The mirror itself never changes;
 * accepted versions are what the owner pulls back into the research repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { createTwoFilesPatch } from "diff";
import { q, one, queueFileEffect, pendingFileText, projectTransaction } from "../db/index.js";
import { ROOT } from "./paths.js";
import * as files from "./files.js";
import { reopenRegressed } from "./findings.js";

export const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
export const OVERLAY = process.env.OVERLAY_DIR ?? join(ROOT, "data", "overlay");
const EDITABLE = /\.(md|js|mjs|ts|py|lean|json|jsonl|csv|tsv|sh|tex|bib|txt|yaml|yml)$/i;

export function safeRel(path: string): string | null {
  // Normalise as POSIX so a document path is forward-slash on every platform. win32 path.normalize rewrites the
  // separator to a backslash: that leaked into stored paths and left them one segment, defeating the guards below.
  const n = posix.normalize("/" + String(path ?? "").replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!n || n.split("/").some((s) => s === ".." || s.startsWith(".git")) || !EDITABLE.test(n)) return null;
  return n;
}
export function overlayPath(slug: string, rel: string): string { return join(OVERLAY, slug, rel); }
export function mirrorPath(slug: string, rel: string): string { return join(REPOS, slug, rel); }
/** The text the site serves for a document now: the overlay if the swarm revised it, else the mirror, else (agent-proposed paper) its current file. */
export async function currentText(slug: string, rel: string, problemId?: number): Promise<{ text: string; from: "overlay" | "mirror" | "paper" } | null> {
  const pending = await pendingFileText(overlayPath(slug, rel));
  if (pending?.content !== null && pending?.content !== undefined) return { text: pending.content, from: "overlay" };
  const ov = overlayPath(slug, rel); if (!pending && existsSync(ov)) return { text: readFileSync(ov, "utf8"), from: "overlay" };
  const mp = mirrorPath(slug, rel); if (existsSync(mp)) return { text: readFileSync(mp, "utf8"), from: "mirror" };
  if (problemId) { const p = await one<{ current_file_sha: string | null }>(`SELECT current_file_sha FROM papers WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [problemId, rel]); const t = p?.current_file_sha ? files.read(p.current_file_sha) : null; if (t !== null && t !== undefined) return { text: t, from: "paper" }; }
  return null;
}
export async function exists(slug: string, rel: string, problemId?: number): Promise<boolean> { return (await currentText(slug, rel, problemId)) !== null; }

/**
 * What integrating an accepted revision did (Sep 24 2026, paper review integrity), kept on the return and shown with it:
 * applied (the next version), unchanged (the document already is that text), conflict (the document moved on from the text the revision
 * was made against; nothing is overwritten and a rebase job carries it forward), missing (the revised file is not in the store).
 */
export type Integration = "applied" | "unchanged" | "conflict" | "missing";
/** Integrate an accepted return's revision. Idempotent per return. */
export async function integrate(ret: any, slug: string, votes: Array<{ verdict: string; user_id: number; model?: string; verification?: string }>): Promise<Integration | null> {
  return projectTransaction(ret.problem_id, () => integrateLocked(ret, slug, votes));
}
async function integrateLocked(ret: any, slug: string, votes: Array<{ verdict: string; user_id: number; model?: string; verification?: string }>): Promise<Integration | null> {
  const rel = safeRel(ret.revision_path); if (!rel || !ret.revision_sha) return null;
  if (await one(`SELECT 1 FROM document_versions WHERE return_id = $1`, [ret.id])) return "applied";
  const outcome = async (o: Integration) => { await q(`UPDATE returns SET integration = $2 WHERE id = $1`, [ret.id, o]); return o; };
  const next = files.read(ret.revision_sha); if (next === null) return outcome("missing");
  const base = await currentText(slug, rel, Number(ret.problem_id));
  const baseText = base?.text ?? "";
  const head = base ? files.sha256(baseText) : null;
  if (head === ret.revision_sha) {
    await q(`UPDATE papers SET current_return_id = $3, current_file_sha = $4, updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2)) AND COALESCE(current_file_sha, $4) = $4`, [ret.problem_id, rel, ret.id, ret.revision_sha]);
    return outcome("unchanged");
  }
  // Compare and set on the text the author and reviewers worked from: a revision made against an older text never replaces a newer one.
  // An older return without a recorded base is integrated as before; its base is unknown and is not filled in with the current head.
  if (head && ret.revision_base_sha && head !== ret.revision_base_sha) return outcome("conflict");
  const last = await one<{ version: string }>(`SELECT max(version) AS version FROM document_versions WHERE problem_id = $1 AND path = $2`, [ret.problem_id, rel]);
  let version = Number(last?.version ?? 0);
  if (version === 0 && base && base.from !== "paper") {
    // Version 1 is the document as it stood before the swarm touched it, kept as a blob (Chris, Sep 10): a link into a document
    // made before the swarm revised it must always resolve to the text that was linked, and a mirror cut must not erase it.
    const keeper = await keeperFor(Number(ret.problem_id), Number(ret.user_id));
    const { sha } = await files.store(keeper, undefined, rel.split("/").pop() ?? rel, ext(rel), baseText);
    const v1 = await one<{ id: number }>(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,$2,1,$3,NULL,NULL,NULL,'[]',$4,'') RETURNING id`,
      [ret.problem_id, rel, sha, base.from === "mirror" ? "as mirrored from the research repository" : "as served"]);
    await pin(sha, Number(v1!.id));
    version = 1;
  }
  const accepting = votes.filter((v) => v.verdict === "accept");
  const verifiers = await q<{ id: number; handle: string }>(`SELECT u.id, u.handle FROM users u WHERE u.id = ANY($1::bigint[])`, [accepting.map((v) => Number(v.user_id))]);
  const tiers = await q<{ model: string; tier: number }>(`SELECT model, tier FROM model_tiers WHERE model = ANY($1::text[])`, [accepting.map((v) => v.model ?? "").filter(Boolean)]);
  // Provenance (Q68): who verified this version and with what, so the next reviewer knows which eyes have seen it.
  const verifiedModels = accepting.map((v) => ({ handle: verifiers.find((u) => Number(u.id) === Number(v.user_id))?.handle ?? null, model: v.model ?? null, tier: tiers.find((t) => t.model === v.model)?.tier ?? null, verification: v.verification ?? "read" }));
  const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, baseText, next, `version ${version}`, `version ${version + 1}`);
  const summary = String(ret.report_md ?? "").split("\n").find((l: string) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 300) ?? "";
  const row = await one<{ id: number }>(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff, author_model, verified_models) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ret.problem_id, rel, version + 1, ret.revision_sha, files.sha256(baseText), ret.id, ret.user_id, JSON.stringify(verifiers.map((v) => v.handle)), summary, diff, ret.model ?? null, JSON.stringify(verifiedModels)]);
  await pin(String(ret.revision_sha), Number(row!.id));
  await queueFileEffect(overlayPath(slug, rel), next);
  await q(`UPDATE papers SET current_return_id = $3, current_file_sha = $4, status = 'reviewed', updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [ret.problem_id, rel, ret.id, ret.revision_sha]);
  await reopenRegressed(Number(ret.problem_id), rel, String(ret.revision_sha));
  return outcome("applied");
}

export async function history(problemId: number, rel: string) {
  return q(`SELECT v.version, v.content_sha, v.return_id, v.verified_by, v.verified_models, v.author_model, v.summary, v.created_at, u.handle AS author, u.display_name AS author_name, r.model, length(v.diff) AS diff_chars
            FROM document_versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN returns r ON r.id = v.return_id WHERE v.problem_id = $1 AND v.path = $2 ORDER BY v.version`, [problemId, rel]);
}
export async function revisedPaths(problemId: number): Promise<Map<string, { versions: number; author: string; verified: string[]; at: string; swarm: boolean }>> {
  const rows = await q(`SELECT DISTINCT ON (v.path) v.path, v.version, v.verified_by, v.created_at, v.return_id, u.handle FROM document_versions v LEFT JOIN users u ON u.id = v.author_user_id WHERE v.problem_id = $1 ORDER BY v.path, v.version DESC`, [problemId]);
  return new Map(rows.map((r: any) => [r.path, { versions: Number(r.version), author: r.handle, verified: r.verified_by ?? [], at: r.created_at, swarm: !!r.return_id }]));
}

const ext = (rel: string) => (rel.split(".").pop() ?? "md").toLowerCase();
/** Whose file-store row holds a version blob: the project's researcher, else the user given. Blobs of versions are pinned, so curation never removes them. */
async function keeperFor(problemId: number, fallback: number): Promise<number> {
  const p = await one<{ researcher_user_id: number | null }>(`SELECT researcher_user_id FROM problems WHERE id = $1`, [problemId]);
  return Number(p?.researcher_user_id ?? fallback);
}
async function pin(sha: string, versionId: number): Promise<void> {
  await q(`INSERT INTO file_refs (file_sha, ref_type, ref_id) VALUES ($1,'document_version',$2) ON CONFLICT DO NOTHING`, [sha, versionId]);
}

/**
 * After a mirror cut (Chris, Sep 10): the research repository is the researcher's edition and a cut may change a document the swarm
 * has already revised. For every document with history: if the new mirror equals the latest version, the repository has caught up and
 * the overlay is dropped (the served text does not change); if it differs, the cut is recorded as the next version (author: the
 * researcher, no reviewers, diff against the latest) and served in place of the overlay. The trail never loses its base.
 *
 * A cut equal to an older version is stale (Sep 24 2026, paper review integrity): the repository has not pulled the accepted revisions
 * yet, and recording it would silently undo them, as a cut of Sep 16 did to an accepted correction of beta2-note. It is reported and the
 * served version stays. The owner who means to go back names the path in `promote`, and the cut is recorded as usual. A recorded cut
 * never carries a review: the paper's pointer to the accepted return is cleared and its summary names the accepted version it replaces.
 */
export type CutAction = "unchanged" | "caught-up" | "recorded" | "stale" | "missing";
export async function recordMirrorCut(slug: string, problemId: number, note = "", options: { promote?: string[] } = {}): Promise<Array<{ path: string; action: CutAction; version?: number; matches?: number }>> {
  return projectTransaction(problemId, async () => {
    await recordPublication(slug, problemId);
    return recordMirrorCutLocked(slug, problemId, note, new Set(options.promote ?? []));
  });
}
async function recordMirrorCutLocked(slug: string, problemId: number, note: string, promote: Set<string>): Promise<Array<{ path: string; action: CutAction; version?: number; matches?: number }>> {
  const out: Array<{ path: string; action: CutAction; version?: number; matches?: number }> = [];
  const latest = await q<{ path: string; version: string; content_sha: string | null; id: number; return_id: string | null }>(
    `SELECT DISTINCT ON (path) path, version, content_sha, id, return_id FROM document_versions WHERE problem_id = $1 ORDER BY path, version DESC`, [problemId]);
  const keeper = await keeperFor(problemId, 0);
  for (const l of latest) {
    const mp = mirrorPath(slug, l.path);
    if (!existsSync(mp)) { out.push({ path: l.path, action: "missing" }); continue; }
    const text = readFileSync(mp, "utf8"), sha = files.sha256(text);
    const ov = overlayPath(slug, l.path);
    if (sha === l.content_sha) {
      if (existsSync(ov) || await pendingFileText(ov)) { await queueFileEffect(ov, null); out.push({ path: l.path, action: "caught-up", version: Number(l.version) }); }
      else out.push({ path: l.path, action: "unchanged", version: Number(l.version) });
      continue;
    }
    const older = await one<{ version: string }>(`SELECT max(version) AS version FROM document_versions WHERE problem_id = $1 AND path = $2 AND content_sha = $3 AND version < $4`, [problemId, l.path, sha, l.version]);
    if (older?.version && !promote.has(l.path)) { out.push({ path: l.path, action: "stale", version: Number(l.version), matches: Number(older.version) }); continue; }
    // Version 1 of a document nobody has revised since may simply have moved on in the repository: still a new version, so the link trail holds.
    const prevText = (l.content_sha ? files.read(l.content_sha) : null) ?? "";
    const version = Number(l.version) + 1;
    const diff = createTwoFilesPatch(`a/${l.path}`, `b/${l.path}`, prevText, text, `version ${l.version}`, `version ${version}`);
    if (!keeper) throw new Error(`project ${slug} has no researcher to hold the version blob`);
    await files.store(keeper, undefined, l.path.split("/").pop() ?? l.path, ext(l.path), text);
    const replaces = l.return_id ? `; replaces version ${l.version}, accepted in return #${l.return_id}` : "";
    const how = promote.has(l.path) ? "promoted by the owner from the research repository" : "as mirrored from the research repository";
    const row = await one<{ id: number }>(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,$2,$3,$4,$5,NULL,$6,'[]',$7,$8) RETURNING id`,
      [problemId, l.path, version, sha, l.content_sha, keeper, `${how}, cut of ${new Date().toISOString().slice(0, 10)}${note ? ` (${note})` : ""}${replaces}`, diff]);
    await pin(sha, Number(row!.id));
    await queueFileEffect(ov, null);
    await q(`UPDATE papers SET current_return_id = NULL, current_file_sha = $3, status = CASE WHEN status = 'reviewed' THEN 'draft' ELSE status END, updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [problemId, l.path, sha]);
    await reopenRegressed(problemId, l.path, sha);
    out.push({ path: l.path, action: "recorded", version });
  }
  return out;
}

/**
 * Serve an earlier version again, as a recorded version of its own (recovery, Sep 24 2026): the history keeps every step, including the
 * one being undone, and nothing is paid or re-reviewed. The paper points at the accepted return whose text it is, if any. Idempotent:
 * a document already serving that text is left alone. `apply: false` reports what it would do.
 */
export async function restoreVersion(slug: string, problemId: number, rel: string, version: number, reason: string, apply: boolean): Promise<{ action: "restored" | "unchanged" | "would-restore"; version?: number; sha: string; return_id: number | null }> {
  return projectTransaction(problemId, async () => {
    const v = await one<{ content_sha: string | null; return_id: string | null }>(`SELECT content_sha, return_id FROM document_versions WHERE problem_id = $1 AND path = $2 AND version = $3`, [problemId, rel, version]);
    if (!v?.content_sha) throw new Error(`${rel} has no stored version ${version}`);
    const text = files.read(v.content_sha); if (text === null) throw new Error(`the blob of ${rel} version ${version} is missing`);
    const accepted = await one<{ id: string }>(`SELECT id FROM returns WHERE problem_id = $1 AND revision_path = $2 AND revision_sha = $3 AND status = 'accepted' AND NOT provisional ORDER BY id DESC LIMIT 1`, [problemId, rel, v.content_sha]);
    const rid = v.return_id ? Number(v.return_id) : accepted ? Number(accepted.id) : null;
    const cur = await currentText(slug, rel, problemId);
    if (cur && files.sha256(cur.text) === v.content_sha) return { action: "unchanged", sha: v.content_sha, return_id: rid };
    const last = await one<{ version: string; content_sha: string | null }>(`SELECT version, content_sha FROM document_versions WHERE problem_id = $1 AND path = $2 ORDER BY version DESC LIMIT 1`, [problemId, rel]);
    const next = Number(last?.version ?? 0) + 1;
    if (!apply) return { action: "would-restore", version: next, sha: v.content_sha, return_id: rid };
    const keeper = await keeperFor(problemId, 0);
    if (!keeper) throw new Error(`project ${slug} has no researcher to author the restore`);
    const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, cur?.text ?? "", text, `version ${last?.version ?? 0}`, `version ${next}`);
    const row = await one<{ id: number }>(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,$2,$3,$4,$5,NULL,$6,'[]',$7,$8) RETURNING id`,
      [problemId, rel, next, v.content_sha, cur ? files.sha256(cur.text) : null, keeper, `restored version ${version}${rid ? ` (accepted in return #${rid})` : ""}: ${reason}`.slice(0, 300), diff]);
    await pin(v.content_sha, Number(row!.id));
    // Served from the overlay unless the mirror already is this text.
    const mp = mirrorPath(slug, rel);
    await queueFileEffect(overlayPath(slug, rel), existsSync(mp) && files.sha256(readFileSync(mp, "utf8")) === v.content_sha ? null : text);
    await q(`UPDATE papers SET current_return_id = $3, current_file_sha = $4, updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [problemId, rel, rid, v.content_sha]);
    await reopenRegressed(problemId, rel, v.content_sha);
    return { action: "restored", version: next, sha: v.content_sha, return_id: rid };
  });
}
