import { readFileSync, rmSync } from "node:fs";

const expected = new URL("../cloudflare-env.d.ts", import.meta.url);
const generated = new URL("../.cloudflare-env.check.d.ts", import.meta.url);

try {
  const normalize = (value) => value
    .replace(".cloudflare-env.check.d.ts", "cloudflare-env.d.ts")
    .replace(/[ \t]+$/gmu, "");
  const normalized = normalize(readFileSync(generated, "utf8"));
  if (normalize(readFileSync(expected, "utf8")) !== normalized) {
    throw new Error("cloudflare-env.d.ts is stale; run npm run cf-typegen --workspace @aic/rag");
  }
  console.log("cloudflare-env.d.ts matches workers/rag/wrangler.jsonc.");
} finally {
  rmSync(generated, { force: true });
}
