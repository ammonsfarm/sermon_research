export type IntelligenceProviderErrorCode =
  | "authentication"
  | "configuration"
  | "invalid_provider_response"
  | "provider_timeout_unknown"
  | "throttled"
  | "transient_dependency";

export class IntelligenceProviderError extends Error {
  readonly code: IntelligenceProviderErrorCode;

  constructor(code: IntelligenceProviderErrorCode, message: string) {
    super(message);
    this.name = "IntelligenceProviderError";
    this.code = code;
  }
}

export interface EpisodeIntelligenceItem {
  readonly itemType: string;
  readonly label: string;
  readonly summary: string;
  readonly sourceTimes: readonly string[];
  readonly speakers: readonly string[];
  readonly confidence: string;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface EpisodeIntelligenceArtifact {
  readonly model: string;
  readonly episodeType: string;
  readonly executiveSummary: string;
  readonly longSummary: string;
  readonly mainTopics: readonly string[];
  readonly searchKeywords: readonly string[];
  readonly items: readonly EpisodeIntelligenceItem[];
}

export interface EpisodeIntelligenceInput {
  readonly episodeId: string;
  readonly title: string;
  readonly publishDate: string;
  readonly transcript: string;
  readonly transcriptTruncated: boolean;
}

export interface EpisodeIntelligenceProvider {
  generate(input: EpisodeIntelligenceInput): Promise<EpisodeIntelligenceArtifact>;
}

export type SiloIntelligenceReasoning = "low" | "medium" | "high";

export const SILO_INTELLIGENCE_BACKEND_MODE = "codex-direct";
export const MAX_SILO_INTELLIGENCE_TOKENS = 32_768;

function configuration(message: string): IntelligenceProviderError {
  return new IntelligenceProviderError("configuration", message);
}

function invalidResponse(detail = ""): IntelligenceProviderError {
  return new IntelligenceProviderError(
    "invalid_provider_response",
    `Episode intelligence provider returned an invalid bounded artifact${detail ? ` (${detail})` : ""}.`,
  );
}

function privateIpv4(parts: readonly number[]): boolean {
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254
    || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31 || parts[0] === 192 && parts[1] === 168
    || parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127 || parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.includes(":")) {
    if (host === "::" || host === "::1" || /^f[cd][0-9a-f:]*$/u.test(host) || /^fe[89ab][0-9a-f:]*$/u.test(host)) return true;
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
    return mapped ? privateIpv4([Number.parseInt(mapped[1]!, 16) >> 8, Number.parseInt(mapped[1]!, 16) & 255, Number.parseInt(mapped[2]!, 16) >> 8, Number.parseInt(mapped[2]!, 16) & 255]) : false;
  }
  if (!host.includes(".")) return true;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && privateIpv4(parts);
}

function publicSiloUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configuration("Silo intelligence endpoint is invalid.");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash
    || !url.pathname.endsWith("/chat/completions")
    || privateHost(url.hostname)
  ) throw configuration("Silo intelligence endpoint must be a public HTTPS chat-completions URL.");
  return url.toString();
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || !allowEmpty && value.trim().length === 0
    || new TextEncoder().encode(value).byteLength > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) throw invalidResponse();
  return value.trim();
}

function stringList(value: unknown, maximumItems: number, maximumItemBytes: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw invalidResponse();
  return value.map((item) => boundedText(item, "Intelligence list item", maximumItemBytes));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}

/** Silo's accepted contract: every field must already be well formed (verified by the Silo gateway gate). */
function strictArtifact(payload: unknown, model: string): EpisodeIntelligenceArtifact {
  const root = object(payload);
  if (!Array.isArray(root.items) || root.items.length > 200) throw invalidResponse();
  const items = root.items.map((candidate) => {
    const item = object(candidate);
    const itemType = boundedText(item.itemType, "Intelligence item type", 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(itemType)) throw invalidResponse();
    return {
      itemType,
      label: boundedText(item.label ?? "", "Intelligence item label", 2_048, true),
      summary: boundedText(item.summary, "Intelligence item summary", 16_384),
      sourceTimes: stringList(item.sourceTimes ?? [], 32, 64),
      speakers: stringList(item.speakers ?? [], 32, 256),
      confidence: boundedText(item.confidence ?? "", "Intelligence confidence", 64, true),
      value: object(item.value ?? {}),
    };
  });
  return {
    model,
    episodeType: boundedText(root.episodeType ?? "unknown", "Episode type", 128),
    executiveSummary: boundedText(root.executiveSummary, "Executive summary", 32_768),
    longSummary: boundedText(root.longSummary, "Long summary", 80_000),
    mainTopics: stringList(root.mainTopics ?? [], 100, 512),
    searchKeywords: stringList(root.searchKeywords ?? [], 200, 256),
    items,
  };
}

