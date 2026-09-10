/**
 * Revisions (Chris, Sep 9): the swarm edits the body of work with a full record. An accepted audit or paper return carries a
 * revised document; integration writes it to the overlay the site serves on top of the read-only mirror, records the version
 * (who changed it, who verified it, the unified diff), and moves a paper's current version forward. The mirror itself never changes;
 * accepted versions are what the owner pulls back into the research repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { createTwoFilesPatch } from "diff";
import { q, one } from "../db/index.js";
import { ROOT } from "./paths.js";
import * as files from "./files.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");
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
    // Version 1 is the document as it stood before the swarm touched it.
    await q(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff) VALUES ($1,$2,1,$3,NULL,NULL,NULL,'[]',$4,'')`,
      [ret.problem_id, rel, files.sha256(baseText), base.from === "mirror" ? "as mirrored from the research repository" : "as served"]);
    version = 1;
  }
  const accepting = votes.filter((v) => v.verdict === "accept");
  const verifiers = await q<{ id: number; handle: string }>(`SELECT u.id, u.handle FROM users u WHERE u.id = ANY($1::bigint[])`, [accepting.map((v) => Number(v.user_id))]);
  const tiers = await q<{ model: string; tier: number }>(`SELECT model, tier FROM model_tiers WHERE model = ANY($1::text[])`, [accepting.map((v) => v.model ?? "").filter(Boolean)]);
  // Provenance (Q68): who verified this version and with what, so the next reviewer knows which eyes have seen it.
  const verifiedModels = accepting.map((v) => ({ handle: verifiers.find((u) => Number(u.id) === Number(v.user_id))?.handle ?? null, model: v.model ?? null, tier: tiers.find((t) => t.model === v.model)?.tier ?? null, verification: v.verification ?? "read" }));
  const diff = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, baseText, next, `version ${version}`, `version ${version + 1}`);
  const summary = String(ret.report_md ?? "").split("\n").find((l: string) => l.trim() && !l.startsWith("#"))?.trim().slice(0, 300) ?? "";
  await q(`INSERT INTO document_versions (problem_id, path, version, content_sha, base_sha, return_id, author_user_id, verified_by, summary, diff, author_model, verified_models) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [ret.problem_id, rel, version + 1, ret.revision_sha, files.sha256(baseText), ret.id, ret.user_id, JSON.stringify(verifiers.map((v) => v.handle)), summary, diff, ret.model ?? null, JSON.stringify(verifiedModels)]);
  const ov = overlayPath(slug, rel); mkdirSync(dirname(ov), { recursive: true }); writeFileSync(ov, next);
  await q(`UPDATE papers SET current_return_id = $3, current_file_sha = $4, status = 'reviewed', updated_at = now() WHERE problem_id = $1 AND (path = $2 OR (path IS NULL AND 'paper/' || slug || '.md' = $2))`, [ret.problem_id, rel, ret.id, ret.revision_sha]);
}

export async function history(problemId: number, rel: string) {
  return q(`SELECT v.version, v.content_sha, v.return_id, v.verified_by, v.verified_models, v.author_model, v.summary, v.created_at, u.handle AS author, u.display_name AS author_name, r.model, length(v.diff) AS diff_chars
            FROM document_versions v LEFT JOIN users u ON u.id = v.author_user_id LEFT JOIN returns r ON r.id = v.return_id WHERE v.problem_id = $1 AND v.path = $2 ORDER BY v.version`, [problemId, rel]);
}
export async function revisedPaths(problemId: number): Promise<Map<string, { versions: number; author: string; verified: string[]; at: string }>> {
  const rows = await q(`SELECT DISTINCT ON (v.path) v.path, v.version, v.verified_by, v.created_at, u.handle FROM document_versions v LEFT JOIN users u ON u.id = v.author_user_id WHERE v.problem_id = $1 ORDER BY v.path, v.version DESC`, [problemId]);
  return new Map(rows.map((r: any) => [r.path, { versions: Number(r.version), author: r.handle, verified: r.verified_by ?? [], at: r.created_at }]));
}
