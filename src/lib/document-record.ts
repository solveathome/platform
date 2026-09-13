import {readFileSync} from "node:fs";
import {join} from "node:path";
import {q, projectTransaction} from "../db/index.js";
import {ROOT} from "./paths.js";
import {publishedDocument, readPublication, sha256, type Publication} from "./document-publication.js";
import {isoTime, datesHtml, type DocumentDates} from "./timestamps.js";

const REPOS = process.env.DOCS_DIR ?? join(ROOT, "data", "repos");

/** Capture every admitted file, including code/data/proofs. Identical cuts are no-ops; reversions are events.
 * recorded_at is the database clock at observation, never a filesystem or supplied source date. */
export async function recordPublication(slug: string, problemId: number): Promise<void> {
  const root = join(REPOS, slug), publication = readPublication(root);
  if (!publication) return;
  await projectTransaction(problemId, async () => {
    const latest = new Map((await q(`SELECT DISTINCT ON (path) path, sha256, source FROM document_publications WHERE problem_id = $1 ORDER BY path, id DESC`, [problemId])).map(r => [r.path, r]));
    for (const [path, entry] of Object.entries(publication.files)) {
      if (!publishedDocument(root, path, publication)) continue;
      const previous = latest.get(path);
      const sameSource = ["created_at", "modified_at", "first_commit", "last_commit", "state", "public_edition"].every(key => previous?.source?.[key] === (entry.source as any)?.[key]);
      if (previous?.sha256 === entry.sha256 && sameSource) continue;
      // Verify the bytes again immediately before recording; don't attest a manifest alone.
      if (sha256(readFileSync(join(root, path))) !== entry.sha256) continue;
      await q(`INSERT INTO document_publications (problem_id, path, sha256, prepared_at, source) VALUES ($1,$2,$3,$4,$5)`,
        [problemId, path, entry.sha256, isoTime(publication.generated_at), JSON.stringify(entry.source ?? null)]);
    }
  });
}

export async function recordAllPublications(): Promise<void> {
  for (const p of await q(`SELECT id, slug FROM problems ORDER BY id`)) await recordPublication(p.slug, Number(p.id));
}

export type DocumentRecord = {publications: any[]; versions: any[]};
/** One pair of queries for a project listing; an optional path bounds detail-page reads. */
export async function documentRecords(problemId: number, path?: string): Promise<Map<string, DocumentRecord>> {
  const args = path === undefined ? [problemId] : [problemId, path];
  const filter = path === undefined ? "" : " AND path = $2";
  const publications = await q(`SELECT path, id, sha256, prepared_at, source, recorded_at FROM document_publications WHERE problem_id = $1${filter} ORDER BY id`, args);
  const versions = await q(`SELECT v.path, v.version, v.content_sha, v.return_id, v.created_at, r.created_at AS submitted_at FROM document_versions v LEFT JOIN returns r ON r.id = v.return_id WHERE v.problem_id = $1${path === undefined ? "" : " AND v.path = $2"} ORDER BY v.version`, args);
  const records = new Map<string, DocumentRecord>();
  for (const row of publications) { if (!records.has(row.path)) records.set(row.path, {publications: [], versions: []}); records.get(row.path)!.publications.push(row); }
  for (const row of versions) { if (!records.has(row.path)) records.set(row.path, {publications: [], versions: []}); records.get(row.path)!.versions.push(row); }
  return records;
}

export function documentDates(publication: Publication | null, path: string, record?: DocumentRecord, currentSha?: string | null, seed = false): DocumentDates {
  const entry = publication?.files[path];
  const sha = currentSha ?? entry?.sha256 ?? null;
  const mirrored = sha === entry?.sha256;
  const pubs = record?.publications ?? [], versions = record?.versions ?? [];
  const pub = pubs.filter(p => p.sha256 === sha).at(-1);
  const version = seed ? undefined : versions.filter(v => v.content_sha === sha).at(-1);
  const source = (mirrored ? entry?.source : undefined) ?? pub?.source;
  const originalSource = entry?.source ?? pubs.find(p => p.source?.created_at)?.source;
  const recorded = [pub?.recorded_at, version?.created_at].map(isoTime).filter((d): d is string => !!d).sort().at(-1) ?? null;
  const first = [...pubs.map(p => p.recorded_at), ...versions.map(v => v.created_at)].map(isoTime).filter((d): d is string => !!d).sort()[0] ?? null;
  return {
    created_at: isoTime(originalSource?.created_at), created_basis: originalSource?.created_at ? "first Git record" : "",
    modified_at: isoTime(version?.submitted_at) ?? isoTime(source?.modified_at),
    modified_basis: version?.submitted_at ? "submitted revision" : source?.modified_at ? "Git" : "",
    first_recorded_at: seed ? null : first, recorded_at: seed ? null : recorded,
    prepared_at: mirrored ? isoTime(publication?.generated_at) : isoTime(pub?.prepared_at), sha256: sha,
  };
}

export async function datesForDocument(problemId: number | undefined, publication: Publication | null, path: string, sha?: string, seed = false): Promise<DocumentDates> {
  const records = problemId && !seed ? await documentRecords(problemId, path) : new Map();
  return documentDates(publication, path, records.get(path), sha, seed);
}

export function recordHtml(dates: DocumentDates, historyUrl: string): string {
  // historyUrl is constructed from an encoded slug/path by the caller.
  return `<div class="document-record" aria-label="Document timestamps"><p>${datesHtml(dates)}</p>${dates.sha256 ? `<p class="document-hash">SHA-256 <code>${dates.sha256}</code></p>` : ""}<p><a href="${historyUrl}">Timestamp and revision history →</a></p></div>`;
}
