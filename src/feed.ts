/** A podcast episode as listed in the RSS feed. */
export interface FeedEpisode {
  readonly guid: string;
  readonly title: string;
  readonly publishedAt: string | null;
  readonly audioUrl: string | null;
  readonly durationSeconds: number | null;
}

export interface Feed {
  readonly title: string;
  readonly episodes: readonly FeedEpisode[];
}

const MAX_FEED_BYTES = 20 * 1024 * 1024;

export class FeedError extends Error {}

/** Fetches and parses a podcast RSS feed. Throws FeedError with a message meant for people. */
export async function fetchFeed(feedUrl: string, fetcher: typeof fetch = fetch): Promise<Feed> {
  let url: URL;
  try {
    url = new URL(feedUrl);
  } catch {
    throw new FeedError("That isn't a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FeedError("Use an http:// or https:// address.");
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
  } catch {
    throw new FeedError("The feed didn't respond. Check the address and try again.");
  }
  if (!response.ok) throw new FeedError(`The feed returned HTTP ${response.status}.`);
  const length = Number(response.headers.get("Content-Length") ?? 0);
  if (length > MAX_FEED_BYTES) throw new FeedError("The feed is larger than 20 MB.");
  const text = await response.text();
  if (text.length > MAX_FEED_BYTES) throw new FeedError("The feed is larger than 20 MB.");
  return parseFeed(text);
}

export function parseFeed(xml: string): Feed {
  const channel = /<channel\b[^>]*>([\s\S]*)<\/channel>/iu.exec(xml)?.[1];
  if (!channel) throw new FeedError("That address isn't an RSS podcast feed.");
  const items = [...channel.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/giu)].map((match) => match[1] ?? "");
  const header = channel.split(/<item\b/iu)[0] ?? "";
  const episodes = items.map(parseItem).filter((episode): episode is FeedEpisode => episode !== null);
  return { title: tagText(header, "title") || "Untitled podcast", episodes };
}

function parseItem(item: string): FeedEpisode | null {
  const enclosure = /<enclosure\b([^>]*)>/iu.exec(item)?.[1] ?? "";
  const audioUrl = attribute(enclosure, "url");
  const guid = tagText(item, "guid") || audioUrl || tagText(item, "link");
  if (!guid) return null;
  const pubDate = tagText(item, "pubDate");
  const parsed = pubDate ? Date.parse(pubDate) : Number.NaN;
  return {
    guid,
    title: tagText(item, "title") || "Untitled episode",
    publishedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
    audioUrl: audioUrl || null,
    durationSeconds: parseDuration(tagText(item, "itunes:duration")),
  };
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "iu").exec(xml);
  return match ? decodeText(match[1] ?? "") : "";
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "iu").exec(attributes);
  return decodeEntities((match?.[2] ?? match?.[3] ?? "").trim());
}

function decodeText(value: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/u.exec(value);
  return (cdata ? cdata[1] ?? "" : decodeEntities(value)).trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[lower] ?? "";
  });
}

/** Accepts `3600`, `59:30` or `1:02:03`. */
export function parseDuration(value: string): number | null {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}
