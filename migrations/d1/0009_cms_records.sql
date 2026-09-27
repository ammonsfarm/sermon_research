-- Simple CMS collections (people, endorsements, redirects) edited in the D1 console.
-- Field values follow apps/web/lib/structured-content-config.ts and live in data_json.

CREATE TABLE IF NOT EXISTS cms_records (
  collection TEXT NOT NULL CHECK (collection IN ('people', 'endorsements', 'redirects')),
  document_id TEXT NOT NULL CHECK (length(document_id) BETWEEN 1 AND 64),
  title TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json) AND json_type(data_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
  published_at TEXT,
  source_record_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, document_id)
);

CREATE INDEX IF NOT EXISTS cms_records_collection_title ON cms_records(collection, title);

CREATE TABLE IF NOT EXISTS cms_record_revisions (
  revision_id TEXT PRIMARY KEY CHECK (length(revision_id) > 0),
  collection TEXT NOT NULL,
  document_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'publish', 'unpublish', 'archive', 'restore', 'delete')),
  actor_email TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(snapshot_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cms_record_revisions_document ON cms_record_revisions(collection, document_id, created_at);
