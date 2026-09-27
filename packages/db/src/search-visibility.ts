import { ServiceError, type UserId } from "@aic/contracts";

export type SearchCorpusAccess =
  | { readonly kind: "authenticated-corpus"; readonly userId: UserId }
  | { readonly kind: "public-published" };

export type SearchVisibilityLane = "vector" | "research";

const SOURCE_ALIAS = { vector: "v", research: "r" } as const;

/**
 * Returns the common P5/P6 serving predicate for code-owned reader aliases.
 * Callers may choose only a fixed lane; no SQL identifier comes from input.
 */
export function searchVisibilityPredicate(lane: SearchVisibilityLane): string {
  const source = SOURCE_ALIAS[lane];
  const entityType = lane === "vector"
    ? `CASE WHEN ${source}.source_type = 'article' THEN 'article' ELSE 'episode' END`
    : `${source}.entity_type`;
  const entityId = lane === "vector" ? `${source}.source_id` : `${source}.entity_id`;
  const ledgerVisible = lane === "vector"
    ? ` AND (${source}.processing_revision_hash IS NULL OR ${source}.processing_visibility_state = 'visible')`
    : "";

  return `
    NOT EXISTS (
      SELECT 1 FROM processing_heads denied_head
       WHERE denied_head.aggregate_type = ${entityType}
         AND denied_head.aggregate_id = ${entityId}
         AND denied_head.authenticated_corpus_visibility IN ('hidden', 'erased')
    )
    AND (
      (${source}.processing_revision_hash IS NULL AND (
        NOT EXISTS (
          SELECT 1 FROM processing_heads historical_head
           WHERE historical_head.aggregate_type = ${entityType}
             AND historical_head.aggregate_id = ${entityId}
        )
        OR EXISTS (
          SELECT 1 FROM processing_heads inherited_head
           WHERE inherited_head.aggregate_type = ${entityType}
             AND inherited_head.aggregate_id = ${entityId}
             AND inherited_head.authenticated_corpus_visibility = 'inherited'
        )
      ))
      OR (${source}.processing_revision_hash IS NOT NULL AND EXISTS (
        SELECT 1 FROM processing_heads visible_head
         WHERE visible_head.aggregate_type = ${entityType}
           AND visible_head.aggregate_id = ${entityId}
           AND visible_head.authenticated_corpus_visibility = 'visible'
           AND visible_head.authenticated_corpus_revision_hash = ${source}.processing_revision_hash
      ))
    )${ledgerVisible}`;
}

/** Head-level policy for the fixed canonical episodes alias `e`. */
export function canonicalEpisodeVisibilityPredicate(): string {
  return `COALESCE((
    SELECT canonical_head.authenticated_corpus_visibility
      FROM processing_heads canonical_head
     WHERE canonical_head.aggregate_type = 'episode'
       AND canonical_head.aggregate_id = e.episode_id
  ), 'inherited') IN ('inherited', 'visible')`;
}

export function assertSearchAccess(access: SearchCorpusAccess): void {
  if (!access || typeof access !== "object" || Array.isArray(access)) {
    throw new ServiceError({ code: "invalid_argument", message: "Search access policy is invalid." });
  }
  if (access.kind === "public-published" && Object.keys(access).length === 1) return;
  if (
    access.kind === "authenticated-corpus"
    && Object.keys(access).sort().join(",") === "kind,userId"
    && typeof access.userId === "string"
    && access.userId.length > 0
    && access.userId.trim() === access.userId
    && !/[\u0000-\u001F\u007F]/u.test(access.userId)
  ) return;
  throw new ServiceError({ code: "invalid_argument", message: "Search access policy is invalid." });
}
