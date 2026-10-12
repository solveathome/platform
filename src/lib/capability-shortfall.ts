/**
 * Operational limits are not research obstacles (Chris, Oct 12 2026, card 1387: "we don't want to block jobs for hardware reasons we
 * just don't want to assign such jobs to a maschine that can't run it"). On md5, routes 263, 265 and 268 were closed as blocked because
 * the host that took the step had no RTX 2080 Ti, no constrain interface in the stock tool within 2 CPU-h, or a precompute that did not
 * finish in the assignment; a blocked route queues nothing, so the scheduler never got to offer the step to a machine that could run it.
 *
 * A report with outcome `needs_capability` says so directly. Agents still file such limits as obstacles, so intake reads a blocked or
 * inconclusive obstacle for the marks of an operational limit (this host lacks, no GPU, did not finish within the assignment, not
 * installed) and turns it into a wait: the experiment stays the route's next step, with the requirement the failed attempt shows, and
 * the route stays active. The patterns are deliberately narrow and name the machine or the budget: "cannot be decided at any budget
 * tried" or "random search needs 16^k" is a finding about the mathematics or the method and stays an obstacle.
 */
import type { NextStep, ResearchReport } from './research-format.js';

export type Shortfall = { gpu: boolean; gpu_name: string | null; time: boolean; tool: boolean };

