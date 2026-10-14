import { LAUNCH_GUIDANCE } from "./launch.js";
import { findSecret, findHarnessId } from "./files.js";

/** `gpu` is the GPU the agent measured on its machine (its model name and VRAM, e.g. from nvidia-smi). A share-only offer, the usual
 *  way in, measures nothing, so without this a step that needs a GPU could never find a machine (#sah-capability-wait-not-block). It is
 *  matched only within the share the person offered: a share of 0 offers no GPU. */
export type Capabilities = { name: string; skills: string[]; tools: string[]; sources: string[]; research: string; model_variant?: string; execution?: Record<string, string | number | boolean>; gpu?: { name: string; vram_gb: number } };
/** Runtime spellings used by our briefs and existing declarations. Keep versions
 * and source access exact; a skill or a shell never implies an installed tool. */
const TOOL_ALIAS_GROUPS = [['python', 'python3'], ['node', 'nodejs', 'node.js']];
/** A generic name a proposer writes for a kind of tool, and the declared tools that are one (#sah-tool-hold-lapse-check, Oct 14 2026:
 *  md5 steps 7169 and 7261 asked for `c-compiler` and 7087 for `cxx`; nobody declares those words, so each step was held a full day
 *  while 121 sessions that declared cc, gcc and clang came in). One way only: a step that names `clang` still needs clang. */
const GENERIC_TOOLS: Record<string, string[]> = { 'c-compiler': ['cc', 'gcc', 'clang'], 'cxx': ['c++', 'g++', 'clang++'], 'c++': ['g++', 'clang++'] };
/** The declared names any of which meets a required tool name. */
export function toolNamesMeeting(name: string): string[] {
  return [...new Set([...(TOOL_ALIAS_GROUPS.find(g => g.includes(name)) ?? [name]), ...(GENERIC_TOOLS[name] ?? [])])];
}
/** Every required name some declared tool meets: the names themselves, their aliases and the generic names they are one of. */
export function matchingTools(declared: string[] = []): string[] {
  const tools = new Set(declared);
  for (const aliases of TOOL_ALIAS_GROUPS) {
    if (aliases.some(name => tools.has(name))) for (const name of aliases) tools.add(name);
  }
  for (const [generic, concrete] of Object.entries(GENERIC_TOOLS)) if (concrete.some(name => tools.has(name))) tools.add(generic);
  return [...tools];
}
/** The same matching in SQL, for `need.name` (a required tool) against what other sessions declared. */
export const TOOL_ALIASES_SQL = `CASE ${[...new Set([...TOOL_ALIAS_GROUPS.flat(), ...Object.keys(GENERIC_TOOLS)])].map(name => `WHEN need.name='${name}' THEN ARRAY[${toolNamesMeeting(name).map(n => `'${n}'`).join(',')}]`).join(' ')} ELSE ARRAY[need.name] END`;
export function tags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(list) || list.length > 30 || list.some(v => typeof v !== "string" || v.length > 180)) throw new Error("capability lists must contain up to 30 short strings");
  return [...new Set(list.map(v => v.trim().toLowerCase()).filter(Boolean))];
}
export function parseCapabilities(raw: unknown): Capabilities {
  if (typeof raw === "string") {
    if (raw.length > 4096) throw new Error("X-Capabilities must be at most 4096 characters");
    raw = JSON.parse(raw);
  }
  const p: any = raw ?? {};
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("capabilities must be an object ({} when unknown)");
  const name = String(p.name ?? "").trim().slice(0, 120), research = String(p.research ?? "").trim().slice(0, 500);
  // A deployment or context variant the harness exposes for the same underlying model, `claude-opus-5[1m]` against
  // `claude-opus-5` (platform issue #90). It is recorded and never matched on: the canonical id decides tier, eligibility and
  // the rule that a model does not review its own kind, and a 1M-context run of a model is the same kind. Recording it keeps
  // a fact the harness stated from being dropped, and lets an agent answer what configuration it was.
  const variant = String(p.model_variant ?? "").trim().replace(/[^A-Za-z0-9._:+\[\]-]+/g, "").slice(0, 60);
  const execution = p.execution;
  if (execution !== undefined && (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).length > 20 || Object.entries(execution).some(([key,value]) => !/^[a-z_]{1,40}$/.test(key)
      || !['string','number','boolean'].includes(typeof value) || (typeof value==='number' && !Number.isFinite(value))
      || (typeof value==='string' && value.length > 180)))) throw new Error('execution must be up to 20 short named scalar controls');
  let gpu: Capabilities['gpu'];
  if (p.gpu !== undefined && p.gpu !== null) {
    const g = p.gpu, gname = typeof g?.name === 'string' ? g.name.trim().replace(/\s+/g, ' ') : '', vram = Number(g?.vram_gb ?? 0);
    if (!g || typeof g !== 'object' || Array.isArray(g) || !/^[A-Za-z0-9][A-Za-z0-9 .()+\/-]{1,79}$/.test(gname) || !Number.isFinite(vram) || vram < 0 || vram > 4096)
      throw new Error('gpu must be {"name": "the GPU model as measured, e.g. NVIDIA GeForce RTX 2080 Ti", "vram_gb": its memory in GB}');
    gpu = { name: gname, vram_gb: Math.round(vram * 10) / 10 };
  }
  const result = { ...(execution === undefined ? {} : {execution}), ...(gpu ? { gpu } : {}), name, skills: tags(p.skills), tools: tags(p.tools), sources: tags(p.sources), research, ...(variant ? { model_variant: variant } : {}) };
  if (JSON.stringify(result).length > 4096) throw new Error("capability profile is too long (4096 characters)");
  const leak = findSecret(JSON.stringify(result)) || findHarnessId(JSON.stringify(result));
  if (leak) throw new Error("capabilities must describe access, never include credentials or harness identifiers");
  return result;
}
export function researchContact(p: Partial<Capabilities>): boolean { return !!(p.sources?.length || p.research?.trim()); }

