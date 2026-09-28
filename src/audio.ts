import type { Context } from "./context.ts";
import { sign, timingSafeEqual } from "./crypto.ts";
import type { AppEnv } from "./env.ts";
import { ProviderError, withUserAgent } from "./providers.ts";

/** Sermon MP3s are usually 20 to 80 MB; this stops a runaway download. */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
/** Without a Content-Length the file has to be buffered, and Workers have 128 MB of memory. */
const MAX_UNSIZED_BYTES = 100 * 1024 * 1024;
/** How long a link handed to the transcription service stays valid. */
const SIGNED_LINK_SECONDS = 2 * 3_600;

const TYPES: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg" };

function extension(audioUrl: string, contentType: string | null): string {
  const fromPath = /\.([a-z0-9]{2,4})$/iu.exec(new URL(audioUrl).pathname)?.[1]?.toLowerCase();
  if (fromPath && fromPath in TYPES) return fromPath;
  const fromType = Object.entries(TYPES).find(([, type]) => contentType?.startsWith(type))?.[0];
  return fromType ?? "mp3";
}

export function formatBytes(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Copies an episode's audio from the feed into R2 and returns its key and size.
 * The Worker fetches it itself because church sites often block services like
 * Mistral with bot checks that the Worker gets past.
 */
export async function downloadAudio(env: AppEnv, episodeId: string, audioUrl: string): Promise<{ key: string; bytes: number }> {
  let response: Response;
  try {
    response = await fetch(audioUrl, { headers: withUserAgent({ Accept: "audio/*, */*" }), redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new ProviderError("The audio file didn't download. Check that the feed's audio link plays in a browser.");
  }
  if (!response.ok) throw new ProviderError(`The church's website returned HTTP ${response.status} for the audio file.`);
  const type = response.headers.get("Content-Type");
  if (type?.startsWith("text/html")) {
    throw new ProviderError("The church's website sent a web page instead of the audio file, probably a bot check. Ask whoever runs the site to allow downloads of its podcast files.");
  }
  const length = Number(response.headers.get("Content-Length") ?? 0);
  if (length > MAX_AUDIO_BYTES) throw new ProviderError(`The audio file is ${formatBytes(length)}, over the ${formatBytes(MAX_AUDIO_BYTES)} limit.`);
  const key = `episodes/${episodeId}.${extension(audioUrl, type)}`;
  const metadata = { httpMetadata: { contentType: type && !type.startsWith("application/octet-stream") ? type : TYPES[extension(audioUrl, type)]! } };
  if (length > 0 && response.body) {
    // Stream straight into R2 so a long recording never sits in memory.
    const { readable, writable } = new FixedLengthStream(length);
    const [, object] = await Promise.all([response.body.pipeTo(writable), env.AUDIO.put(key, readable, metadata)]);
    return { key, bytes: object?.size ?? length };
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_UNSIZED_BYTES) throw new ProviderError(`The audio file is ${formatBytes(buffer.byteLength)}; without a size from the website only files up to ${formatBytes(MAX_UNSIZED_BYTES)} can be copied.`);
  if (buffer.byteLength === 0) throw new ProviderError("The church's website sent an empty audio file.");
  await env.AUDIO.put(key, buffer, metadata);
  return { key, bytes: buffer.byteLength };
}

/** A link to the stored audio that works without signing in, until it expires. */
export async function signedAudioUrl(appSecret: string, origin: string, episodeId: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SIGNED_LINK_SECONDS;
  const signature = await sign(appSecret, `audio:${episodeId}:${expires}`);
  return `${origin}/audio/${episodeId}?expires=${expires}&signature=${signature}`;
}

async function validSignature(context: Context, episodeId: string): Promise<boolean> {
  const expires = Number(context.url.searchParams.get("expires"));
  const signature = context.url.searchParams.get("signature") ?? "";
  const secret = context.env.APP_SECRET ?? "";
  if (!signature || !secret || !Number.isInteger(expires) || expires * 1000 < Date.now()) return false;
  return timingSafeEqual(signature, await sign(secret, `audio:${episodeId}:${expires}`));
}

/**
 * GET /audio/:id streams the stored copy, with byte ranges so players can seek.
 * Allowed with a valid signed link, or for anyone who may view the research pages.
 */
export async function serveAudio(context: Context, episodeId: string, mayView: () => Promise<boolean>): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await validSignature(context, episodeId)) && !(await mayView())) return notFound();
  const row = await context.db.prepare("SELECT audio_key FROM episodes WHERE id = ?").bind(episodeId).first<{ audio_key: string | null }>();
  if (!row?.audio_key) return notFound();
  const object = await context.env.AUDIO.get(row.audio_key, { range: context.request.headers });
  if (!object) return notFound();
  const headers = new Headers({ "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
  object.writeHttpMetadata(headers);
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && context.request.headers.has("Range")) {
    const offset = range.offset ?? (range.suffix !== undefined ? object.size - range.suffix : 0);
    const length = range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
