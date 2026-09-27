import { ServiceError } from "./errors.ts";
import {
  articleId,
  objectKey,
  vectorId,
  type ArticleId,
  type ContentHash,
  type EpisodeId,
  type IsoDateTime,
  type ObjectKey,
  type VectorId,
} from "./ids.ts";
import type { SearchDocumentSourceType } from "./repositories.ts";

export const MIGRATION_CONTRACT_VERSION = "p3-v1" as const;
export const MIGRATION_REPORT_SCHEMA = "aic.migration-report/v1" as const;
export const MIGRATION_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const VECTOR_SOURCE_PREFIX = {
  transcript_chunks: "t/",
  episode_intelligence_vectors: "i/",
  pastorwood_post_chunks: "a/",
} as const;

export type VectorSourceTable = keyof typeof VECTOR_SOURCE_PREFIX;

export const VECTORIZE_METADATA_INDEXES = [
  { propertyName: "source_type", type: "string" },
  { propertyName: "source_id", type: "string" },
  { propertyName: "content_subtype", type: "string" },
  { propertyName: "published_day", type: "number" },
  { propertyName: "content_hash", type: "string" },
  { propertyName: "chunk_index", type: "number" },
] as const;

const utf8 = new TextEncoder();

function requireExactSourceValue(value: string, name: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001F\u007F]/.test(value)
  ) {
    throw new ServiceError({
      code: "invalid_argument",
      message: `${name} must be a non-empty, unmodified source value.`,
    });
  }
  return value;
}

/** The existing MinIO and target R2 key remain byte-for-byte compatible. */
export function episodeAudioObjectKey(id: EpisodeId): ObjectKey {
  return objectKey(`podcasts/${id}.mp3`);
}

/** WordPress/Pastor Wood numeric IDs become globally explicit article IDs. */
export function pastorWoodArticleId(legacyPostId: string): ArticleId {
  const value = requireExactSourceValue(legacyPostId, "legacyPostId");
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ServiceError({
      code: "invalid_argument",
      message: "legacyPostId must be a canonical positive decimal string.",
    });
  }
  return articleId(`pastorwood:${value}`);
}

/** CMS-only articles use the immutable Strapi document ID, never a slug. */
export function cmsArticleId(documentId: string): ArticleId {
  return articleId(`cms:${requireExactSourceValue(documentId, "documentId")}`);
}

/**
 * PostgreSQL custom IDs are primary keys only within their source tables.
 * A short source prefix prevents silent cross-table collisions while retaining
 * the complete source custom ID in the destination value.
 */
export function migrationVectorId(
  sourceTable: VectorSourceTable,
  sourceCustomId: string,
): VectorId {
  const sourceId = requireExactSourceValue(sourceCustomId, "sourceCustomId");
  const value = `${VECTOR_SOURCE_PREFIX[sourceTable]}${sourceId}`;
  if (utf8.encode(value).byteLength > 64) {
    throw new ServiceError({
      code: "invalid_argument",
      message: "The prefixed vector ID exceeds the Vectorize 64-byte limit.",
    });
  }
  return vectorId(value);
}

export type MigrationMode = "full" | "incremental" | "delta" | "verify";
export type MigrationStage =
  | "preflight"
  | "export"
  | "import"
  | "verify"
  | "complete";
export type MigrationDecision = "pass" | "fail" | "blocked" | "not-authorized";
export type MigrationCheckStatus = "pass" | "fail" | "skip";
export type MigrationDomain = "d1" | "r2" | "vectorize" | "cross-domain";

export type MigrationDomainFingerprintMap = Readonly<{
  readonly d1?: ContentHash;
  readonly r2?: ContentHash;
  readonly vectorize?: ContentHash;
}>;

export type MigrationJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly MigrationJsonValue[]
  | { readonly [key: string]: MigrationJsonValue };

export type MigrationPolicyDescriptor = Readonly<Record<string, MigrationJsonValue>>;

export interface MigrationPolicy {
  readonly descriptor: MigrationPolicyDescriptor;
  readonly fingerprint: ContentHash;
}

export interface MigrationToolIdentity {
  readonly name: string;
  readonly version: string;
  readonly commit: string;
}

