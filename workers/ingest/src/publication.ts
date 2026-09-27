import {
  canonicalProcessingSnapshot, createProcessingIdempotencyKey, createProcessingRevisionHash,
  ProcessingStateError, type BackgroundJobReceipt, type JsonValue, type ProcessingStateStore,
} from "@aic/contracts";
import type { D1Database } from "@aic/db";

export interface EpisodePublicationInput {
  readonly requestId: string;
  readonly revisionHash: `sha256:${string}`;
  readonly generation: number;
  readonly actor: string;
}

/** A new immutable editorial intent, dispatched through the complete episode Workflow. */
export async function requestEpisodePublication(options: {
  readonly db: D1Database;
  readonly stateStore: ProcessingStateStore;
  readonly dispatch: (requestId: string) => Promise<BackgroundJobReceipt>;
}, input: EpisodePublicationInput) {
  if (!input.actor || input.actor.length > 512 || input.actor.trim() !== input.actor || /[\u0000-\u001f\u007f]/u.test(input.actor)) {
    throw new ProcessingStateError("invalid_input", "Episode publication actor is invalid.");
  }
  const source = await options.db.prepare(`SELECT entity_id, revision_hash, generation, input_snapshot_json,
    desired_publication FROM processing_requests WHERE request_id=? AND workflow_name='episode'
    AND operation='episode_ingest' AND contract_version='p6-v1'`).bind(input.requestId)
    .first<{ entity_id: string; revision_hash: `sha256:${string}`; generation: number; input_snapshot_json: string; desired_publication: string }>();
  if (!source) throw new ProcessingStateError("not_found", "Episode draft request was not found.");
  if (source.desired_publication !== "draft" || source.revision_hash !== input.revisionHash || source.generation !== input.generation) {
    throw new ProcessingStateError("identity_conflict", "Episode publication does not identify the immutable draft.");
  }
  const original = JSON.parse(source.input_snapshot_json) as Record<string, JsonValue>;
  if (canonicalProcessingSnapshot(original) !== source.input_snapshot_json || await createProcessingRevisionHash(original) !== source.revision_hash) {
    throw new ProcessingStateError("identity_conflict", "Episode draft snapshot identity is invalid.");
  }
  const snapshot = { ...original, publicationIntent: "published", publicationSourceRequestId: input.requestId };
  const revisionHash = await createProcessingRevisionHash(snapshot);
  const identity = { operation: "episode_ingest", entityType: "episode", entityId: source.entity_id, revisionHash } as const;
  const idempotencyKey = await createProcessingIdempotencyKey(identity);
  const receipt = await options.stateStore.createOrGetRequest({
    ...identity, requestId: `p6pub-${revisionHash.slice(7)}`, workflow: "episode",
    revisionId: `episode-publication:${source.entity_id}:${revisionHash.slice(7)}`,
    snapshot, desiredPublication: "published", idempotencyKey,
    requestedBy: input.actor, correlationId: input.requestId,
    expectedPredecessor: { requestId: input.requestId, revisionHash: input.revisionHash, generation: input.generation },
  });
  const dispatched = await options.dispatch(receipt.requestId);
  return { ...receipt, jobId: dispatched.jobId };
}
