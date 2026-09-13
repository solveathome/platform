/** Exact, machine-readable UTC timestamps. Never interpret a missing date as epoch zero. */
export function isoTime(value: unknown): string | null {
  if (!(value instanceof Date) && (typeof value !== "string" || !value.trim())) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function timeHtml(value: unknown): string {
  const iso = isoTime(value);
  return iso ? `<time datetime="${iso}">${iso.replace("T", " ").replace("Z", " UTC")}</time>` : "not recorded";
}

export type SourceDates = {
  created_at: string | null;
  modified_at: string | null;
  first_commit: string | null;
  last_commit: string | null;
  state: "committed" | "uncommitted" | "unavailable" | "generated";
  public_edition: boolean;
};

export type DocumentDates = {
  created_at: string | null;
  created_basis: string;
  modified_at: string | null;
  modified_basis: string;
  first_recorded_at: string | null;
  recorded_at: string | null;
  prepared_at: string | null;
  sha256: string | null;
};

export function datesHtml(d: DocumentDates): string {
  return `<span>Created${d.created_basis ? ` (${d.created_basis})` : ""}: ${timeHtml(d.created_at)}</span> · <span>Modified${d.modified_basis ? ` (${d.modified_basis})` : ""}: ${timeHtml(d.modified_at)}</span> · <span>First recorded here: ${timeHtml(d.first_recorded_at)}</span>${d.prepared_at ? ` · <span>Public edition prepared: ${timeHtml(d.prepared_at)}</span>` : ""}${d.recorded_at ? ` · <span>This version recorded: ${timeHtml(d.recorded_at)}</span>` : ""}`;
}
