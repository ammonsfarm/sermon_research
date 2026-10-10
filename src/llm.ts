import type { AppEnv } from "./env.ts";
import { getKey, type KeySlot } from "./keys.ts";
import { isReasoningEffort, ProviderError, providerMessage, REASONING_EFFORTS, type ReasoningEffort, withUserAgent } from "./providers.ts";
import { getSetting, putSetting } from "./settings.ts";

/**
 * Answers-AI providers. Every one is called through its OpenAI-compatible
 * chat completions endpoint, but they differ in the details, which `chatBody`
 * and `fetchCatalog` absorb:
 *
 * - openai: `max_completion_tokens` (reasoning models reject `max_tokens`); `reasoning_effort`.
 *   /models lists ids only, so a model's efforts are inferred from its name.
 * - google (Gemini): `reasoning_effort` of minimal/low/medium/high, plus none on 2.5 Flash only.
 *   The native /v1beta/models list says which models think.
 * - anthropic: its compatibility layer ignores `reasoning_effort`; thinking is turned on with
 *   `thinking: {type: "enabled", budget_tokens}`, and max_tokens must cover the budget too.
 *   Its native /v1/models list reports each model's effort levels.
 * - openrouter: a unified `reasoning: {effort}` object; /models reports each model's efforts.
 * - meta (Muse): `reasoning_effort` from none to max.
 * - custom: any other OpenAI-compatible gateway; no reasoning field unless an admin gives a model efforts.
 */
export const PROVIDER_KINDS = ["meta", "google", "openai", "anthropic", "openrouter", "custom"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return PROVIDER_KINDS.includes(value as ProviderKind);
}

export const KIND_NAMES: Record<ProviderKind, string> = {
  meta: "Meta (Muse)", google: "Google Gemini", openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter", custom: "Other OpenAI-compatible",
};

/** What each kind does with a reasoning effort, for admins. */
export const KIND_NOTES: Record<ProviderKind, string> = {
  meta: "Muse takes every reasoning level from none to max.",
  google: "Gemini takes minimal, low, medium and high. Only Gemini 2.5 Flash models can turn thinking off (none); Gemini 2.5 Pro and 3 always think.",
  openai: "OpenAI's model list doesn't say which models reason or at what levels, so these are inferred from the model name (o-series: low to high; GPT-5: minimal to high; GPT-5.1 and later: none to high, GPT-5.2 and later also xhigh). Edit a model if OpenAI differs.",
  anthropic: "Anthropic's OpenAI-compatible endpoint ignores reasoning_effort, so this site turns an effort into a thinking budget instead (low 2,048 tokens, up to max 32,000). Anthropic describes that endpoint as meant for testing rather than long-term production use.",
  openrouter: "OpenRouter reports each model's supported efforts, which are sent as its unified reasoning setting.",
  custom: "Reasoning settings are sent as reasoning_effort only for models you give efforts to; leave them off if the gateway rejects unknown fields.",
};

export interface BuiltinProvider { readonly id: string; readonly kind: ProviderKind; readonly name: string; readonly baseUrl: string }

/** Present on every site (migration 15 inserts the same rows). A provider is usable once it has a key. */
export const BUILTIN_PROVIDERS: readonly BuiltinProvider[] = [
  { id: "meta", kind: "meta", name: "Meta (Muse)", baseUrl: "https://api.meta.ai/v1" },
  { id: "google", kind: "google", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "openai", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", kind: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { id: "openrouter", kind: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
];

export interface LlmProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly baseUrl: string;
  /** Where the key lives in provider_keys. */
  readonly keySlot: KeySlot;
  readonly keyLast4: string | null;
}

export interface LlmModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly label: string;
  /** Reasoning levels the model takes. Empty means none are sent. */
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort | null;
  readonly contextWindow: number | null;
  readonly enabled: boolean;
}

