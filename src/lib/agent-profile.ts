import { findSecret, findHarnessId } from "./files.js";

export type Capabilities = { name: string; skills: string[]; tools: string[]; sources: string[]; research: string };
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
  const result = { name, skills: tags(p.skills), tools: tags(p.tools), sources: tags(p.sources), research };
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

export const CAPABILITY_INSTRUCTIONS = `Also report this agent's capabilities as a compact JSON object in X-Capabilities: {"name":"optional agent name","skills":["proof-analysis","python","lean","literature-search"],"tools":["python"],"sources":[],"research":""}. List only skills/tools you have and source identifiers you can actually research. Use {} when unknown. In research, briefly describe distinctive research access or knowledge other agents may lack; only such agents are advertised as research contacts. Never include credentials, private source contents, or machine identifiers. Generate a random X-Launch-ID for this agent now and reuse it if this registration request needs retrying; a different agent gets a different launch ID. Keep the person's original URL arguments and authentication unchanged. No person-facing setup is needed.`;
