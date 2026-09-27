-- Phase 3 source-fidelity hardening.
--
-- This migration keeps the source vector rows' authoritative text, source
-- identity, URL/location, and complete JSON metadata in D1. Embedding values
-- remain deliberately absent from these tables and are imported to Vectorize.

CREATE TABLE IF NOT EXISTS migration_source_records (
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  target_table TEXT NOT NULL,
  classification_action TEXT NOT NULL CHECK (classification_action IN ('migrate_d1', 'migrate_d1_vectorize')),
  fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
  source_fingerprint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_schema, source_table, source_record_id),
  UNIQUE (source_schema, source_table, source_record_id, target_table)
);

CREATE TABLE IF NOT EXISTS migration_field_policies (
  source_schema TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_field TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('allow', 'exclude')),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (source_schema, source_table, source_field)
);

INSERT INTO migration_field_policies
  (source_schema, source_table, source_field, action, reason)
VALUES
  ('public', 'agent_settings', 'system_api_key', 'exclude', 'secret value is never copied to D1'),
  ('public', 'agent_settings', 'system_api_key_updated_at', 'exclude', 'secret-field companion metadata is not copied'),
  ('public', 'rag_api_request_logs', '*', 'exclude', 'raw request logs are excluded by the frozen classification'),
  ('aic_strapi', 'admin_users', '*', 'exclude', 'framework identity and credential state are excluded'),
  ('aic_strapi', 'strapi_api_tokens', '*', 'exclude', 'API tokens are excluded'),
  ('aic_strapi', 'strapi_sessions', '*', 'exclude', 'session material is excluded'),
  ('aic_strapi', 'strapi_transfer_tokens', '*', 'exclude', 'transfer tokens are excluded');

CREATE TRIGGER migration_source_records_reject_agent_secret_insert
BEFORE INSERT ON migration_source_records
WHEN NEW.source_schema = 'public'
  AND NEW.source_table = 'agent_settings'
  AND json_type(NEW.fields_json, '$.system_api_key') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'public.agent_settings.system_api_key is excluded');
END;

CREATE TRIGGER migration_source_records_reject_agent_secret_update
BEFORE UPDATE OF fields_json ON migration_source_records
WHEN NEW.source_schema = 'public'
  AND NEW.source_table = 'agent_settings'
  AND json_type(NEW.fields_json, '$.system_api_key') IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'public.agent_settings.system_api_key is excluded');
END;

