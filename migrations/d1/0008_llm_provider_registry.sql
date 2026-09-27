-- Admin-managed LLM provider registry.
-- Providers are OpenAI-compatible endpoints; keys are AES-GCM ciphertext only.
-- Access is role default plus per-user allow/deny override.

CREATE TABLE IF NOT EXISTS llm_providers (
  provider_id TEXT PRIMARY KEY
    CHECK (length(provider_id) BETWEEN 2 AND 64 AND provider_id NOT GLOB '*[^a-z0-9-]*'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  base_url TEXT NOT NULL CHECK (base_url GLOB 'https://*' AND length(base_url) <= 2048),
  api_key_ciphertext TEXT,
  api_key_last4 TEXT CHECK (api_key_last4 IS NULL OR length(api_key_last4) <= 4),
  api_key_updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  probed_at TEXT,
  probe_error TEXT CHECK (probe_error IS NULL OR length(probe_error) <= 1000),
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((api_key_ciphertext IS NULL) = (api_key_last4 IS NULL))
);

CREATE TABLE IF NOT EXISTS llm_models (
  model_id TEXT PRIMARY KEY CHECK (length(model_id) BETWEEN 3 AND 320),
  provider_id TEXT NOT NULL,
  remote_model TEXT NOT NULL CHECK (length(remote_model) BETWEEN 1 AND 256),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  api_style TEXT NOT NULL DEFAULT 'chat' CHECK (api_style IN ('chat', 'completions', 'responses')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, remote_model),
  FOREIGN KEY (provider_id) REFERENCES llm_providers(provider_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_models_single_default
  ON llm_models(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS llm_model_role_access (
  role TEXT NOT NULL CHECK (role IN ('User', 'Admin', 'Content Manager', 'Research User', 'Read Only')),
  model_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (role, model_id),
  FOREIGN KEY (model_id) REFERENCES llm_models(model_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS llm_model_user_access (
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, model_id),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (model_id) REFERENCES llm_models(model_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS llm_model_user_access_by_user ON llm_model_user_access(user_id);
