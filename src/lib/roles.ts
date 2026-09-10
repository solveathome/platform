/**
 * Trusted reviewers (Sep 10). A small group of people who put their time and their tier-1 agents behind the quality of one
 * project. Their reviews decide; everyone else's are advisory. The owner (the maintainer and the project's researcher) grants
 * and revokes trust, always with a public note, and decides applications. Roles are per project.
 */
import { q, one } from "../db/index.js";

export type Role = "owner" | "trusted";
export type Member = { user_id: number; handle: string; display_name: string | null; role: Role; granted_at: string; note: string; granted_by: string | null; reviews: number; agreed: number; last_review: string | null; dormant: boolean };

const OWNER_HANDLES = new Set((process.env.OWNER_HANDLES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

export async function roleOf(problemId: number, userId: number, handle?: string): Promise<Role | null> {
  if (handle && OWNER_HANDLES.has(handle.toLowerCase())) return "owner";
  const r = await one<{ role: Role; researcher: number | null }>(`SELECT (SELECT role FROM project_roles WHERE problem_id = $1 AND user_id = $2 AND revoked_at IS NULL) AS role, (SELECT researcher_user_id FROM problems WHERE id = $1) AS researcher`, [problemId, userId]);
  if (r?.role === "owner" || Number(r?.researcher) === userId) return "owner";
  return r?.role ?? null;
}
export async function isOwner(problemId: number, userId: number, handle?: string): Promise<boolean> { return (await roleOf(problemId, userId, handle)) === "owner"; }
/** Owners are trusted too. */
export async function isTrusted(problemId: number, userId: number, handle?: string): Promise<boolean> { return (await roleOf(problemId, userId, handle)) !== null; }

export async function roster(problemId: number): Promise<Member[]> {
  // Explicit grants, plus the implicit owners: the project's researcher and the maintainer handles.
  return q<Member>(`
    WITH members AS (
      SELECT user_id, role, granted_at, note, granted_by FROM project_roles WHERE problem_id = $1 AND revoked_at IS NULL
      UNION ALL
      SELECT researcher_user_id, 'owner', now(), 'project researcher', NULL FROM problems WHERE id = $1 AND researcher_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM project_roles r WHERE r.problem_id = $1 AND r.user_id = problems.researcher_user_id AND r.revoked_at IS NULL)
      UNION ALL
      SELECT u.id, 'owner', now(), 'maintainer', NULL FROM users u WHERE lower(u.handle) = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM project_roles r WHERE r.problem_id = $1 AND r.user_id = u.id AND r.revoked_at IS NULL)
        AND u.id IS DISTINCT FROM (SELECT researcher_user_id FROM problems WHERE id = $1)
    )
    SELECT m.user_id, u.handle, u.display_name, m.role, m.granted_at, m.note, g.handle AS granted_by,
      (SELECT count(*) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = m.user_id AND x.problem_id = $1) AS reviews,
      (SELECT count(*) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = m.user_id AND x.problem_id = $1 AND rv.agreed_with_outcome) AS agreed,
      (SELECT max(rv.created_at) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = m.user_id AND x.problem_id = $1) AS last_review,
      coalesce((SELECT max(rv.created_at) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = m.user_id AND x.problem_id = $1) < now() - interval '60 days', false) AS dormant
    FROM members m JOIN users u ON u.id = m.user_id LEFT JOIN users g ON g.id = m.granted_by
    ORDER BY (m.role = 'owner') DESC, m.granted_at`, [problemId, [...OWNER_HANDLES]]);
}

export async function grant(problemId: number, userId: number, role: Role, by: number | null, note: string): Promise<void> {
  await q(`INSERT INTO project_roles (problem_id, user_id, role, granted_by, note) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (problem_id, user_id) DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, note = EXCLUDED.note, granted_at = now(), revoked_at = NULL, revoke_note = NULL`, [problemId, userId, role, by, note]);
}
export async function revoke(problemId: number, userId: number, by: number, note: string): Promise<boolean> {
  const r = await q(`UPDATE project_roles SET revoked_at = now(), revoked_by = $3, revoke_note = $4 WHERE problem_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING user_id`, [problemId, userId, by, note]);
  return r.length > 0;
}
/** Past grants and revocations: the public record. */
export async function history(problemId: number): Promise<any[]> {
  return q(`SELECT u.handle, r.role, r.granted_at, r.note, g.handle AS granted_by, r.revoked_at, r.revoke_note, v.handle AS revoked_by
            FROM project_roles r JOIN users u ON u.id = r.user_id LEFT JOIN users g ON g.id = r.granted_by LEFT JOIN users v ON v.id = r.revoked_by
            WHERE r.problem_id = $1 ORDER BY coalesce(r.revoked_at, r.granted_at) DESC`, [problemId]);
}

export type Application = { id: number; user_id: number; handle: string; display_name: string | null; statement: string; model: string; hours_per_week: number; status: string; decided_by: string | null; decision_note: string | null; created_at: string; decided_at: string | null; advisory_reviews: number; advisory_agreed: number; accepted_returns: number };
export async function applications(problemId: number, status?: string): Promise<Application[]> {
  return q<Application>(`
    SELECT a.id, a.user_id, u.handle, u.display_name, a.statement, a.model, a.hours_per_week, a.status, d.handle AS decided_by, a.decision_note, a.created_at, a.decided_at,
      (SELECT count(*) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = a.user_id AND x.problem_id = $1) AS advisory_reviews,
      (SELECT count(*) FROM reviews rv JOIN returns x ON x.id = rv.return_id WHERE rv.user_id = a.user_id AND x.problem_id = $1 AND rv.agreed_with_outcome) AS advisory_agreed,
      (SELECT count(*) FROM returns x WHERE x.user_id = a.user_id AND x.problem_id = $1 AND x.status = 'accepted' AND NOT x.provisional) AS accepted_returns
    FROM trust_applications a JOIN users u ON u.id = a.user_id LEFT JOIN users d ON d.id = a.decided_by
    WHERE a.problem_id = $1 AND ($2::text IS NULL OR a.status = $2) ORDER BY a.created_at DESC`, [problemId, status ?? null]);
}
export async function apply(problemId: number, userId: number, statement: string, model: string, hours: number): Promise<{ id: number }> {
  const open = await one<{ id: number }>(`SELECT id FROM trust_applications WHERE problem_id = $1 AND user_id = $2 AND status = 'open'`, [problemId, userId]);
  if (open) { await q(`UPDATE trust_applications SET statement = $2, model = $3, hours_per_week = $4 WHERE id = $1`, [open.id, statement, model, hours]); return { id: Number(open.id) }; }
  const r = await one<{ id: number }>(`INSERT INTO trust_applications (problem_id, user_id, statement, model, hours_per_week) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [problemId, userId, statement, model, hours]);
  return { id: Number(r!.id) };
}
export async function decideApplication(id: number, problemId: number, by: number, accept: boolean, note: string): Promise<Application | null> {
  const a = await one<{ id: number; user_id: number }>(`UPDATE trust_applications SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1 AND problem_id = $2 AND status = 'open' RETURNING id, user_id`, [id, problemId, accept ? "accepted" : "declined", by, note]);
  if (!a) return null;
  if (accept) await grant(problemId, Number(a.user_id), "trusted", by, note || "application accepted");
  return (await applications(problemId)).find((x) => Number(x.id) === Number(a.id)) ?? null;
}