/** Coerce a scalar the model returned (e.g. a numeric confidence) to trimmed text within `maximum` bytes. */
function lenientText(value: unknown, maximum: number): string {
  const raw = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ").trim();
  const bytes = new TextEncoder().encode(clean);
  return bytes.byteLength <= maximum ? clean : new TextDecoder().decode(bytes.slice(0, maximum)).replace(/\uFFFD$/u, "").trim();
}

function lenientList(value: unknown, maximumItems: number, maximumItemBytes: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => lenientText(item, maximumItemBytes)).filter(Boolean).slice(0, maximumItems);
}

/**
 * The episode-level summaries must be present; individual items are best-effort. A malformed
 * item (empty summary, odd type name, numeric confidence) is repaired or dropped instead of
 * failing the whole episode.
 */
function lenientArtifact(payload: unknown, model: string): EpisodeIntelligenceArtifact {
  const root = object(payload);
  const executiveSummary = lenientText(root.executiveSummary, 32_768);
  const longSummary = lenientText(root.longSummary, 80_000);
  if (!executiveSummary) throw invalidResponse("missing executiveSummary");
  if (!longSummary) throw invalidResponse("missing longSummary");
  const candidates = Array.isArray(root.items) ? root.items.slice(0, 200) : [];
  const items = candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const itemType = lenientText(item.itemType, 256).toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^[^a-z]+|_+$/gu, "").slice(0, 64);
    const summary = lenientText(item.summary, 16_384);
    if (!itemType || !summary) return [];
    const value = item.value && typeof item.value === "object" && !Array.isArray(item.value) ? item.value as Record<string, unknown> : {};
    return [{
      itemType,
      label: lenientText(item.label, 2_048),
      summary,
      sourceTimes: lenientList(item.sourceTimes, 32, 64),
      speakers: lenientList(item.speakers, 32, 256),
      confidence: lenientText(item.confidence, 64),
      value,
    }];
  });
  return {
    model,
    episodeType: lenientText(root.episodeType, 128) || "unknown",
    executiveSummary,
    longSummary,
    mainTopics: lenientList(root.mainTopics, 100, 512),
    searchKeywords: lenientList(root.searchKeywords, 200, 256),
    items,
  };
}

async function boundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximumBytes) throw invalidResponse();
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw invalidResponse();
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw invalidResponse();
  }
}

function providerFailure(status: number): IntelligenceProviderError {
  if (status === 504) return new IntelligenceProviderError("provider_timeout_unknown", "Silo intelligence outcome is unknown after gateway timeout.");
  if (status === 429) return new IntelligenceProviderError("throttled", "Silo intelligence is temporarily throttled.");
  if (status === 401 || status === 403) return new IntelligenceProviderError("authentication", "Silo intelligence authentication failed.");
  if (status === 408 || status === 425 || status >= 500) return new IntelligenceProviderError("transient_dependency", `Silo intelligence returned status ${status}.`);
  return invalidResponse();
}

function maxTokens(value: string | number): number {
  const parsed = typeof value === "string" ? (/^[1-9]\d*$/u.test(value) ? Number(value) : Number.NaN) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SILO_INTELLIGENCE_TOKENS) {
    throw configuration("Silo intelligence max tokens is invalid.");
  }
  return parsed;
}

