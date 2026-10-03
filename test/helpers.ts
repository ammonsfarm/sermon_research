import { readFileSync } from "node:fs";

import worker from "../src/index.ts";
import type { AppEnv } from "../src/env.ts";
import { type PipelineStep, runEpisode } from "../src/pipeline.ts";
import { resetSchemaCache } from "../src/schema.ts";
import { writeDocument } from "../src/writing.ts";
import { createTestD1 } from "./d1-sqlite.ts";

export const ORIGIN = "https://sermons.example.org";
export const SECRET = "test-secret-0123456789-abcdefghijklmnop";

export interface FakeVectors {
  readonly stored: Map<string, VectorizeVector>;
  readonly deleted: string[];
  /** The options of every query, to check filters. */
  readonly queries: unknown[];
}

export interface FakeWorkflow {
  readonly created: { id: string; params: { episodeId: string } }[];
  /** Set to make create() throw, as when Workflows is unavailable. */
  failing: boolean;
}

export interface FakeDocumentWorkflow {
  readonly created: { id: string; params: { documentId: string } }[];
  failing: boolean;
}

export interface TestApp {
  readonly env: AppEnv;
  readonly vectors: FakeVectors;
  readonly workflow: FakeWorkflow;
  /** Document runs started and not yet run by runDocuments(). */
  readonly documentRuns: FakeDocumentWorkflow;
  /** Objects in the fake AUDIO bucket, by key. */
  readonly audio: Map<string, { bytes: Uint8Array; contentType: string | undefined }>;
  request(path: string, init?: { method?: string; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> }): Promise<Response>;
}

export function createApp(overrides: Partial<AppEnv> = {}): TestApp {
  resetSchemaCache();
  const vectors: FakeVectors = { stored: new Map(), deleted: [], queries: [] };
  const workflow: FakeWorkflow = { created: [], failing: false };
  const documentRuns: FakeDocumentWorkflow = { created: [], failing: false };
  const VECTORS = {
    async upsert(items: VectorizeVector[]) {
      for (const item of items) vectors.stored.set(item.id, item);
      return { mutationId: "m" };
    },
    async query(_vector: number[], options: { topK?: number; filter?: { episodeId?: { $in?: string[] } } } = {}) {
      const allowed = options.filter?.episodeId?.$in;
      const ids = [...vectors.stored.values()].filter((item) => !allowed || allowed.includes(String(item.metadata?.episodeId))).map((item) => item.id);
      vectors.queries.push(options);
      return { count: 0, matches: ids.slice(0, options.topK ?? 5).map((id) => ({ id, score: 0.9 })) };
    },
    async deleteByIds(ids: string[]) {
      for (const id of ids) { vectors.deleted.push(id); vectors.stored.delete(id); }
      return { mutationId: "m" };
    },
  };
  const EPISODE_WORKFLOW = {
    async create(options: { id: string; params: { episodeId: string } }) {
      if (workflow.failing) throw new Error("Workflows unavailable");
      workflow.created.push(options);
      return { id: options.id };
    },
  };
  const DOCUMENT_WORKFLOW = {
    async create(options: { id: string; params: { documentId: string } }) {
      if (documentRuns.failing) throw new Error("Workflows unavailable");
      documentRuns.created.push(options);
      return { id: options.id };
    },
  };
  const audio: TestApp["audio"] = new Map();
  const AUDIO = {
    async put(key: string, value: ReadableStream | ArrayBuffer, options: { httpMetadata?: { contentType?: string } } = {}) {
      const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
      audio.set(key, { bytes, contentType: options.httpMetadata?.contentType });
      return { key, size: bytes.byteLength };
    },
    async head(key: string) {
      const stored = audio.get(key);
      return stored ? { key, size: stored.bytes.byteLength } : null;
    },
    async get(key: string, options: { range?: Headers } = {}) {
      const stored = audio.get(key);
      if (!stored) return null;
      const size = stored.bytes.byteLength;
      const match = /^bytes=(\d+)-(\d*)$/u.exec(options.range?.get("Range") ?? "");
      const range = match ? { offset: Number(match[1]), length: (match[2] ? Number(match[2]) + 1 : size) - Number(match[1]) } : undefined;
      const bytes = range ? stored.bytes.slice(range.offset, range.offset + range.length) : stored.bytes;
      return {
        key, size, range, body: new Response(bytes).body,
        writeHttpMetadata(headers: Headers) { if (stored.contentType) headers.set("Content-Type", stored.contentType); },
      };
    },
  };
  const env = { DB: createTestD1(), APP_SECRET: SECRET, VECTORS, EPISODE_WORKFLOW, DOCUMENT_WORKFLOW, AUDIO, ...overrides } as unknown as AppEnv;
  return {
    env,
    vectors,
    workflow,
    documentRuns,
    audio,
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set("Cookie", init.cookie);
      const method = init.method ?? (init.form ? "POST" : "GET");
      if (method === "POST" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
      const body = init.form ? new URLSearchParams(init.form) : undefined;
      return worker.fetch(new Request(ORIGIN + path, { method, headers, ...(body ? { body } : {}) }), env);
    },
  };
}

