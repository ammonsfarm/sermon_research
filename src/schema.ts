/**
 * Schema migrations, applied by the Worker itself on the first request so a
 * fresh deploy needs no separate migration command. Append new versions; never
 * edit one that has shipped.
 */
export const MIGRATIONS: readonly { readonly version: number; readonly statements: readonly string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        password_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS login_attempts (
        bucket TEXT NOT NULL,
        attempted_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS login_attempts_by_bucket ON login_attempts(bucket, attempted_at)`,
    ],
  },
];

let applied: Promise<void> | undefined;

/** Applies pending migrations once per isolate. Safe to race across isolates. */
export function ensureSchema(db: D1Database): Promise<void> {
  applied ??= migrate(db).catch((error: unknown) => {
    applied = undefined;
    throw error;
  });
  return applied;
}

/** Test hook: forget that this isolate already migrated. */
export function resetSchemaCache(): void {
  applied = undefined;
}

async function migrate(db: D1Database): Promise<void> {
  await db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)").run();
  const { results } = await db.prepare("SELECT version FROM schema_migrations").all<{ version: number }>();
  const done = new Set(results.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(migration.version, new Date().toISOString()),
    ]);
  }
}
