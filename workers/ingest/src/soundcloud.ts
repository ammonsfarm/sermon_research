import { XMLParser } from "fast-xml-parser";

export const SOUNDCLOUD_SOURCE_ADAPTER = "soundcloud-rss" as const;
export const SOUNDCLOUD_DEFAULT_MAX_RESPONSE_BYTES = 2_097_152 as const;
export const SOUNDCLOUD_MAX_ITEMS_PER_READ = 100 as const;

export type SoundCloudSourceErrorCode =
  | "cursor_unavailable"
  | "fetch_failed"
  | "invalid_content_type"
  | "invalid_xml"
  | "response_too_large"
  | "unsafe_xml";

export class SoundCloudSourceError extends Error {
  readonly code: SoundCloudSourceErrorCode;

  constructor(code: SoundCloudSourceErrorCode, message: string) {
    super(message);
    this.name = "SoundCloudSourceError";
    this.code = code;
  }
}

export interface SoundCloudEpisodeSnapshot extends Readonly<Record<string, string | number | null>> {
  readonly source: typeof SOUNDCLOUD_SOURCE_ADAPTER;
  readonly episodeId: string;
  readonly title: string;
  readonly publishDate: string;
  readonly pubDateRaw: string;
  readonly soundcloudUrl: string;
  readonly enclosureUrl: string;
  readonly enclosureType: string;
  readonly enclosureLength: number | null;
  readonly duration: string;
  readonly author: string;
  readonly explicit: string;
  readonly summary: string;
  readonly subtitle: string;
  readonly description: string;
  readonly imageUrl: string;
  readonly category: string;
  readonly detail: string;
  readonly guid: string;
}

export interface SoundCloudEpisode {
  readonly episodeId: string;
  readonly snapshot: SoundCloudEpisodeSnapshot;
}

export interface SoundCloudEpisodeRecord {
  readonly kind: "episode";
  readonly sourceCursor: string;
  readonly episode: SoundCloudEpisode;
}

export type InvalidSoundCloudRecordReason =
  | "enclosure_missing"
  | "publish_date_invalid"
  | "stable_episode_identity_missing"
  | "title_missing";

export interface InvalidSoundCloudRecord {
  readonly kind: "invalid";
  readonly sourceCursor: string;
  readonly reason: InvalidSoundCloudRecordReason;
}

export type SoundCloudDiscoveryRecord = SoundCloudEpisodeRecord | InvalidSoundCloudRecord;

export interface SoundCloudDiscoveryRead {
  readonly sourceCursor: string | null;
  readonly sourceValidator: string | null;
  readonly maxItems: number;
}

export interface SoundCloudDiscoveryBatch {
  readonly records: readonly SoundCloudDiscoveryRecord[];
  readonly sourceValidator: string | null;
  readonly hasMore: boolean;
}

export interface SoundCloudSource {
  readonly sourceAdapter: typeof SOUNDCLOUD_SOURCE_ADAPTER;
  discover(input: SoundCloudDiscoveryRead): Promise<SoundCloudDiscoveryBatch>;
}

export interface CreateSoundCloudSourceOptions {
  readonly feedUrl: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly maxResponseBytes?: number;
  readonly userAgent?: string;
}

interface SourceValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

const XML_CONTENT_TYPES = new Set([
  "application/atom+xml",
  "application/rss+xml",
  "application/xml",
  "text/xml",
]);

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  isArray: (_tagName, path) => path === "rss.channel.item",
});

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function text(value: unknown): string {
  if (typeof value === "string") return normalizeText(value);
  const record = object(value);
  return typeof record?.["#text"] === "string" ? normalizeText(record["#text"]) : "";
}

function normalizeText(value: string): string {
  return value
    .replace(/[＂“”]/gu, '"')
    .replace(/[’‘]/gu, "'")
    .replace(/：/gu, ":")
    .replace(/[｜]/gu, "|")
    .replace(/[⧸／]/gu, "/")
    .replace(/\s+/gu, " ")
    .trim();
}

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Single-pass decode of the predefined XML entities and numeric references (no DTD expansion). */
function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/giu, (match, decimal, hexadecimal, named) => {
    if (named) return XML_NAMED_ENTITIES[named.toLowerCase()] ?? match;
    const codePoint = decimal ? Number(decimal) : Number.parseInt(hexadecimal, 16);
    return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

function boundedText(value: unknown, max: number): string {
  return Array.from(decodeXmlEntities(text(value))).slice(0, max).join("");
}

function splitTitle(value: string): readonly [string, string] {
  const delimiter = [":", "|"].find((candidate) => value.includes(candidate));
  if (!delimiter) return [value, ""];
  const [category = "", ...rest] = value.split(delimiter);
  return [normalizeText(category), normalizeText(rest.join(delimiter))];
}

function sourceError(code: SoundCloudSourceErrorCode, message: string): SoundCloudSourceError {
  return new SoundCloudSourceError(code, message);
}

function validateUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("SoundCloud feed URL must be an HTTPS URL without credentials or a fragment.");
  }
  return url.toString();
}

