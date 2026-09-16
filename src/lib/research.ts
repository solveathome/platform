/** Route progression and selective rescue. Called inside the assignment/project transaction. */
import { createHash } from 'node:crypto';
import { one, q } from '../db/index.js';
import { bad, type NextStep, type ResearchReport, type ResearchStage } from './research-format.js';

const experimentKey = (step: NextStep) => createHash('sha256').update(JSON.stringify([step.question.trim(), step.method.trim(), step.success.trim(), step.failure.trim()])).digest('hex');

export async function routeContext(id: number): Promise<any> {
  const route = await one(`SELECT rr.*,u.handle AS origin_handle,r.model AS origin_model FROM research_routes rr JOIN returns r ON r.id=rr.origin_return_id JOIN users u ON u.id=r.user_id WHERE rr.id=$1`, [id]);
  if (!route) return null;
  const dependencies = await q(`SELECT r.id,r.status,r.final_rung,r.provisional FROM research_dependencies d JOIN returns r ON r.id=d.return_id WHERE d.route_id=$1 ORDER BY r.id`, [id]);
  // Assignment provenance is already an evidence chain. A rescue's new findings start
  // a fresh chain; any older premises it still requires remain explicit dependencies.
  const basis = await q(`WITH RECURSIVE basis AS (
      SELECT r.id,r.job_id FROM returns r WHERE r.id=$1
      UNION
      SELECT prior.id,prior.job_id FROM basis b JOIN jobs j ON j.id=b.job_id
      JOIN returns prior ON prior.id=j.research_source_return_id
      WHERE j.research_route_id=$2 AND j.research_stage IN ('triage','pursue')
    ) SELECT r.id,r.status,r.final_rung,r.provisional FROM basis b JOIN returns r ON r.id=b.id ORDER BY r.id`, [route.last_return_id, id]);
  const events = await q(`SELECT e.*,r.model,u.handle,r.status AS evidence_status,r.final_rung FROM research_events e LEFT JOIN returns r ON r.id=e.return_id LEFT JOIN users u ON u.id=r.user_id WHERE route_id=$1 ORDER BY e.id DESC`, [id]);
  const jobs = await q(`SELECT id,type,research_stage,title,status,budget_hours FROM jobs WHERE research_route_id=$1 ORDER BY id DESC LIMIT 20`, [id]);
  return { ...route, dependencies, basis, events, jobs };
}
export async function researchSummary(problemId: number): Promise<any> {
  const routes = await q(`SELECT id,title,state,next_step,obstacle,origin_return_id,last_return_id,updated_at FROM research_routes WHERE problem_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 40`, [problemId]);
  const states = await q(`SELECT state,count(*)::int AS n FROM research_routes WHERE problem_id=$1 GROUP BY state`, [problemId]);
  const checks = await one(`SELECT count(*)::int AS runs,count(*) FILTER (WHERE v.outcome='pass')::int AS passed,
    count(*) FILTER (WHERE v.outcome='fail')::int AS failed,count(*) FILTER (WHERE v.outcome='unable')::int AS unable,
    coalesce(sum(v.elapsed_seconds),0) AS elapsed_seconds FROM verification_runs v JOIN returns r ON r.id=v.result_return_id WHERE r.problem_id=$1`, [problemId]);
  const reuse = await one(`SELECT count(*)::int AS reused_receipts FROM reviews rv JOIN returns r ON r.id=rv.return_id JOIN verification_runs v ON v.id=rv.verification_receipt_id WHERE r.problem_id=$1 AND v.subject_return_id<>r.id`, [problemId]);
  // Measurement the proposal asked for (Sep 14): where packages stand,
  // A reused receipt can predate the package it now serves: that package waited zero hours, never a negative number.
  // Advisory-only (provisional) decisions are open work, never judged. how fast a first receipt arrives, whether the first attempt
  // reconstructs at all, and whether the controls workers ran caught anything. Counted from receipts, never from acceptance rate.
  const packages = await one(`WITH pkg AS (SELECT r.id,r.status,r.provisional,(r.status='pending' OR r.provisional) AS open,r.user_id,r.model,r.verification_fingerprint AS fp,r.created_at FROM returns r WHERE r.problem_id=$1 AND r.verification_plan IS NOT NULL AND r.duplicate_of IS NULL),
    run AS (SELECT v.outcome,v.fingerprint,v.created_at,w.user_id,w.model FROM verification_runs v JOIN returns w ON w.id=v.result_return_id WHERE w.problem_id=$1 AND w.status IN ('recorded','accepted')),
    independent AS (SELECT p.id,r.outcome,r.created_at FROM pkg p JOIN run r ON r.fingerprint=p.fp AND r.user_id<>p.user_id AND r.model<>p.model),
    completed AS (SELECT id,min(created_at) AS first_at FROM independent WHERE outcome IN ('pass','fail') GROUP BY id),
    first_attempt AS (SELECT DISTINCT ON (id) id,outcome FROM independent ORDER BY id,created_at),
    decided AS (SELECT d.return_id AS id,min(d.decided_at) AS decided_at FROM return_decisions d JOIN pkg p ON p.id=d.return_id WHERE d.status IN ('accepted','rejected') AND NOT d.provisional GROUP BY d.return_id)
    SELECT (SELECT count(*) FROM pkg)::int AS packages,
      (SELECT count(*) FROM pkg WHERE open AND id IN (SELECT id FROM completed))::int AS awaiting_judgment,
      (SELECT count(*) FROM pkg WHERE open AND id NOT IN (SELECT id FROM completed))::int AS awaiting_execution,
      (SELECT count(*) FROM pkg WHERE provisional)::int AS provisional,
      (SELECT count(*) FROM pkg WHERE status IN ('accepted','rejected') AND NOT provisional)::int AS judged,
      (SELECT count(*) FROM first_attempt)::int AS first_attempts,
      (SELECT count(*) FROM first_attempt WHERE outcome IN ('pass','fail'))::int AS first_attempt_completed,
      (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0,extract(epoch FROM c.first_at-p.created_at)/3600)::double precision))::numeric,2) FROM completed c JOIN pkg p ON p.id=c.id) AS median_hours_to_first_receipt,
      (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY (extract(epoch FROM d.decided_at-c.first_at)/3600)::double precision))::numeric,2) FROM decided d JOIN completed c ON c.id=d.id) AS median_hours_receipt_to_judgment`, [problemId]);
  const controls = await one(`SELECT count(*) FILTER (WHERE v.outcome IN ('pass','fail'))::int AS completed_runs,
      count(*) FILTER (WHERE jsonb_typeof(v.details->'controls')='array')::int AS itemised_runs,
      count(*) FILTER (WHERE v.details->>'method'='independent_implementation')::int AS independent_implementations,
      coalesce(sum((SELECT count(*) FROM jsonb_array_elements(v.details->'controls') c WHERE (c->>'detected')::boolean)) FILTER (WHERE jsonb_typeof(v.details->'controls')='array'),0)::int AS controls_detected,
      coalesce(sum((SELECT count(*) FROM jsonb_array_elements(v.details->'controls'))) FILTER (WHERE jsonb_typeof(v.details->'controls')='array'),0)::int AS controls_total,
      (SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY x.elapsed_seconds::double precision))::numeric,1) FROM verification_runs x JOIN returns y ON y.id=x.result_return_id WHERE y.problem_id=$1 AND x.outcome IN ('pass','fail')) AS median_elapsed_seconds
    FROM verification_runs v JOIN returns r ON r.id=v.result_return_id WHERE r.problem_id=$1`, [problemId]);
  return { routes, states, checks: { ...checks, ...reuse, ...packages, ...controls } };
}
export async function researchBrief(id: number): Promise<string> {
  const r = await routeContext(id); if (!r) return '';
  return `\n\n### Research route #${r.id}: ${r.title}\n\nInvestment state: ${r.state}; this is not a truth grade. Revision ${r.revision}.\n\nContribution: ${r.contribution_md}\n\nPrior art and exact difference: ${r.prior_art_md}\n\nCentral uncertainty: ${r.uncertainty_md}\n\nNext experiment: ${JSON.stringify(r.next_step)}\n\nObstacle: ${JSON.stringify(r.obstacle)}\n\nEvidence behind continued investment: ${JSON.stringify(r.basis)}.\n\nDeclared dependencies: ${JSON.stringify(r.dependencies)}. Pending, recorded, rejected or provisional premises remain conditional; inspect the evidence before building on them.\n\nRecent investigations:\n${r.events.slice(0, 5).map((e: any) => `- Return #${e.return_id ?? '—'} (${e.model ?? 'system'}): ${e.outcome}. ${e.evidence_md}`).join('\n')}\n\nFull route and event record: GET <project base>/research-routes/${r.id}.\n`;
}
async function queueInvestigation(route: any, stage: ResearchStage, source: any): Promise<any> {
  if (await one(`SELECT 1 FROM jobs WHERE research_route_id=$1 AND research_stage IN ('triage','pursue','rescue') AND status IN ('queued','assigned')`, [route.id])) return null;
  const step: NextStep | null = route.next_step;
  const origin = stage === 'pursue' && step ? `pursue:${route.id}:${experimentKey(step)}` : `${stage}:${route.id}:${route.revision}`;
  if (await one(`SELECT 1 FROM jobs WHERE problem_id=$1 AND origin_key=$2`, [route.problem_id, origin])) return null;
  const task = stage === 'triage'
    ? 'Search online for existing attempts, results, tables and datasets before testing feasibility. Reuse the recorded search and inspect the closest sources and weakest assumption. Use published numbers with citations; do not reproduce them in triage. Seek the smallest experiment on the uncovered step. Recommend promising only with specific evidence and a bounded next step; do not claim the route is proved. Map the assumptions of any borrowed method onto this problem.'
    : stage === 'rescue'
      ? 'Inspect the decisive obstruction with a fresh perspective. Distinguish an unresolved task, failed attempt, refuted statement and scoped obstruction. Seek a repair, weaker requirement, new ingredient or alternate method. Preserve valid counterexamples and their exact scope. A successful rescue needs a distinct next experiment and evidence that the alternative avoids the obstruction. Reuse the prior search and search online for the changed ingredient, including failures in the source field. Do not rerun published computations here. Your findings start a new investment basis; explicitly list any earlier return still required in depends_on.'
      : 'First update the online prior-work search for this experiment. If existing work covers it, record that and stop; otherwise run this bounded sprint on the uncovered uncertainty. Use cited published numbers during pursuit; their reproduction belongs in later validation. Build on the supplied findings; do not reconstruct earlier research. Return concrete progress and its cheapest credible check, a useful result for review, or a precisely scoped obstacle. Continued investment requires a distinct experiment.';
  return one(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,compute_hint,purpose,research_stage,research_route_id,research_source_return_id,avoid_model,origin_key,required_tools,required_sources,priority,research_revision)
    VALUES ($1,$2,'explore',$3,$4,$5,$6,$7,'discovery',$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [route.problem_id, route.lane_id, `${stage === 'triage' ? 'Triage' : stage === 'rescue' ? 'Rescue' : 'Pursue'}: ${route.title}`.slice(0, 200),
      `${task}\n\nRead GET <project base>/research-routes/${route.id} and return #${source.id}. Return the ordinary report and transcript plus research: {route_id: ${route.id}, outcome: "promising|progress|blocked|inconclusive|known|result", evidence_md: "what the evidence changes, <=4000 chars", prior_art_md: "updated online search record, sources and exact remaining gap, <=4000", next_step: {question, method, success, failure, budget_hours} <only for continued pursuit>, obstacle: {kind, statement, assumptions, evidence, revisit_when} <for blocked/inconclusive>, depends_on: [<return ids actually required>]}. A result with a distinct next_step requests review and continues pursuit concurrently; omit next_step when no further experiment is warranted. Use known with prior_art_md and no next_step or obstacle when cited prior work already covers the proposed contribution; it stops automatic investigation without requesting review. The evidence grade is separate. Do not close a broad route because one proof attempt failed.`,
      stage === 'pursue' ? step?.budget_hours ?? 1 : 0.5, 99,
      JSON.stringify(stage === 'pursue' ? step?.compute ?? {} : {}), stage, route.id, source.id,
      stage === 'rescue' ? source.model : null, origin,
      stage === 'pursue' ? step?.required_tools ?? [] : [], stage === 'pursue' ? step?.required_sources ?? [] : [], stage === 'pursue' ? 3 : 1, route.revision]);
}