export interface MigrationSourceSnapshot {
  readonly kind: "postgresql" | "minio" | "pgvector" | "composite";
  readonly capturedAt: IsoDateTime;
  readonly consistency: {
    readonly mode: "transaction" | "statement-per-table" | "frozen-listing-plus-delta";
    readonly cutoffAt: IsoDateTime;
    readonly deltaRequired: boolean;
  };
  /** Sanitized source identity metadata; it is evidence, not fingerprint input. */
  readonly identity?: MigrationJsonValue;
  readonly fingerprint: ContentHash;
}

export interface MigrationDestinationContract {
  readonly environment: "local" | "test" | "unrouted-production";
  readonly d1SchemaVersion: string;
  readonly r2BucketLogicalNames: readonly string[];
  readonly vectorizeIndexLogicalName: "aic-content-v1";
  readonly vectorizeDimensions: 1536;
  readonly vectorizeMetric: "cosine";
  readonly fingerprint?: ContentHash;
  readonly schemaFingerprint?: ContentHash;
  readonly namespace?: string | null;
  readonly metadataIndexes?: readonly (typeof VECTORIZE_METADATA_INDEXES)[number][];
}

export interface MigrationCheck {
  readonly id: string;
  readonly domain: MigrationDomain;
  readonly severity: "required" | "warning";
  readonly status: MigrationCheckStatus;
  readonly expected?: MigrationJsonValue;
  readonly observed?: MigrationJsonValue;
  readonly evidenceRef?: string;
  readonly message: string;
}

export interface MigrationFailure {
  readonly domain: MigrationDomain;
  readonly code: string;
  readonly evidenceRef?: string;
  readonly message: string;
  readonly keyDigest?: ContentHash;
}

export interface MigrationCheckpoint {
  readonly domain?: Exclude<MigrationDomain, "cross-domain">;
  readonly checkpointFingerprint?: ContentHash;
  readonly sourceFingerprint?: ContentHash;
  readonly policyFingerprint?: ContentHash;
  readonly destinationFingerprint?: ContentHash;
  readonly classificationFingerprint?: ContentHash;
  readonly schemaFingerprint?: ContentHash;
  readonly status?: "pending" | "applied" | "processed" | "failed" | "complete";
  readonly attempt?: number;
  readonly cursor?: string | null;
  readonly lastCompletedKey?: string | null;
  readonly nextChunk?: number;
  readonly failedChunks?: readonly number[];
  readonly [key: string]: MigrationJsonValue | undefined;
}

export interface MigrationDomainSummary {
  readonly laneStatus?: "active" | "not-applicable";
  readonly notApplicableReason?: string;
  readonly expected: number;
  readonly processed: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly orphaned: number;
  readonly duplicates: number;
}

export interface MigrationReport {
  readonly schema: typeof MIGRATION_REPORT_SCHEMA;
  readonly contractVersion: typeof MIGRATION_CONTRACT_VERSION;
  readonly manifestId: string;
  readonly runId: string;
  readonly mode: MigrationMode;
  readonly stage: MigrationStage;
  readonly createdAt: IsoDateTime;
  readonly tool: MigrationToolIdentity;
  readonly sourceSnapshot: MigrationSourceSnapshot;
  readonly destination: MigrationDestinationContract;
  readonly policy: MigrationPolicy;
  /** Compatibility aliases are accepted only while lanes converge on policy. */
  readonly policyFingerprint?: ContentHash;
  readonly policyDescriptor?: MigrationPolicyDescriptor;
  readonly destinationFingerprint?: ContentHash;
  readonly classificationFingerprint?: ContentHash;
  readonly schemaFingerprint?: ContentHash;
  readonly checkpointFingerprint?: ContentHash;
  readonly failures?: readonly MigrationFailure[];
  readonly checkpoints?: readonly MigrationCheckpoint[];
  readonly inventory?: MigrationJsonValue;
  readonly blockedReason?: string;
  readonly domains: Readonly<{
    d1: MigrationDomainSummary;
    r2: MigrationDomainSummary;
    vectorize: MigrationDomainSummary;
  }>;
  readonly checks: readonly MigrationCheck[];
  readonly decision: MigrationDecision;
}

