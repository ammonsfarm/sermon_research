import { ROLE_NAMES, ServiceError, type RoleName } from "@aic/contracts";
import type { D1Database } from "./index.ts";

export interface AdminUserRow {
  clerkUserId: string;
  email: string;
  name: string;
  role: RoleName;
  lastSeenAt: string | null;
  updatedAt: string | null;
}

function unavailable(): ServiceError {
  return new ServiceError({ code: "dependency_unavailable", message: "User administration is temporarily unavailable.", retryable: true });
}

export async function listD1Users(db: D1Database): Promise<AdminUserRow[]> {
  const result = await db.prepare(`SELECT u.clerk_user_id,u.verified_email,u.display_name,u.last_seen_at,u.updated_at,
    coalesce((SELECT r.role FROM user_roles r WHERE r.user_id=u.user_id AND r.revoked_at IS NULL
      ORDER BY CASE r.role WHEN 'Admin' THEN 0 WHEN 'Content Manager' THEN 1 WHEN 'Research User' THEN 2 WHEN 'Read Only' THEN 3 ELSE 4 END LIMIT 1),'User') AS role
    FROM users u ORDER BY lower(coalesce(u.verified_email,'')),u.user_id LIMIT 5001`).all<Record<string, unknown>>();
  if (result.success === false || result.results.length > 5000) throw unavailable();
  return result.results.map((row) => {
    if (typeof row.clerk_user_id !== "string" || typeof row.role !== "string" || !ROLE_NAMES.includes(row.role as RoleName)) throw unavailable();
    return { clerkUserId: row.clerk_user_id, email: typeof row.verified_email === "string" ? row.verified_email : "", name: typeof row.display_name === "string" ? row.display_name : "", role: row.role as RoleName, lastSeenAt: typeof row.last_seen_at === "string" ? row.last_seen_at : null, updatedAt: typeof row.updated_at === "string" ? row.updated_at : null };
  });
}

export async function assignD1UserRole(db: D1Database, input: { email: string; role: RoleName; actorClerkUserId: string }): Promise<AdminUserRow> {
  const email = input.email.trim().toLowerCase();
  if (!email || email.length > 320 || !email.includes("@") || !ROLE_NAMES.includes(input.role) || !input.actorClerkUserId || input.actorClerkUserId.length > 512) {
    throw new ServiceError({ code: "invalid_argument", message: "A valid existing user, role, and administrator identity are required." });
  }
  if (!db.batch) throw unavailable();
  const target = "SELECT user_id FROM users WHERE lower(verified_email)=?";
  const at = new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  // Recheck identity uniqueness and the actor's D1 authority inside the same
  // atomic batch as the grant. Never infer ownership or create a Clerk identity.
  const guard = `SELECT json(CASE WHEN
    (SELECT count(*) FROM users WHERE lower(verified_email)=?)=1 AND
    EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.user_id WHERE u.clerk_user_id=? AND u.status='active' AND r.role='Admin' AND r.revoked_at IS NULL) AND
    (?='Admin' OR NOT EXISTS(SELECT 1 FROM user_roles WHERE user_id=(${target}) AND role='Admin' AND revoked_at IS NULL) OR
      EXISTS(SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.user_id WHERE u.user_id<>(${target}) AND u.status='active' AND r.role='Admin' AND r.revoked_at IS NULL))
    THEN '{}' ELSE 'role_assignment_conflict' END)`;
  try {
    const results = await db.batch([
      db.prepare(guard).bind(email, input.actorClerkUserId, input.role, email, email),
      db.prepare(`INSERT INTO admin_operation_audit(audit_id,action,entity_type,entity_id,actor_email,detail_json,created_at)
        SELECT ?,'user_role_assign','user',user_id,?,json_object('actorClerkUserId',?,'role',?,'priorRoles',json((SELECT json_group_array(role) FROM user_roles WHERE user_id=users.user_id AND revoked_at IS NULL))),? FROM users WHERE lower(verified_email)=?`)
        .bind(crypto.randomUUID(), input.actorClerkUserId, input.actorClerkUserId, input.role, at, email),
      db.prepare(`UPDATE user_roles SET revoked_at=? WHERE user_id=(${target}) AND revoked_at IS NULL`).bind(at, email),
      db.prepare(`INSERT INTO user_roles(user_id,role,granted_at,revoked_at,granted_by) SELECT user_id,?,?,NULL,? FROM users WHERE lower(verified_email)=? ON CONFLICT(user_id,role) DO UPDATE SET granted_at=excluded.granted_at,revoked_at=NULL,granted_by=excluded.granted_by`).bind(input.role, at, input.actorClerkUserId, email),
      db.prepare(`UPDATE users SET updated_at=? WHERE user_id=(${target})`).bind(at, email),
    ]);
    if (results.length !== 5 || results.some((row) => row.success === false)) throw unavailable();
  } catch {
    throw new ServiceError({ code: "conflict", message: "Role change was not committed. Confirm a unique existing user, current administrator access, and another active administrator before removing the last Admin." });
  }
  const user = (await listD1Users(db)).find((row) => row.email.toLowerCase() === email);
  if (!user) throw unavailable();
  return user;
}
