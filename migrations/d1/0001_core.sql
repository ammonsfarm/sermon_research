-- AIC Cloudflare D1 schema, contract p3-v1.
-- PostgreSQL transaction wrappers, extensions, vector columns, and generated
-- PostgreSQL search indexes are intentionally not present here. D1 receives
-- authoritative relational state; Vectorize receives embeddings separately.

CREATE TABLE IF NOT EXISTS migration_runs (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) > 0),
  contract_version TEXT NOT NULL CHECK (contract_version = 'p3-v1'),
  domain TEXT NOT NULL CHECK (domain IN ('d1', 'r2', 'vectorize', 'cross-domain')),
  mode TEXT NOT NULL CHECK (mode IN ('full', 'incremental', 'delta', 'verify')),
  stage TEXT NOT NULL CHECK (stage IN ('preflight', 'export', 'import', 'verify', 'complete')),
  decision TEXT NOT NULL CHECK (decision IN ('pass', 'fail', 'blocked', 'not-authorized')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('postgresql', 'minio', 'pgvector', 'composite')),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) > 0),
  source_cutoff_at TEXT NOT NULL,
  source_consistency TEXT NOT NULL CHECK (source_consistency IN ('transaction', 'statement-per-table', 'frozen-listing-plus-delta')),
  destination_environment TEXT NOT NULL CHECK (destination_environment IN ('local', 'test', 'unrouted-production')),
  tool_name TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  tool_commit TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_checkpoints (
  run_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('d1', 'r2', 'vectorize', 'cross-domain')),
  checkpoint_key TEXT NOT NULL CHECK (length(checkpoint_key) > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed')),
  source_cursor TEXT,
  source_fingerprint TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  expected_count INTEGER CHECK (expected_count IS NULL OR expected_count >= 0),
  last_mutation_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, domain, checkpoint_key),
  FOREIGN KEY (run_id) REFERENCES migration_runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS migration_table_state (
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  target_table TEXT NOT NULL,
  classification_action TEXT NOT NULL CHECK (classification_action IN ('migrate_d1', 'migrate_d1_vectorize', 'reconcile_into_canonical', 'replace_no_row_copy', 'exclude')),
  source_fingerprint TEXT,
  last_run_id TEXT,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'imported', 'verified', 'failed', 'excluded')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_schema, source_table),
  FOREIGN KEY (last_run_id) REFERENCES migration_runs(run_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS migration_reconciliation_decisions (
  decision_id TEXT PRIMARY KEY CHECK (length(decision_id) > 0),
  run_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('accept', 'merge', 'reject', 'hold', 'tombstone')),
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES migration_runs(run_id) ON DELETE SET NULL,
  UNIQUE (source_system, source_id)
);

CREATE TABLE IF NOT EXISTS migration_identity_aliases (
  alias_id TEXT PRIMARY KEY CHECK (length(alias_id) > 0),
  entity_type TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_id TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_system, source_id)
);