function requireMaxItems(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > SOUNDCLOUD_MAX_ITEMS_PER_READ) {
    throw new TypeError(`SoundCloud discovery maxItems must be between 1 and ${SOUNDCLOUD_MAX_ITEMS_PER_READ}.`);
  }
  return value;
}

function decodeValidators(value: string | null): SourceValidators {
  if (value === null) return { etag: null, lastModified: null };
  try {
    const parsed = object(JSON.parse(value));
    const etag = parsed?.etag;
    const lastModified = parsed?.lastModified;
    if (
      parsed
      && (etag === null || typeof etag === "string")
      && (lastModified === null || typeof lastModified === "string")
      && Object.keys(parsed).length === 2
    ) return { etag, lastModified };
  } catch {
    // Fall through to the public validation error.
  }
  throw new TypeError("SoundCloud source validator is invalid.");
}

function encodeValidators(headers: Headers): string | null {
  const etag = headers.get("etag");
  const lastModified = headers.get("last-modified");
  if (etag === null && lastModified === null) return null;
  return JSON.stringify({ etag, lastModified });
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function itemCursor(item: Readonly<Record<string, unknown>>): Promise<string> {
  const enclosure = object(item.enclosure);
  const guid = boundedText(item.guid, 1_024);
  const enclosureUrl = boundedText(enclosure?.["@_url"], 2_048);
  const trackId = extractTrackId(guid, enclosureUrl);
  const stableMaterial = trackId
    ? `track\0${trackId}`
    : ["invalid", guid, enclosureUrl, boundedText(item.pubDate, 256), boundedText(item.title, 1_024)].join("\0");
  return `sc:${await sha256(stableMaterial)}`;
}

function extractTrackId(guid: string, enclosureUrl: string): string {
  const haystack = `${guid}\n${enclosureUrl}`;
  for (const pattern of [
    /tracks\/(\d+)/u,
    /\/stream\/(\d+)-/u,
    /soundcloud:tracks:(\d+)/u,
  ]) {
    const match = pattern.exec(haystack);
    if (match?.[1]) return match[1];
  }
  return "";
}

function parsePublishDate(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

async function parseItem(item: Readonly<Record<string, unknown>>): Promise<SoundCloudDiscoveryRecord> {
  const sourceCursor = await itemCursor(item);
  const title = boundedText(item.title, 1_024);
  if (!title) return { kind: "invalid", sourceCursor, reason: "title_missing" };
  const pubDateRaw = boundedText(item.pubDate, 256);
  const publishDate = parsePublishDate(pubDateRaw);
  if (!publishDate) return { kind: "invalid", sourceCursor, reason: "publish_date_invalid" };
  const enclosure = object(item.enclosure);
  let enclosureUrl = boundedText(enclosure?.["@_url"], 2_048);
  let parsedEnclosure: URL;
  try {
    parsedEnclosure = new URL(enclosureUrl);
  } catch {
    return { kind: "invalid", sourceCursor, reason: "enclosure_missing" };
  }
  // The feed publishes Podtrac-tracked enclosures as http://dts.podtrac.com/redirect.mp3/<host>/<path>.
  // Fetch the underlying SoundCloud stream directly over https so ingest never counts as a download.
  if (parsedEnclosure.hostname.toLowerCase() === "dts.podtrac.com" && parsedEnclosure.pathname.startsWith("/redirect.mp3/")) {
    try {
      parsedEnclosure = new URL(`https://${parsedEnclosure.pathname.slice("/redirect.mp3/".length)}${parsedEnclosure.search}`);
      enclosureUrl = parsedEnclosure.toString();
    } catch {
      return { kind: "invalid", sourceCursor, reason: "enclosure_missing" };
    }
  } else if (parsedEnclosure.protocol === "http:") {
    parsedEnclosure.protocol = "https:";
    enclosureUrl = parsedEnclosure.toString();
  }
  if (parsedEnclosure.protocol !== "https:" || parsedEnclosure.username || parsedEnclosure.password || parsedEnclosure.hash) {
    return { kind: "invalid", sourceCursor, reason: "enclosure_missing" };
  }
  const guid = boundedText(item.guid, 1_024);
  const episodeId = extractTrackId(guid, enclosureUrl);
  if (!episodeId) return { kind: "invalid", sourceCursor, reason: "stable_episode_identity_missing" };
  const rawLength = boundedText(enclosure?.["@_length"], 32);
  const parsedLength = /^\d+$/u.test(rawLength) ? Number(rawLength) : Number.NaN;
  const enclosureLength = Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null;
  const [category, detail] = splitTitle(title);
  const image = object(item["itunes:image"]);
  const snapshot: SoundCloudEpisodeSnapshot = {
    source: SOUNDCLOUD_SOURCE_ADAPTER,
    episodeId,
    title,
    publishDate,
    pubDateRaw,
    soundcloudUrl: boundedText(item.link, 2_048),
    enclosureUrl,
    enclosureType: boundedText(enclosure?.["@_type"], 128),
    enclosureLength,
    duration: boundedText(item["itunes:duration"], 128),
    author: boundedText(item["itunes:author"], 512),
    explicit: boundedText(item["itunes:explicit"], 64),
    summary: boundedText(item["itunes:summary"], 8_192),
    subtitle: boundedText(item["itunes:subtitle"], 2_048),
    description: boundedText(item.description, 16_384),
    imageUrl: boundedText(image?.["@_href"], 2_048),
    category,
    detail,
    guid,
  };
  return { kind: "episode", sourceCursor, episode: { episodeId, snapshot } };
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw sourceError("response_too_large", "SoundCloud RSS response exceeds the configured byte bound.");
  }
  if (!response.body) throw sourceError("invalid_xml", "SoundCloud RSS response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw sourceError("response_too_large", "SoundCloud RSS response exceeds the configured byte bound.");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw sourceError("invalid_xml", "SoundCloud RSS response is not valid UTF-8.");
  }
}

function rssItems(parsed: unknown): readonly Readonly<Record<string, unknown>>[] {
  const root = object(parsed);
  const rss = object(root?.rss);
  const channel = object(rss?.channel);
  const raw = channel?.item;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  const items = values.map(object);
  if (!root || !rss || !channel || items.some((item) => item === null)) {
    throw sourceError("invalid_xml", "SoundCloud RSS response is missing a valid channel or item list.");
  }
  return items as readonly Readonly<Record<string, unknown>>[];
}

export function createSoundCloudSource(options: CreateSoundCloudSourceOptions): SoundCloudSource {
  const feedUrl = validateUrl(options.feedUrl);
  const maxResponseBytes = options.maxResponseBytes ?? SOUNDCLOUD_DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 5_242_880) {
    throw new TypeError("SoundCloud RSS byte bound must be between 1 and 5242880 bytes.");
  }
  const userAgent = options.userAgent ?? "aic-cloudflare-discovery/1.0";

  return {
    sourceAdapter: SOUNDCLOUD_SOURCE_ADAPTER,
    async discover(input) {
      const maxItems = requireMaxItems(input.maxItems);
      const validators = decodeValidators(input.sourceValidator);
      const headers = new Headers({
        accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "user-agent": userAgent,
      });
      if (validators.etag !== null) headers.set("if-none-match", validators.etag);
      if (validators.lastModified !== null) headers.set("if-modified-since", validators.lastModified);
      let response: Response;
      try {
        response = await options.fetch(new Request(feedUrl, { headers }));
      } catch {
        throw sourceError("fetch_failed", "SoundCloud RSS fetch failed.");
      }
      if (response.status === 304) {
        return { records: [], sourceValidator: input.sourceValidator, hasMore: false };
      }
      if (response.status !== 200) throw sourceError("fetch_failed", "SoundCloud RSS returned an unsuccessful status.");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (!XML_CONTENT_TYPES.has(contentType)) {
        throw sourceError("invalid_content_type", "SoundCloud RSS returned a non-XML content type.");
      }
      const xml = await readBoundedBody(response, maxResponseBytes);
      if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
        throw sourceError("unsafe_xml", "SoundCloud RSS contains a forbidden DTD or entity declaration.");
      }
      let parsed: unknown;
      try {
        parsed = XML_PARSER.parse(xml);
      } catch {
        throw sourceError("invalid_xml", "SoundCloud RSS could not be parsed.");
      }
      const records = await Promise.all(rssItems(parsed).map(parseItem));
      let candidates: readonly SoundCloudDiscoveryRecord[];
      let hasMore = false;
      if (input.sourceCursor === null) {
        candidates = records.slice(0, maxItems).reverse();
      } else {
        const cursorIndex = records.findIndex((record) => record.sourceCursor === input.sourceCursor);
        if (cursorIndex < 0) throw sourceError("cursor_unavailable", "The prior SoundCloud RSS cursor is outside the retained feed window.");
        const newer = records.slice(0, cursorIndex);
        hasMore = newer.length > maxItems;
        candidates = newer.slice(-maxItems).reverse();
      }
      return {
        records: candidates,
        sourceValidator: encodeValidators(response.headers),
        hasMore,
      };
    },
  };
}