CREATE TABLE IF NOT EXISTS admin_operation_audit (
  audit_id TEXT PRIMARY KEY CHECK (length(audit_id) > 0),
  action TEXT NOT NULL CHECK (length(action) > 0),
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  actor_email TEXT NOT NULL CHECK (length(actor_email) > 0),
  detail_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_audit_log (
  audit_id TEXT PRIMARY KEY CHECK (length(audit_id) > 0),
  entity_type TEXT NOT NULL CHECK (length(entity_type) > 0),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  action TEXT NOT NULL CHECK (length(action) > 0),
  actor_email TEXT NOT NULL DEFAULT 'system',
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_interactions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  clerk_user_id TEXT NOT NULL,
  user_email TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL CHECK (scope IN ('research', 'archive', 'episode', 'writing')),
  track_id TEXT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  top_k INTEGER NOT NULL DEFAULT 0 CHECK (top_k >= 0),
  retrieval_lanes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retrieval_lanes_json)),
  sources_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(sources_json)),
  top_episode_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(top_episode_ids_json)),
  coverage_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  error TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  usage_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (clerk_user_id) REFERENCES users(clerk_user_id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES episodes(episode_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS episode_intelligence_vectors (
  custom_id TEXT PRIMARY KEY CHECK (length(custom_id) > 0),
  record_id TEXT NOT NULL CHECK (length(record_id) > 0),
  vector_type TEXT NOT NULL,
  track_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  episode_type TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_field TEXT NOT NULL CHECK (length(source_field) > 0),
  source_url TEXT NOT NULL DEFAULT '',
  source_location TEXT NOT NULL DEFAULT '',
  source_file TEXT NOT NULL DEFAULT '',
  source_model TEXT NOT NULL DEFAULT '',
  source_updated_at TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL,
  source_times_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_times_json)),
  speakers_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(speakers_json)),
  confidence TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small'
    CHECK (embedding_model = 'text-embedding-3-small'),
  embedding_dimensions INTEGER
    CHECK (embedding_dimensions IS NULL OR embedding_dimensions IN (0, 1536)),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  sqlite_created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (track_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  CHECK (publish_date = '' OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK ((length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-fA-F]*') OR (content_hash GLOB 'sha256:*' AND length(content_hash) = 71 AND substr(content_hash, 8) NOT GLOB '*[^0-9a-fA-F]*'))
);

CREATE TABLE IF NOT EXISTS pastorwood_post_chunks (
  custom_id TEXT PRIMARY KEY CHECK (length(custom_id) > 0),
  record_id TEXT NOT NULL CHECK (length(record_id) > 0),
  post_id TEXT NOT NULL CHECK (post_id NOT GLOB '*[^0-9]*' AND length(post_id) > 0),
  article_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'pastorwood_devotional',
  title TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  source_location TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  source_field TEXT NOT NULL DEFAULT 'text' CHECK (length(source_field) > 0),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small'
    CHECK (embedding_model = 'text-embedding-3-small'),
  embedding_dimensions INTEGER
    CHECK (embedding_dimensions IS NULL OR embedding_dimensions IN (0, 1536)),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (publish_date = '' OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK ((length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-fA-F]*') OR (content_hash GLOB 'sha256:*' AND length(content_hash) = 71 AND substr(content_hash, 8) NOT GLOB '*[^0-9a-fA-F]*')),
  UNIQUE (post_id, chunk_index)
);

-- Source-column retention for the accepted PostgreSQL operational records.
ALTER TABLE transcript_chunks ADD COLUMN source_field TEXT NOT NULL DEFAULT 'text';
ALTER TABLE transcript_chunks ADD COLUMN sqlite_created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_segments ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0 CHECK (segment_index >= 0);
ALTER TABLE transcript_segments ADD COLUMN start_seconds REAL;
ALTER TABLE transcript_segments ADD COLUMN end_seconds REAL;
ALTER TABLE transcript_segments ADD COLUMN speaker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_segments ADD COLUMN speaker_name TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_segments ADD COLUMN bible_references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bible_references_json));
ALTER TABLE transcript_segments ADD COLUMN other_references_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(other_references_json));
ALTER TABLE transcript_segments ADD COLUMN source_file TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_segments ADD COLUMN raw_segment_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_segment_json));
ALTER TABLE transcript_segments ADD COLUMN source_table TEXT NOT NULL DEFAULT 'transcript_segments';
ALTER TABLE transcript_segments ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_segments ADD COLUMN source_location TEXT NOT NULL DEFAULT '';

ALTER TABLE transcript_references ADD COLUMN segment_index INTEGER;
ALTER TABLE transcript_references ADD COLUMN source_scope TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN reference TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN start_seconds REAL;
ALTER TABLE transcript_references ADD COLUMN end_seconds REAL;
ALTER TABLE transcript_references ADD COLUMN context TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN text TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN raw_reference_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_reference_json));
ALTER TABLE transcript_references ADD COLUMN source_file TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_references ADD COLUMN source_location TEXT NOT NULL DEFAULT '';