/**
 * Reserved Gate G2 evidence payload. Phase 3 never treats this plain object as
 * authorization; a later gate-time integration must authenticate its issuer.
 */
export interface MigrationGateG2Proof {
  readonly gate: "G2";
  readonly accepted: true;
  readonly trusted: true;
  /** Optional legacy evidence alias; it is not a trust root. */
  readonly coordinator?: string;
  readonly issuer: string;
  readonly approver: string;
  readonly manifestId: string;
  readonly runId: string;
  readonly sourceFingerprint: ContentHash;
  readonly destinationFingerprint: ContentHash;
  readonly policyFingerprint: ContentHash;
  readonly classificationFingerprint: ContentHash;
  readonly contextFingerprint: ContentHash;
  readonly evidenceRef: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/** Out-of-band values used to bind a report; this object never authorizes G2. */
export interface MigrationTrustedExpectations {
  readonly sourceFingerprint?: ContentHash;
  readonly sources?: MigrationDomainFingerprintMap;
  readonly policyFingerprint?: ContentHash;
  readonly policyDescriptor?: MigrationPolicyDescriptor;
  readonly policies?: MigrationDomainFingerprintMap;
  readonly policyDescriptors?: Readonly<Record<Exclude<MigrationDomain, "cross-domain">, MigrationPolicyDescriptor>>;
  readonly destinationFingerprint?: ContentHash;
  readonly destinations?: MigrationDomainFingerprintMap;
  readonly destinationEnvironment?: MigrationDestinationContract["environment"];
  readonly classificationFingerprint?: ContentHash;
  readonly classifications?: MigrationDomainFingerprintMap;
  readonly classificationTables?: readonly string[];
  readonly requireFullClassificationInventory?: boolean;
  readonly checkpointFingerprint?: ContentHash;
  readonly checkpoints?: MigrationDomainFingerprintMap;
  readonly schemaFingerprint?: ContentHash;
  readonly schemas?: MigrationDomainFingerprintMap;
  readonly metadataIndexes?: readonly (typeof VECTORIZE_METADATA_INDEXES)[number][];
  readonly metadataIndexEvidence?: MigrationJsonValue;
  readonly manifestId?: string;
}

export interface MigrationArtifactEntry {
  readonly domain: Exclude<MigrationDomain, "cross-domain">;
  readonly [key: string]: MigrationJsonValue | undefined;
}

export interface VectorManifestRecord {
  readonly sourceTable: VectorSourceTable;
  readonly sourceCustomId: string;
  readonly vectorId: VectorId;
  readonly sourceType: SearchDocumentSourceType;
  readonly sourceId: EpisodeId | ArticleId;
  readonly contentSubtype: string;
  readonly contentHash: ContentHash;
  readonly chunkIndex: number | null;
  readonly publishedDay: number | null;
  readonly embeddingModel: string;
  readonly dimensions: 1536;
  readonly vectorDigest: ContentHash;
  readonly metadataDigest: ContentHash;
  readonly d1Reference?: string;
  readonly mutationProcessed?: boolean;
  readonly status?: "pending" | "processed" | "verified" | "failed";
}

export interface ObjectManifestRecord {
  readonly sourceProvider: "minio" | "filesystem" | "strapi";
  readonly sourceBucket: string;
  readonly sourceKey: string;
  readonly sourceVersionId?: string;
  /** Provider audit value only; multipart ETags are not content checksums. */
  readonly sourceEtag?: string;
  readonly sourceLastModified: IsoDateTime;
  readonly destinationBucket: "aic-podcast-audio" | "aic-assets";
  readonly destinationKey: ObjectKey;
  readonly sizeBytes: number;
  readonly sourceBytes: number;
  readonly destinationBytes: number;
  readonly contentType: string;
  readonly sha256: ContentHash;
  readonly sourceSha256?: ContentHash;
  readonly destinationSha256?: ContentHash;
  readonly verification?: Readonly<{
    readonly head: MigrationJsonValue;
    readonly fullRead: MigrationJsonValue;
    readonly range: MigrationJsonValue;
    readonly playback: MigrationJsonValue;
  }>;
  readonly status: "pending" | "copied" | "verified" | "failed" | "conflict";
}
