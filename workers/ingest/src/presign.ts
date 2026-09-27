import { AwsClient } from "aws4fetch";
import {
  AUDIO_BUCKET,
  PRESIGN_EXPIRY_SECONDS,
  validateAudioDescriptor,
  type MintAudioUrl,
} from "./audio-transport.ts";

function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("R2 audio S3 endpoint is invalid.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || !/^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/u.test(url.hostname)
  ) throw new TypeError("R2 audio S3 endpoint is invalid.");
  return url;
}

/** Creates a GET-only R2 S3 presigner; returned bearer URLs stay inside a transcription attempt. */
export function createR2AudioPresigner(options: {
  readonly endpoint: string;
  readonly bucketName?: "aic-podcast-audio" | "aic-podcast-audio-dev";
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): MintAudioUrl {
  const base = endpoint(options.endpoint);
  const bucketName = options.bucketName ?? AUDIO_BUCKET;
  if (bucketName !== AUDIO_BUCKET && bucketName !== "aic-podcast-audio-dev") {
    throw new TypeError("R2 audio presign bucket is invalid.");
  }
  if (!options.accessKeyId || !options.secretAccessKey) throw new TypeError("R2 audio presign credential is missing.");
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  return async ({ descriptor, expiresInSeconds, attempt }) => {
    validateAudioDescriptor(descriptor);
    if (expiresInSeconds !== PRESIGN_EXPIRY_SECONDS) throw new TypeError("R2 audio presign expiry is invalid.");
    const path = [bucketName, ...descriptor.key.split("/")].map(encodeURIComponent).join("/");
    const target = new URL(path, base);
    target.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    target.searchParams.set("aic-attempt", `${attempt}-${crypto.randomUUID()}`);
    const signed = await client.sign(new Request(target, { method: "GET" }), { aws: { signQuery: true } });
    const result = new URL(signed.url);
    if (result.origin !== base.origin || result.pathname !== target.pathname || !result.searchParams.has("X-Amz-Signature")) {
      throw new TypeError("R2 audio presigning returned an invalid URL.");
    }
    return result.toString();
  };
}