ALTER TABLE transcript_edit_requests ADD COLUMN segment_index INTEGER;
ALTER TABLE transcript_edit_requests ADD COLUMN source_table TEXT NOT NULL DEFAULT 'transcript_segments';
ALTER TABLE transcript_edit_requests ADD COLUMN source_field TEXT NOT NULL DEFAULT 'text';
ALTER TABLE transcript_edit_requests ADD COLUMN original_text TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN edited_text TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN edited_by TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN processing_error TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN needs_revectorization INTEGER NOT NULL DEFAULT 1 CHECK (needs_revectorization IN (0, 1));
ALTER TABLE transcript_edit_requests ADD COLUMN applied_at TEXT;
ALTER TABLE transcript_edit_requests ADD COLUMN start_time TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN end_time TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN source_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN raw_request_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_request_json));
ALTER TABLE transcript_edit_requests ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE transcript_edit_requests ADD COLUMN next_attempt_at TEXT;
ALTER TABLE transcript_edit_requests ADD COLUMN claimed_at TEXT;
ALTER TABLE transcript_edit_requests ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE transcript_edit_requests ADD COLUMN revectorization_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (revectorization_attempt_count >= 0);
ALTER TABLE transcript_edit_requests ADD COLUMN next_revectorization_at TEXT;
ALTER TABLE transcript_edit_requests ADD COLUMN revectorization_claimed_at TEXT;
ALTER TABLE transcript_edit_requests ADD COLUMN revectorization_worker_id TEXT NOT NULL DEFAULT '';

