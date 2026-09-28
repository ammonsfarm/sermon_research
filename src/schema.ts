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
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS provider_keys (
        slot TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        last4 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS login_links (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      `CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        guid TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        published_at TEXT,
        audio_url TEXT,
        duration_seconds INTEGER,
        status TEXT NOT NULL CHECK (status IN ('not_imported', 'queued', 'running', 'done', 'failed')),
        stage TEXT CHECK (stage IS NULL OR stage IN ('transcribe', 'summarize', 'index')),
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS episodes_by_status ON episodes(status, published_at)`,
      `CREATE TABLE IF NOT EXISTS transcripts (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        segments_json TEXT NOT NULL CHECK (json_valid(segments_json)),
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS summaries (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        topics_json TEXT NOT NULL CHECK (json_valid(topics_json)),
        scriptures_json TEXT NOT NULL CHECK (json_valid(scriptures_json)),
        model TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('summary', 'transcript')),
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        start_seconds REAL,
        end_seconds REAL
      )`,
      `CREATE INDEX IF NOT EXISTS chunks_by_episode ON chunks(episode_id, seq)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE TABLE IF NOT EXISTS invites (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS invites_by_user ON invites(user_id)`,
    ],
  },
  {
    version: 5,
    statements: [
      // What a running episode is doing right now, and the last error a retry is working past.
      `ALTER TABLE episodes ADD COLUMN detail TEXT`,
      `ALTER TABLE episodes ADD COLUMN last_error TEXT`,
      // The copy of the episode's audio in R2, once downloaded.
      `ALTER TABLE episodes ADD COLUMN audio_key TEXT`,
      `ALTER TABLE episodes ADD COLUMN audio_bytes INTEGER`,
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
