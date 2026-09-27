import { AudioStorageError, requireSourceUrl, type OpenAudioSource, type R2AudioWriteBucket } from "./audio-storage.ts";

// One checked-in synthetic MP3; never a caller-selected R2 key or public transport.
export const DEVELOPMENT_AUDIO = {
  sha256: "sha256:2775222bc1018554bc1160d9e0b05e47970bfb707124c34b7d976ff2655550a6",
  sizeBytes: 18225,
  durationMs: 4420,
  key: "acceptance/source/2775222bc1018554bc1160d9e0b05e47970bfb707124c34b7d976ff2655550a6.mp3",
  url: "https://aic-development.invalid/fixtures/2775222bc1018554bc1160d9e0b05e47970bfb707124c34b7d976ff2655550a6.mp3",
} as const;

export function developmentAudioSource(environment: string, bucket: R2AudioWriteBucket, soundcloud: OpenAudioSource) {
  const validateSourceUrl = (url: string): string => environment === "development" && url === DEVELOPMENT_AUDIO.url
    ? url : requireSourceUrl(url);
  const openAudioSource: OpenAudioSource = async (url) => {
    validateSourceUrl(url);
    if (url !== DEVELOPMENT_AUDIO.url) return soundcloud(url);
    const object = await bucket.get(DEVELOPMENT_AUDIO.key);
    if (!object?.body) throw new AudioStorageError("transient_dependency", "Development audio fixture is unavailable.");
    if (object.size !== DEVELOPMENT_AUDIO.sizeBytes) throw new AudioStorageError("invalid_input", "Development audio fixture size is invalid.");
    return { body: object.body, sizeBytes: DEVELOPMENT_AUDIO.sizeBytes,
      contentType: typeof object.httpMetadata?.contentType === "string" ? object.httpMetadata.contentType : "",
      expectedSha256: DEVELOPMENT_AUDIO.sha256 };
  };
  return { openAudioSource, validateSourceUrl };
}