export function createSiloIntelligenceProvider(options: {
  readonly environment?: string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly backendMode: string;
  readonly reasoning: string;
  readonly maxTokens: string | number;
  readonly maxResponseBytes?: number;
}): EpisodeIntelligenceProvider {
  const url = publicSiloUrl(options.url);
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) throw configuration("Silo intelligence credential is missing.");
  if (typeof options.model !== "string" || !options.model.trim() || options.model.length > 256 || /[\u0000-\u001F\u007F]/u.test(options.model)) {
    throw configuration("Silo intelligence model is invalid.");
  }
  // Explicit Development-only public API amendment; production's Codex contract is unchanged.
  const developmentOpenAi = options.environment === "development" && options.backendMode === "openai-responses"
    && options.model === "gpt-5.6-luna";
  if (options.backendMode !== SILO_INTELLIGENCE_BACKEND_MODE && !developmentOpenAi) throw configuration("Silo intelligence backend mode is invalid.");
  if (options.reasoning !== "low" && options.reasoning !== "medium" && options.reasoning !== "high") {
    throw configuration("Silo intelligence reasoning is invalid.");
  }
  const configuredMaxTokens = maxTokens(options.maxTokens);
  const maximumBytes = options.maxResponseBytes ?? 524_288;
  return {
    async generate(input) {
      const transcript = boundedText(input.transcript, "Intelligence transcript", 240_000);
      const body = JSON.stringify({
        model: options.model,
        backend_mode: options.backendMode,
        reasoning: { effort: options.reasoning },
        max_tokens: configuredMaxTokens,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return only a JSON object, without Markdown. episodeType, executiveSummary, and longSummary must be strings; mainTopics and searchKeywords must be arrays of strings; items must be an array of objects. Each item has itemType (lowercase snake_case string), label (string), summary (string), sourceTimes (array of strings), speakers (array of strings), confidence (string), and value (JSON object, never a string). Use empty arrays or an empty value object when the transcript supplies no corresponding details. Do not invent claims absent from the transcript.",
          },
          {
            role: "user",
            content: `Episode ID: ${input.episodeId}\nTitle: ${input.title}\nPublish date: ${input.publishDate}\nTranscript truncated: ${input.transcriptTruncated ? "yes" : "no"}\n\n${transcript}`,
          },
        ],
      });
      let response: Response;
      try {
        response = await options.fetch(new Request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body,
        }));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new IntelligenceProviderError("provider_timeout_unknown", "Silo intelligence outcome is unknown after timeout.");
        }
        throw new IntelligenceProviderError("transient_dependency", "Silo intelligence is temporarily unavailable.");
      }
      if (!response.ok) throw providerFailure(response.status);
      let envelope: unknown;
      try {
        envelope = JSON.parse(await boundedBody(response, maximumBytes));
      } catch (error) {
        if (error instanceof IntelligenceProviderError) throw error;
        throw invalidResponse();
      }
      const root = object(envelope);
      const first = Array.isArray(root.choices) ? root.choices[0] : undefined;
      const message = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>).content : undefined;
      if (typeof content !== "string") throw invalidResponse();
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw invalidResponse();
      }
      return strictArtifact(parsed, options.model);
    },
  };
}

export function createGeminiIntelligenceProvider(options: {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly url?: string | undefined;
  readonly apiKey: string;
  readonly model?: string | undefined;
  readonly maxTokens?: string | number | undefined;
  readonly maxResponseBytes?: number | undefined;
}): EpisodeIntelligenceProvider {
  const url = options.url || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) throw configuration("Gemini intelligence credential is missing.");
  const model = options.model || "gemini-3.8-flash";
  const configuredMaxTokens = options.maxTokens ? maxTokens(options.maxTokens) : 16_384;
  const maximumBytes = options.maxResponseBytes ?? 1_048_576;
  return {
    async generate(input) {
      const transcript = boundedText(input.transcript, "Intelligence transcript", 240_000);
      const body = JSON.stringify({
        model,
        max_tokens: configuredMaxTokens,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return only a JSON object, without Markdown. episodeType, executiveSummary, and longSummary must be strings; mainTopics and searchKeywords must be arrays of strings; items must be an array of objects. Each item has itemType (lowercase snake_case string), label (string), summary (string), sourceTimes (array of strings), speakers (array of strings), confidence (string), and value (JSON object, never a string). Use empty arrays or an empty value object when the transcript supplies no corresponding details. Do not invent claims absent from the transcript.",
          },
          {
            role: "user",
            content: `Episode ID: ${input.episodeId}\nTitle: ${input.title}\nPublish date: ${input.publishDate}\nTranscript truncated: ${input.transcriptTruncated ? "yes" : "no"}\n\n${transcript}`,
          },
        ],
      });
      let response: Response;
      try {
        response = await options.fetch(new Request(url, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body,
        }));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new IntelligenceProviderError("provider_timeout_unknown", "Gemini intelligence outcome is unknown after timeout.");
        }
        throw new IntelligenceProviderError("transient_dependency", "Gemini intelligence is temporarily unavailable.");
      }
      if (!response.ok) throw providerFailure(response.status);
      let envelope: unknown;
      try {
        envelope = JSON.parse(await boundedBody(response, maximumBytes));
      } catch (error) {
        if (error instanceof IntelligenceProviderError) throw error;
        throw invalidResponse();
      }
      const root = object(envelope);
      const first = Array.isArray(root.choices) ? root.choices[0] : undefined;
      const message = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>).message : undefined;
      const content = message && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>).content : undefined;
      const finishReason = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>).finish_reason : undefined;
      if (finishReason === "length") throw invalidResponse("output limit reached");
      if (finishReason === "content_filter" || finishReason === "safety") throw invalidResponse("blocked by the provider's safety filter");
      if (typeof content !== "string") throw invalidResponse("no message content");
      let parsed: unknown;
      try {
        parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, ""));
      } catch {
        throw invalidResponse("response was not JSON");
      }
      return lenientArtifact(parsed, model);
    },
  };
}