/** The jobs an admin picks a model for. */
export const LLM_ACTIONS = [
  { key: "summary", label: "Summaries and sermon processing", hint: "Each new sermon: reviewing the transcript, the summary, picking the speaker and main passage." },
  { key: "chat", label: "Chat", hint: "Answering questions." },
  { key: "document", label: "Document creation", hint: "Outlines, study questions and custom documents." },
] as const;
export type LlmAction = (typeof LLM_ACTIONS)[number]["key"];

export interface LlmChoice { readonly provider: string; readonly model: string; readonly effort: ReasoningEffort | null }
export type LlmDefaults = Partial<Record<LlmAction, LlmChoice>>;

/** "provider/model", the form value and document column for one model. Provider ids never contain a slash. */
export function modelKey(model: { providerId: string; modelId: string }): string {
  return `${model.providerId}/${model.modelId}`;
}

export function parseModelKey(value: unknown): { providerId: string; modelId: string } | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1 ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } : null;
}

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum",
};

// ---------------------------------------------------------------- storage

interface ProviderRow { id: string; kind: string; name: string; base_url: string; key_slot: string; last4: string | null }
interface ModelRow { provider_id: string; model_id: string; label: string; efforts_json: string; default_effort: string | null; context_window: number | null; enabled: number }

function toProvider(row: ProviderRow): LlmProvider {
  return { id: row.id, kind: isProviderKind(row.kind) ? row.kind : "custom", name: row.name, baseUrl: row.base_url, keySlot: row.key_slot as KeySlot, keyLast4: row.last4 };
}

function toModel(row: ModelRow): LlmModel {
  const parsed = JSON.parse(row.efforts_json) as unknown;
  return {
    providerId: row.provider_id, modelId: row.model_id, label: row.label,
    efforts: Array.isArray(parsed) ? parsed.filter(isReasoningEffort) : [],
    defaultEffort: isReasoningEffort(row.default_effort) ? row.default_effort : null,
    contextWindow: row.context_window, enabled: row.enabled === 1,
  };
}

const PROVIDER_SQL = `SELECT p.id, p.kind, p.name, p.base_url, p.key_slot, k.last4 FROM llm_providers p LEFT JOIN provider_keys k ON k.slot = p.key_slot`;

export async function listProviders(db: D1Database): Promise<LlmProvider[]> {
  return (await db.prepare(`${PROVIDER_SQL} ORDER BY p.position, p.name`).all<ProviderRow>()).results.map(toProvider);
}

export async function getProvider(db: D1Database, id: string): Promise<LlmProvider | null> {
  const row = await db.prepare(`${PROVIDER_SQL} WHERE p.id = ?`).bind(id).first<ProviderRow>();
  return row ? toProvider(row) : null;
}

export async function listModels(db: D1Database, providerId?: string): Promise<LlmModel[]> {
  const sql = "SELECT provider_id, model_id, label, efforts_json, default_effort, context_window, enabled FROM llm_models";
  const statement = providerId ? db.prepare(`${sql} WHERE provider_id = ? ORDER BY label`).bind(providerId) : db.prepare(`${sql} ORDER BY provider_id, label`);
  return (await statement.all<ModelRow>()).results.map(toModel);
}

export async function saveModel(db: D1Database, model: LlmModel): Promise<void> {
  await db.prepare(
    `INSERT INTO llm_models (provider_id, model_id, label, efforts_json, default_effort, context_window, enabled, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET label = excluded.label, efforts_json = excluded.efforts_json, default_effort = excluded.default_effort,
       context_window = excluded.context_window, enabled = excluded.enabled`,
  ).bind(model.providerId, model.modelId, model.label, JSON.stringify(model.efforts), model.defaultEffort, model.contextWindow, model.enabled ? 1 : 0, new Date().toISOString()).run();
}

export async function removeModel(db: D1Database, providerId: string, modelId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM llm_models WHERE provider_id = ? AND model_id = ?").bind(providerId, modelId),
    db.prepare("DELETE FROM user_llm_models WHERE provider_id = ? AND model_id = ?").bind(providerId, modelId),
  ]);
}

