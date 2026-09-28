import { registerHooks } from "node:module";

// Workers-only modules don't exist in Node, so tests get small stand-ins.
const STUBS: Record<string, string> = {
  "cloudflare:workers": "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
};

// Workers' FixedLengthStream only checks the byte count, so a pass-through stream stands in for it.
(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream ??= class extends TransformStream {
  constructor(_length: number) { super(); }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: STUBS[url.slice(5)]!, shortCircuit: true };
    return nextLoad(url, context);
  },
});