const MACHINE = String.raw`(?:this|the|my|our|current|local|assigned|available|worker'?s?|contributor'?s?)\s+(?:host|machine|box|computer|worker|environment|sandbox|container|node|laptop|server|hardware)`;
const LACKS = String.raw`(?:lacks?|lacking|has\s+no|had\s+no|does\s+not\s+have|did\s+not\s+have|doesn'?t\s+have|didn'?t\s+have|is\s+missing|was\s+missing|without)`;
const GPU_WORD = String.raw`(?:gpus?|nvidia|cuda|nvcc|rtx|gtx|vram|sm_\d{2,3}|metal\s+gpu|rocm)`;
const PATTERNS: Array<[keyof Omit<Shortfall, 'gpu_name'> | 'any', RegExp]> = [
  // "This host lacks an RTX 2080 Ti (sm_75), CUDA 12.9/NVCC" (route 268)
  ['any', new RegExp(String.raw`\b${MACHINE}\b[^.;]{0,60}?\b${LACKS}\b`, 'i')],
  ['gpu', new RegExp(String.raw`\b(?:no|without|lacks?|lacking|missing|absent)\s+(?:an?\s+|any\s+)?(?:usable\s+|suitable\s+|compatible\s+)?${GPU_WORD}`, 'i')],
  ['gpu', new RegExp(String.raw`\b${GPU_WORD}[^.;]{0,30}?\b(?:absent|unavailable|not\s+available|not\s+present|not\s+installed|missing)\b`, 'i')],
  // "table precompute did not finish in this sprint" (route 265)
  ['time', /\b(?:did\s+not|didn'?t|could\s+not|couldn'?t|failed\s+to|was\s+unable\s+to|unable\s+to)\s+(?:finish|complete|terminate|run\s+to\s+completion)\b[^.;]{0,80}?\b(?:in|within|during|inside)\s+(?:this|the|my|its|one|a\s+single|the\s+allotted|the\s+assigned|the\s+available)\s+(?:sprint|budget|assignment|session|time\s+budget|time|allowance|attempt|run)\b/i],
  // "Cannot execute ... within 2 CPU-h: ... host TTF too slow" (route 263); "emitted 0 full collisions in ~14 CPU-minutes" (route 261)
  ['time', /\b(?:cannot|can'?t|could\s+not|couldn'?t|unable\s+to|did\s+not|didn'?t|not\s+possible\s+to)\b[^.;]{0,160}?\b(?:in|within)\s+~?\s*\d+(?:\.\d+)?\s*(?:cpu[- ]?(?:hours?|h|minutes?|mins?)|core[- ]?hours?|wall[- ]?(?:clock\s+)?(?:hours?|minutes?))\b/i],
  ['time', /\btoo\s+slow\b[^.;]{0,80}?\b(?:within|for|under|in)\b[^.;]{0,40}?\b(?:budget|assignment|cpu[- ]?h(?:ours?)?|session|allowance)\b/i],
  ['tool', /\b(?:is\s+not|isn'?t|was\s+not|wasn'?t|not)\s+installed\b[^.;]{0,40}?\b(?:on|in)\s+(?:this|the|my)\s+(?:host|machine|environment|sandbox|container)\b/i],
  ['tool', new RegExp(String.raw`\b(?:unavailable|not\s+available)\s+(?:on|in)\s+(?:this|the|my)\s+(?:host|machine|environment|sandbox|container)\b`, 'i')],
];
const GPU_MODEL = /\b(?:nvidia\s+)?(?:geforce\s+)?((?:rtx|gtx)\s?a?\d{3,4}(?:\s?(?:ti|super))?|(?:a|h|l|v|b)\d{2,3}s?\b(?=[^a-z0-9]|$)|t4\b|quadro\s+[a-z]?\d{3,5}|radeon\s+[a-z]{0,3}\s?\d{3,4}(?:\s?xtx?)?)/i;

/** The operational limit an obstacle statement describes, or null when it reads as a research finding. Only the statement decides;
 *  `context` (its evidence and reopening condition) may only name the GPU model. */
export function operationalShortfall(text: string, context = ''): Shortfall | null {
  const t = String(text ?? '');
  let hit = false; const found: Shortfall = { gpu: false, gpu_name: null, time: false, tool: false };
  for (const [kind, re] of PATTERNS) if (re.test(t)) { hit = true; if (kind !== 'any') found[kind] = true; }
  if (!hit) return null;
  const model = GPU_MODEL.exec(t) ?? GPU_MODEL.exec(String(context ?? ''));
  if (new RegExp(`\\b${GPU_WORD}`, 'i').test(t) && (found.gpu || /\b(?:host|machine|worker|environment)\b/i.test(t))) found.gpu = true;
  if (model && found.gpu) found.gpu_name = model[1].toLowerCase().replace(/\s+/g, ' ').trim();
  if (!found.gpu && !found.time && !found.tool) found.tool = true;   // "this machine lacks X" with X neither a GPU nor time: a missing capability
  return found;
}

/** An obstacle's operational limit: read from its statement, with its evidence and reopening condition as context for the GPU model. */
export function obstacleShortfall(o: ResearchReport['obstacle'] | null | undefined): Shortfall | null {
  return o ? operationalShortfall(o.statement, [o.evidence, o.revisit_when].filter(Boolean).join('\n')) : null;
}

/**
 * The step a capability wait holds: the reported next step if any, else the route's current one, with the requirement the failed
 * attempt shows merged in. A time shortfall asks for more than the session that tried offered (twice its CPU hours per assignment, at
 * least two more than the step already asked for); a GPU shortfall asks for a GPU, by name when the report names one.
 */
export function waitingStep(step: NextStep, shortfall: Shortfall | null, statement: string, offered: { cpu_hours?: number | null } = {}): NextStep {
  const compute = { ...step.compute };
  if (shortfall?.gpu) { compute.gpu = true; if (shortfall.gpu_name && !compute.gpu_name) compute.gpu_name = shortfall.gpu_name; }
  if (shortfall?.time) compute.cpu_hours = Math.min(32, Math.max(Number(compute.cpu_hours ?? 0) + 2, 2 * Number(offered.cpu_hours ?? 0), 2));
  return { ...step, compute, shortfall: statement.slice(0, 1000) };
}

/** The requirement a capability wait is held to, for comparing two jobs of the same experiment. */
export function requirementKey(compute: Record<string, any> | null | undefined, tools: string[] | null | undefined, sources: string[] | null | undefined): string {
  const c = compute ?? {};
  return JSON.stringify([Number(c.cpu_hours ?? 0), Number(c.ram_gb ?? 0), Number(c.disk_gb ?? 0), !!c.gpu, c.gpu_name ?? null, Number(c.vram_gb ?? 0), [...(tools ?? [])].sort(), [...(sources ?? [])].sort()]);
}

/** What an active route's next step waits for, in words, or null when it is not waiting on a machine. */
export function waitingFor(route: { state?: string | null; next_step?: any } | null | undefined): string | null {
  if (!route || route.state !== 'active' || !route.next_step?.shortfall) return null;
  return describeNeeds(route.next_step) || 'a machine that can run it';
}

/** "rtx 2080 ti" as people write it: RTX 2080 Ti. */
export function gpuLabel(name: string): string {
  return name.split(' ').map(w => /^ti$/i.test(w) ? 'Ti' : /^super$/i.test(w) ? w[0].toUpperCase() + w.slice(1) : /^[a-z]{1,6}$/i.test(w) && !/^(geforce|quadro|radeon|tesla)$/i.test(w) ? w.toUpperCase() : /^[a-z]\d/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Short words for what a waiting step needs, for pages and briefs: "GPU RTX 2080 Ti, 8 CPU h per assignment, cuda-12.9". */
export function describeNeeds(step: { compute?: Record<string, any> | null; required_tools?: string[] | null; required_sources?: string[] | null } | null | undefined): string {
  if (!step) return '';
  const c = step.compute ?? {}, parts: string[] = [];
  if (c.gpu_name) parts.push(`GPU ${gpuLabel(String(c.gpu_name))}${c.vram_gb ? ` with ${c.vram_gb} GB VRAM` : ''}`);
  else if (c.gpu) parts.push(`a GPU${c.vram_gb ? ` with ${c.vram_gb} GB VRAM` : ''}`);
  if (Number(c.cpu_hours) > 0) parts.push(`${Number(c.cpu_hours)} CPU h per assignment`);
  if (Number(c.ram_gb) > 8) parts.push(`${Number(c.ram_gb)} GB RAM`);
  if (Number(c.disk_gb) > 5) parts.push(`${Number(c.disk_gb)} GB disk`);
  for (const t of step.required_tools ?? []) parts.push(t);
  for (const x of step.required_sources ?? []) parts.push(`access to ${x}`);
  return parts.join(', ');
}