CREATE TABLE IF NOT EXISTS migration_tombstones (
  tombstone_id TEXT PRIMARY KEY CHECK (length(tombstone_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_snapshot_fingerprint TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  UNIQUE (source_system, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS episodes (
  episode_id TEXT PRIMARY KEY CHECK (length(episode_id) > 0),
  title TEXT NOT NULL,
  publish_date TEXT NOT NULL DEFAULT '',
  album TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  canonical_audio_key TEXT NOT NULL UNIQUE,
  source_system TEXT NOT NULL DEFAULT 'postgresql',
  source_id TEXT NOT NULL,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Published', 'Archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  CHECK (
    (episode_id NOT GLOB '*[^0-9]*') OR
    (episode_id GLOB 'sa_*' AND length(substr(episode_id, 4)) > 0 AND substr(episode_id, 4) NOT GLOB '*[^0-9]*') OR
    (episode_id GLOB 'wp-sermon:*' AND length(substr(episode_id, 11)) > 0 AND substr(episode_id, 11) NOT GLOB '*[^0-9]*') OR
    (episode_id GLOB 'cms_*' AND length(substr(episode_id, 5)) > 0 AND substr(episode_id, 5) NOT GLOB '*[^A-Za-z0-9._-]*')
  ),
  CHECK (canonical_audio_key = 'podcasts/' || episode_id || '.mp3'),
  CHECK (publish_date = '' OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE TABLE IF NOT EXISTS episode_documents (
  document_id TEXT PRIMARY KEY CHECK (length(document_id) > 0),
  episode_id TEXT NOT NULL UNIQUE,
  cms_document_id TEXT UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('podcast', 'cms_episode', 'legacy')),
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  scripture_references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scripture_references_json)),
  guest_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(guest_names_json)),
  category TEXT NOT NULL DEFAULT '',
  series TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Published', 'Archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private', 'unlisted')),
  transcript_status TEXT NOT NULL DEFAULT 'Not Requested' CHECK (transcript_status IN ('Not Requested', 'Queued', 'Running', 'Completed', 'Failed', 'Skipped')),
  intelligence_status TEXT NOT NULL DEFAULT 'Not Requested' CHECK (intelligence_status IN ('Not Requested', 'Queued', 'Running', 'Completed', 'Failed', 'Skipped')),
  vector_status TEXT NOT NULL DEFAULT 'Not Requested' CHECK (vector_status IN ('Not Requested', 'Queued', 'Running', 'Completed', 'Failed', 'Skipped')),
  source_url TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  scheduled_for TEXT,
  archived_at TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS articles (
  article_id TEXT PRIMARY KEY CHECK (length(article_id) > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('pastorwood', 'cms')),
  cms_document_id TEXT UNIQUE,
  source_post_id TEXT,
  slug TEXT UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body_json)),
  body_html TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  publish_date TEXT,
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Published', 'Archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private', 'unlisted')),
  canonical_url TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  scheduled_for TEXT,
  archived_at TEXT,
  CHECK (
    (article_id GLOB 'pastorwood:*' AND length(substr(article_id, 12)) > 0 AND substr(article_id, 12) NOT GLOB '*[^0-9]*') OR
    (article_id GLOB 'cms:*' AND length(substr(article_id, 5)) > 0 AND substr(article_id, 5) NOT GLOB '*[^A-Za-z0-9._-]*')
  ),
  CHECK (publish_date IS NULL OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE TABLE IF NOT EXISTS pages (
  page_key TEXT PRIMARY KEY CHECK (length(page_key) > 0),
  document_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Published', 'Archived')),
  published_revision_id TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  scheduled_for TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS editorial_revisions (
  revision_id TEXT PRIMARY KEY CHECK (length(revision_id) > 0),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('article', 'page', 'episode')),
  entity_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  title TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  hero_title TEXT NOT NULL DEFAULT '',
  hero_body TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(body_json)),
  body_html TEXT NOT NULL DEFAULT '',
  plain_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Scheduled', 'Published', 'Archived')),
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  change_note TEXT NOT NULL DEFAULT '',
  UNIQUE (entity_type, entity_id, revision_number)
);

CREATE TABLE IF NOT EXISTS content_components (
  component_id TEXT PRIMARY KEY CHECK (length(component_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  component_type TEXT NOT NULL,
  component_order INTEGER NOT NULL DEFAULT 0 CHECK (component_order >= 0),
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, component_type, component_order)
);

CREATE TABLE IF NOT EXISTS people (
  person_id TEXT PRIMARY KEY CHECK (length(person_id) > 0),
  document_id TEXT UNIQUE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  biography TEXT NOT NULL DEFAULT '',
  image_asset_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json)),
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS endorsements (
  endorsement_id TEXT PRIMARY KEY CHECK (length(endorsement_id) > 0),
  person_id TEXT,
  quote TEXT NOT NULL,
  attribution TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (person_id) REFERENCES people(person_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS redirects (
  redirect_id TEXT PRIMARY KEY CHECK (length(redirect_id) > 0),
  source_path TEXT NOT NULL UNIQUE,
  target_path TEXT NOT NULL,
  status_code INTEGER NOT NULL CHECK (status_code IN (301, 302, 307, 308)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY CHECK (length(setting_key) > 0),
  value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
  value_type TEXT NOT NULL DEFAULT 'json' CHECK (value_type IN ('json', 'text', 'number', 'boolean')),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS editorial_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  revision_id TEXT,
  actor_id TEXT NOT NULL DEFAULT 'system',
  note TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  event_at TEXT NOT NULL,
  FOREIGN KEY (revision_id) REFERENCES editorial_revisions(revision_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS processing_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('transcribe', 'intelligence', 'embed', 'index', 'publish', 'verify')),
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS processing_provenance (
  provenance_id TEXT PRIMARY KEY CHECK (length(provenance_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  source_fingerprint TEXT CHECK (source_fingerprint IS NULL OR source_fingerprint = '' OR (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-fA-F]*') OR (source_fingerprint GLOB 'sha256:*' AND length(source_fingerprint) = 71 AND substr(source_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  input_hash TEXT CHECK (input_hash IS NULL OR input_hash = '' OR (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-fA-F]*') OR (input_hash GLOB 'sha256:*' AND length(input_hash) = 71 AND substr(input_hash, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  output_hash TEXT CHECK (output_hash IS NULL OR output_hash = '' OR (length(output_hash) = 64 AND output_hash NOT GLOB '*[^0-9a-fA-F]*') OR (output_hash GLOB 'sha256:*' AND length(output_hash) = 71 AND substr(output_hash, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  provider TEXT,
  model TEXT,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, stage)
);

CREATE TABLE IF NOT EXISTS processing_ownership (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS transcript_chunks (
  source_custom_id TEXT PRIMARY KEY CHECK (length(source_custom_id) > 0),
  episode_id TEXT NOT NULL,
  record_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  speakers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(speakers_json)),
  segment_type TEXT NOT NULL DEFAULT 'speech',
  source_file TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  source_location TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT '' CHECK (embedding_model IN ('', 'text-embedding-3-small')),
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions IN (0, 1536)),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  content_hash TEXT,
  chunk_index INTEGER CHECK (chunk_index IS NULL OR chunk_index >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  CHECK (((embedding_dimensions IS NULL OR embedding_dimensions = 0) AND embedding_model = '') OR (embedding_dimensions = 1536 AND embedding_model = 'text-embedding-3-small')),
  CHECK (publish_date = '' OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  segment_id TEXT PRIMARY KEY CHECK (length(segment_id) > 0),
  episode_id TEXT NOT NULL,
  chunk_source_id TEXT,
  speaker TEXT NOT NULL DEFAULT '',
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  segment_type TEXT NOT NULL DEFAULT 'speech',
  text TEXT NOT NULL,
  sequence_number INTEGER NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_source_id) REFERENCES transcript_chunks(source_custom_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transcript_references (
  reference_id TEXT PRIMARY KEY CHECK (length(reference_id) > 0),
  episode_id TEXT NOT NULL,
  chunk_source_id TEXT,
  reference_type TEXT NOT NULL,
  reference_value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  start_time TEXT,
  end_time TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_source_id) REFERENCES transcript_chunks(source_custom_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transcript_edit_requests (
  edit_request_id TEXT PRIMARY KEY CHECK (length(edit_request_id) > 0),
  episode_id TEXT NOT NULL,
  chunk_source_id TEXT,
  requested_by TEXT NOT NULL,
  requested_text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'cancelled')),
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_source_id) REFERENCES transcript_chunks(source_custom_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS episode_intelligence (
  episode_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  publish_date TEXT,
  episode_type TEXT NOT NULL DEFAULT 'unknown',
  executive_summary TEXT NOT NULL DEFAULT '',
  long_summary TEXT NOT NULL DEFAULT '',
  main_topics_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(main_topics_json)),
  search_keywords_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(search_keywords_json)),
  raw_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_json)),
  source_file TEXT NOT NULL DEFAULT '',
  source_model TEXT NOT NULL DEFAULT '',
  input_chars INTEGER NOT NULL DEFAULT 0 CHECK (input_chars >= 0),
  transcript_truncated INTEGER NOT NULL DEFAULT 0 CHECK (transcript_truncated IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'skipped')),
  error_message TEXT NOT NULL DEFAULT '',
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS episode_intelligence_items (
  item_id TEXT PRIMARY KEY CHECK (length(item_id) > 0),
  episode_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  source_times_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_times_json)),
  speakers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(speakers_json)),
  confidence TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vector_documents (
  vector_id TEXT PRIMARY KEY CHECK (length(vector_id) > 0 AND length(CAST(vector_id AS BLOB)) <= 64),
  source_table TEXT NOT NULL CHECK (source_table IN ('transcript_chunks', 'episode_intelligence_vectors', 'pastorwood_post_chunks')),
  source_custom_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('episode_transcript', 'episode_intelligence', 'article')),
  source_id TEXT NOT NULL,
  content_subtype TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  chunk_index INTEGER CHECK (chunk_index IS NULL OR chunk_index >= 0),
  published_day INTEGER CHECK (published_day IS NULL OR published_day >= 0),
  embedding_model TEXT NOT NULL CHECK (embedding_model = 'text-embedding-3-small'),
  dimensions INTEGER NOT NULL CHECK (dimensions = 1536),
  vector_digest TEXT NOT NULL,
  metadata_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'verified', 'failed', 'tombstoned')),
  last_mutation_id TEXT,
  imported_at TEXT,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (source_table, source_custom_id),
  CHECK (
    (source_table = 'transcript_chunks' AND vector_id GLOB 't/*') OR
    (source_table = 'episode_intelligence_vectors' AND vector_id GLOB 'i/*') OR
    (source_table = 'pastorwood_post_chunks' AND vector_id GLOB 'a/*')
  ),
  CHECK ((length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-fA-F]*') OR (content_hash GLOB 'sha256:*' AND length(content_hash) = 71 AND substr(content_hash, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  CHECK ((length(vector_digest) = 64 AND vector_digest NOT GLOB '*[^0-9a-fA-F]*') OR (vector_digest GLOB 'sha256:*' AND length(vector_digest) = 71 AND substr(vector_digest, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  CHECK ((length(metadata_digest) = 64 AND metadata_digest NOT GLOB '*[^0-9a-fA-F]*') OR (metadata_digest GLOB 'sha256:*' AND length(metadata_digest) = 71 AND substr(metadata_digest, 8) NOT GLOB '*[^0-9a-fA-F]*'))
);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY CHECK (length(user_id) > 0),
  clerk_user_id TEXT NOT NULL UNIQUE,
  verified_email TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'pending')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('User', 'Admin', 'Content Manager', 'Research User', 'Read Only')),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  granted_by TEXT NOT NULL DEFAULT 'migration',
  PRIMARY KEY (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_settings (
  setting_key TEXT PRIMARY KEY CHECK (length(setting_key) > 0),
  value_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value_json)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podtrac_clients (
  client_id TEXT PRIMARY KEY CHECK (length(client_id) > 0),
  client_name TEXT NOT NULL,
  source_payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(source_payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podtrac_countries (
  country_code TEXT PRIMARY KEY CHECK (length(country_code) > 0),
  country_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS podtrac_episodes (
  podtrac_episode_id TEXT PRIMARY KEY CHECK (length(podtrac_episode_id) > 0),
  episode_id TEXT,
  external_episode_id TEXT,
  source_track_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS podtrac_daily_activity (
  activity_date TEXT NOT NULL,
  podtrac_episode_id TEXT NOT NULL,
  episode_id TEXT,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  streams INTEGER NOT NULL DEFAULT 0 CHECK (streams >= 0),
  unique_clients INTEGER NOT NULL DEFAULT 0 CHECK (unique_clients >= 0),
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (activity_date, podtrac_episode_id),
  FOREIGN KEY (podtrac_episode_id) REFERENCES podtrac_episodes(podtrac_episode_id) ON DELETE CASCADE,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS podtrac_activity_by_client (
  activity_date TEXT NOT NULL,
  client_id TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (activity_date, client_id),
  FOREIGN KEY (client_id) REFERENCES podtrac_clients(client_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS podtrac_activity_by_country (
  activity_date TEXT NOT NULL,
  country_code TEXT NOT NULL,
  downloads INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (activity_date, country_code),
  FOREIGN KEY (country_code) REFERENCES podtrac_countries(country_code) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS podtrac_import_runs (
  import_run_id TEXT PRIMARY KEY CHECK (length(import_run_id) > 0),
  source_fingerprint TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  rows_seen INTEGER NOT NULL DEFAULT 0 CHECK (rows_seen >= 0),
  rows_imported INTEGER NOT NULL DEFAULT 0 CHECK (rows_imported >= 0),
  error_message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS podtrac_import_metadata (
  metadata_key TEXT PRIMARY KEY CHECK (length(metadata_key) > 0),
  metadata_value TEXT NOT NULL,
  import_run_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_run_id) REFERENCES podtrac_import_runs(import_run_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS podtrac_sync_runs (
  sync_run_id TEXT PRIMARY KEY CHECK (length(sync_run_id) > 0),
  source_fingerprint TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  error_message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS podtrac_reconciliation_audit (
  audit_id TEXT PRIMARY KEY CHECK (length(audit_id) > 0),
  sync_run_id TEXT,
  external_episode_id TEXT NOT NULL,
  episode_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('matched', 'created', 'held', 'rejected')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (sync_run_id) REFERENCES podtrac_sync_runs(sync_run_id) ON DELETE SET NULL,
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_subscriptions (
  subscription_id TEXT PRIMARY KEY CHECK (length(subscription_id) > 0),
  email_address TEXT NOT NULL CHECK (email_address = lower(email_address)),
  provider TEXT NOT NULL DEFAULT 'mailchimp',
  provider_contact_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'subscribed', 'unsubscribed', 'bounced', 'failed', 'suppressed')),
  consent_state TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_state IN ('unknown', 'granted', 'withdrawn')),
  unsubscribe_token_digest TEXT,
  source TEXT NOT NULL DEFAULT 'public',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_contact_id)
);

CREATE TABLE IF NOT EXISTS public_subscription_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) > 0),
  subscription_id TEXT,
  email_address TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('subscribe', 'unsubscribe', 'resubscribe')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES public_subscriptions(subscription_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_subscription_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
  subscription_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('consent-captured', 'resubscribe-blocked-suppressed', 'unsubscribed', 'unsubscribe-confirmed-suppressed', 'admin-suppressed', 'provider-confirmed', 'provider-unsubscribed', 'provider-cleaned', 'provider-sync-failed', 'provider-sync-retried')),
  provider_event_id TEXT UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES public_subscriptions(subscription_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_subscription_provider_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (length(outbox_id) > 0),
  subscription_id TEXT,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES public_subscriptions(subscription_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_subscription_provider_webhook_events (
  webhook_event_id TEXT PRIMARY KEY CHECK (length(webhook_event_id) > 0),
  provider_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  signature_verified INTEGER NOT NULL CHECK (signature_verified IN (0, 1)),
  processed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_contact_messages (
  message_id TEXT PRIMARY KEY CHECK (length(message_id) > 0),
  name TEXT NOT NULL,
  email_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT 'unknown' CHECK (consent_state IN ('unknown', 'granted', 'withdrawn')),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('new', 'in_review', 'resolved', 'archived', 'received', 'queued', 'sent', 'failed', 'retained', 'purged')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_contact_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) > 0),
  message_id TEXT,
  operation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'failed')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES public_contact_messages(message_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_contact_message_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) > 0),
  message_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES public_contact_messages(message_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public_contact_notification_outbox (
  outbox_id TEXT PRIMARY KEY CHECK (length(outbox_id) > 0),
  message_id TEXT,
  destination TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES public_contact_messages(message_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS consent_events (
  consent_event_id TEXT PRIMARY KEY CHECK (length(consent_event_id) > 0),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  consent_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('granted', 'withdrawn', 'unknown')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_data_retention (
  retention_id TEXT PRIMARY KEY CHECK (length(retention_id) > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'eligible', 'held', 'purged')),
  eligible_at TEXT,
  held_until TEXT,
  purged_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (entity_type, entity_id, policy_key)
);

CREATE TABLE IF NOT EXISTS media_assets (
  asset_id TEXT PRIMARY KEY CHECK (length(asset_id) > 0),
  asset_type TEXT NOT NULL DEFAULT 'file',
  filename TEXT NOT NULL DEFAULT '',
  original_filename TEXT NOT NULL DEFAULT '',
  source_provider TEXT NOT NULL CHECK (source_provider IN ('minio', 'filesystem', 'strapi', 'r2')),
  source_bucket TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL DEFAULT '',
  destination_bucket TEXT NOT NULL CHECK (destination_bucket IN ('aic-podcast-audio', 'aic-assets')),
  canonical_object_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR ((length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-fA-F]*') OR (sha256 GLOB 'sha256:*' AND length(sha256) = 71 AND substr(sha256, 8) NOT GLOB '*[^0-9a-fA-F]*'))),
  width INTEGER CHECK (width IS NULL OR width >= 0),
  height INTEGER CHECK (height IS NULL OR height >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  alt_text TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  attribution TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'copied', 'verified', 'published', 'failed', 'conflict')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (destination_bucket = 'aic-podcast-audio' AND canonical_object_key GLOB 'podcasts/*') OR
    (destination_bucket = 'aic-assets' AND (canonical_object_key GLOB 'cms/*' OR canonical_object_key GLOB 'legacy/*'))
  )
);

CREATE TABLE IF NOT EXISTS media_aliases (
  alias_id TEXT PRIMARY KEY CHECK (length(alias_id) > 0),
  asset_id TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  alias_value TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id) ON DELETE CASCADE
);
