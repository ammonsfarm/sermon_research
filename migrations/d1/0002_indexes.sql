-- Query and reconciliation indexes for the p3-v1 D1 schema.

CREATE INDEX IF NOT EXISTS idx_migration_checkpoints_status
  ON migration_checkpoints(domain, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_migration_table_state_target
  ON migration_table_state(target_table, status);
CREATE INDEX IF NOT EXISTS idx_migration_decisions_entity
  ON migration_reconciliation_decisions(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_migration_aliases_canonical
  ON migration_identity_aliases(entity_type, canonical_id);
CREATE INDEX IF NOT EXISTS idx_migration_tombstones_entity
  ON migration_tombstones(entity_type, entity_id, applied_at);

CREATE INDEX IF NOT EXISTS idx_episodes_status_publish_date
  ON episodes(status, publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_updated_at
  ON episodes(updated_at);
CREATE INDEX IF NOT EXISTS idx_episode_documents_status
  ON episode_documents(status, published_at);
CREATE INDEX IF NOT EXISTS idx_episode_documents_cms_document
  ON episode_documents(cms_document_id);
CREATE INDEX IF NOT EXISTS idx_articles_status_publish_date
  ON articles(status, publish_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles(source_type, source_post_id);
CREATE INDEX IF NOT EXISTS idx_pages_status
  ON pages(status, published_at);
CREATE INDEX IF NOT EXISTS idx_editorial_revisions_entity
  ON editorial_revisions(entity_type, entity_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_content_components_entity
  ON content_components(entity_type, entity_id, component_order);
CREATE INDEX IF NOT EXISTS idx_people_status
  ON people(status, name);
CREATE INDEX IF NOT EXISTS idx_endorsements_person
  ON endorsements(person_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_redirects_active
  ON redirects(active, source_path);
CREATE INDEX IF NOT EXISTS idx_site_settings_public
  ON site_settings(is_public, setting_key);
CREATE INDEX IF NOT EXISTS idx_editorial_events_entity
  ON editorial_events(entity_type, entity_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_requests_status
  ON processing_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_processing_provenance_entity
  ON processing_provenance(entity_type, entity_id, stage);
CREATE INDEX IF NOT EXISTS idx_processing_ownership_expiry
  ON processing_ownership(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_transcript_chunks_episode
  ON transcript_chunks(episode_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_transcript_chunks_hash
  ON transcript_chunks(content_hash);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_episode
  ON transcript_segments(episode_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_transcript_references_episode
  ON transcript_references(episode_id, reference_type);
CREATE INDEX IF NOT EXISTS idx_transcript_edit_requests_status
  ON transcript_edit_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_episode_intelligence_status
  ON episode_intelligence(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_episode_intelligence_items_episode
  ON episode_intelligence_items(episode_id, item_type);
CREATE INDEX IF NOT EXISTS idx_vector_documents_source
  ON vector_documents(source_type, source_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_vector_documents_status
  ON vector_documents(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_vector_documents_content_hash
  ON vector_documents(content_hash);

CREATE INDEX IF NOT EXISTS idx_users_status
  ON users(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_user_roles_active
  ON user_roles(user_id, revoked_at, role);
CREATE INDEX IF NOT EXISTS idx_agent_settings_public
  ON agent_settings(is_public, setting_key);

CREATE INDEX IF NOT EXISTS idx_podtrac_daily_episode
  ON podtrac_daily_activity(episode_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_podtrac_client_date
  ON podtrac_activity_by_client(client_id, activity_date);
CREATE INDEX IF NOT EXISTS idx_podtrac_country_date
  ON podtrac_activity_by_country(country_code, activity_date);
CREATE INDEX IF NOT EXISTS idx_podtrac_import_runs_status
  ON podtrac_import_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_podtrac_sync_runs_status
  ON podtrac_sync_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_podtrac_reconciliation_episode
  ON podtrac_reconciliation_audit(episode_id, created_at);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status
  ON public_subscriptions(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_subscription_attempts_subscription
  ON public_subscription_attempts(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription
  ON public_subscription_events(subscription_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_subscription_outbox_status
  ON public_subscription_provider_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created
  ON public_subscription_provider_webhook_events(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_messages_status
  ON public_contact_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_attempts_message
  ON public_contact_attempts(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_events_message
  ON public_contact_message_events(message_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contact_outbox_status
  ON public_contact_notification_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_consent_subject
  ON consent_events(subject_type, subject_id, consent_type, created_at);
CREATE INDEX IF NOT EXISTS idx_retention_state
  ON public_data_retention(state, eligible_at);

CREATE INDEX IF NOT EXISTS idx_media_assets_status
  ON media_assets(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_source
  ON media_assets(source_provider, source_bucket, source_key);
CREATE INDEX IF NOT EXISTS idx_media_assets_sha256
  ON media_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_media_aliases_asset
  ON media_aliases(asset_id, alias_type);
