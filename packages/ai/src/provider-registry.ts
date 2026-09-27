import { ServiceError } from "../../contracts/src/errors.ts";
import { isPrivateHost } from "./generation.ts";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type LlmApiStyle = "chat" | "completions" | "responses";

/** Cost tier from the blended (input + output) / 2 price per million tokens. */
export type LlmPriceTier = "free" | "$" | "$$" | "$$$" | "$$$$";

/** Per-model detail when the provider publishes it (OpenRouter does; most do not). */
export interface LlmModelDetail {
  readonly id: string;
  readonly name: string | null;
  /** USD per million input tokens. */
  readonly inputPerMillion: number | null;
  /** USD per million output tokens. */
  readonly outputPerMillion: number | null;
  readonly tier: LlmPriceTier | null;
  readonly contextLength: number | null;
}

/** What a probe observed about an OpenAI-compatible endpoint. `null` means not determinable. */
export interface LlmProviderCapabilities {
  readonly models: readonly string[];
  readonly modelDetails?: readonly LlmModelDetail[];
  readonly chat: boolean | null;
  readonly completions: boolean | null;
  readonly responses: boolean | null;
  readonly websocket: boolean | null;
  readonly transport: "https" | "https+wss";
  readonly probedModel: string | null;
}

export interface LlmProbeResult {
  readonly capabilities: LlmProviderCapabilities;
  readonly error: string | null;
}