export async function getDefaults(db: D1Database): Promise<LlmDefaults> {
  const stored = await getSetting<Record<string, { provider?: unknown; model?: unknown; effort?: unknown }>>(db, "llm_defaults");
  const defaults: Record<string, LlmChoice> = {};
  for (const { key } of LLM_ACTIONS) {
    const entry = stored?.[key];
    if (entry && typeof entry.provider === "string" && typeof entry.model === "string") {
      defaults[key] = { provider: entry.provider, model: entry.model, effort: isReasoningEffort(entry.effort) ? entry.effort : null };
    }
  }
  return defaults;
}

export async function saveDefaults(db: D1Database, defaults: LlmDefaults): Promise<void> {
  await putSetting(db, "llm_defaults", defaults);
}

/** The model keys this person is limited to, or null when they follow the site's list. */
export async function userModelKeys(db: D1Database, userId: string): Promise<Set<string> | null> {
  const { results } = await db.prepare("SELECT provider_id, model_id FROM user_llm_models WHERE user_id = ?").bind(userId).all<{ provider_id: string; model_id: string }>();
  return results.length > 0 ? new Set(results.map((row) => modelKey({ providerId: row.provider_id, modelId: row.model_id }))) : null;
}

export async function saveUserModels(db: D1Database, userId: string, keys: readonly string[]): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM user_llm_models WHERE user_id = ?").bind(userId),
    ...keys.flatMap((key) => {
      const parsed = parseModelKey(key);
      return parsed ? [db.prepare("INSERT OR IGNORE INTO user_llm_models (user_id, provider_id, model_id) VALUES (?, ?, ?)").bind(userId, parsed.providerId, parsed.modelId)] : [];
    }),
  ]);
}

/** Models that can be used right now: enabled, with a saved key on their provider, and within this person's limit. */
export async function availableModels(db: D1Database, userId: string | null = null): Promise<LlmModel[]> {
  const [providers, models, limit] = await Promise.all([listProviders(db), listModels(db), userId ? userModelKeys(db, userId) : Promise.resolve(null)]);
  const usable = new Set(providers.filter((provider) => provider.keyLast4 !== null).map((provider) => provider.id));
  return models.filter((model) => model.enabled && usable.has(model.providerId) && (!limit || limit.has(modelKey(model))));
}

export interface ModelChoice { readonly key: string; readonly label: string }

/** What a signed-in person can pick from on the Ask box: empty unless they have a real choice (two or more models). */
export async function modelChoices(db: D1Database, userId: string | null): Promise<ModelChoice[]> {
  if (!userId) return [];
  const [available, providers] = await Promise.all([availableModels(db, userId), listProviders(db)]);
  if (available.length < 2) return [];
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return available.map((model) => ({ key: modelKey(model), label: `${names.get(model.providerId) ?? model.providerId} · ${model.label}` }));
}

export interface LlmSummary {
  readonly providers: readonly string[];
  readonly models: number;
  /** One line per job: "Chat: OpenAI · gpt-5-mini, low effort". */
  readonly defaults: readonly string[];
}

/** For the Admin overview: who is connected and what each job uses. */
export async function llmSummary(db: D1Database): Promise<LlmSummary> {
  const [providers, models, defaults] = await Promise.all([listProviders(db), listModels(db), getDefaults(db)]);
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return {
    providers: providers.filter((provider) => provider.keyLast4).map((provider) => provider.name),
    models: models.filter((model) => model.enabled).length,
    defaults: LLM_ACTIONS.flatMap(({ key, label }) => {
      const choice = defaults[key];
      return choice ? [`${label.split(" and ")[0]}: ${names.get(choice.provider) ?? choice.provider} · ${choice.model}${choice.effort ? `, ${EFFORT_LABELS[choice.effort].toLowerCase()} effort` : ""}`] : [];
    }),
  };
}