/** Returns `name=value` from a response's Set-Cookie, ready for a Cookie header. */
export function cookieFrom(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] ?? "";
}

export const ADMIN = { setupCode: SECRET, name: "Jane Admin", email: "Jane@Example.org", password: "correct horse battery", confirm: "correct horse battery" };
export const MINISTRY = { siteTitle: "Grace Sermons", churchName: "Grace Church", speakerNames: "Pastor Jane Doe, John Smith", description: "Sunday teaching", logoUrl: "" };

export const FEED_URL = "https://feeds.example.org/grace.rss";
export const FEED_XML = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title><![CDATA[Grace Church Sermons]]></title>
<item><title>Faith &amp; Works</title><guid isPermaLink="false">ep-2</guid><pubDate>Sun, 14 Sep 2026 15:00:00 GMT</pubDate>
<description><![CDATA[<p>Sermon from <b>John  Smith</b> on September 14, 2026</p>]]></description><itunes:author>Grace Church</itunes:author>
<enclosure url="https://cdn.example.org/ep2.mp3?a=1&amp;b=2" length="1" type="audio/mpeg"/><itunes:duration>45:30</itunes:duration></item>
<item><title>Grace Alone</title><guid>ep-1</guid><pubDate>Sun, 07 Sep 2026 15:00:00 GMT</pubDate>
<enclosure url="https://cdn.example.org/ep1.mp3" length="1" type="audio/mpeg"/><itunes:duration>2700</itunes:duration></item>
</channel></rss>`;

/** What the fake church website serves for every episode's MP3. */
export const AUDIO_BYTES = new TextEncoder().encode("ID3 fake mp3 audio bytes");
/** A real MP3, 44.1 kHz stereo: 2.5 s of tone, 0.6 s of silence, 2.4 s of tone. */
export const TONES_MP3 = new Uint8Array(readFileSync(`${import.meta.dirname}/fixtures/tones.mp3`));

/** What Mistral hears, mistakes included. The fake answers AI's cleanup turns it into "Welcome, church. Today we read Ephesians 2:8." */
export const TRANSCRIPT_SEGMENTS = [
  { text: "Welcome. church.", start: 0, end: 4.5 },
  { text: "Today we read a fusions 2:8.", start: 4.5, end: 11 },
];

/** Fixes the transcript's two mistakes and returns the segments in the same JSON, as the cleanup prompt asks. */
function cleanupReply(user: string): string {
  const items = JSON.parse(user.slice(user.indexOf("Segments:\n") + "Segments:\n".length)) as { id: number; text: string }[];
  const fixed = items.map((item) => ({ id: item.id, text: item.text.replace("Welcome. church.", "Welcome, church.").replace("a fusions", "Ephesians") }));
  return `\`\`\`json\n${JSON.stringify(fixed)}\n\`\`\``;
}
export const SUMMARY_REPLY = "```json\n{\"summary\": \"Grace is a gift.\", \"mainScripture\": \"Ephesians 2:1–10\", \"topics\": [\"grace\"], \"scriptures\": [\"Ephesians 2:8\"]}\n```";

export const DOCUMENT_REPLY = "```markdown\n# Saved by Grace\n\n**Big idea:** grace is a gift [1].\n\n## Main points\n\n1. Grace is unearned [1]\n   - Read Ephesians 2:8\n2. Faith receives it [2]\n\n<script>alert(1)</script> [evil](javascript:alert(1))\n```";

export const ANSWER_REPLY = "Salvation is by grace [1].\n\nSee also [1, 2] and <b>[9]</b>.";

