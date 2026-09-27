import type {
  AudioObjectReader,
  EpisodeId,
  ObjectMetadata,
  ObjectReadResult,
  RequestOperationContext,
} from "@aic/contracts";
import {
  R2AudioObjectReader,
  type R2BucketBinding,
  type R2ObjectBinding,
} from "../src/index.ts";

declare const bucket: R2BucketBinding;
declare const context: RequestOperationContext;
declare const episode: EpisodeId;

const reader: AudioObjectReader = new R2AudioObjectReader(bucket);
const result: Promise<ObjectReadResult> = reader.readAudio(context, episode);
const head: Promise<ObjectMetadata | null> = reader.headAudio(context, episode);
void result;
void head;

if (false) {
  // Structural provider objects are accepted without importing Cloudflare's
  // ambient worker types, while provider methods never appear in the contract.
  const object: R2ObjectBinding = {
    key: "podcasts/example.mp3",
    size: 1,
    httpMetadata: { contentType: "audio/mpeg" },
  };
  void object;

  // @ts-expect-error provider-only methods do not escape as ObjectMetadata
  const leaked: ObjectMetadata = object;
  void leaked;
}