// ---------------------------------------------------------------- choosing a model

/** The effort to send for a model: the one asked for if it takes it, else the model's own default. */
export function fitEffort(model: Pick<LlmModel, "efforts" | "defaultEffort">, wanted: ReasoningEffort | null): ReasoningEffort | null {
  if (model.efforts.length === 0) return null;
  if (wanted && model.efforts.includes(wanted)) return wanted;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return model.efforts.includes("low") ? "low" : model.efforts[0]!;
}

/** What a call needs to reach one model. */
export interface LlmTarget {
  readonly kind: ProviderKind;
  readonly providerName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly effort: ReasoningEffort | null;
  /** The model's context window in tokens, when it is known. */
  readonly contextWindow?: number | null;
}

export interface ResolveOptions {
  readonly action: LlmAction;
  /** Whose limit applies; sermon processing has no user. */
  readonly userId?: string | null;
  /** A model the person chose, as "provider/model". Ignored if it isn't one they may use. */
  readonly choice?: string | null;
}

/** Picks the model and effort for a call: the person's choice, else the site default, else (for a limited person) their first model. */
export async function resolveTarget(env: AppEnv, options: ResolveOptions): Promise<LlmTarget> {
  const db = env.DB;
  const userId = options.userId ?? null;
  const [defaults, available, providers] = await Promise.all([getDefaults(db), availableModels(db, userId), listProviders(db)]);
  const wanted = defaults[options.action] ?? defaults.chat;
  const byKey = new Map(available.map((model) => [modelKey(model), model]));
  const chosen = typeof options.choice === "string" ? byKey.get(options.choice) : undefined;
  let model = chosen;
  let effort: ReasoningEffort | null = null;
  if (model) {
    effort = wanted && wanted.provider === model.providerId && wanted.model === model.modelId ? wanted.effort : null;
  } else if (wanted) {
    model = byKey.get(modelKey({ providerId: wanted.provider, modelId: wanted.model }));
    effort = wanted.effort;
  }
  if (!model) {
    const limited = userId ? await userModelKeys(db, userId) : null;
    if (limited && available[0]) model = available[0];
    else if (!wanted) throw new ProviderError("The answers AI isn't set up.");
    else throw new ProviderError(`The model chosen for ${LLM_ACTIONS.find((each) => each.key === options.action)?.label.toLowerCase() ?? "this"} (${wanted.model}) isn't available. Check Admin → Answers AI.`);
  }
  const provider = providers.find((each) => each.id === model!.providerId);
  const apiKey = provider ? await getKey(db, env.APP_SECRET ?? "", provider.keySlot) : null;
  if (!provider || !apiKey) throw new ProviderError(`The ${provider?.name ?? "answers AI"} key is missing or unreadable. Re-enter it in Admin → Answers AI.`);
  return { kind: provider.kind, providerName: provider.name, baseUrl: provider.baseUrl.replace(/\/+$/u, ""), apiKey, model: model.modelId, effort: fitEffort(model, effort), contextWindow: model.contextWindow };
}

// ---------------------------------------------------------------- calling a model

/** Anthropic thinking budgets, in tokens. The API needs at least 1,024. */
const THINKING_BUDGET: Record<ReasoningEffort, number> = { none: 0, minimal: 1_024, low: 2_048, medium: 8_192, high: 16_384, xhigh: 24_576, max: 32_000 };
const ANTHROPIC_MAX_OUTPUT = 64_000;

export interface ChatMessage { readonly role: "system" | "user"; readonly content: string }

