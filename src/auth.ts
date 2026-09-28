import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto.ts";

export const SESSION_COOKIE = "__Host-sr_session";
export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;
/** Sessions are extended at most once a day so every request does not write to D1. */
const REFRESH_AFTER_MS = DAY_MS;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;

export type Role = "admin" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
}

export interface Session {
  readonly user: User;
  readonly tokenHash: string;
  /** Set when the cookie should be re-sent with a later expiry. */
  readonly refreshedToken?: string;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (password.length > 256) return "Use at most 256 characters.";
  return null;
}

export async function hasAdmin(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS found FROM users WHERE role = 'admin' LIMIT 1").first()) !== null;
}

/**
 * Creates the first admin. Returns null when an admin already exists, so two
 * racing setup submissions cannot both succeed.
 */
export async function createFirstAdmin(db: D1Database, input: { email: string; name: string; password: string }): Promise<User | null> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
     SELECT ?, ?, ?, 'admin', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
  ).bind(id, input.email, input.name, await hashPassword(input.password), now, now).run();
  return result.meta.changes === 1 ? { id, email: input.email, name: input.name, role: "admin" } : null;
}

export async function authenticate(db: D1Database, email: string, password: string): Promise<User | null> {
  const row = await db.prepare("SELECT id, email, name, role, password_hash FROM users WHERE email = ?")
    .bind(email).first<{ id: string; email: string; name: string; role: Role; password_hash: string | null }>();
  // Hash anyway when the user is missing so response time does not reveal which emails exist.
  const ok = await verifyPassword(password, row?.password_hash ?? "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  return row && row.password_hash && ok ? { id: row.id, email: row.email, name: row.name, role: row.role } : null;
}

export async function createSession(db: D1Database, userId: string, now = Date.now()): Promise<string> {
  const token = randomToken();
  const iso = new Date(now).toISOString();
  await db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), userId, iso, iso, new Date(now + SESSION_DAYS * DAY_MS).toISOString()).run();
  return token;
}

export async function readSession(db: D1Database, token: string | undefined, now = Date.now()): Promise<Session | null> {
  if (!token || token.length > 128) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare(
    `SELECT s.last_seen_at, s.expires_at, u.id, u.email, u.name, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(tokenHash).first<{ last_seen_at: string; expires_at: string; id: string; email: string; name: string; role: Role }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  const user: User = { id: row.id, email: row.email, name: row.name, role: row.role };
  if (now - Date.parse(row.last_seen_at) < REFRESH_AFTER_MS) return { user, tokenHash };
  await db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?")
    .bind(new Date(now).toISOString(), new Date(now + SESSION_DAYS * DAY_MS).toISOString(), tokenHash).run();
  return { user, tokenHash, refreshedToken: token };
}

export async function endSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function endAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** True when any of the buckets has used up its failures in the current window. */
export async function isRateLimited(db: D1Database, buckets: readonly string[], now = Date.now()): Promise<boolean> {
  for (const bucket of buckets) {
    const row = await db.prepare("SELECT count(*) AS n FROM login_attempts WHERE bucket = ? AND attempted_at > ?")
      .bind(bucket, now - LOGIN_WINDOW_MS).first<{ n: number }>();
    if ((row?.n ?? 0) >= LOGIN_MAX_FAILURES) return true;
  }
  return false;
}

export async function recordFailure(db: D1Database, buckets: readonly string[], now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE attempted_at < ?").bind(now - DAY_MS),
    ...buckets.map((bucket) => db.prepare("INSERT INTO login_attempts (bucket, attempted_at) VALUES (?, ?)").bind(bucket, now)),
  ]);
}
