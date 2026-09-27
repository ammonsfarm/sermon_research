import { readFile, rm } from "node:fs/promises";

const generated = new URL("../.cloudflare-env.check.d.ts", import.meta.url);
const committed = new URL("../cloudflare-env.d.ts", import.meta.url);

try {
  const normalize = (value) => value.replace(".cloudflare-env.check.d.ts", "cloudflare-env.d.ts").replace(/[ \t]+$/gmu, "");
  if (normalize(await readFile(generated, "utf8")) !== normalize(await readFile(committed, "utf8"))) {
    throw new Error("Run npm run cf-typegen --workspace @aic/ingest and commit the result.");
  }
  console.log("cloudflare-env.d.ts matches workers/ingest/wrangler.jsonc.");
} finally {
  await rm(generated, { force: true });
}