/** The JSON body of a chat completion for this model, with the provider's own spelling of the limits and reasoning. */
export function chatBody(target: Pick<LlmTarget, "kind" | "model" | "effort">, messages: readonly ChatMessage[], maxTokens: number): Record<string, unknown> {
  const { kind, model, effort } = target;
  const body: Record<string, unknown> = { model, messages };
  switch (kind) {
    case "openai":
      body.max_completion_tokens = maxTokens;
      if (effort) body.reasoning_effort = effort;
      break;
    case "anthropic": {
      const budget = effort ? THINKING_BUDGET[effort] : 0;
      body.max_tokens = budget ? Math.min(maxTokens + budget, ANTHROPIC_MAX_OUTPUT) : maxTokens;
      // The budget has to leave room for the answer.
      if (budget && (body.max_tokens as number) > budget) body.thinking = { type: "enabled", budget_tokens: budget };
      break;
    }
    case "openrouter":
      body.max_tokens = maxTokens;
      if (effort) body.reasoning = { effort };
      break;
    default:
      body.max_tokens = maxTokens;
      if (effort) body.reasoning_effort = effort;
  }
  return body;
}

export interface ChatResult { readonly content: string | null; readonly finishReason: string | null }

/** One chat completion. Throws ProviderError with the provider's own message on a failure. */
export async function chatCompletion(
  target: LlmTarget, messages: readonly ChatMessage[], options: { maxTokens: number; timeoutMs: number; fetcher?: typeof fetch },
): Promise<ChatResult> {
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(`${target.baseUrl}/chat/completions`, {
      method: "POST",
      headers: withUserAgent({ Authorization: `Bearer ${target.apiKey}`, "Content-Type": "application/json" }),
      body: JSON.stringify(chatBody(target, messages, options.maxTokens)),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    throw new ProviderError(`${target.providerName} didn't respond. Check the address and try again.`);
  }
  if (!response.ok) {
    const detail = providerMessage(await response.text().catch(() => ""));
    // Throwing lets a workflow step retry; the final message is what admins see.
    throw new ProviderError(`${target.providerName} returned HTTP ${response.status} for ${target.model}.${detail ? ` It said: "${detail}"` : ""}`);
  }
  const body = await response.json().catch(() => null) as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] } | null;
  if (!Array.isArray(body?.choices)) throw new ProviderError(`${target.providerName} replied, but not in the OpenAI chat format.`);
  const choice = body.choices[0];
  return { content: typeof choice?.message?.content === "string" ? choice.message.content : null, finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null };
}

/** Sends one tiny request to confirm the endpoint, key and model work together. */
export async function checkTarget(target: LlmTarget, fetcher: typeof fetch = fetch): Promise<void> {
  await chatCompletion({ ...target, effort: null }, [{ role: "user", content: "Reply with the single word OK." }], { maxTokens: 64, timeoutMs: 30_000, fetcher });
}

// ---------------------------------------------------------------- listing a provider's models

export interface CatalogModel {
  readonly modelId: string;
  readonly label: string;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort | null;
  readonly contextWindow: number | null;
}

const ALL_EFFORTS: readonly ReasoningEffort[] = REASONING_EFFORTS;
const LEVELS = (...values: ReasoningEffort[]): readonly ReasoningEffort[] => values;

/** Picks "low" when the model takes it: the cheapest level that still reasons a little. */
function defaultFor(efforts: readonly ReasoningEffort[]): ReasoningEffort | null {
  return efforts.length === 0 ? null : efforts.includes("low") ? "low" : efforts[0]!;
}

function entry(modelId: string, label: string, efforts: readonly ReasoningEffort[], contextWindow: number | null = null): CatalogModel {
  return { modelId, label, efforts, defaultEffort: defaultFor(efforts), contextWindow };
}

/** OpenAI lists only ids, so what a model takes is inferred from its name. */
export function openaiEfforts(id: string): readonly ReasoningEffort[] {
  if (/chat-latest|-instruct|-search/u.test(id)) return [];
  if (/^o\d/u.test(id)) return LEVELS("low", "medium", "high");
  if (/-pro(\b|-)/u.test(id) && /^gpt-5/u.test(id)) return LEVELS("high");
  const later = /^gpt-5\.(\d+)/u.exec(id);
  if (later) return Number(later[1]) >= 2 ? LEVELS("none", "low", "medium", "high", "xhigh") : LEVELS("none", "low", "medium", "high");
  if (/^gpt-5/u.test(id)) return LEVELS("minimal", "low", "medium", "high");
  return [];
}

