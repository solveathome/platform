/** Maintenance of accepted correction obligations, not a scientific result.
 * Usage: repair-index-prerequisites <slug> <index-job> <JSON mapping file> [--apply].
 * Mapping: [{finding_id, source_path, ledger_id}]. Dry-run and idempotent by default.
 * Only an accepted, non-provisional origin and an exact served source ledger qualify.
 */
import {readFileSync} from 'node:fs';
import {one,q,pool,projectTransaction} from '../src/db/index.js';
import {currentText,safeRel} from '../src/lib/revisions.js';
import {sha256} from '../src/lib/document-publication.js';
import {recordFinding} from '../src/lib/findings.js';
import {spawnFixJob} from '../src/routes/job.js';

const [slug,indexJob,input]=process.argv.slice(2);
const apply=process.argv.includes('--apply');
const mappings=JSON.parse(readFileSync(input,'utf8'));
if (!Array.isArray(mappings) || mappings.length>30) throw new Error('Expected at most 30 explicit source mappings');
try {
  const p=await one(`SELECT id FROM problems WHERE slug=$1`,[slug]);
  if (!p) throw new Error('Unknown project');
  await projectTransaction(p.id,async()=>{
    const job=await one(`SELECT * FROM jobs WHERE id=$1 AND problem_id=$2`,[indexJob,p.id]);
    if (!job || job.title!=='Fix research/QUESTIONS.md') throw new Error('Expected the original generated-index repair');
    for (const m of mappings) {
      const f=await one(`SELECT f.*,r.status AS origin_status,r.provisional,r.lane_id FROM findings f JOIN returns r ON r.id=f.return_id
        WHERE f.id=$1 AND f.job_id=$2 AND f.problem_id=$3`,[m.finding_id,job.id,p.id]);
      const path=safeRel(m.source_path);
      if (!f || f.status!=='open' || f.scope==='advisory' || f.origin_status!=='accepted' || f.provisional || !path || path===f.path
        || typeof m.ledger_id!=='string' || !/^Q-[a-zA-Z0-9-]+$/.test(m.ledger_id) || !f.note.includes(m.ledger_id)) throw new Error('Unverified correction mapping');
      const source=await currentText(slug,path,Number(p.id));
      if (!source || !source.text.includes(`id: ${m.ledger_id}\n`)) throw new Error('Source does not contain the named ledger');
      const note=`Source prerequisite derived by platform maintenance from finding #${f.id}${f.review_id ? ` (review #${f.review_id})` : ''} of accepted return #${f.return_id}. The original annotation targets a generated index; implement its supported correction in this authoritative ledger first, preserve its evidence grade and scope, then regenerate the index. Do not invent results or hand-edit generated rows.\n\nOriginal correction:\n${f.note}`;
      let finding:null|number=null, repair:null|number=null;
      if(apply){
        // Null review_id explicitly distinguishes a maintenance-derived obligation from an original review annotation.
        finding=await recordFinding({problemId:Number(p.id),path,note,scope:f.scope,contentSha:sha256(source.text),returnId:Number(f.return_id)});
        repair=await spawnFixJob(Number(p.id),f.lane_id,slug,path,note,{findingId:finding,returnId:Number(f.return_id)});
        if (!repair) throw new Error('Source repair was not queued');
        await q('INSERT INTO job_correction_prerequisites(job_id,finding_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[job.id,finding]);
      }
      console.log(JSON.stringify({original_finding:Number(f.id),source_path:path,source_sha256:sha256(source.text),source_finding:finding,source_job:repair,applied:apply}));
    }
  });
} finally {await pool.end();}
