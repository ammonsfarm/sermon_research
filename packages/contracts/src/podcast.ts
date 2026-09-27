import { ServiceError } from "./errors.ts";
import type { EpisodeId } from "./ids.ts";

export interface PodcastUrlGenerator {
  /** Public, publication-gated R2-backed audio route. */
  publicAudioUrl(id: EpisodeId): string;
  /** Authenticated internal compatibility audio route. */
  internalAudioUrl(id: EpisodeId): string;
  /** Canonical public episode page route. */
  episodePageUrl(slug: string): string;
}

function pathSegment(value: string, name: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized === "."
    || normalized === ".."
    || normalized.includes("/")
    || normalized.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new ServiceError({
      code: "invalid_argument",
      message: `${name} must be one non-empty path segment.`,
    });
  }
  return encodeURIComponent(normalized);
}

/** Frozen same-origin Phase 4 podcast routes. */
export const PODCAST_URLS: PodcastUrlGenerator = Object.freeze({
  publicAudioUrl(id: EpisodeId): string {
    return `/media/episodes/${pathSegment(id, "episodeId")}`;
  },
  internalAudioUrl(id: EpisodeId): string {
    return `/api/audio/${pathSegment(id, "episodeId")}`;
  },
  episodePageUrl(slug: string): string {
    return `/radio/${pathSegment(slug, "episode slug")}/`;
  },
});
