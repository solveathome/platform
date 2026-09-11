/**
 * Revisions (Chris, Sep 9): the swarm edits the body of work with a full record. An accepted audit or paper return carries a
 * revised document; integration writes it to the overlay the site serves on top of the read-only mirror, records the version
 * (who changed it, who verified it, the unified diff), and moves a paper's current version forward. The mirror itself never changes;
 * accepted versions are what the owner pulls back into the research repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { createTwoFilesPatch } from "diff";
import { q, one } from "../db/index.js";
import { ROOT } from "./paths.js";
import * as files from "./files.js";

export const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
export const OVERLAY = process.env.OVERLAY_DIR ?? join(ROOT, "data", "overlay");
const EDITABLE = /\.(md|js|mjs|ts|py|lean|json|jsonl|csv|tsv|sh|tex|bib|txt|yaml|yml)$/i;

export function safeRel(path: string): string | null {
  const n = normalize("/" + String(path ?? "")).replace(/^\/+/, "");
  if (!n || n.split("/").some((s) => s === ".." || s.startsWith(".git")) || !EDITABLE.test(n)) return null;
  return n;
}
export function overlayPath(slug: string, rel: string): string { return join(OVERLAY, slug, rel); }
export function mirrorPath(slug: string, rel: string): string { return join(REPOS, slug, rel); }
/** The text the site serves for a document now: the overlay if the swarm revised it, else the mirror, else (agent-proposed paper) its current file. */
export async function currentText(slug: string, rel: string, problemId?: number): Promise<{ text: string; from: "overlay" | "mirror" | "paper" } | null> {
  const ov = overlayPath(slug, rel); if (existsSync(ov)) return { text: readFileSync(ov, "utf8"), from: "overlay" };
  const mp = mirrorPath(slug, rel); if (existsSync(mp)) return { text: readFileSync(mp, "utf8"), from: "mirror" };
  if (problemId) { const p = await one<{ current_file_sha: string | null }>(`SELECT current_file_sha FROM papers WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [problemId, rel]); const t = p?.current_file_sha ? files.read(p.current_file_sha) : null; if (t !== null && t !== undefined) return { text: t, from: "paper" }; }
  return null;
}
export async function exists(slug: string, rel: string, problemId?: number): Promise<boolean> { return (await currentText(slug, rel, problemId)) !== null; }

/** Integrate an accepted return's revision. Idempotent per return. */
export async function integrate(ret: any, slug: string, votes: Array<{ verdict: string; user_id: number; model?: string; verification?: string }>): Promise<void> {
  const rel = safeRel(ret.revision_path); if (!rel || !ret.revision_sha) return;
  if (await one(`SELECT 1 FROM document_versions WHERE return_id = $1`, [ret.id])) return;
  const next = files.read(ret.revision_sha); if (next === null) return;
  const base = await currentText(slug, rel, Number(ret.problem_id));
  const baseText = base?.text ?? "";
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
  const ov = overlayPath(slug, rel); mkdirSync(dirname(ov), { recursive: true }); writeFileSync(ov, next);
  await q(`UPDATE papers SET current_return_id = $3, current_file_sha = $4, status = 'reviewed', updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [ret.problem_id, rel, ret.id, ret.revision_sha]);
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
 */
export async function recordMirrorCut(slug: string, problemId: number, note = ""): Promise<Array<{ path: string; action: "unchanged" | "caught-up" | "recorded" | "missing"; version?: number }>> {
  const out: Array<{ path: string; action: "unchanged" | "caught-up" | "recorded" | "missing"; version?: number }> = [];
  const latest = await q<{ path: string; version: string; content_sha: string | null; id: number }>(
    `SELECT DISTINCT ON (path) path, version, content_sha, id FROM document_versions WHERE problem_id = $1 ORDER BY path, version DESC`, [problemId]);
  const keeper = await keeperFor(problemId, 0);
  for (const l of latest) {
    const mp = mirrorPath(slug, l.path);
    if (!existsSync(mp)) { out.push({ path: l.path, action: "missing" }); continue; }
    const text = readFileSync(mp, "utf8"), sha = files.sha256(text);
    const ov = overlayPath(slug, l.path);
    if (sha === l.content_sha) {
      if (existsSync(ov)) { unlinkSync(ov); out.push({ path: l.path, action: "caught-up", version: Number(l.version) }); }
      else out.push({ path: l.path, action: "unchanged", version: Number(l.version) });
      continue;
    }
    // Version 1 of a document nobody has revised since may simply have moved on in the repository: still a new version, so the link trail holds.
    const prevText = (l.content_sha ? files.read(l.content_sha) : null) ?? "";
    const version = Number(l.version) + 1;
    const diff = createTwoFilesPatch(`a/${l.path}`, `b/${l.path}`, prevText, text, `version ${l.version}`, `version ${version}`);
    if (!keeper) throw new Error(`project ${slug} has no researcher to hold the version blob`);
    await files.store(keeper, undefined, l.path.split("/").pop() ?? l.path, ext(l.path), text);
    const row = await one<{ id: number }>(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,$2,$3,$4,$5,NULL,$6,'[]',$7,$8) RETURNING id`,
      [problemId, l.path, version, sha, l.content_sha, keeper, `as mirrored from the research repository, cut of ${new Date().toISOString().slice(0, 10)}${note ? ` (${note})` : ""}`, diff]);
    await pin(sha, Number(row!.id));
    if (existsSync(ov)) unlinkSync(ov);
    await q(`UPDATE papers SET current_return_id = NULL, current_file_sha = $3, updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [problemId, l.path, sha]);
    out.push({ path: l.path, action: "recorded", version });
  }
  return out;
}