export async function recordResearch(ret: any, job: any, report: ResearchReport | null): Promise<any> {
  if (job?.research_route_id && ['triage', 'pursue', 'rescue'].includes(job.research_stage) && !report) bad('this route assignment requires research with outcome, evidence and its next step or obstacle');
  if (!report) return null;
  if (report.depends_on !== undefined) for (const id of report.depends_on)
    if (id === Number(ret.id) || !(await one(`SELECT 1 FROM returns WHERE id=$1 AND problem_id=$2`, [id, ret.problem_id]))) bad('research dependencies must name earlier returns in this project');
  if (job?.research_route_id && Number(job.research_route_id) !== report.route_id) bad('this assignment must report on its assigned route; propose independent alternatives in a separate linked return');
  let route: any;
  if (report.proposal) {
    if (!['explore', 'direction'].includes(ret.type)) bad('propose a route through an explore or direction return');
    if (report.parent_route_id && !(await one(`SELECT 1 FROM research_routes WHERE id=$1 AND problem_id=$2`, [report.parent_route_id, ret.problem_id]))) bad('parent route is not in this project');
    const p = report.proposal;
    // A contributor may offer many ideas, but cannot turn them into an unbounded immediate job fan-out.
    const n = await one(`SELECT count(*)::int AS n FROM research_routes rr JOIN returns r ON r.id=rr.origin_return_id WHERE rr.problem_id=$1 AND r.user_id=$2 AND rr.created_at>now()-interval '1 day'`, [ret.problem_id, ret.user_id]);
    if (n!.n >= 10) bad('at most ten new routes per contributor per day; build on an existing route');
    route = await one(`INSERT INTO research_routes (problem_id,lane_id,origin_return_id,parent_route_id,title,contribution_md,prior_art_md,uncertainty_md,next_step,last_return_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$3) RETURNING *`, [ret.problem_id, ret.lane_id, ret.id, report.parent_route_id ?? null, p.title, p.contribution_md, p.prior_art_md, p.uncertainty_md, JSON.stringify(report.next_step)]);
  } else {
    if (!report.route_id || Number(job?.research_route_id) !== report.route_id) bad('progress must answer the assignment for that route; propose a linked route for an independent alternative');
    route = await one(`SELECT * FROM research_routes WHERE id=$1 AND problem_id=$2`, [report.route_id, ret.problem_id]);
    if (!route) bad('research route is not in this project');
    // A premise can change while a worker is still running. Keep its evidence without allowing
    // an old assignment to clear the new obstacle or replace the current dependency list.
    if (job.research_revision != null && Number(job.research_revision) !== Number(route.revision)) {
      const premises = report.depends_on ?? (await q(`SELECT depends_on_id FROM return_dependencies WHERE return_id=$1`, [job.research_source_return_id])).map(d => Number(d.depends_on_id));
      for (const id of premises) await q(`INSERT INTO return_dependencies (return_id,depends_on_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ret.id,id]);
      await q(`UPDATE returns SET research=$2,research_route_id=$3 WHERE id=$1`, [ret.id, JSON.stringify(report), route.id]);
      await q(`INSERT INTO research_events (route_id,return_id,outcome,evidence_md,detail) VALUES ($1,$2,'stale_progress',$3,$4)`, [route.id, ret.id, report.evidence_md, JSON.stringify(report)]);
      return { route_id: Number(route.id), state: route.state, next_job_id: null, stale: true, note: 'Route premises changed during this assignment. Findings are preserved for reassessment.' };
    }
    let state = ({ promising: 'active', progress: 'active', blocked: 'blocked', inconclusive: 'paused', known: 'known', result: report.next_step ? 'active' : 'result' } as any)[report.outcome];
    if (!state) bad('this is an existing route; report progress or an obstacle');
    // An identical experiment is already on record. Cosmetic re-budgeting cannot buy the same work again.
    if (report.next_step && await one(`SELECT 1 FROM jobs WHERE problem_id=$1 AND origin_key=$2`, [ret.problem_id, `pursue:${route.id}:${experimentKey(report.next_step)}`])) state = 'paused';
    route = await one(`UPDATE research_routes SET state=$2,next_step=$3,obstacle=$4,revision=revision+1,last_return_id=$5,prior_art_md=coalesce($6,prior_art_md),updated_at=now() WHERE id=$1 RETURNING *`,
      [route.id, state, report.next_step ? JSON.stringify(report.next_step) : null, report.obstacle ? JSON.stringify(report.obstacle) : null, ret.id, report.prior_art_md ?? null]);
  }
  if (report.depends_on !== undefined) {
    await q(`DELETE FROM research_dependencies WHERE route_id=$1`, [route.id]);
    for (const id of report.depends_on) await q(`INSERT INTO research_dependencies (route_id,return_id) VALUES ($1,$2)`, [route.id, id]);
  }
  await q(`INSERT INTO return_dependencies (return_id,depends_on_id)
    SELECT $1,return_id FROM research_dependencies WHERE route_id=$2 ON CONFLICT DO NOTHING`, [ret.id, route.id]);
  await q(`UPDATE returns SET research=$2,research_route_id=$3 WHERE id=$1`, [ret.id, JSON.stringify(report), route.id]);
  await q(`INSERT INTO research_events (route_id,return_id,outcome,evidence_md,detail) VALUES ($1,$2,$3,$4,$5)`, [route.id, ret.id, report.outcome, report.evidence_md, JSON.stringify(report)]);
  // The current assignment was marked returned before this function. Exactly one next experiment may now open.
  const next = report.proposal ? await queueInvestigation(route, 'triage', ret)
    : route.state === 'active' ? await queueInvestigation(route, 'pursue', ret) : null;
  return { route_id: Number(route.id), state: route.state, next_job_id: next ? Number(next.id) : null };
}

/** Materialize one eligible rescue when its allocation needs it. No repeated rechecks of the same obstacle. */
export async function prepareRescue(problemId: number, model: string | null, lane: string | null): Promise<void> {
  const candidate = await one(`SELECT rr.*,r.model AS source_model FROM research_routes rr JOIN returns r ON r.id=rr.last_return_id LEFT JOIN lanes l ON l.id=rr.lane_id
    WHERE rr.problem_id=$1 AND rr.state IN ('blocked','paused') AND r.model IS DISTINCT FROM $2::text AND ($3::text IS NULL OR l.slug=$3)
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.research_route_id=rr.id AND j.status IN ('queued','assigned'))
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.problem_id=rr.problem_id AND j.origin_key='rescue:'||rr.id||':'||rr.revision)
    AND (NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=r.job_id AND j.research_stage='rescue') OR EXISTS (SELECT 1 FROM research_events e WHERE e.route_id=rr.id AND e.outcome='dependency_changed' AND e.id>(SELECT coalesce(max(last.id),0) FROM research_events last WHERE last.route_id=rr.id AND last.return_id=r.id)))
    ORDER BY (SELECT count(*) FROM research_dependencies d WHERE d.return_id=rr.last_return_id) DESC,rr.updated_at,rr.id LIMIT 1`, [problemId, model, lane]);
  if (candidate) { await queueInvestigation(candidate, 'rescue', { id: candidate.last_return_id, model: candidate.source_model }); return; }
  // A monthly sample catches over-broad legacy negatives, one assignment per selected return per month.
  const r = await one(`SELECT r.id,r.lane_id,r.model FROM returns r LEFT JOIN lanes l ON l.id=r.lane_id
    WHERE r.problem_id=$1 AND (r.status='rejected' OR r.final_rung='refuted') AND r.type NOT IN ('check','curate')
    AND r.model IS DISTINCT FROM $2::text AND ($3::text IS NULL OR l.slug=$3) AND r.created_at<now()-interval '7 days'
    AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.research_source_return_id=r.id AND j.research_stage='rescue' AND (j.status IN ('queued','assigned') OR j.created_at>now()-interval '30 days'))
    ORDER BY r.created_at,r.id LIMIT 1`, [problemId, model, lane]);
  if (!r) return;
  await q(`INSERT INTO jobs (problem_id,lane_id,type,title,brief_md,budget_hours,min_tier,purpose,research_stage,research_source_return_id,avoid_model,origin_key)
    VALUES ($1,$2,'explore',$3,$4,0.5,99,'discovery','rescue',$5,$6,$7)`, [problemId, r.lane_id, `Rescue investigation: return #${r.id}`,
    `Read return #${r.id} and its search record, then search online for the method and changed alternatives before testing them. Check whether its negative conclusion closes only a statement or attempt. Use published numerical results with citations, reserving reproduction for later validation. Inspect the decisive evidence, then seek a concrete alternative. Preserve valid refutations. A promising alternative should return research.proposal with parent evidence in cites.returns, a prior-art comparison and the cheapest next experiment. If nothing changes, record the scoped obstacle and stop. This is a bounded sample; do not reproduce the whole investigation.`, r.id, r.model, `rescue-sample:${r.id}:${new Date().toISOString().slice(0, 7)}`]);
}

