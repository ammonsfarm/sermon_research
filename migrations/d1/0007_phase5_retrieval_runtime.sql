-- Phase 5 retrieval runtime schema, contract p5-rag-v1.
-- This migration is additive and leaves publication associations empty.

ALTER TABLE rag_interactions ADD COLUMN article_id TEXT
  CHECK (
    article_id IS NULL OR
    (article_id GLOB 'pastorwood:[1-9]*' AND
      substr(article_id, 12) NOT GLOB '*[^0-9]*') OR
    (article_id GLOB 'cms:*' AND length(substr(article_id, 5)) > 0 AND
      substr(article_id, 5) NOT GLOB '*[^A-Za-z0-9._-]*')
  );

ALTER TABLE vector_documents ADD COLUMN processing_revision_hash TEXT
  CHECK (
    processing_revision_hash IS NULL OR
    (processing_revision_hash GLOB 'sha256:*' AND
     length(processing_revision_hash) = 71 AND
     substr(processing_revision_hash, 8) NOT GLOB '*[^0-9a-f]*')
  );

ALTER TABLE vector_documents ADD COLUMN processing_visibility_state TEXT
  CHECK (
    (processing_revision_hash IS NULL AND processing_visibility_state IS NULL) OR
    (processing_revision_hash IS NOT NULL AND
     processing_visibility_state IS NOT NULL AND
     processing_visibility_state IN (
       'prepared', 'accepted', 'visible', 'delete_accepted', 'deleted',
       'failed', 'superseded'
     ) AND
     length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
  );

CREATE INDEX idx_vector_documents_processing_revision_visibility
  ON vector_documents(processing_revision_hash, processing_visibility_state);

-- Bounded discovery accounting uses owner lookups and oldest-run pages.
CREATE INDEX idx_processing_requests_discovery_owner
  ON processing_requests(requested_by, request_id);
CREATE INDEX idx_processing_discovery_runs_accounting_order
  ON processing_discovery_runs(status, updated_at, discovery_run_id);

CREATE INDEX idx_rag_interactions_user_created_id
  ON rag_interactions(clerk_user_id, created_at DESC, id);
CREATE INDEX idx_rag_interactions_user_scope_created_id
  ON rag_interactions(clerk_user_id, scope, created_at DESC, id);
CREATE INDEX idx_rag_interactions_user_article_created
  ON rag_interactions(clerk_user_id, article_id, created_at DESC, id)
  WHERE article_id IS NOT NULL;

CREATE TRIGGER p5_rag_interactions_single_target_insert
BEFORE INSERT ON rag_interactions
WHEN NEW.track_id IS NOT NULL AND NEW.article_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'p5_rag_interaction_target_conflict');
END;

CREATE TRIGGER p5_rag_interactions_single_target_update
BEFORE UPDATE OF track_id, article_id ON rag_interactions
WHEN NEW.track_id IS NOT NULL AND NEW.article_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'p5_rag_interaction_target_conflict');
END;

CREATE TABLE rag_rate_windows (
  user_id TEXT NOT NULL,
  window_start_ms INTEGER NOT NULL
    CHECK (typeof(window_start_ms) = 'integer' AND window_start_ms >= 0),
  count INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(count) = 'integer' AND count >= 0 AND count <= 60),
  PRIMARY KEY (user_id, window_start_ms),
  FOREIGN KEY (user_id) REFERENCES users(clerk_user_id) ON DELETE CASCADE
);

CREATE TABLE search_publications (
  vector_id TEXT NOT NULL,
  published_revision_id TEXT NOT NULL,
  text_sha256 TEXT NOT NULL
    CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (vector_id, published_revision_id),
  FOREIGN KEY (vector_id) REFERENCES vector_documents(vector_id) ON DELETE CASCADE,
  FOREIGN KEY (published_revision_id) REFERENCES editorial_revisions(revision_id) ON DELETE CASCADE
);

CREATE INDEX idx_search_publications_revision
  ON search_publications(published_revision_id, vector_id);

CREATE TABLE research_sources (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) > 0),
  source_table TEXT NOT NULL CHECK (length(source_table) > 0),
  source_record_id TEXT NOT NULL CHECK (length(source_record_id) > 0),
  episode_id TEXT,
  article_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('episode', 'article')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'item', 'segment')),
  item_type TEXT NOT NULL CHECK (length(item_type) > 0),
  title TEXT NOT NULL,
  publish_date TEXT NOT NULL DEFAULT ''
    CHECK (publish_date = '' OR publish_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  text TEXT NOT NULL CHECK (length(text) > 0),
  text_sha256 TEXT NOT NULL
    CHECK (length(text_sha256) = 64 AND text_sha256 NOT GLOB '*[^0-9a-f]*'),
  start_ms INTEGER CHECK (start_ms IS NULL OR (typeof(start_ms) = 'integer' AND start_ms >= 0)),
  end_ms INTEGER CHECK (end_ms IS NULL OR (typeof(end_ms) = 'integer' AND end_ms >= 0)),
  sequence_number INTEGER
    CHECK (sequence_number IS NULL OR (typeof(sequence_number) = 'integer' AND sequence_number >= 0)),
  speakers_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(speakers_json) AND json_type(speakers_json) = 'array'),
  source_model TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
  source_fingerprint TEXT NOT NULL CHECK (length(source_fingerprint) > 0),
  processing_revision_hash TEXT
    CHECK (
      processing_revision_hash IS NULL OR
      (processing_revision_hash GLOB 'sha256:*' AND
       length(processing_revision_hash) = 71 AND
       substr(processing_revision_hash, 8) NOT GLOB '*[^0-9a-f]*')
    ),
  FOREIGN KEY (episode_id) REFERENCES episodes(episode_id) ON DELETE CASCADE,
  CHECK (
    (entity_type = 'episode' AND episode_id IS NOT NULL AND
     episode_id = entity_id AND article_id IS NULL) OR
    (entity_type = 'article' AND article_id IS NOT NULL AND
     article_id = entity_id AND episode_id IS NULL)
  ),
  CHECK (
    (start_ms IS NULL AND end_ms IS NULL) OR
    (start_ms IS NOT NULL AND end_ms IS NOT NULL AND end_ms >= start_ms)
  ),
  UNIQUE (source_table, source_record_id)
);

CREATE INDEX idx_research_sources_episode_kind_sequence
  ON research_sources(episode_id, kind, sequence_number);
CREATE INDEX idx_research_sources_kind_item_type_publish_date
  ON research_sources(kind, item_type, publish_date);
CREATE INDEX idx_research_sources_entity_revision
  ON research_sources(entity_type, entity_id, processing_revision_hash);

CREATE VIRTUAL TABLE research_sources_fts USING fts5(
  title,
  text,
  content='research_sources',
  content_rowid='rowid',
  tokenize='unicode61'
);
