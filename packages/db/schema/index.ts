/**
 * Machine-readable description of the D1 target schema.
 *
 * This module intentionally contains no D1 binding types or SQL execution.
 * Migration tools can use it to report the contract-owned table families
 * without coupling the shared application contracts to SQLite.
 */

export const D1_SCHEMA_VERSION = "p3-v1" as const;
/** Runtime repository schema layered on the historical migration contract. */
export const D1_RUNTIME_SCHEMA_VERSION = "p4-d1-write-v1" as const;
/** Additive public-listing schema layered on the frozen write schema. */
export const D1_PUBLIC_LISTING_SCHEMA_VERSION = "p4-v2" as const;
/** Durable processing state layered on the migrated content schema. */
export const D1_PROCESSING_SCHEMA_VERSION = "p6-v1" as const;
/** Retrieval history, admission, publication proof, and supplemental search. */
export const D1_RETRIEVAL_SCHEMA_VERSION = "p5-rag-v1" as const;
export const D1_SOURCE_CROSSWALK_FILE = "source-crosswalk.json" as const;

export const D1_MIGRATION_FILES = [
  "0001_core.sql",
  "0002_indexes.sql",
  "0003_source_fidelity.sql",
  "0004_runtime_editorial.sql",
  "0005_public_listing_fidelity.sql",
  "0006_phase6_processing_state.sql",
  "0007_phase5_retrieval_runtime.sql",
] as const;

export const D1_TABLE_FAMILIES = {
  migration: [
    "migration_runs",
    "migration_checkpoints",
    "migration_table_state",
    "migration_reconciliation_decisions",
    "migration_identity_aliases",
    "migration_tombstones",
    "migration_source_records",
    "migration_field_policies",
  ],
  editorial: [
    "episodes",
    "episode_documents",
    "articles",
    "pages",
    "editorial_revisions",
    "content_components",
    "people",
    "endorsements",
    "redirects",
    "site_settings",
    "editorial_events",
    "processing_requests",
    "processing_provenance",
    "processing_ownership",
    "admin_operation_audit",
    "content_audit_log",
  ],
  processing: [
    "processing_heads",
    "processing_executions",
    "processing_stage_runs",
    "processing_vector_batches",
    "processing_discovery_runs",
  ],
  retrieval: [
    "rag_rate_windows",
    "search_publications",
    "research_sources",
  ],
  transcript: [
    "transcript_chunks",
    "transcript_segments",
    "transcript_references",
    "transcript_edit_requests",
    "episode_intelligence",
    "episode_intelligence_items",
    "episode_intelligence_vectors",
    "pastorwood_post_chunks",
    "rag_interactions",
    "vector_documents",
  ],
  access: ["users", "user_roles", "agent_settings"],
  podtrac: [
    "podtrac_clients",
    "podtrac_countries",
    "podtrac_episodes",
    "podtrac_daily_activity",
    "podtrac_activity_by_client",
    "podtrac_activity_by_country",
    "podtrac_import_runs",
    "podtrac_import_metadata",
    "podtrac_sync_runs",
    "podtrac_reconciliation_audit",
  ],
  engagement: [
    "public_subscriptions",
    "public_subscription_attempts",
    "public_subscription_events",
    "public_subscription_provider_outbox",
    "public_subscription_provider_webhook_events",
    "public_contact_messages",
    "public_contact_attempts",
    "public_contact_message_events",
    "public_contact_notification_outbox",
    "consent_events",
    "public_data_retention",
  ],
  media: ["media_assets", "media_aliases"],
} as const;

export type D1TableFamily = keyof typeof D1_TABLE_FAMILIES;

export const D1_TABLES = Object.freeze(
  Object.values(D1_TABLE_FAMILIES).flat(),
);
