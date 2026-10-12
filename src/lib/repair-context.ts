import {createHash} from 'node:crypto';
import {q,one} from '../db/index.js';
import {findingsOfJob} from './findings.js';
import {currentText} from './revisions.js';
import {redactHarnessIds,redactHomePaths} from './files.js';

const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const safeText = (s:string) => redactHarnessIds(redactHomePaths(s).text).text;
const excerpt = (s:unknown,n=1800) => {const original=String(s??''),text=safeText(original),truncated=text.length>n;return {text:truncated?text.slice(0,n).replace(/\S+$/,''):text,truncated,redacted:text!==original,sha256:sha(original)};};
const ids = (xs:any) => [...new Set((Array.isArray(xs)?xs:[]).map(Number).filter(n=>Number.isSafeInteger(n)&&n>0))];

/** Informational evidence attached to the issued assignment, never an acceptance or scheduler gate. */
export async function repairContext(problemId:number,slug:string,job:any):Promise<any|null> {
  const findings=(await findingsOfJob(Number(job.id))).filter(f=>f.status==='open'&&f.scope!=='advisory');
  if(!job.follow_up_of&&!findings.length)return null;
  const follow=job.follow_up_of ? await one(`SELECT id,revision_path FROM returns WHERE id=$1 AND problem_id=$2`,[job.follow_up_of,problemId]) : null;
  const paths=[...new Set([...findings.map(f=>f.path),...(follow?.revision_path?[follow.revision_path]:[])])];
  const documents=[];
  for(const path of paths) {
    const served=await currentText(slug,path,problemId),content_sha256=served?sha(served.text):null;
    // Bind the actually served bytes, not a later version number whose overlay may have drifted.
    const version=content_sha256 ? await one(`SELECT version,return_id FROM document_versions WHERE problem_id=$1 AND path=$2 AND content_sha=$3 ORDER BY version DESC LIMIT 1`,[problemId,path,content_sha256]) : null;
    documents.push({path,content_sha256,version:version?Number(version.version):null,return_id:version?.return_id?Number(version.return_id):null});
  }
  const relations=new Map<number,string[]>();
  function add(id:any,relation:string) {for(const n of ids([id])){const r=relations.get(n)??[];if(!r.includes(relation))r.push(relation);relations.set(n,r);}}
  add(follow?.id,'prior_attempt');for(const f of findings)add(f.return_id,'finding_source');for(const d of documents)add(d.return_id,'served_document');
  // Same-document attempts are useful repair history, not an inferred dependency or endorsement.
  for(const path of paths) for(const r of await q(`SELECT id FROM returns WHERE problem_id=$1 AND revision_path=$2 ORDER BY id DESC LIMIT 2`,[problemId,path]))add(r.id,'same_document_attempt');
  // Only explicit citations supply dependencies; same-topic similarity is not lineage.
  const sources:any[]=[];let pending=[...relations.keys()],omitted:number[]=[];
  for(let depth=0;depth<3&&pending.length;depth++) {
    const remaining=8-sources.length;omitted.push(...pending.slice(remaining));pending=pending.slice(0,remaining);if(!pending.length)break;
    const rows=await q<any>(`SELECT id,status,provisional,duplicate_of,report_md,recipe_md,research_evidence,cites,revision_path,revision_base_sha,revision_sha,integration FROM returns WHERE problem_id=$1 AND id=ANY($2::bigint[]) ORDER BY id`,[problemId,pending]);
    omitted.push(...pending.filter(n=>!rows.some(r=>Number(r.id)===n)));
    const next:number[]=[];
    for(const r of rows) {
      const id=Number(r.id);sources.push(r);
      for(const ref of ids(r.cites?.returns??[])){add(ref,`cited_by_return_${id}`);if(!sources.some(s=>Number(s.id)===ref)&&!pending.includes(ref))next.push(ref);}
    }
    pending=ids(next);
  }
  omitted.push(...pending);
  const sourceIds=sources.map(r=>Number(r.id));
  const files=sourceIds.length?await q(`SELECT ref_id,file_sha FROM file_refs WHERE ref_type='return' AND ref_id=ANY($1::bigint[]) ORDER BY ref_id,file_sha`,[sourceIds]):[];
  const reviews=sourceIds.length?await q<any>(`SELECT id,return_id,notes_md,needs_md,verdict,trusted,created_at,NULL::timestamptz AS archived_at FROM reviews WHERE return_id=ANY($1::bigint[])
    UNION ALL SELECT (review->>'id')::bigint,return_id,review->>'notes_md',review->>'needs_md',review->>'verdict',(review->>'trusted')::boolean,(review->>'created_at')::timestamptz,archived_at FROM review_history WHERE return_id=ANY($1::bigint[]) ORDER BY created_at DESC`,[sourceIds]):[];
  const namedReviews=new Set(findings.map(f=>Number(f.review_id)));
  reviews.sort((a,b)=>Number(namedReviews.has(Number(b.id)))-Number(namedReviews.has(Number(a.id))));
  const context:any={schema:'repair-context-v1',observed_at:new Date().toISOString(),job_id:Number(job.id),documents,
    obligations:findings.map(f=>({finding_id:f.id,path:f.path,requirement_md:safeText(f.note),source_content_sha256:f.content_sha,return_id:f.return_id,review_id:f.review_id})),
    source_returns:sources.map(r=>({return_id:Number(r.id),relations:relations.get(Number(r.id)),status_at_issue:r.status,provisional_at_issue:Boolean(r.provisional),
      preservation_candidate:r.status==='accepted'&&!r.provisional&&!r.duplicate_of,report:excerpt(r.report_md),recipe_sha256:r.recipe_md?sha(r.recipe_md):null,
      declared_scopes:JSON.parse(safeText(JSON.stringify(r.research_evidence?.scopes??[]))),revision_path:r.revision_path,revision_base_sha256:r.revision_base_sha,revision_sha256:r.revision_sha,integration_at_issue:r.integration,
      artifact_sha256:files.filter(f=>Number(f.ref_id)===Number(r.id)).map(f=>f.file_sha)})),
    reviews:reviews.slice(0,16).map(r=>({review_id:Number(r.id),return_id:Number(r.return_id),verdict:r.verdict,trusted:r.trusted,archived_at:r.archived_at,notes:excerpt(r.notes_md),needs:excerpt(r.needs_md)})),
    omitted_source_ids:ids(omitted).filter(n=>!sourceIds.includes(n)),omitted_reviews:Math.max(0,reviews.length-16)};
  context.context_sha256=sha(JSON.stringify(context));return context;
}

/** Fetch the author's frozen issue snapshot, never reconstruct acceptance from today's state. */
export async function issuedRepairContext(ret:any):Promise<any|null> {
  if(!ret?.job_id)return null;
  const attempt=await one(`SELECT assignment_payload->'repair_context' AS context FROM assignment_attempts WHERE job_id=$1 AND user_id=$2 AND problem_id=$3
    AND started_at <= $4 AND (ended_at IS NULL OR ended_at >= $4) ORDER BY started_at DESC LIMIT 1`,[ret.job_id,ret.user_id,ret.problem_id,ret.created_at]);
  return attempt?.context??null;
}
