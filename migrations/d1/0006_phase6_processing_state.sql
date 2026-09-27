-- Phase 6 durable processing control plane, contract p6-v1.
-- Migration runners apply each file transactionally. This rebuild preserves
-- every Phase 3 request column while isolating legacy and live vocabularies.

ALTER TABLE processing_requests RENAME TO processing_requests_p3_legacy;

CREATE TABLE processing_requests (
  request_id TEXT PRIMARY KEY CHECK (length(request_id) > 0),
  contract_version TEXT NOT NULL DEFAULT 'p3-legacy' CHECK (contract_version IN ('p3-legacy', 'p6-v1')),
  workflow_name TEXT CHECK (workflow_name IS NULL OR workflow_name IN ('episode', 'content')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL CHECK (length(entity_id) > 0),
  aggregate_type TEXT CHECK (aggregate_type IS NULL OR aggregate_type IN ('episode', 'article')),
  aggregate_id TEXT CHECK (aggregate_id IS NULL OR length(aggregate_id) > 0),
  document_id TEXT,
  revision_id TEXT,
  revision_hash TEXT CHECK (
    revision_hash IS NULL OR
    (revision_hash GLOB 'sha256:*' AND length(revision_hash) = 71 AND
     substr(revision_hash, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_snapshot_json TEXT,
  input_size_bytes INTEGER CHECK (
    input_size_bytes IS NULL OR
    (input_size_bytes >= 0 AND input_size_bytes <= 262144)
  ),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  desired_publication TEXT CHECK (
    desired_publication IS NULL OR
    desired_publication IN ('draft', 'published', 'unpublished', 'archived')
  ),
  state TEXT CHECK (
    state IS NULL OR state IN (
      'discovered', 'audio_storing', 'audio_stored', 'transcribing',
      'transcript_ready', 'revision_recorded', 'chunking', 'embedding',
      'indexing', 'index_visibility_pending', 'stale_vector_deleting',
      'delete_visibility_pending', 'indexed', 'intelligence_generating',
      'intelligence_ready', 'intelligence_embedding',
      'intelligence_indexing', 'intelligence_visibility_pending',
      'publish_ready', 'public_unpublish_requested',
      'public_archive_requested', 'public_hidden', 'corpus_erase_requested',
      'corpus_hidden', 'vector_deleting', 'published', 'unpublished',
      'archived', 'corpus_erased', 'failed', 'retry_required', 'superseded',
      'cancelled'
    )
  ),
  resume_sequence INTEGER NOT NULL DEFAULT 0 CHECK (resume_sequence >= 0),
  current_execution_id TEXT,
  superseded_by_request_id TEXT,
  cancel_requested_at TEXT,
  last_error_code TEXT,
  last_error_class TEXT,
  last_error_message TEXT NOT NULL DEFAULT '' CHECK (length(last_error_message) <= 2000),
  requested_by TEXT NOT NULL DEFAULT 'system',
  correlation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT,

  -- Phase 3 source-fidelity columns are retained byte-for-byte.
  status TEXT DEFAULT 'queued',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  source_record_id TEXT,
  source_fingerprint TEXT CHECK (
    source_fingerprint IS NULL OR source_fingerprint = '' OR
    (length(source_fingerprint) = 64 AND source_fingerprint NOT GLOB '*[^0-9a-fA-F]*') OR
    (source_fingerprint GLOB 'sha256:*' AND length(source_fingerprint) = 71 AND
     substr(source_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*')
  ),
  audio_fingerprint TEXT CHECK (
    audio_fingerprint IS NULL OR audio_fingerprint = '' OR
    (audio_fingerprint GLOB 'sha256:*' AND length(audio_fingerprint) = 71 AND
     substr(audio_fingerprint, 8) NOT GLOB '*[^0-9a-fA-F]*')
  ),
  request_key TEXT,
  audio_source TEXT,
  input_hash TEXT,
  output_hash TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  claimed_at TEXT,
  worker_id TEXT NOT NULL DEFAULT '',
  requested_at TEXT,

  FOREIGN KEY (superseded_by_request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  CHECK (
    (contract_version = 'p3-legacy' AND
      operation IN ('transcribe', 'intelligence', 'embed', 'index', 'publish', 'verify') AND
      status IN ('queued', 'running', 'completed', 'failed', 'cancelled') AND
      workflow_name IS NULL AND aggregate_type IS NULL AND aggregate_id IS NULL AND
      revision_hash IS NULL AND input_snapshot_json IS NULL AND input_size_bytes IS NULL AND
      generation = 0 AND desired_publication IS NULL AND state IS NULL AND
      current_execution_id IS NULL) OR
    (contract_version = 'p6-v1' AND
      workflow_name IS NOT NULL AND
      entity_type IN ('episode', 'article', 'transcript') AND
      operation IN ('episode_ingest', 'article_replace', 'transcript_replace',
                    'public_unpublish', 'public_archive', 'corpus_erase') AND
      status IS NULL AND revision_id IS NOT NULL AND length(revision_id) > 0 AND
      revision_hash IS NOT NULL AND input_snapshot_json IS NOT NULL AND
      json_valid(input_snapshot_json) AND json_type(input_snapshot_json) = 'object' AND
      input_size_bytes = length(CAST(input_snapshot_json AS BLOB)) AND
      generation > 0 AND desired_publication IS NOT NULL AND state IS NOT NULL AND
      updated_at IS NOT NULL AND correlation_id IS NOT NULL AND length(correlation_id) > 0 AND
      ((operation = 'episode_ingest' AND workflow_name = 'episode' AND entity_type = 'episode' AND
        aggregate_type = 'episode' AND aggregate_id = entity_id AND
        idempotency_key GLOB 'p6:episode-ingest:v1:*' AND length(idempotency_key) = 85) OR
       (operation = 'transcript_replace' AND workflow_name = 'content' AND entity_type = 'transcript' AND
        aggregate_type = 'episode' AND aggregate_id = entity_id AND
        idempotency_key GLOB 'p6:transcript-index:v1:*' AND length(idempotency_key) = 87) OR
       (operation IN ('article_replace', 'public_unpublish', 'public_archive', 'corpus_erase') AND
        workflow_name = 'content' AND entity_type = 'article' AND
        aggregate_type = 'article' AND aggregate_id = entity_id AND
        idempotency_key GLOB 'p6:article-index:v1:*' AND length(idempotency_key) = 84)) AND
      substr(idempotency_key, -64) NOT GLOB '*[^0-9a-f]*')
  )
);

INSERT INTO processing_requests (
  request_id, contract_version, entity_type, entity_id, document_id,
  revision_id, operation, idempotency_key, requested_by, status,
  error_message, created_at, started_at, completed_at, source_record_id,
  source_fingerprint, audio_fingerprint, request_key, audio_source, input_hash,
  output_hash, attempt_count, next_attempt_at, claimed_at, worker_id,
  requested_at
)
SELECT
  request_id, 'p3-legacy', entity_type, entity_id, document_id,
  revision_id, operation, idempotency_key, requested_by, status,
  error_message, created_at, started_at, completed_at, source_record_id,
  source_fingerprint, audio_fingerprint, request_key, audio_source, input_hash,
  output_hash, attempt_count, next_attempt_at, claimed_at, worker_id,
  requested_at
FROM processing_requests_p3_legacy;

DROP TABLE processing_requests_p3_legacy;

CREATE UNIQUE INDEX idx_processing_requests_idempotency
  ON processing_requests(idempotency_key);
CREATE INDEX idx_processing_requests_status
  ON processing_requests(contract_version, state, created_at);
CREATE UNIQUE INDEX idx_processing_requests_aggregate_generation
  ON processing_requests(aggregate_type, aggregate_id, generation)
  WHERE contract_version = 'p6-v1';
CREATE UNIQUE INDEX idx_processing_requests_current_execution
  ON processing_requests(workflow_name, current_execution_id)
  WHERE current_execution_id IS NOT NULL;

CREATE TABLE processing_heads (
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('episode', 'article')),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) > 0),
  generation INTEGER NOT NULL CHECK (generation > 0),
  head_request_id TEXT NOT NULL,
  head_revision_hash TEXT NOT NULL CHECK (
    head_revision_hash GLOB 'sha256:*' AND length(head_revision_hash) = 71 AND
    substr(head_revision_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  published_request_id TEXT,
  published_revision_hash TEXT CHECK (
    published_revision_hash IS NULL OR
    (published_revision_hash GLOB 'sha256:*' AND length(published_revision_hash) = 71 AND
     substr(published_revision_hash, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  authenticated_corpus_request_id TEXT,
  authenticated_corpus_revision_hash TEXT CHECK (
    authenticated_corpus_revision_hash IS NULL OR
    (authenticated_corpus_revision_hash GLOB 'sha256:*' AND
     length(authenticated_corpus_revision_hash) = 71 AND
     substr(authenticated_corpus_revision_hash, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  public_visibility TEXT NOT NULL DEFAULT 'hidden' CHECK (public_visibility IN ('hidden', 'visible')),
  authenticated_corpus_visibility TEXT NOT NULL DEFAULT 'inherited'
    CHECK (authenticated_corpus_visibility IN ('inherited', 'visible', 'hidden', 'erased')),
  desired_publication TEXT NOT NULL CHECK (desired_publication IN ('draft', 'published', 'unpublished', 'archived')),
  mutation_owner_request_id TEXT,
  mutation_lease_token TEXT,
  mutation_lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id),
  FOREIGN KEY (head_request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  FOREIGN KEY (published_request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  FOREIGN KEY (authenticated_corpus_request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  FOREIGN KEY (mutation_owner_request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  CHECK (
    (published_request_id IS NULL AND published_revision_hash IS NULL) OR
    (published_request_id IS NOT NULL AND published_revision_hash IS NOT NULL)
  ),
  CHECK (
    (authenticated_corpus_request_id IS NULL AND authenticated_corpus_revision_hash IS NULL) OR
    (authenticated_corpus_request_id IS NOT NULL AND authenticated_corpus_revision_hash IS NOT NULL)
  ),
  CHECK (
    (mutation_owner_request_id IS NULL AND mutation_lease_token IS NULL AND mutation_lease_expires_at IS NULL) OR
    (mutation_owner_request_id IS NOT NULL AND length(mutation_owner_request_id) > 0 AND
     mutation_lease_token IS NOT NULL AND length(mutation_lease_token) > 0 AND
     mutation_lease_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_processing_heads_current
  ON processing_heads(head_request_id, generation);
CREATE INDEX idx_processing_heads_mutation_lease
  ON processing_heads(aggregate_type, aggregate_id, mutation_lease_expires_at);

CREATE TRIGGER p6_processing_request_generation_guard
BEFORE INSERT ON processing_requests
WHEN NEW.contract_version = 'p6-v1'
BEGIN
  SELECT CASE WHEN NEW.generation != COALESCE((
    SELECT generation + 1 FROM processing_heads
     WHERE aggregate_type = NEW.aggregate_type AND aggregate_id = NEW.aggregate_id
  ), 1) THEN RAISE(ABORT, 'p6_stale_generation') END;
END;

CREATE TRIGGER p6_processing_request_head_after_insert
AFTER INSERT ON processing_requests
WHEN NEW.contract_version = 'p6-v1'
BEGIN
  UPDATE processing_requests
     SET superseded_by_request_id = NEW.request_id,
         cancel_requested_at = CASE WHEN current_execution_id IS NULL THEN cancel_requested_at ELSE NEW.created_at END,
         state = CASE WHEN current_execution_id IS NULL THEN 'superseded' ELSE state END,
         completed_at = CASE WHEN current_execution_id IS NULL THEN NEW.created_at ELSE completed_at END,
         updated_at = NEW.created_at
   WHERE request_id = (
     SELECT head_request_id FROM processing_heads
      WHERE aggregate_type = NEW.aggregate_type AND aggregate_id = NEW.aggregate_id
   );

  INSERT INTO processing_heads (
    aggregate_type, aggregate_id, generation, head_request_id,
    head_revision_hash, desired_publication, updated_at
  ) VALUES (
    NEW.aggregate_type, NEW.aggregate_id, NEW.generation, NEW.request_id,
    NEW.revision_hash, NEW.desired_publication, NEW.created_at
  )
  ON CONFLICT (aggregate_type, aggregate_id) DO UPDATE SET
    generation = excluded.generation,
    head_request_id = excluded.head_request_id,
    head_revision_hash = excluded.head_revision_hash,
    desired_publication = excluded.desired_publication,
    updated_at = excluded.updated_at;
END;

CREATE TABLE processing_executions (
  execution_id TEXT PRIMARY KEY CHECK (length(execution_id) > 0),
  request_id TEXT NOT NULL,
  workflow_instance_id TEXT NOT NULL CHECK (
    length(workflow_instance_id) < 100 AND
    (workflow_instance_id GLOB 'p6e-*' OR workflow_instance_id GLOB 'p6a-*')
  ),
  resume_sequence INTEGER NOT NULL CHECK (resume_sequence >= 0),
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'complete', 'errored', 'terminated')),
  initiated_by TEXT NOT NULL CHECK (length(initiated_by) > 0),
  resume_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_processing_executions_request_resume
  ON processing_executions(request_id, resume_sequence);
CREATE UNIQUE INDEX idx_processing_executions_workflow_instance
  ON processing_executions(workflow_instance_id);
CREATE INDEX idx_processing_executions_status
  ON processing_executions(status, updated_at);

CREATE TRIGGER p6_processing_execution_guard
BEFORE INSERT ON processing_executions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM processing_requests r
      JOIN processing_heads h
        ON h.aggregate_type = r.aggregate_type
       AND h.aggregate_id = r.aggregate_id
       AND h.head_request_id = r.request_id
       AND h.generation = r.generation
     WHERE r.request_id = NEW.request_id
       AND r.contract_version = 'p6-v1'
       AND r.superseded_by_request_id IS NULL
       AND r.cancel_requested_at IS NULL
       AND (
         (NEW.resume_sequence = 0 AND r.resume_sequence = 0 AND
          r.current_execution_id IS NULL AND r.state NOT IN (
            'published', 'unpublished', 'archived', 'corpus_erased', 'failed',
            'superseded', 'cancelled'
          )) OR
         (NEW.resume_sequence > 0 AND r.state = 'retry_required' AND
          NEW.resume_sequence = r.resume_sequence + 1)
       )
  ) THEN RAISE(ABORT, 'p6_execution_conflict') END;
END;

CREATE TRIGGER p6_processing_execution_after_insert
AFTER INSERT ON processing_executions
BEGIN
  UPDATE processing_requests
     SET current_execution_id = NEW.execution_id,
         resume_sequence = NEW.resume_sequence,
         state = CASE WHEN NEW.resume_sequence = 0 THEN state
           ELSE COALESCE((
             SELECT from_state
               FROM processing_stage_runs
              WHERE request_id = NEW.request_id
                AND status = 'failed' AND to_state = 'retry_required'
              ORDER BY updated_at DESC, stage_key DESC
              LIMIT 1
           ), CASE
             WHEN operation = 'episode_ingest' THEN 'discovered'
             WHEN operation = 'transcript_replace' OR operation = 'article_replace' THEN 'revision_recorded'
             WHEN operation = 'public_unpublish' THEN 'public_unpublish_requested'
             WHEN operation = 'public_archive' THEN 'public_archive_requested'
             ELSE 'corpus_erase_requested' END) END,
         last_error_code = CASE WHEN NEW.resume_sequence = 0 THEN last_error_code ELSE NULL END,
         last_error_class = CASE WHEN NEW.resume_sequence = 0 THEN last_error_class ELSE NULL END,
         last_error_message = CASE WHEN NEW.resume_sequence = 0 THEN last_error_message ELSE '' END,
         updated_at = NEW.created_at
   WHERE request_id = NEW.request_id;
END;

CREATE TABLE processing_stage_runs (
  stage_key TEXT PRIMARY KEY CHECK (length(stage_key) > 0),
  request_id TEXT NOT NULL,
  stage_name TEXT NOT NULL CHECK (length(stage_name) > 0),
  batch_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (batch_ordinal >= 0),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'side_effect_unknown', 'accepted', 'visible',
    'complete', 'failed', 'skipped', 'superseded', 'cancelled'
  )),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  mutation_lease_token TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  input_hash TEXT CHECK (
    input_hash IS NULL OR
    (input_hash GLOB 'sha256:*' AND length(input_hash) = 71 AND
     substr(input_hash, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  output_hash TEXT CHECK (
    output_hash IS NULL OR
    (output_hash GLOB 'sha256:*' AND length(output_hash) = 71 AND
     substr(output_hash, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  side_effect_key TEXT,
  provider TEXT,
  model TEXT,
  provider_mutation_id TEXT,
  retry_class TEXT,
  error_code TEXT,
  error_class TEXT,
  error_message TEXT NOT NULL DEFAULT '' CHECK (length(error_message) <= 2000),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_processing_stage_runs_request_stage_batch
  ON processing_stage_runs(request_id, stage_name, batch_ordinal);
CREATE INDEX idx_processing_stage_runs_status
  ON processing_stage_runs(status, updated_at);

CREATE TRIGGER p6_processing_stage_after_insert
AFTER INSERT ON processing_stage_runs
BEGIN
  UPDATE processing_requests
     SET state = NEW.to_state,
         last_error_code = CASE WHEN NEW.error_code IS NULL THEN last_error_code ELSE NEW.error_code END,
         last_error_class = CASE WHEN NEW.error_class IS NULL THEN last_error_class ELSE NEW.error_class END,
         last_error_message = CASE WHEN NEW.error_message = '' THEN last_error_message ELSE NEW.error_message END,
         completed_at = CASE WHEN NEW.to_state IN (
           'published', 'unpublished', 'archived', 'corpus_erased', 'failed',
           'superseded', 'cancelled'
         ) THEN NEW.completed_at ELSE completed_at END,
         updated_at = NEW.updated_at
   WHERE request_id = NEW.request_id
     AND generation = NEW.generation
     AND state = NEW.from_state
     AND superseded_by_request_id IS NULL
     AND cancel_requested_at IS NULL
     AND EXISTS (
       SELECT 1 FROM processing_heads h
        WHERE h.aggregate_type = processing_requests.aggregate_type
          AND h.aggregate_id = processing_requests.aggregate_id
          AND h.head_request_id = processing_requests.request_id
          AND h.generation = processing_requests.generation
          AND (NEW.mutation_lease_token IS NULL OR
               (h.mutation_owner_request_id = NEW.request_id AND
                h.mutation_lease_token = NEW.mutation_lease_token AND
                h.mutation_lease_expires_at > NEW.updated_at))
     );
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_transition_conflict') END;
END;

CREATE TRIGGER p6_processing_stage_after_retry
AFTER UPDATE OF status, to_state ON processing_stage_runs
WHEN OLD.status = 'failed' AND OLD.to_state = 'retry_required'
BEGIN
  UPDATE processing_requests
     SET state = NEW.to_state,
         last_error_code = NEW.error_code,
         last_error_class = NEW.error_class,
         last_error_message = NEW.error_message,
         completed_at = CASE WHEN NEW.to_state IN (
           'published', 'unpublished', 'archived', 'corpus_erased', 'failed',
           'superseded', 'cancelled'
         ) THEN NEW.completed_at ELSE completed_at END,
         updated_at = NEW.updated_at
   WHERE request_id = NEW.request_id
     AND generation = NEW.generation
     AND state = NEW.from_state
     AND superseded_by_request_id IS NULL
     AND cancel_requested_at IS NULL
     AND EXISTS (
       SELECT 1 FROM processing_heads h
        WHERE h.aggregate_type = processing_requests.aggregate_type
          AND h.aggregate_id = processing_requests.aggregate_id
          AND h.head_request_id = processing_requests.request_id
          AND h.generation = processing_requests.generation
          AND (NEW.mutation_lease_token IS NULL OR
               (h.mutation_owner_request_id = NEW.request_id AND
                h.mutation_lease_token = NEW.mutation_lease_token AND
                h.mutation_lease_expires_at > NEW.updated_at))
     );
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_transition_conflict') END;
END;

CREATE TRIGGER p6_processing_public_hide_after_transition
AFTER UPDATE OF state ON processing_requests
WHEN NEW.contract_version = 'p6-v1' AND NEW.state = 'public_hidden' AND OLD.state != NEW.state
BEGIN
  UPDATE processing_heads
     SET public_visibility = 'hidden', updated_at = NEW.updated_at
   WHERE aggregate_type = NEW.aggregate_type
     AND aggregate_id = NEW.aggregate_id
     AND head_request_id = NEW.request_id
     AND generation = NEW.generation;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_public_hide_conflict') END;
  UPDATE articles
     SET status = CASE WHEN NEW.operation = 'public_archive' THEN 'Archived' ELSE 'Draft' END,
         published_at = NULL,
         scheduled_for = NULL,
         archived_at = CASE WHEN NEW.operation = 'public_archive' THEN NEW.updated_at ELSE archived_at END,
         updated_at = NEW.updated_at
   WHERE article_id = NEW.aggregate_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_public_hide_conflict') END;
END;

CREATE TRIGGER p6_processing_corpus_hide_after_transition
AFTER UPDATE OF state ON processing_requests
WHEN NEW.contract_version = 'p6-v1' AND NEW.operation = 'corpus_erase'
 AND NEW.state = 'corpus_hidden' AND OLD.state != NEW.state
BEGIN
  UPDATE processing_heads
     SET authenticated_corpus_visibility = 'hidden', updated_at = NEW.updated_at
   WHERE aggregate_type = NEW.aggregate_type
     AND aggregate_id = NEW.aggregate_id
     AND head_request_id = NEW.request_id
     AND generation = NEW.generation;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_corpus_hide_conflict') END;
END;

CREATE TABLE processing_vector_batches (
  request_id TEXT NOT NULL,
  batch_ordinal INTEGER NOT NULL CHECK (batch_ordinal >= 0),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  expected_ids_digest TEXT NOT NULL CHECK (
    expected_ids_digest GLOB 'sha256:*' AND length(expected_ids_digest) = 71 AND
    substr(expected_ids_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  expected_count INTEGER NOT NULL CHECK (expected_count >= 0 AND expected_count <= 1000),
  target_revision_hash TEXT NOT NULL CHECK (
    target_revision_hash GLOB 'sha256:*' AND length(target_revision_hash) = 71 AND
    substr(target_revision_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_mutation_id TEXT NOT NULL CHECK (length(provider_mutation_id) > 0),
  visibility_state TEXT NOT NULL CHECK (visibility_state IN (
    'prepared', 'accepted', 'visible', 'delete_accepted', 'deleted', 'failed', 'superseded'
  )),
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  processed_up_to_mutation TEXT,
  accepted_at TEXT,
  visible_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (request_id, batch_ordinal, operation),
  FOREIGN KEY (request_id) REFERENCES processing_requests(request_id) ON DELETE RESTRICT,
  CHECK (
    (operation = 'upsert' AND visibility_state IN ('prepared', 'accepted', 'visible', 'failed', 'superseded')) OR
    (operation = 'delete' AND visibility_state IN ('prepared', 'delete_accepted', 'deleted', 'failed', 'superseded'))
  )
);

CREATE UNIQUE INDEX idx_processing_vector_batches_request_batch
  ON processing_vector_batches(request_id, batch_ordinal, operation);
CREATE INDEX idx_processing_vector_batches_visibility
  ON processing_vector_batches(visibility_state, updated_at);

CREATE TRIGGER p6_processing_publication_after_head_update
AFTER UPDATE OF published_request_id, published_revision_hash ON processing_heads
WHEN NEW.head_request_id IS NOT NULL
BEGIN
  UPDATE processing_requests
     SET state = CASE
       WHEN NEW.desired_publication = 'published' THEN 'published'
       WHEN NEW.desired_publication = 'unpublished' THEN 'unpublished'
       ELSE 'archived' END,
         completed_at = NEW.updated_at,
         updated_at = NEW.updated_at
   WHERE request_id = NEW.head_request_id
     AND generation = NEW.generation
     AND (
       (NEW.desired_publication = 'published' AND state = 'publish_ready' AND
        NEW.public_visibility = 'visible' AND NEW.published_request_id = request_id AND
        NEW.published_revision_hash = revision_hash) OR
       (NEW.desired_publication = 'unpublished' AND state = 'public_hidden' AND
        operation = 'public_unpublish' AND NEW.public_visibility = 'hidden') OR
       (NEW.desired_publication = 'archived' AND state = 'public_hidden' AND
        operation = 'public_archive' AND NEW.public_visibility = 'hidden')
     );
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_publication_conflict') END;
END;

CREATE TRIGGER p6_processing_corpus_erase_after_head_update
AFTER UPDATE OF authenticated_corpus_visibility ON processing_heads
WHEN NEW.authenticated_corpus_visibility = 'erased'
 AND OLD.authenticated_corpus_visibility != NEW.authenticated_corpus_visibility
BEGIN
  UPDATE processing_requests
     SET state = 'corpus_erased', completed_at = NEW.updated_at, updated_at = NEW.updated_at
   WHERE request_id = NEW.head_request_id
     AND generation = NEW.generation
     AND state = 'delete_visibility_pending'
     AND operation = 'corpus_erase'
     AND superseded_by_request_id IS NULL
     AND cancel_requested_at IS NULL;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'p6_corpus_erase_conflict') END;
END;

CREATE TABLE processing_discovery_runs (
  discovery_run_id TEXT PRIMARY KEY CHECK (length(discovery_run_id) > 0),
  source_adapter TEXT NOT NULL CHECK (length(source_adapter) > 0),
  scheduled_slot TEXT NOT NULL CHECK (length(scheduled_slot) > 0),
  scheduled_utc_minute TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK (length(requested_by) > 0),
  source_validator TEXT,
  source_cursor TEXT,
  seen_count INTEGER NOT NULL DEFAULT 0 CHECK (seen_count >= 0),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  invalid_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  dispatched_count INTEGER NOT NULL DEFAULT 0 CHECK (dispatched_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'complete', 'failed')),
  error_message TEXT NOT NULL DEFAULT '' CHECK (length(error_message) <= 2000),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_processing_discovery_runs_scheduled_slot
  ON processing_discovery_runs(source_adapter, scheduled_slot);
CREATE INDEX idx_processing_discovery_runs_status
  ON processing_discovery_runs(status, updated_at);
