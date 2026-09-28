import worker from "../src/index.ts";
import type { AppEnv } from "../src/env.ts";
import { resetSchemaCache } from "../src/schema.ts";
import { createTestD1 } from "./d1-sqlite.ts";

export const ORIGIN = "https://sermons.example.org";
export const SECRET = "test-secret-0123456789-abcdefghijklmnop";

export interface FakeVectors {
  readonly stored: Map<string, VectorizeVector>;
  readonly deleted: string[];
}

export interface FakeWorkflow {
  readonly created: { id: string; params: { episodeId: string } }[];
  /** Set to make create() throw, as when Workflows is unavailable. */
  failing: boolean;
}

export interface TestApp {
  readonly env: AppEnv;
  readonly vectors: FakeVectors;
  readonly workflow: FakeWorkflow;
  request(path: string, init?: { method?: string; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> }): Promise<Response>;
}

export function createApp(overrides: Partial<AppEnv> = {}): TestApp {
  resetSchemaCache();
  const vectors: FakeVectors = { stored: new Map(), deleted: [] };
  const workflow: FakeWorkflow = { created: [], failing: false };
  const VECTORS = {
    async upsert(items: VectorizeVector[]) {
      for (const item of items) vectors.stored.set(item.id, item);
      return { mutationId: "m" };
    },
    async query(_vector: number[], options: { topK?: number } = {}) {
      return { count: 0, matches: [...vectors.stored.keys()].slice(0, options.topK ?? 5).map((id) => ({ id, score: 0.9 })) };
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
  const env = { DB: createTestD1(), APP_SECRET: SECRET, VECTORS, EPISODE_WORKFLOW, ...overrides } as unknown as AppEnv;
  return {
    env,
    vectors,
    workflow,
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
<enclosure url="https://cdn.example.org/ep2.mp3?a=1&amp;b=2" length="1" type="audio/mpeg"/><itunes:duration>45:30</itunes:duration></item>
<item><title>Grace Alone</title><guid>ep-1</guid><pubDate>Sun, 07 Sep 2026 15:00:00 GMT</pubDate>
<enclosure url="https://cdn.example.org/ep1.mp3" length="1" type="audio/mpeg"/><itunes:duration>2700</itunes:duration></item>
</channel></rss>`;

export const TRANSCRIPT_SEGMENTS = [
  { text: "Welcome, church.", start: 0, end: 4.5 },
  { text: "Today we read Ephesians 2:8.", start: 4.5, end: 11 },
];
export const SUMMARY_REPLY = "```json\n{\"summary\": \"Grace is a gift.\", \"topics\": [\"grace\"], \"scriptures\": [\"Ephesians 2:8\"]}\n```";

export const ANSWER_REPLY = "Salvation is by grace [1].\n\nSee also [1, 2] and <b>[9]</b>.";

export interface FakeCall { readonly url: string; readonly method: string; readonly authorization: string | null; readonly userAgent: string | null; readonly body: unknown }

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
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", authorization: headers.get("Authorization"), userAgent: headers.get("User-Agent"), body });
    const failure = Object.entries(fail).find(([prefix]) => url.startsWith(prefix));
    if (failure) return new Response("{\"error\":\"nope\"}", { status: failure[1] });
    if (url === FEED_URL) return new Response(FEED_XML, { headers: { "Content-Type": "application/rss+xml" } });
    if (url.endsWith("/chat/completions")) {
      const system = ((body as { messages?: { role: string; content: string }[] } | null)?.messages ?? []).find((message) => message.role === "system")?.content ?? "";
      const content = system.includes("numbered sources") ? ANSWER_REPLY : system ? SUMMARY_REPLY : "OK";
      return Response.json({ choices: [{ message: { content } }] });
    }
    if (url === "https://api.openai.com/v1/embeddings") {
      const input = (body as { input?: unknown } | null)?.input;
      const count = Array.isArray(input) ? input.length : 1;
      return Response.json({ data: Array.from({ length: count }, (_unused, index) => ({ index, embedding: Array(1536).fill(0.01) })) });
    }
    if (url === "https://api.mistral.ai/v1/audio/transcriptions") return Response.json({ text: "full", segments: TRANSCRIPT_SEGMENTS });
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