ALTER TABLE processing_requests ADD COLUMN document_id TEXT;
ALTER TABLE processing_requests ADD COLUMN revision_id TEXT;
ALTER TABLE processing_requests ADD COLUMN source_record_id TEXT;
ALTER TABLE processing_requests ADD COLUMN source_fingerprint TEXT CHECK (source_fingerprint IS NULL OR source_fingerprint = '' OR (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-fA-F]*') OR (source_fingerprint GLOB 'sha256:*' AND length(source_fingerprint) = 71 AND substr(source_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE processing_requests ADD COLUMN audio_fingerprint TEXT CHECK (audio_fingerprint IS NULL OR audio_fingerprint = '' OR (audio_fingerprint GLOB 'sha256:*' AND length(audio_fingerprint) = 71 AND substr(audio_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE processing_requests ADD COLUMN request_key TEXT;
ALTER TABLE processing_requests ADD COLUMN audio_source TEXT;
ALTER TABLE processing_requests ADD COLUMN input_hash TEXT;
ALTER TABLE processing_requests ADD COLUMN output_hash TEXT;
ALTER TABLE processing_requests ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE processing_requests ADD COLUMN next_attempt_at TEXT;
ALTER TABLE processing_requests ADD COLUMN claimed_at TEXT;
ALTER TABLE processing_requests ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE processing_requests ADD COLUMN requested_at TEXT;

ALTER TABLE processing_provenance ADD COLUMN document_id TEXT;
ALTER TABLE processing_provenance ADD COLUMN revision_id TEXT;
ALTER TABLE processing_provenance ADD COLUMN request_id TEXT;
ALTER TABLE processing_provenance ADD COLUMN request_key TEXT;
ALTER TABLE processing_provenance ADD COLUMN episode_document_id TEXT;
ALTER TABLE processing_provenance ADD COLUMN revision_number INTEGER;
ALTER TABLE processing_provenance ADD COLUMN audio_source TEXT;
ALTER TABLE processing_provenance ADD COLUMN audio_fingerprint TEXT CHECK (audio_fingerprint IS NULL OR audio_fingerprint = '' OR (audio_fingerprint GLOB 'sha256:*' AND length(audio_fingerprint) = 71 AND substr(audio_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE processing_provenance ADD COLUMN completed_at TEXT;
ALTER TABLE processing_provenance ADD COLUMN source_record_id TEXT;
ALTER TABLE processing_provenance ADD COLUMN idempotency_key TEXT;
ALTER TABLE processing_provenance ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE processing_provenance ADD COLUMN next_attempt_at TEXT;
ALTER TABLE processing_provenance ADD COLUMN revectorization_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (revectorization_attempt_count >= 0);

ALTER TABLE processing_ownership ADD COLUMN document_id TEXT;
ALTER TABLE processing_ownership ADD COLUMN revision_id TEXT;
ALTER TABLE processing_ownership ADD COLUMN request_id TEXT;
ALTER TABLE processing_ownership ADD COLUMN episode_document_id TEXT;
ALTER TABLE processing_ownership ADD COLUMN source_record_id TEXT;
ALTER TABLE processing_ownership ADD COLUMN source_fingerprint TEXT CHECK (source_fingerprint IS NULL OR source_fingerprint = '' OR (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-fA-F]*') OR (source_fingerprint GLOB 'sha256:*' AND length(source_fingerprint) = 71 AND substr(source_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE processing_ownership ADD COLUMN audio_fingerprint TEXT CHECK (audio_fingerprint IS NULL OR audio_fingerprint = '' OR (audio_fingerprint GLOB 'sha256:*' AND length(audio_fingerprint) = 71 AND substr(audio_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*'));
ALTER TABLE processing_ownership ADD COLUMN claimed_at TEXT;
ALTER TABLE processing_ownership ADD COLUMN request_key TEXT;
ALTER TABLE processing_ownership ADD COLUMN audio_source TEXT;
ALTER TABLE processing_ownership ADD COLUMN idempotency_key TEXT;
ALTER TABLE processing_ownership ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE processing_ownership ADD COLUMN next_attempt_at TEXT;
ALTER TABLE processing_ownership ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';

ALTER TABLE vector_documents ADD COLUMN record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE vector_documents ADD COLUMN source_field TEXT NOT NULL DEFAULT '';
ALTER TABLE vector_documents ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE vector_documents ADD COLUMN source_location TEXT NOT NULL DEFAULT '';
ALTER TABLE vector_documents ADD COLUMN authoritative_text TEXT NOT NULL DEFAULT '';
ALTER TABLE vector_documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));

ALTER TABLE podtrac_reconciliation_audit ADD COLUMN podtrac_episode_id TEXT;
CREATE INDEX IF NOT EXISTS idx_podtrac_reconciliation_podtrac_episode
  ON podtrac_reconciliation_audit(podtrac_episode_id, created_at);

ALTER TABLE public_subscriptions ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscriptions ADD COLUMN consent_version TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscriptions ADD COLUMN consent_text TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscriptions ADD COLUMN consent_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN source_path TEXT NOT NULL DEFAULT '/';
ALTER TABLE public_subscriptions ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '' CHECK (ip_hash = '' OR length(ip_hash) = 64);
ALTER TABLE public_subscriptions ADD COLUMN user_agent_hash TEXT NOT NULL DEFAULT '' CHECK (user_agent_hash = '' OR length(user_agent_hash) = 64);
ALTER TABLE public_subscriptions ADD COLUMN unsubscribed_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN provider_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (provider_status IN ('unknown', 'pending', 'subscribed', 'unsubscribed', 'cleaned', 'error'));
ALTER TABLE public_subscriptions ADD COLUMN provider_member_id TEXT;
ALTER TABLE public_subscriptions ADD COLUMN provider_synced_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN provider_last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscriptions ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'active'
  CHECK (retention_state IN ('active', 'eligible', 'held', 'purged'));
ALTER TABLE public_subscriptions ADD COLUMN retention_eligible_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN retention_deleted_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE public_subscriptions ADD COLUMN last_attempt_at TEXT;
ALTER TABLE public_subscriptions ADD COLUMN abuse_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscriptions ADD COLUMN blocked_until TEXT;

ALTER TABLE public_subscription_attempts ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_attempts ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_attempts ADD COLUMN email_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_attempts ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1));
ALTER TABLE public_subscription_attempts ADD COLUMN source_path TEXT NOT NULL DEFAULT '/';
ALTER TABLE public_subscription_attempts ADD COLUMN user_agent_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_attempts ADD COLUMN abuse_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_attempts ADD COLUMN blocked_until TEXT;
ALTER TABLE public_subscription_attempts ADD COLUMN request_id TEXT;
ALTER TABLE public_subscription_attempts ADD COLUMN failure_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE public_subscription_events ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_events ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system-worker'
  CHECK (actor_type IN ('public-form', 'signed-link', 'content-manager', 'provider-webhook', 'system-worker'));
