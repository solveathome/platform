/**
 * Compute offers (Chris, Sep 10; Q67): a share of the machine, not a fixed size. The agent measures the machine it runs on
 * (cores, RAM, GPU, free disk) and the person says what share of it may be used. The server derives what that is worth in
 * absolute terms and matches jobs against it. A 25% share of a 64-core box is 16 cores; of a laptop, 2. The offer stays
 * meaningful in local context and nobody is asked to fit a preset.
 */
export type Machine = { cores: number; ram_gb: number; gpu: { name: string; vram_gb: number } | null; disk_free_gb: number | null; os?: string | null };
export type ComputeOffer = {
  share: number;                // 0..1 of the machine
  machine: Machine;
  mathlib_cache: boolean;
  cap_hours?: number | null;    // the person's own CPU-hours cap per assignment, when they gave one on top of the share
  usable: { cores: number; ram_gb: number; vram_gb: number; disk_free_gb: number | null; cpu_hours: number };  // per assignment
};

const num = (v: unknown, max = 1e6) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0; };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** Parse what the agent posted. Accepts the share shape and, for old agents, the fixed {cpu_hours, ram_gb} shape. Null when nothing is offered. */
export function parseOffer(raw: any, maxHoursPerAssignment: number): ComputeOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const hours = Math.max(0.25, Math.min(24, Number(maxHoursPerAssignment) || 2));
  if (raw.machine && typeof raw.machine === "object") {
    const share = Math.max(0, Math.min(1, Number(raw.share ?? 0.25) || 0));
    if (share === 0) return null;
    const m: Machine = {
      cores: num(raw.machine.cores, 4096), ram_gb: round(num(raw.machine.ram_gb, 65536)),
      gpu: raw.machine.gpu && typeof raw.machine.gpu === "object" && String(raw.machine.gpu.name ?? "").trim() ? { name: String(raw.machine.gpu.name).slice(0, 80), vram_gb: round(num(raw.machine.gpu.vram_gb, 4096)) } : null,
      disk_free_gb: raw.machine.disk_free_gb !== undefined && raw.machine.disk_free_gb !== null ? round(num(raw.machine.disk_free_gb, 1e6)) : null,
      os: raw.machine.os ? String(raw.machine.os).slice(0, 40) : null,
    };
    if (!m.cores && !m.ram_gb && !m.gpu) return null;
    // A cpu_hours next to the share is the person's own cap per assignment (a reviewer agent posted both, Sep 10): the lower number wins and is the one shown.
    const cap = raw.cpu_hours !== undefined && raw.cpu_hours !== null ? num(raw.cpu_hours, 1e4) : null;
    return finish({ share, machine: m, mathlib_cache: !!raw.mathlib_cache, cap_hours: cap || null }, hours);
  }
  // Legacy fixed shape: treat the numbers as the whole offer (share 1 of a machine that size).
  const cpuHours = num(raw.cpu_hours, 1e4), ram = round(num(raw.ram_gb, 65536));
  if (!cpuHours && !ram) return null;
  const cores = cpuHours ? Math.max(1, Math.round(cpuHours / hours)) : 1;
  return finish({ share: 1, machine: { cores, ram_gb: ram, gpu: null, disk_free_gb: null, os: null }, mathlib_cache: !!raw.mathlib_cache }, hours);
}

function finish(o: Omit<ComputeOffer, "usable">, hours: number): ComputeOffer {
  const cores = round(o.machine.cores * o.share), ram = round(o.machine.ram_gb * o.share), vram = round((o.machine.gpu?.vram_gb ?? 0) * o.share);
  const derived = round(cores * hours, 2);
  const cpuHours = o.cap_hours ? Math.min(derived, round(o.cap_hours, 2)) : derived;
  return { ...o, usable: { cores, ram_gb: ram, vram_gb: vram, disk_free_gb: o.machine.disk_free_gb, cpu_hours: cpuHours } };
}

/** One line for briefs and settings: "50% of 32 cores / 128 GB / RTX 5090 32 GB: 16 cores, 64 GB, 16 GB VRAM, 32 CPU h per assignment". */
export function describeOffer(o: ComputeOffer | null | undefined): string {
  if (!o || !o.usable) return "not offered";
  const m = o.machine, u = o.usable;
  const whole = [m.cores ? `${m.cores} cores` : null, m.ram_gb ? `${m.ram_gb} GB` : null, m.gpu ? `${m.gpu.name}${m.gpu.vram_gb ? ` ${m.gpu.vram_gb} GB` : ""}` : null].filter(Boolean).join(" / ");
  const part = [`${u.cores} cores`, `${u.ram_gb} GB`, u.vram_gb ? `${u.vram_gb} GB VRAM` : null, `${u.cpu_hours} CPU h per assignment${o.cap_hours && u.cpu_hours === round(o.cap_hours, 2) ? " (their own cap)" : ""}`].filter(Boolean).join(", ");
  return `${Math.round(o.share * 100)}% of ${whole || "the machine"}: ${part}${o.mathlib_cache ? ", Mathlib cache allowed" : ""}`;
}

/** What the orientation tells the agent to run before asking its person. */
export const MEASURE_HOWTO = `Measure the machine first, with your shell (one command per line, ignore what fails): macOS \`sysctl -n hw.ncpu hw.memsize\` and \`system_profiler SPDisplaysDataType | grep -E "Chipset|VRAM|Model"\`; Linux \`nproc\`, \`free -g\`, \`nvidia-smi --query-gpu=name,memory.total --format=csv,noheader\`; Windows \`wmic cpu get NumberOfLogicalProcessors\`, \`wmic computersystem get TotalPhysicalMemory\`, \`wmic path win32_VideoController get Name,AdapterRAM\`; free disk \`df -h .\`. Put the real numbers in the option labels so the person sees what a share means on this machine.`;
