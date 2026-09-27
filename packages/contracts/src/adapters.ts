export type AdapterRuntime =
  | "node-host"
  | "external-service"
  | "cloudflare-workers";

export interface AdapterDescriptor {
  readonly id: string;
  readonly stage: "current" | "target";
  readonly runtime: AdapterRuntime;
  readonly implements: readonly string[];
  readonly forbiddenInWebsiteImports: readonly string[];
  readonly notes: string;
}

/**
 * Names implementation slots without importing any provider SDK or binding
 * type. Adapter packages implement @aic/contracts; website modules consume only
 * these interfaces.
 */
export const ADAPTER_IMPLEMENTATIONS = {
  relational: {
    current: {
      id: "postgresql-relational-repositories",
      stage: "current",
      runtime: "node-host",
      implements: ["RelationalRepositories"],
      forbiddenInWebsiteImports: ["pg", "postgresql SQL", "database credentials"],
      notes: "Transitional adapter over the canonical PostgreSQL public schema.",
    },
    target: {
      id: "d1-relational-repositories",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["RelationalRepositories"],
      forbiddenInWebsiteImports: ["D1Database", "D1PreparedStatement", "SQL"],
      notes: "D1 bindings and SQLite semantics remain inside packages/db.",
    },
  },
  editorial: {
    current: {
      id: "strapi-editorial-repository",
      stage: "current",
      runtime: "external-service",
      implements: ["EditorialRepository", "PublicContentRepository"],
      forbiddenInWebsiteImports: ["Strapi tokens", "Strapi response shapes"],
      notes: "Preserves Strapi lifecycle plus PostgreSQL projection/fallback behavior.",
    },
    target: {
      id: "d1-r2-workflow-editorial-repository",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["EditorialRepository", "PublicContentRepository"],
      forbiddenInWebsiteImports: ["D1Database", "R2Bucket", "Workflow bindings"],
      notes: "Future replacement; schema and lifecycle detail are frozen in later phases.",
    },
  },
  objectStorage: {
    current: {
      id: "minio-object-storage",
      stage: "current",
      runtime: "node-host",
      implements: ["ObjectReader", "AudioObjectReader", "ObjectWriter"],
      forbiddenInWebsiteImports: ["node:child_process", "mc", "MinIO credentials"],
      notes: "Translates MinIO metadata/streams into portable range outcomes.",
    },
    target: {
      id: "r2-object-storage",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["ObjectStorage"],
      forbiddenInWebsiteImports: ["R2Bucket", "R2Object", "S3 credentials"],
      notes: "Uses an R2 binding for reads and short-lived direct-upload authorization.",
    },
  },
  semanticSearch: {
    current: {
      id: "pgvector-semantic-search",
      stage: "current",
      runtime: "node-host",
      implements: ["SemanticSearch"],
      forbiddenInWebsiteImports: ["pgvector operators", "PostgreSQL FTS"],
      notes: "Preserves current custom_id values and 1,536-dimensional vectors.",
    },
    target: {
      id: "vectorize-semantic-search",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["SemanticSearch"],
      forbiddenInWebsiteImports: ["VectorizeIndex", "Vectorize metadata schema"],
      notes: "Returns stable IDs and bounded routing metadata; D1 hydrates source text.",
    },
  },
  auth: {
    current: {
      id: "clerk-postgresql-auth",
      stage: "current",
      runtime: "node-host",
      implements: ["AuthServices", "UserAccessRepository"],
      forbiddenInWebsiteImports: ["Clerk secrets", "PostgreSQL role SQL"],
      notes: "Node Proxy admission is not a deployable Worker authorization boundary.",
    },
    target: {
      id: "clerk-workers-auth",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["AuthServices", "UserAccessRepository"],
      forbiddenInWebsiteImports: ["Clerk secrets", "D1Database"],
      notes: "Uses supported request admission plus mandatory handler/action RBAC.",
    },
  },
  ai: {
    current: {
      id: "node-external-ai-providers",
      stage: "current",
      runtime: "node-host",
      implements: ["AiProviders"],
      forbiddenInWebsiteImports: ["provider API keys", "provider response shapes"],
      notes: "Silo generation, Mistral transcription, and OpenAI embeddings.",
    },
    target: {
      id: "workers-external-ai-providers",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["AiProviders"],
      forbiddenInWebsiteImports: ["provider API keys", "provider response shapes"],
      notes: "Workers fetch adapters retain Silo/Mistral/OpenAI unless a later ADR changes providers.",
    },
  },
  background: {
    current: {
      id: "systemd-postgresql-job-dispatcher",
      stage: "current",
      runtime: "node-host",
      implements: ["BackgroundJobDispatcher"],
      forbiddenInWebsiteImports: ["systemd", "subprocesses", "host paths"],
      notes: "Bounded bridge to current durable queues/workers only.",
    },
    target: {
      id: "cloudflare-workflow-dispatcher",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["BackgroundJobDispatcher"],
      forbiddenInWebsiteImports: ["Workflow bindings", "Queue bindings"],
      notes: "Workflows own durable dependent work; Queues are optional buffering.",
    },
  },
  observability: {
    current: {
      id: "node-structured-observability",
      stage: "current",
      runtime: "node-host",
      implements: ["ObservabilityServices"],
      forbiddenInWebsiteImports: ["console formatting", "request payload logs"],
      notes: "Normalizes current logs before transport.",
    },
    target: {
      id: "workers-structured-observability",
      stage: "target",
      runtime: "cloudflare-workers",
      implements: ["ObservabilityServices"],
      forbiddenInWebsiteImports: ["Workers tracing/log transport APIs"],
      notes: "Structured Worker logs and traces carry the same correlation identifiers.",
    },
  },
} as const satisfies Readonly<
  Record<string, { readonly current: AdapterDescriptor; readonly target: AdapterDescriptor }>
>;
