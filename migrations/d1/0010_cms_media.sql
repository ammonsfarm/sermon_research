-- Uploaded CMS files (R2 bucket aic-cms-media) and media-asset records.
-- Numeric file IDs match the editor's existing media-reference contract.

CREATE TABLE IF NOT EXISTS cms_files (
  file_id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_key TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 512),
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
  alternative_text TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- Allow media-asset records alongside people, endorsements, and redirects.
CREATE TABLE cms_records_0010 (
  collection TEXT NOT NULL CHECK (collection IN ('people', 'endorsements', 'redirects', 'media-assets')),
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
INSERT INTO cms_records_0010 SELECT collection, document_id, title, data_json, status, published_at, source_record_id, created_by, updated_by, created_at, updated_at FROM cms_records;
DROP INDEX IF EXISTS cms_records_collection_title;
DROP TABLE cms_records;
ALTER TABLE cms_records_0010 RENAME TO cms_records;
CREATE INDEX IF NOT EXISTS cms_records_collection_title ON cms_records(collection, title);