ALTER TABLE public_subscription_events ADD COLUMN actor_email TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_events ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));
ALTER TABLE public_subscription_events ADD COLUMN event_at TEXT;

ALTER TABLE public_subscription_provider_outbox ADD COLUMN desired_action TEXT
  CHECK (desired_action IS NULL OR desired_action IN ('subscribe', 'unsubscribe'));
ALTER TABLE public_subscription_provider_outbox ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE public_subscription_provider_outbox ADD COLUMN available_at TEXT;
ALTER TABLE public_subscription_provider_outbox ADD COLUMN started_at TEXT;
ALTER TABLE public_subscription_provider_outbox ADD COLUMN completed_at TEXT;
ALTER TABLE public_subscription_provider_outbox ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_provider_outbox ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_provider_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

ALTER TABLE public_subscription_provider_webhook_events ADD COLUMN event_key TEXT;
ALTER TABLE public_subscription_provider_webhook_events ADD COLUMN provider_member_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_subscription_provider_webhook_events ADD COLUMN received_at TEXT;
ALTER TABLE public_subscription_provider_webhook_events ADD COLUMN raw_event_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(raw_event_json));

ALTER TABLE public_contact_messages ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_messages ADD COLUMN public_id TEXT;
ALTER TABLE public_contact_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'general'
  CHECK (category IN ('general', 'feedback', 'prayer', 'speaking'));
ALTER TABLE public_contact_messages ADD COLUMN email TEXT NOT NULL DEFAULT '' CHECK (email = lower(email));
ALTER TABLE public_contact_messages ADD COLUMN phone TEXT;
ALTER TABLE public_contact_messages ADD COLUMN organization TEXT;
ALTER TABLE public_contact_messages ADD COLUMN status_updated_by TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_messages ADD COLUMN consent_version TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_messages ADD COLUMN consent_text TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_messages ADD COLUMN consent_at TEXT;
ALTER TABLE public_contact_messages ADD COLUMN source_path TEXT NOT NULL DEFAULT '/contact/';
ALTER TABLE public_contact_messages ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '' CHECK (ip_hash = '' OR length(ip_hash) = 64);
ALTER TABLE public_contact_messages ADD COLUMN user_agent_hash TEXT NOT NULL DEFAULT '' CHECK (user_agent_hash = '' OR length(user_agent_hash) = 64);
ALTER TABLE public_contact_messages ADD COLUMN notification_status TEXT NOT NULL DEFAULT 'not_configured'
  CHECK (notification_status IN ('not_configured', 'pending', 'sent', 'failed'));
ALTER TABLE public_contact_messages ADD COLUMN notification_detail TEXT;
ALTER TABLE public_contact_messages ADD COLUMN notified_at TEXT;
ALTER TABLE public_contact_messages ADD COLUMN resolved_at TEXT;
ALTER TABLE public_contact_messages ADD COLUMN retention_state TEXT NOT NULL DEFAULT 'active'
  CHECK (retention_state IN ('active', 'eligible', 'held', 'purged'));
ALTER TABLE public_contact_messages ADD COLUMN retention_eligible_at TEXT;
ALTER TABLE public_contact_messages ADD COLUMN retention_deleted_at TEXT;
ALTER TABLE public_contact_messages ADD COLUMN abuse_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_messages ADD COLUMN blocked_until TEXT;

