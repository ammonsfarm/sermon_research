import assert from "node:assert/strict";
import test from "node:test";
import { createR2AudioPresigner } from "../src/presign.ts";

test("Development presigns only its isolated physical bucket with per-attempt GET URLs", async () => {
  const mint = createR2AudioPresigner({ endpoint: `https://${"1".repeat(32)}.r2.cloudflarestorage.com/`, bucketName: "aic-podcast-audio-dev", accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" });
  const descriptor = { episodeId: "42", bucket: "aic-podcast-audio", key: "podcasts/42.mp3", sizeBytes: 32, sha256: `sha256:${"a".repeat(64)}`, contentType: "audio/mpeg", durationMs: 1000 };
  const first = new URL(await mint({ descriptor, expiresInSeconds: 300, attempt: 1 }));
  const second = new URL(await mint({ descriptor, expiresInSeconds: 300, attempt: 2 }));
  assert.equal(first.pathname, "/aic-podcast-audio-dev/podcasts/42.mp3");
  assert.equal(first.searchParams.get("X-Amz-Expires"), "300");
  assert.notEqual(first.href, second.href);
  const defaultMint = createR2AudioPresigner({ endpoint: first.origin, accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" });
  const unchangedDefault = new URL(await defaultMint({ descriptor, expiresInSeconds: 300, attempt: 1 }));
  assert.equal(unchangedDefault.pathname, "/aic-podcast-audio/podcasts/42.mp3");
  await assert.rejects(mint({ descriptor, expiresInSeconds: 301, attempt: 1 }), /expiry/);
  assert.throws(() => createR2AudioPresigner({ endpoint: first.origin, bucketName: "unreviewed", accessKeyId: "x", secretAccessKey: "x" }), /bucket/);
});
