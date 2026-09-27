import { createCompleteIndexingManifest, type CompleteIndexingManifest, type IndexingChunk } from "./chunks.ts";

/** Build the complete, sorted vector target before any embedding or mutation work begins. */
export async function createIndexingManifest(chunks: readonly IndexingChunk[]): Promise<CompleteIndexingManifest> {
  return createCompleteIndexingManifest(chunks);
}

export type { CompleteIndexingManifest, FrozenVectorizeMetadata, IndexingChunk } from "./chunks.ts";
