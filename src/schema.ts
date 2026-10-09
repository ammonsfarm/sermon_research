/**
 * Schema migrations, applied by the Worker itself on the first request so a
 * fresh deploy needs no separate migration command. Append new versions; never
 * edit one that has shipped.
 */
export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
  /**
   * Columns to add only where they're missing. SQLite has no ADD COLUMN IF NOT
   * EXISTS, and a table that CREATE TABLE IF NOT EXISTS left alone can lack
   * columns a later version of it has.
   */
  readonly columns?: readonly { readonly table: string; readonly name: string; readonly definition: string }[];
}

export const MIGRATIONS: readonly Migration[] = [
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
  {
    version: 6,
    statements: [
      // Outlines, study guides and other Markdown documents written from the sermons.
      `CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        request TEXT NOT NULL,
        title TEXT NOT NULL,
        markdown TEXT NOT NULL,
        sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS documents_by_user ON documents(user_id, created_at)`,
    ],
  },
  {
    version: 7,
    statements: [
      // Questions and answers, grouped into conversations by thread_id.
      `CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
        scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS turns_by_thread ON turns(thread_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS turns_by_user ON turns(user_id, created_at)`,
      // Which sermons a document was written from; null means all of them.
      `ALTER TABLE documents ADD COLUMN scope_json TEXT`,
    ],
  },
  {
    version: 8,
    statements: [
      // Documents are written in the background: 'writing', then 'done' or 'failed'.
      `ALTER TABLE documents ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`,
      // What a writing document is doing right now, and why a failed one stopped.
      `ALTER TABLE documents ADD COLUMN detail TEXT`,
      `ALTER TABLE documents ADD COLUMN error TEXT`,
      `ALTER TABLE documents ADD COLUMN updated_at TEXT`,
    ],
  },
  {
    version: 9,
    statements: [
      // The feed's own description and author for each episode, kept current by every feed check.
      `ALTER TABLE episodes ADD COLUMN description TEXT`,
      `ALTER TABLE episodes ADD COLUMN author TEXT`,
      // Who preached: null when unknown. speaker_source is 'ai' or 'admin', and null until identified.
      `ALTER TABLE episodes ADD COLUMN speaker TEXT`,
      `ALTER TABLE episodes ADD COLUMN speaker_source TEXT`,
    ],
  },
  {
    version: 10,
    statements: [
      // The passage the sermon preaches from. Null until chosen; empty when the AI found no single main passage.
      `ALTER TABLE summaries ADD COLUMN main_scripture TEXT`,
    ],
  },
  {
    version: 11,
    statements: [
      // Mistral's transcript as it came back, kept after the answers AI cleans it up into transcripts.
      // cleaned_json holds the cleaned segment texts so far, so a retry carries on where it stopped.
      `CREATE TABLE IF NOT EXISTS transcripts_draft (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        segments_json TEXT NOT NULL CHECK (json_valid(segments_json)),
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cleaned_json TEXT CHECK (cleaned_json IS NULL OR json_valid(cleaned_json))
      )`,
      // The answers AI model that cleaned the transcript; null for ones transcribed before cleanup.
      `ALTER TABLE transcripts ADD COLUMN cleaned_by TEXT`,
    ],
  },
  {
    version: 12,
    statements: [
      // Muse transcribes 10 minutes at a time: how far it has got, in 16 kHz samples, and the segments so far.
      `CREATE TABLE IF NOT EXISTS transcription_progress (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
        done_samples INTEGER NOT NULL,
        segments_json TEXT NOT NULL CHECK (json_valid(segments_json)),
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 13,
    statements: [],
    // A transcripts_draft table made before version 11, by tools outside the app, was left
    // without the column the transcript review saves its progress in.
    columns: [{ table: "transcripts_draft", name: "cleaned_json", definition: "TEXT CHECK (cleaned_json IS NULL OR json_valid(cleaned_json))" }],
  },
  {
    version: 14,
    statements: [],
    // The earliest step an admin asked to redo for a finished episode. It moves on as each
    // step is redone and clears when the run finishes; the episode stays 'done' throughout.
    columns: [{ table: "episodes", name: "redo", definition: "TEXT CHECK (redo IS NULL OR redo IN ('transcribe', 'rewrite', 'summary', 'index'))" }],
  },
  {
    version: 15,
    statements: [
      // Several answers-AI providers, the models an admin has added from each, and per-person limits on which they may use.
      // key_slot names the provider_keys row holding the key; a site that had the single "llm" connection keeps its key there.
      `CREATE TABLE IF NOT EXISTS llm_providers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        key_slot TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS llm_models (
        provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        label TEXT NOT NULL,
        efforts_json TEXT NOT NULL CHECK (json_valid(efforts_json)),
        default_effort TEXT,
        context_window INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        added_at TEXT NOT NULL,
        PRIMARY KEY (provider_id, model_id)
      )`,
      `CREATE TABLE IF NOT EXISTS user_llm_models (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        PRIMARY KEY (user_id, provider_id, model_id)
      )`,
      // The model a document was asked to be written with ("provider/model"); null follows the site default.
      `ALTER TABLE documents ADD COLUMN model TEXT`,
      ...legacyAnswersAi(),
    ],
  },
];

/**
 * Statements that turn the single "llm" setting of earlier versions into a provider, a model
 * and the site defaults. A site with none just gets the five built-in providers.
 */
function legacyAnswersAi(): string[] {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
  const base = "json_extract(value_json, '$.baseUrl')";
  const known: [string, string][] = [
    ["meta", "https://api.meta.ai"], ["google", "https://generativelanguage.googleapis.com"], ["openai", "https://api.openai.com"],
    ["anthropic", "https://api.anthropic.com"], ["openrouter", "https://openrouter.ai"],
  ];
  const provider = `CASE ${known.map(([id, prefix]) => `WHEN ${base} LIKE '${prefix}%' THEN '${id}'`).join(" ")} ELSE 'custom' END`;
  const seeds: [string, string, string, string][] = [
    ["meta", "meta", "Meta (Muse)", "https://api.meta.ai/v1"],
    ["google", "google", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["openai", "openai", "OpenAI", "https://api.openai.com/v1"],
    ["anthropic", "anthropic", "Anthropic", "https://api.anthropic.com/v1"],
    ["openrouter", "openrouter", "OpenRouter", "https://openrouter.ai/api/v1"],
  ];
  const effort = (field: string) => `coalesce(json_extract(value_json, '$.${field}'), 'low')`;
  const choice = (field: string) => `json_object('provider', ${provider}, 'model', json_extract(value_json, '$.model'), 'effort', ${effort(field)})`;
  return [
    ...seeds.map(([id, kind, name, url], index) =>
      `INSERT OR IGNORE INTO llm_providers (id, kind, name, base_url, key_slot, position, created_at) VALUES ('${id}', '${kind}', '${name}', '${url}', 'llm:${id}', ${index}, ${now})`),
    `INSERT OR IGNORE INTO llm_providers (id, kind, name, base_url, key_slot, position, created_at)
       SELECT 'custom', 'custom', 'Custom provider', rtrim(${base}, '/'), 'llm', 10, ${now} FROM settings WHERE key = 'llm' AND ${provider} = 'custom'`,
    `UPDATE llm_providers SET key_slot = 'llm' WHERE id = (SELECT ${provider} FROM settings WHERE key = 'llm')`,
    `INSERT OR IGNORE INTO llm_models (provider_id, model_id, label, efforts_json, default_effort, enabled, added_at)
       SELECT ${provider}, json_extract(value_json, '$.model'), json_extract(value_json, '$.model'),
         CASE WHEN ${provider} = 'meta' THEN '["none","minimal","low","medium","high","xhigh","max"]' ELSE '[]' END,
         CASE WHEN ${provider} = 'meta' THEN 'low' END, 1, ${now} FROM settings WHERE key = 'llm'`,
    `INSERT OR IGNORE INTO settings (key, value_json, updated_at)
       SELECT 'llm_defaults', json_object('summary', ${choice("summaryEffort")}, 'chat', ${choice("chatEffort")}, 'document', ${choice("chatEffort")}), ${now} FROM settings WHERE key = 'llm'`,
  ];
}

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
    const missing: string[] = [];
    for (const column of migration.columns ?? []) {
      const exists = await db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").bind(column.table, column.name).first();
      if (!exists) missing.push(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.definition}`);
    }
    await db.batch([
      ...[...migration.statements, ...missing].map((sql) => db.prepare(sql)),
      db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").bind(migration.version, new Date().toISOString()),
    ]);
  }
}
