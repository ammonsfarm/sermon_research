import { operationalResponse } from "@aic/observability";
import { createRuntimeRagWorker, type RagRuntimeBindings } from "./runtime.ts";

const worker = {
  async fetch(request: Request, env: RagRuntimeBindings): Promise<Response> {
    const health = await operationalResponse(request, env);
    if (health) return health;
    return createRuntimeRagWorker(request, env).fetch(request);
  },
};

export default worker;
