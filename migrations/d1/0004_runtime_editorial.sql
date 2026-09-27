-- Phase 4 runtime editorial state, contract p4-d1-write-v1.
-- This migration is additive. It does not copy, rewrite, or publish content.

ALTER TABLE editorial_revisions ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(snapshot_json));

ALTER TABLE editorial_revisions ADD COLUMN operation_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_editorial_revisions_operation_key
  ON editorial_revisions(operation_key)
  WHERE operation_key IS NOT NULL;

ALTER TABLE articles ADD COLUMN current_revision_id TEXT;
ALTER TABLE articles ADD COLUMN published_revision_id TEXT;

ALTER TABLE episode_documents ADD COLUMN current_revision_id TEXT;
ALTER TABLE episode_documents ADD COLUMN published_revision_id TEXT;

ALTER TABLE pages ADD COLUMN current_revision_id TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_current_revision
  ON articles(current_revision_id);
CREATE INDEX IF NOT EXISTS idx_articles_published_revision
  ON articles(published_revision_id);
CREATE INDEX IF NOT EXISTS idx_episode_documents_current_revision
  ON episode_documents(current_revision_id);
CREATE INDEX IF NOT EXISTS idx_episode_documents_published_revision
  ON episode_documents(published_revision_id);
CREATE INDEX IF NOT EXISTS idx_pages_current_revision
  ON pages(current_revision_id);