/** The planner's reply for a long custom document. Sermons are numbered oldest first: 1 is Grace Alone. */
export const PLAN_REPLY = "```json\n{\"title\": \"Grace, Chapter by Chapter\", \"parts\": [{\"heading\": \"Chapter 1: Grace Alone\", \"brief\": \"Grace is a gift.\", \"sermons\": [1], \"words\": 2300}, {\"heading\": \"Chapter 2: Faith and Works\", \"brief\": \"Faith receives it.\", \"sermons\": [2, 7], \"words\": 99999}]}\n```";
/** The planner's reply for an outline or study guide: one part from both sermons. */
export const PLAN_SINGLE_REPLY = "{\"title\": \"Saved by Grace\", \"parts\": [{\"heading\": \"Outline\", \"brief\": \"\", \"sermons\": [1, 2], \"words\": 900}]}";
/** Names whoever preached each numbered episode, untidily, as models do: Faith & Works is John Smith's, the rest Jane Doe's. */
function speakerReply(episodes: string): string {
  return JSON.stringify(Object.fromEntries([...episodes.matchAll(/^(\d+)\. "([^"]*)"/gmu)].map(([, n, title]) => [n, title!.includes("Faith") ? "Rev. John  Smith" : "Pastor Jane Doe"])));
}

/** Gives each numbered sermon a main passage, except Faith & Works, which is topical. */
function mainTextReply(sermons: string): string {
  return JSON.stringify(Object.fromEntries([...sermons.matchAll(/^(\d+)\. "([^"]*)"/gmu)].map(([, n, title]) => [n, title!.includes("Faith") ? null : "Ephesians 2:8–10."])));
}

/** Each part of a long document. In a part, [1] is its sermon's summary and [2] its transcript. */
export const PART_REPLY = "## Chapter from the model\n\nThe preacher told a story about a gift [2]. Faith receives it [1, 2]. Not a source [9].\n\n### Questions\n\n1. What is grace? [1-2]";

export interface FakeCall { readonly url: string; readonly method: string; readonly authorization: string | null; readonly userAgent: string | null; readonly body: unknown }

/** A Muse request as the server would read it: each part's headers, the request JSON, and the WAV's format and samples. */
export interface MuseUpload {
  readonly requestHeaders: string;
  readonly audioHeaders: string;
  readonly request: Record<string, unknown>;
  readonly wav: { readonly riff: string; readonly format: number; readonly channels: number; readonly rate: number; readonly bits: number; readonly samples: Int16Array };
}

export async function readMuseUpload(body: Blob, contentType: string): Promise<MuseUpload> {
  const boundary = /boundary=(.+)$/u.exec(contentType)![1]!;
  const bytes = new Uint8Array(await body.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  const parts = new Map<string, { headers: string; start: number; end: number }>();
  let at = text.indexOf(`--${boundary}\r\n`);
  while (at >= 0) {
    const headersEnd = text.indexOf("\r\n\r\n", at);
    const next = text.indexOf(`\r\n--${boundary}`, headersEnd);
    const headers = text.slice(text.indexOf("\r\n", at) + 2, headersEnd);
    parts.set(/name="([^"]+)"/u.exec(headers)![1]!, { headers, start: headersEnd + 4, end: next });
    at = text.startsWith("--", next + 4 + boundary.length) ? -1 : next + 2;
  }
  const request = parts.get("request")!;
  const audio = parts.get("audio")!;
  const view = new DataView(bytes.buffer, audio.start, audio.end - audio.start);
  const samples = new Int16Array(bytes.slice(audio.start + 44, audio.end).buffer);
  return {
    requestHeaders: request.headers,
    audioHeaders: audio.headers,
    request: JSON.parse(text.slice(request.start, request.end)) as Record<string, unknown>,
    wav: { riff: text.slice(audio.start, audio.start + 4), format: view.getUint16(20, true), channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true), samples },
  };
}

/** Muse hears two turns in any part with sound, its first and second half, and nothing in silence. */
function museReply(upload: MuseUpload) {
  const ms = Math.round(upload.wav.samples.length / upload.wav.rate * 1000);
  if (upload.wav.samples.every((sample) => sample === 0)) return { sessionId: "s", transcript: "", audioDurationMs: ms, turns: [] };
  const half = Math.round(ms / 2);
  return {
    sessionId: "s", transcript: "First half. Second half.", audioDurationMs: ms,
    turns: [{ turnId: 0, startMs: 0, endMs: half, transcript: " First half. " }, { turnId: 1, startMs: half, endMs: ms, transcript: "Second half." }],
  };
}

/**
 * Replaces global fetch with fake podcast, OpenAI, Mistral and Resend endpoints.
 * `fail` maps a URL prefix to an HTTP status to return instead.
 */
export function fakeProviders(fail: Record<string, number> = {}): { calls: FakeCall[]; restore(): void } {
  const original = globalThis.fetch;
  const calls: FakeCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? JSON.parse(init.body)
      : init.body instanceof Blob && url === "https://api.meta.ai/v1/asr/transcribe" ? await readMuseUpload(init.body, headers.get("Content-Type") ?? "") : null;
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("Authorization"), userAgent: headers.get("User-Agent"), body });
    const failure = Object.entries(fail).find(([prefix]) => url.startsWith(prefix));
    if (failure) return new Response("{\"error\":\"nope\"}", { status: failure[1] });
    if (url.startsWith("https://cdn.example.org/")) return new Response(AUDIO_BYTES, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(AUDIO_BYTES.byteLength) } });
    if (url === FEED_URL) return new Response(FEED_XML, { headers: { "Content-Type": "application/rss+xml" } });
    if (url.endsWith("/chat/completions")) {
      const messages = (body as { messages?: { role: string; content: string }[] } | null)?.messages ?? [];
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      const content = system.includes("You are a transcript editor") ? cleanupReply(user)
        : system.includes("who preached each sermon") ? speakerReply(user)
        : system.includes("main Bible passage each sermon preaches from") ? mainTextReply(user)
        : system.includes("You plan documents") ? (system.includes("so plan a single part") ? PLAN_SINGLE_REPLY : PLAN_REPLY)
        : system.includes("one part of a longer document") ? PART_REPLY
          : system.includes("Markdown document") ? DOCUMENT_REPLY
            : system.includes("numbered sources") ? ANSWER_REPLY : system ? SUMMARY_REPLY : "OK";
      return Response.json({ choices: [{ message: { content } }] });
    }
    if (url === "https://api.openai.com/v1/embeddings") {
      const input = (body as { input?: unknown } | null)?.input;
      const count = Array.isArray(input) ? input.length : 1;
      return Response.json({ data: Array.from({ length: count }, (_unused, index) => ({ index, embedding: Array(1536).fill(0.01) })) });
    }
    if (url === "https://api.mistral.ai/v1/audio/transcriptions") return Response.json({ text: "full", segments: TRANSCRIPT_SEGMENTS });
    if (url === "https://api.meta.ai/v1/asr/transcribe") return Response.json(museReply(body as MuseUpload));
    if (url === "https://api.mistral.ai/v1/models") return Response.json({ data: [] });
    if (url === "https://api.resend.com/emails") return Response.json({ id: "email-1" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const PROVIDERS = {
  llm: { baseUrl: "https://api.openai.com/v1", model: "gpt-test", apiKey: "sk-llm-key-1234" },
  embeddings: { apiKey: "" },
  transcription: { apiKey: "mistral-key-5678" },
  muse: { provider: "muse", apiKey: "muse-key-4321" },
  email: { intent: "save", from: "Grace Church <sermons@grace.example>", apiKey: "re_key_9999" },
};

export const SCHEDULE_FORM = { frequency: "weekly", weekday: "0", hour: "9", timeZone: "America/Chicago" };

/** Runs the whole setup wizard (importing `count` episodes) and returns the admin's session cookie. */
export async function completeSetup(app: TestApp, options: { email?: boolean; count?: number; stopBefore?: string } = {}): Promise<string> {
  const providers = fakeProviders();
  try {
    const created = await app.request("/setup", { form: ADMIN });
    const cookie = cookieFrom(created);
    const steps: [string, Record<string, string>, string][] = [
      ["/setup/ministry", MINISTRY, "/setup/podcast"],
      ["/setup/podcast", { intent: "save", feedUrl: FEED_URL }, "/setup/llm"],
      ["/setup/llm", PROVIDERS.llm, "/setup/embeddings"],
      ["/setup/embeddings", PROVIDERS.embeddings, "/setup/transcription"],
      ["/setup/transcription", PROVIDERS.transcription, "/setup/email"],
      ["/setup/email", options.email ? PROVIDERS.email : { intent: "skip" }, "/setup/import"],
      ["/setup/import", { count: String(options.count ?? 0), ...SCHEDULE_FORM }, "/admin/episodes"],
    ];
    for (const [path, form, next] of steps) {
      if (path === options.stopBefore) break;
      const response = await app.request(path, { form, cookie });
      if (response.headers.get("Location") !== next) throw new Error(`${path} went to ${response.status} ${response.headers.get("Location")}, expected ${next}`);
    }
    return cookie;
  } finally {
    providers.restore();
  }
}

/** Runs workflow steps inline, like a Workflow run with no retries. */
export const inlineStep: PipelineStep = { do: (_name, _config, callback) => callback() };

/** Runs every document workflow started so far, as Workflows would in the background. */
export async function runDocuments(app: TestApp): Promise<void> {
  for (const run of app.documentRuns.created.splice(0)) await writeDocument(app.env, inlineStep, run.params.documentId);
}

/** A finished site with both feed episodes processed. Leaves fake providers installed. */
export async function indexedSite(): Promise<{ app: TestApp; cookie: string; ids: string[]; providers: ReturnType<typeof fakeProviders>; restore(): void }> {
  const app = createApp();
  const providers = fakeProviders();
  const cookie = await completeSetup(app, { count: 2 });
  const { results } = await app.env.DB.prepare("SELECT id FROM episodes ORDER BY published_at DESC").all<{ id: string }>();
  const ids = results.map((row) => row.id);
  for (const id of ids) await runEpisode(app.env, inlineStep, id);
  return { app, cookie, ids, providers, restore: providers.restore };
}