/** What a hand-typed model name probably takes, from the provider's kind and the name. */
export function guessEfforts(kind: ProviderKind, modelId: string): readonly ReasoningEffort[] {
  switch (kind) {
    case "meta": return ALL_EFFORTS;
    case "openai": return openaiEfforts(modelId);
    case "google": return geminiEfforts(modelId);
    default: return [];
  }
}

/** A model added by name: the provider's own details for it if its list has it, else a guess from the name. */
export async function describeModel(provider: Pick<LlmProvider, "kind" | "name" | "baseUrl">, apiKey: string, modelId: string, fetcher: typeof fetch = fetch): Promise<CatalogModel> {
  try {
    const found = (await fetchCatalog(provider, apiKey, fetcher)).find((model) => model.modelId === modelId);
    if (found) return found;
  } catch {
    // Some providers don't list models; the name is all there is to go on.
  }
  return entry(modelId, modelId, guessEfforts(provider.kind, modelId));
}

export function isOpenaiChatModel(id: string): boolean {
  return /^(gpt-|o\d|chatgpt-)/u.test(id) && !/(audio|realtime|transcribe|tts|image|embedding|moderation|whisper|dall|davinci|babbage|-search|computer-use|sora)/u.test(id);
}

export function geminiEfforts(id: string, thinks?: boolean): readonly ReasoningEffort[] {
  if (thinks === false || /^gemma|gemini-(1|2\.0)/u.test(id)) return [];
  if (/gemini-2\.5-flash/u.test(id)) return LEVELS("none", "minimal", "low", "medium", "high");
  if (/gemini-2\.5-pro/u.test(id) || (/gemini-3/u.test(id) && /pro/u.test(id))) return LEVELS("low", "medium", "high");
  if (/gemini-3/u.test(id)) return LEVELS("minimal", "low", "medium", "high");
  return thinks ? LEVELS("low", "medium", "high") : [];
}

async function getJson(url: string, headers: Record<string, string>, who: string, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: withUserAgent(headers), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ProviderError(`${who} didn't respond. Check the address and try again.`);
  }
  if (!response.ok) {
    const detail = providerMessage(await response.text().catch(() => ""));
    const refused = response.status === 401 || response.status === 403;
    throw new ProviderError(`${who} ${refused ? "refused the key" : `returned HTTP ${response.status}`} when listing models.${detail ? ` It said: "${detail}"` : ""}`);
  }
  const body = await response.json().catch(() => null) as unknown;
  if (typeof body !== "object" || body === null) throw new ProviderError(`${who} replied, but not with a model list.`);
  return body;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null) : [];
}