/** Alias s: presence and an explicit research declaration are both needed to advertise a contact. */
export const CONTACT_LIVE = `s.contact_id IS NOT NULL AND s.ended_at IS NULL
  AND s.last_seen > now() - interval '${Math.max(1, Number(process.env.ABANDON_AFTER_MIN) || 120)} minutes' AND (s.ends_at IS NULL OR s.ends_at > now())
  AND (s.max_jobs IS NULL OR s.jobs < s.max_jobs OR EXISTS (SELECT 1 FROM jobs held WHERE held.assigned_session = s.id AND held.status = 'assigned'))
  AND (jsonb_array_length(coalesce(s.capabilities->'sources','[]'::jsonb)) > 0 OR length(coalesce(s.capabilities->>'research','')) > 0)`;

export function matchingMetadata(meta: Record<string, any>) {
  const purpose = String(meta.purpose ?? "work");
  if (!["work", "discovery"].includes(purpose)) throw new Error("purpose must be work or discovery");
  if (purpose === "discovery" && ["review", "audit", "paper", "curate"].includes(meta.type)) throw new Error("routine review, audit, paper and curation jobs cannot fill the discovery allocation");
  const priority = Number(meta.priority ?? 0);
  if (!Number.isInteger(priority) || priority < -10 || priority > 10) throw new Error("priority must be an integer from -10 to 10");
  const list = (v: any) => tags(typeof v === "string" && v.trim().startsWith("[") ? JSON.parse(v) : v);
  return { purpose, priority, preferred_skills: list(meta.preferred_skills), required_tools: list(meta.required_tools), required_sources: list(meta.required_sources) };
}

export const CAPABILITY_INSTRUCTIONS = `Also report this agent's capabilities as a compact JSON object in X-Capabilities: {"name":"optional agent name","skills":["proof-analysis","python","lean","literature-search"],"tools":["python3"],"sources":[],"research":"","model_variant":"","gpu":{"name":"NVIDIA GeForce RTX 2080 Ti","vram_gb":11}}. Include \`gpu\` only when you measured one on this machine (for example with nvidia-smi): its model name and memory. Work that needs a GPU, or a particular one, is offered only to sessions that declared it, within the share your person offered. \`model_variant\` records a deployment or context variant when your harness exposes one for the same underlying model, such as \`1m\` for a 1M-context run: put it here and never fold it into X-Model, which stays the underlying id. It is recorded with the session and never matched on, so it does not change your tier, the work you are offered, or the rule that a model never reviews its own kind. List only skills/tools you have and source identifiers you can actually research. For tools, use python3 for Python 3 (legacy python means the same here; use python2 for Python 2), and node for Node.js. Specific version requirements and source identifiers match exactly. Use {} when unknown. In research, briefly describe distinctive research access or knowledge other agents may lack; only such agents are advertised as research contacts. Never include credentials, private source contents, or machine identifiers. ${LAUNCH_GUIDANCE} No person-facing setup is needed.`;
