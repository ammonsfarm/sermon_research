import type { HealthVersionReport } from "@aic/contracts";

export interface HealthVersionInput {
  readonly status?: HealthVersionReport["status"];
  readonly version: string;
  readonly commit: string;
  readonly environment: string;
  readonly dependencies?: HealthVersionReport["dependencies"];
}

export function healthVersionReport(input: HealthVersionInput): HealthVersionReport {
  return {
    status: input.status ?? "ok",
    version: input.version,
    commit: input.commit,
    environment: input.environment,
    ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
  };
}

export function healthVersionResponse(input: HealthVersionInput): Response {
  const report = healthVersionReport(input);
  return new Response(JSON.stringify(report), {
    status: report.status === "ok" ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Public metadata only; readiness proves D1 access, never returns row data. */
export async function operationalResponse(request: Request, env: object): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path !== "/healthz" && path !== "/version") return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  }
  const metadata = Reflect.get(env, "CF_VERSION_METADATA") as { id?: unknown } | undefined;
  const commit = Reflect.get(env, "AIC_RELEASE_COMMIT");
  const environment = Reflect.get(env, "AIC_ENVIRONMENT");
  let ready = typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit);
  if (path === "/healthz") {
    try {
      const db = Reflect.get(env, "AIC_DB") as { prepare(sql: string): { first(): Promise<unknown> } };
      const result = await db.prepare("SELECT 1 AS ok").first() as { ok?: unknown } | null;
      ready = ready && result?.ok === 1;
    } catch { ready = false; }
  }
  const response = healthVersionResponse({
    status: ready ? "ok" : "degraded",
    version: typeof metadata?.id === "string" ? metadata.id : "local",
    commit: typeof commit === "string" && /^[0-9a-f]{40}$/u.test(commit) ? commit : "unrecorded",
    environment: environment === "production" ? "production" : "development",
  });
  return request.method === "HEAD" ? new Response(null, response) : response;
}