/** A changed premise flags affected routes; it never silently refutes their descendants. */
export async function reconsiderDependents(returnId: number, status: string): Promise<number[]> {
  // Follow the actual investment chain as well as declared mathematical premises.
  // Rescue is an explicit reassessment, so its output does not implicitly inherit the
  // obstruction it investigated. UNION also makes this safe against accidental cycles.
  const descendants = await q(`WITH RECURSIVE edges AS NOT MATERIALIZED (
      SELECT r.id AS dependent,j.research_source_return_id AS premise FROM returns r JOIN jobs j ON j.id=r.job_id
        WHERE j.research_stage IN ('triage','pursue') AND r.research_route_id=j.research_route_id
      UNION ALL SELECT return_id,depends_on_id FROM return_dependencies
      UNION ALL SELECT rr.last_return_id,d.return_id FROM research_dependencies d JOIN research_routes rr ON rr.id=d.route_id
      UNION ALL SELECT rv.return_id,v.result_return_id FROM reviews rv JOIN verification_runs v ON v.id=rv.verification_receipt_id
        WHERE rv.trusted AND rv.verdict='accept'
      UNION ALL SELECT id,duplicate_of FROM returns WHERE duplicate_of IS NOT NULL
    ), affected AS (
      SELECT id FROM returns WHERE id=$1
      UNION
      SELECT e.dependent FROM affected a JOIN edges e ON e.premise=a.id
    ) SELECT id FROM affected WHERE id IS NOT NULL`, [returnId]);
  const ids = descendants.map(r => Number(r.id));
  const affected = await q(`SELECT * FROM research_routes WHERE last_return_id=ANY($1::bigint[])`, [ids]);
  for (const route of affected) {
    const evidence = `Dependency return #${returnId} is now ${status}. Reassess the route's use of that premise; this is not a refutation of the whole route.`;
    const latest = await one(`SELECT outcome,evidence_md FROM research_events WHERE route_id=$1 ORDER BY id DESC LIMIT 1`, [route.id]);
    if (latest?.outcome === 'dependency_changed' && latest.evidence_md === evidence) continue;
    await q(`UPDATE research_routes SET state='blocked',revision=revision+1,updated_at=now(),obstacle=$2 WHERE id=$1`, [route.id, JSON.stringify({ kind: 'unresolved', statement: `Dependency #${returnId}`, assumptions: 'The route depends on this result.', evidence, revisit_when: 'A fresh investigation of the changed premise or an alternative.' })]);
    await q(`INSERT INTO research_events (route_id,outcome,evidence_md) VALUES ($1,'dependency_changed',$2)`, [route.id, evidence]);
    // Keep held work intact; its next brief and the public dependency record expose the changed premise.
    await q(`UPDATE jobs SET status='expired' WHERE research_route_id=$1 AND research_stage IN ('triage','pursue','rescue') AND status='queued'`, [route.id]);
  }
  return ids;
}