const str = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Asks the provider for its models and works out each one's reasoning levels. */
export async function fetchCatalog(provider: Pick<LlmProvider, "kind" | "name" | "baseUrl">, apiKey: string, fetcher: typeof fetch = fetch): Promise<CatalogModel[]> {
  const bearer = { Authorization: `Bearer ${apiKey}` };
  const base = provider.baseUrl.replace(/\/+$/u, "");
  const who = provider.name;
  const sort = (models: CatalogModel[]) => models.sort((a, b) => a.label.localeCompare(b.label));
  switch (provider.kind) {
    case "openai": {
      const body = await getJson(`${base}/models`, bearer, who, fetcher) as { data?: unknown };
      return sort(records(body.data).flatMap((item) => {
        const id = str(item.id);
        return id && isOpenaiChatModel(id) ? [entry(id, id, openaiEfforts(id))] : [];
      }));
    }
    case "google": {
      // The native list says which models can generate text and which think; the OpenAI-style one has only ids.
      const models: CatalogModel[] = [];
      let token = "";
      for (let page = 0; page < 5; page++) {
        const body = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`, { "x-goog-api-key": apiKey }, who, fetcher) as { models?: unknown; nextPageToken?: unknown };
        for (const item of records(body.models)) {
          const id = str(item.name)?.replace(/^models\//u, "");
          const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
          if (!id || !methods.includes("generateContent") || !/^gemini/u.test(id) || /(tts|image|live|audio|veo|imagen|embedding|aqa|robotics|computer-use)/u.test(id)) continue;
          models.push(entry(id, str(item.displayName) ?? id, geminiEfforts(id, typeof item.thinking === "boolean" ? item.thinking : undefined), num(item.inputTokenLimit)));
        }
        token = str(body.nextPageToken) ?? "";
        if (!token) break;
      }
      return sort(models);
    }
    case "anthropic": {
      const models: CatalogModel[] = [];
      let after = "";
      for (let page = 0; page < 5; page++) {
        const body = await getJson(`https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, who, fetcher) as { data?: unknown; has_more?: unknown; last_id?: unknown };
        for (const item of records(body.data)) {
          const id = str(item.id);
          if (!id) continue;
          models.push(entry(id, str(item.display_name) ?? id, anthropicEfforts(item.capabilities), num(item.max_input_tokens)));
        }
        after = body.has_more === true ? str(body.last_id) ?? "" : "";
        if (!after) break;
      }
      return sort(models);
    }
    case "openrouter": {
      const body = await getJson(`${base}/models`, bearer, who, fetcher) as { data?: unknown };
      return sort(records(body.data).flatMap((item) => {
        const id = str(item.id);
        const output = (item.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
        if (!id || (Array.isArray(output) && !output.includes("text"))) return [];
        return [entry(id, str(item.name) ?? id, openrouterEfforts(item), num(item.context_length))];
      }));
    }
    default: {
      const body = await getJson(`${base}/models`, bearer, who, fetcher) as { data?: unknown };
      const all = provider.kind === "meta";
      return sort(records(body.data).flatMap((item) => {
        const id = str(item.id);
        return id ? [entry(id, id, all ? ALL_EFFORTS : [])] : [];
      }));
    }
  }
}

/** Anthropic's effort levels per model, and none (thinking off) when it can think. */
export function anthropicEfforts(capabilities: unknown): readonly ReasoningEffort[] {
  const caps = (typeof capabilities === "object" && capabilities !== null ? capabilities : {}) as Record<string, Record<string, unknown> | undefined>;
  const budgeted = (caps.thinking?.types as { enabled?: { supported?: unknown } } | undefined)?.enabled?.supported;
  if (caps.thinking?.supported === false || budgeted === false) return [];
  const effort = caps.effort;
  if (!effort || effort.supported === false) return [];
  const levels = (["low", "medium", "high", "xhigh", "max"] as const).filter((level) => (effort[level] as { supported?: unknown } | undefined)?.supported === true);
  return levels.length ? ["none", ...levels] : [];
}

export function openrouterEfforts(model: Record<string, unknown>): readonly ReasoningEffort[] {
  const reasoning = model.reasoning as { supported_efforts?: unknown; mandatory?: unknown } | null | undefined;
  if (reasoning && typeof reasoning === "object") {
    const listed = Array.isArray(reasoning.supported_efforts) ? reasoning.supported_efforts.filter(isReasoningEffort) : null;
    const levels: readonly ReasoningEffort[] = (listed ?? ALL_EFFORTS).filter((level) => level !== "none");
    const ordered = ALL_EFFORTS.filter((level) => levels.includes(level));
    return reasoning.mandatory === true ? ordered : ["none", ...ordered];
  }
  const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  return parameters.includes("reasoning") || parameters.includes("reasoning_effort") ? LEVELS("none", "low", "medium", "high") : [];
}