ALTER TABLE public_contact_attempts ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_attempts ADD COLUMN ip_hash TEXT NOT NULL DEFAULT '' CHECK (ip_hash = '' OR length(ip_hash) = 64);
ALTER TABLE public_contact_attempts ADD COLUMN sender_hash TEXT NOT NULL DEFAULT '' CHECK (sender_hash = '' OR length(sender_hash) = 64);
ALTER TABLE public_contact_attempts ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1));
ALTER TABLE public_contact_attempts ADD COLUMN source_path TEXT NOT NULL DEFAULT '/contact/';
ALTER TABLE public_contact_attempts ADD COLUMN user_agent_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_attempts ADD COLUMN abuse_key_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_attempts ADD COLUMN blocked_until TEXT;
ALTER TABLE public_contact_attempts ADD COLUMN request_id TEXT;
ALTER TABLE public_contact_attempts ADD COLUMN failure_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE public_contact_message_events ADD COLUMN source_record_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_message_events ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'system-worker'
  CHECK (actor_type IN ('public-form', 'content-manager', 'system-worker'));
ALTER TABLE public_contact_message_events ADD COLUMN actor_email TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_message_events ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_message_events ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));
ALTER TABLE public_contact_message_events ADD COLUMN event_at TEXT;

ALTER TABLE public_contact_notification_outbox ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE public_contact_notification_outbox ADD COLUMN available_at TEXT;
ALTER TABLE public_contact_notification_outbox ADD COLUMN started_at TEXT;
ALTER TABLE public_contact_notification_outbox ADD COLUMN completed_at TEXT;
ALTER TABLE public_contact_notification_outbox ADD COLUMN worker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_notification_outbox ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
ALTER TABLE public_contact_notification_outbox ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_ownership_idempotency
  ON processing_ownership(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_migration_source_records_target
  ON migration_source_records(target_table, source_schema, source_table, source_record_id);
CREATE INDEX IF NOT EXISTS idx_migration_field_policies_action
  ON migration_field_policies(action, source_schema, source_table);
CREATE UNIQUE INDEX IF NOT EXISTS idx_processing_provenance_idempotency
  ON processing_provenance(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_operation_audit_created
  ON admin_operation_audit(created_at, audit_id);
CREATE INDEX IF NOT EXISTS idx_admin_operation_audit_entity
  ON admin_operation_audit(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_audit_log_entity
  ON content_audit_log(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_content_audit_log_actor
  ON content_audit_log(actor_email, created_at);
CREATE INDEX IF NOT EXISTS idx_rag_interactions_user_created
  ON rag_interactions(clerk_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rag_interactions_scope_created
  ON rag_interactions(scope, created_at);
CREATE INDEX IF NOT EXISTS idx_episode_intelligence_vectors_track
  ON episode_intelligence_vectors(track_id, source_field, custom_id);
CREATE INDEX IF NOT EXISTS idx_episode_intelligence_vectors_source
  ON episode_intelligence_vectors(source_table, source_id, source_field);
CREATE INDEX IF NOT EXISTS idx_pastorwood_post_chunks_post
  ON pastorwood_post_chunks(post_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_pastorwood_post_chunks_article
  ON pastorwood_post_chunks(article_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_timing
  ON transcript_segments(episode_id, start_seconds, end_seconds);
CREATE INDEX IF NOT EXISTS idx_transcript_references_timing
  ON transcript_references(episode_id, segment_index, start_seconds, end_seconds);
CREATE INDEX IF NOT EXISTS idx_transcript_edit_requests_claimable
  ON transcript_edit_requests(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_public_subscriptions_provider
  ON public_subscriptions(provider, provider_member_id);
CREATE INDEX IF NOT EXISTS idx_public_subscriptions_retention
  ON public_subscriptions(retention_state, retention_eligible_at);
CREATE INDEX IF NOT EXISTS idx_public_contact_messages_retention
  ON public_contact_messages(retention_state, retention_eligible_at);
