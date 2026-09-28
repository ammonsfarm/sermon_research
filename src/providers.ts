/** Fixed embedding model so every deployment's vectors match the Vectorize index (1536 dimensions). */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";

export class ProviderError extends Error {}

export interface LlmSettings {
  readonly baseUrl: string;
  readonly model: string;
}

async function call(url: string, init: RequestInit, fetcher: typeof fetch, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ProviderError(`${what} didn't respond. Check the address and try again.`);
  }
  if (response.ok) return response;
  if (response.status === 401 || response.status === 403) throw new ProviderError(`${what} rejected the key.`);
  if (response.status === 404) throw new ProviderError(`${what} couldn't find that model or address.`);
  if (response.status === 429) throw new ProviderError(`${what} says the account is rate limited or out of credit.`);
  const detail = (await response.text().catch(() => "")).replace(/\s+/gu, " ").slice(0, 200);
  throw new ProviderError(`${what} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`);
}

/** Sends one tiny chat completion to confirm the endpoint, model and key work together. */
export async function checkLlm(settings: LlmSettings, apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await call(`${settings.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16 }),
  }, fetcher, "The answers provider");
  const body = await response.json().catch(() => null) as { choices?: unknown[] } | null;
  if (!Array.isArray(body?.choices)) throw new ProviderError("The answers provider replied, but not in the OpenAI chat format.");
}

export async function checkEmbeddings(apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await call(`${OPENAI_BASE_URL}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: "connection check" }),
  }, fetcher, "OpenAI");
  const body = await response.json().catch(() => null) as { data?: { embedding?: unknown[] }[] } | null;
  if (body?.data?.[0]?.embedding?.length !== EMBEDDING_DIMENSIONS) throw new ProviderError("OpenAI replied, but not with a 1536-dimension embedding.");
}

/** Lists models to confirm the Mistral key works; transcribing a sample would cost money on every check. */
export async function checkTranscription(apiKey: string, fetcher: typeof fetch = fetch): Promise<void> {
  await call("https://api.mistral.ai/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } }, fetcher, "Mistral");
}

export async function sendEmail(
  input: { apiKey: string; from: string; to: string; subject: string; text: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await call("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text }),
  }, fetcher, "Resend");
}

export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