const KEY_VERSION = "v1";
const PROBE_TIMEOUT_MS = 12_000;
const MAX_PROBE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 2_000;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function unbase64(value: string): Uint8Array {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

async function importSecret(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try { raw = unbase64(secret.trim()); }
  catch { invalid("Provider key encryption secret must be base64."); }
  if (raw.byteLength !== 32) invalid("Provider key encryption secret must decode to 32 bytes.");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts an API key as `v1:<iv>:<ciphertext>`; bound to the provider id as associated data. */
export async function encryptProviderApiKey(secret: string, providerId: string, apiKey: string): Promise<string> {
  const plaintext = apiKey.trim();
  if (plaintext.length < 8 || plaintext.length > 4096) invalid("API key length is invalid.");
  const key = await importSecret(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(providerId) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${KEY_VERSION}:${base64(iv)}:${base64(new Uint8Array(ciphertext))}`;
}

export async function decryptProviderApiKey(secret: string, providerId: string, sealed: string): Promise<string> {
  const [version, iv, ciphertext] = sealed.split(":");
  if (version !== KEY_VERSION || !iv || !ciphertext) invalid("Stored API key format is invalid.");
  const key = await importSecret(secret);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(iv) as BufferSource, additionalData: new TextEncoder().encode(providerId) },
      key,
      unbase64(ciphertext) as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new ServiceError({ code: "dependency_unavailable", message: "Stored API key could not be decrypted.", retryable: false });
  }
}

export function apiKeyLast4(apiKey: string): string {
  return apiKey.trim().slice(-4);
}

const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|responses|models|realtime)\/?$/u;

/** Normalizes an admin-entered base URL: public HTTPS, no credentials/query, endpoint suffix stripped. */
export function normalizeProviderBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { invalid("Provider URL is invalid."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || isPrivateHost(parsed.hostname)) {
    invalid("Provider URL must be a public HTTPS URL without credentials or query parameters.");
  }
  const path = parsed.pathname.replace(ENDPOINT_SUFFIX, "").replace(/\/+$/u, "");
  return `${parsed.origin}${path}`;
}

export function providerEndpoint(baseUrl: string, style: LlmApiStyle | "models" | "realtime"): string {
  const suffix = style === "chat" ? "chat/completions" : style;
  return `${baseUrl.replace(/\/+$/u, "")}/${suffix}`;
}

async function timed<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_PROBE_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** 2xx proves support; 404/405/501 proves absence; anything else (auth, 400 model errors, 5xx) is inconclusive. */
function supportFrom(status: number): boolean | null {
  if (status >= 200 && status < 300) return true;
  if (status === 404 || status === 405 || status === 501) return false;
  return null;
}

const TIER_LIMITS: readonly [number, LlmPriceTier][] = [[1, "$"], [5, "$$"], [15, "$$$"]];

export function priceTier(inputPerMillion: number | null, outputPerMillion: number | null): LlmPriceTier | null {
  if (inputPerMillion === null || outputPerMillion === null) return null;
  const blended = (inputPerMillion + outputPerMillion) / 2;
  if (blended <= 0) return "free";
  return TIER_LIMITS.find(([limit]) => blended < limit)?.[1] ?? "$$$$";
}

function perMillion(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  // Negative prices mean "varies" (routers); treat them as unknown.
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1_000_000 * 1_000_000) / 1_000_000 : null;
}

function modelDetails(payload: unknown): LlmModelDetail[] {
  const data = typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data : [];
  const details: LlmModelDetail[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as { id?: unknown; name?: unknown; pricing?: unknown; context_length?: unknown };
    if (typeof row.id !== "string" || !row.id || row.id.length > 256 || typeof row.pricing !== "object" || row.pricing === null) continue;
    const pricing = row.pricing as { prompt?: unknown; completion?: unknown };
    const inputPerMillion = perMillion(pricing.prompt);
    const outputPerMillion = perMillion(pricing.completion);
    details.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.length <= 200 ? row.name : null,
      inputPerMillion,
      outputPerMillion,
      tier: priceTier(inputPerMillion, outputPerMillion),
      contextLength: typeof row.context_length === "number" && Number.isSafeInteger(row.context_length) ? row.context_length : null,
    });
  }
  return details.sort((left, right) => left.id.localeCompare(right.id)).slice(0, MAX_MODELS);
}

function modelIds(payload: unknown): string[] {
  const data = typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray(payload) ? payload : [];
  const ids = data
    .map((entry) => typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
    .map((id) => id.replace(/^models\//u, ""));
  return [...new Set(ids)].sort().slice(0, MAX_MODELS);
}

/**
 * Probes an OpenAI-compatible provider. Each generation probe asks for one output token, so
 * the cost is a few tokens per endpoint. The WebSocket probe attempts a realtime upgrade,
 * which only Workers-style fetch implementations can complete; elsewhere it stays `null`.
 */
export async function probeLlmProvider({
  fetch, baseUrl, apiKey, model,
}: {
  readonly fetch: Fetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model?: string | undefined;
}): Promise<LlmProbeResult> {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const errors: string[] = [];
  let models: string[] = [];
  let details: LlmModelDetail[] = [];
  try {
    const response = await timed((signal) => fetch(providerEndpoint(baseUrl, "models"), { headers, signal, redirect: "manual" }));
    if (response.status === 401 || response.status === 403) errors.push(`The provider rejected the API key (${response.status}).`);
    else if (response.ok) {
      const payload = await readJson(response);
      models = modelIds(payload);
      details = modelDetails(payload);
    }
    else errors.push(`Model listing returned ${response.status}.`);
  } catch {
    errors.push("Model listing did not respond.");
  }
  const probedModel = model?.trim() || models[0] || null;
  const attempt = async (style: LlmApiStyle): Promise<boolean | null> => {
    if (!probedModel) return null;
    const body = style === "chat"
      ? { model: probedModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }
      : style === "completions"
        ? { model: probedModel, prompt: "ping", max_tokens: 1, stream: false }
        : { model: probedModel, input: "ping", max_output_tokens: 16, stream: false };
    try {
      const response = await timed((signal) => fetch(providerEndpoint(baseUrl, style), {
        method: "POST", headers, body: JSON.stringify(body), signal, redirect: "manual",
      }));
      await response.body?.cancel();
      return supportFrom(response.status);
    } catch {
      return null;
    }
  };
  const [chat, completions, responses] = await Promise.all([attempt("chat"), attempt("completions"), attempt("responses")]);
  let websocket: boolean | null = null;
  if (probedModel) {
    try {
      const url = `${providerEndpoint(baseUrl, "realtime")}?model=${encodeURIComponent(probedModel)}`;
      const response = await timed((signal) => fetch(url, { headers: { Authorization: headers.Authorization, Upgrade: "websocket" }, signal }));
      const socket = (response as Response & { webSocket?: { accept(): void; close(): void } | null }).webSocket;
      if (response.status === 101 && socket) {
        socket.accept();
        socket.close();
        websocket = true;
      } else {
        websocket = response.status === 404 || response.status === 405 || response.status === 426 ? false : null;
      }
    } catch {
      websocket = null;
    }
  }
  if (!probedModel && errors.length === 0) errors.push("No model was listed; enter a model id to probe generation endpoints.");
  if (probedModel && chat !== true && completions !== true && responses !== true) errors.push(`No generation endpoint accepted a test request for ${probedModel}.`);
  return {
    capabilities: {
      models, ...(details.length ? { modelDetails: details } : {}), chat, completions, responses, websocket,
      transport: websocket ? "https+wss" : "https",
      probedModel,
    },
    error: errors.length ? errors.join(" ").slice(0, 1000) : null,
  };
}

/** Preferred API style from probed capabilities; chat first, then responses, then legacy completions. */
export function preferredApiStyle(capabilities: Partial<LlmProviderCapabilities> | null | undefined): LlmApiStyle {
  if (capabilities?.chat === true) return "chat";
  if (capabilities?.responses === true) return "responses";
  if (capabilities?.completions === true) return "completions";
  return "chat";
}
