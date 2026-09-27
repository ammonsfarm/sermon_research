import { ROLE_NAMES, ServiceError, type RoleName } from "@aic/contracts";
import type { D1Database, D1PreparedStatement } from "./index.ts";

export type LlmApiStyle = "chat" | "completions" | "responses";

export interface LlmProviderRow {
  readonly providerId: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly status: "active" | "disabled";
  readonly hasApiKey: boolean;
  readonly apiKeyLast4: string | null;
  readonly apiKeyUpdatedAt: string | null;
  readonly capabilities: Record<string, unknown>;
  readonly probedAt: string | null;
  readonly probeError: string | null;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface LlmModelRow {
  readonly modelId: string;
  readonly providerId: string;
  readonly remoteModel: string;
  readonly displayName: string;
  readonly apiStyle: LlmApiStyle;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly sortOrder: number;
}

export interface LlmAccessGrant {
  readonly role: RoleName;
  readonly modelId: string;
}

export interface LlmUserOverride {
  readonly clerkUserId: string;
  readonly email: string;
  readonly modelId: string;
  readonly effect: "allow" | "deny";
}

/** A model a specific user may call, with the sealed key the caller must decrypt. */
export interface ResolvedLlmModel extends LlmModelRow {
  readonly providerDisplayName: string;
  readonly baseUrl: string;
  readonly apiKeyCiphertext: string;
}

const PROVIDER_ID = /^[a-z0-9-]{2,64}$/u;
const API_STYLES = new Set<LlmApiStyle>(["chat", "completions", "responses"]);
const MAX_ROWS = 2_000;

function invalid(message: string): never {
  throw new ServiceError({ code: "invalid_argument", message });
}

function unavailable(): ServiceError {
  return new ServiceError({ code: "dependency_unavailable", message: "The model registry is temporarily unavailable.", retryable: true });
}

function now(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/u, ".$1000Z");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) invalid(`${label} is invalid.`);
  return trimmed;
}

export function assertLlmProviderId(value: string): string {
  if (!PROVIDER_ID.test(value)) invalid("Provider id must be 2-64 lowercase letters, digits, or hyphens.");
  return value;
}

export function llmModelId(providerId: string, remoteModel: string): string {
  return `${assertLlmProviderId(providerId)}:${boundedText(remoteModel, "Model id", 256)}`;
}

function assertRole(role: string): RoleName {
  if (!ROLE_NAMES.includes(role as RoleName)) invalid("Role is invalid.");
  return role as RoleName;
}

async function all(statement: D1PreparedStatement): Promise<readonly Record<string, unknown>[]> {
  const result = await statement.all<Record<string, unknown>>();
  if (result.success === false || result.results.length > MAX_ROWS) throw unavailable();
  return result.results;
}

async function batch(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  if (!db.batch) throw unavailable();
  const results = await db.batch(statements);
  if (results.some((result) => result.success === false)) throw unavailable();
}

function providerFrom(row: Record<string, unknown>): LlmProviderRow {
  return {
    providerId: text(row.provider_id),
    displayName: text(row.display_name),
    baseUrl: text(row.base_url),
    status: row.status === "disabled" ? "disabled" : "active",
    hasApiKey: typeof row.api_key_last4 === "string",
    apiKeyLast4: nullableText(row.api_key_last4),
    apiKeyUpdatedAt: nullableText(row.api_key_updated_at),
    capabilities: parseJson(row.capabilities_json),
    probedAt: nullableText(row.probed_at),
    probeError: nullableText(row.probe_error),
    updatedBy: text(row.updated_by),
    updatedAt: text(row.updated_at),
  };
}

function modelFrom(row: Record<string, unknown>): LlmModelRow {
  const apiStyle = text(row.api_style) as LlmApiStyle;
  return {
    modelId: text(row.model_id),
    providerId: text(row.provider_id),
    remoteModel: text(row.remote_model),
    displayName: text(row.display_name),
    apiStyle: API_STYLES.has(apiStyle) ? apiStyle : "chat",
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
  };
}

export async function listD1LlmProviders(db: D1Database): Promise<LlmProviderRow[]> {
  const rows = await all(db.prepare(`SELECT provider_id,display_name,base_url,status,api_key_last4,api_key_updated_at,
    capabilities_json,probed_at,probe_error,updated_by,updated_at FROM llm_providers ORDER BY lower(display_name),provider_id`));
  return rows.map(providerFrom);
}

export async function readD1LlmProviderKey(db: D1Database, providerId: string): Promise<{ readonly baseUrl: string; readonly apiKeyCiphertext: string | null } | null> {
  const row = await db.prepare("SELECT base_url,api_key_ciphertext FROM llm_providers WHERE provider_id=?")
    .bind(assertLlmProviderId(providerId)).first<Record<string, unknown>>();
  return row ? { baseUrl: text(row.base_url), apiKeyCiphertext: nullableText(row.api_key_ciphertext) } : null;
}

export interface SaveLlmProviderInput {
  readonly providerId: string;
  readonly displayName: string;
  /** Already normalized by `normalizeProviderBaseUrl`. */
  readonly baseUrl: string;
  readonly status: "active" | "disabled";
  /** Sealed key and its last four characters; omit to keep the stored key. */
  readonly apiKey?: { readonly ciphertext: string; readonly last4: string } | undefined;
  readonly clearApiKey?: boolean | undefined;
  readonly actor: string;
}

export async function saveD1LlmProvider(db: D1Database, input: SaveLlmProviderInput): Promise<void> {
  const providerId = assertLlmProviderId(input.providerId);
  const displayName = boundedText(input.displayName, "Provider name", 120);
  if (!input.baseUrl.startsWith("https://") || input.baseUrl.length > 2048) invalid("Provider URL is invalid.");
  if (input.status !== "active" && input.status !== "disabled") invalid("Provider status is invalid.");
  const at = now();
  const statements = [
    db.prepare(`INSERT INTO llm_providers(provider_id,display_name,base_url,status,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id) DO UPDATE SET display_name=excluded.display_name,base_url=excluded.base_url,
        status=excluded.status,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .bind(providerId, displayName, input.baseUrl, input.status, input.actor, input.actor, at, at),
  ];
  if (input.apiKey) {
    statements.push(db.prepare("UPDATE llm_providers SET api_key_ciphertext=?,api_key_last4=?,api_key_updated_at=? WHERE provider_id=?")
      .bind(input.apiKey.ciphertext, input.apiKey.last4.slice(-4), at, providerId));
  } else if (input.clearApiKey) {
    statements.push(db.prepare("UPDATE llm_providers SET api_key_ciphertext=NULL,api_key_last4=NULL,api_key_updated_at=? WHERE provider_id=?")
      .bind(at, providerId));
  }
  await batch(db, statements);
}

export async function saveD1LlmProbe(db: D1Database, providerId: string, capabilities: unknown, error: string | null): Promise<void> {
  await db.prepare("UPDATE llm_providers SET capabilities_json=?,probe_error=?,probed_at=? WHERE provider_id=?")
    .bind(JSON.stringify(capabilities ?? {}), error ? error.slice(0, 1000) : null, now(), assertLlmProviderId(providerId)).run();
}

export async function deleteD1LlmProvider(db: D1Database, providerId: string): Promise<void> {
  await batch(db, [
    db.prepare("DELETE FROM llm_model_role_access WHERE model_id IN (SELECT model_id FROM llm_models WHERE provider_id=?)").bind(assertLlmProviderId(providerId)),
    db.prepare("DELETE FROM llm_model_user_access WHERE model_id IN (SELECT model_id FROM llm_models WHERE provider_id=?)").bind(providerId),
    db.prepare("DELETE FROM llm_models WHERE provider_id=?").bind(providerId),
    db.prepare("DELETE FROM llm_providers WHERE provider_id=?").bind(providerId),
  ]);
}

export async function listD1LlmModels(db: D1Database): Promise<LlmModelRow[]> {
  const rows = await all(db.prepare(`SELECT model_id,provider_id,remote_model,display_name,api_style,enabled,is_default,sort_order
    FROM llm_models ORDER BY sort_order,lower(display_name),model_id`));
  return rows.map(modelFrom);
}

export interface SaveLlmModelInput {
  readonly providerId: string;
  readonly remoteModel: string;
  readonly displayName: string;
  readonly apiStyle: LlmApiStyle;
  readonly enabled: boolean;
  readonly sortOrder?: number | undefined;
}

export async function saveD1LlmModel(db: D1Database, input: SaveLlmModelInput): Promise<string> {
  const modelId = llmModelId(input.providerId, input.remoteModel);
  const displayName = boundedText(input.displayName || input.remoteModel, "Model name", 120);
  if (!API_STYLES.has(input.apiStyle)) invalid("Model API style is invalid.");
  const sortOrder = Number.isSafeInteger(input.sortOrder) ? input.sortOrder! : 0;
  const at = now();
  await db.prepare(`INSERT INTO llm_models(model_id,provider_id,remote_model,display_name,api_style,enabled,sort_order,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(model_id) DO UPDATE SET display_name=excluded.display_name,api_style=excluded.api_style,
      enabled=excluded.enabled,sort_order=excluded.sort_order,updated_at=excluded.updated_at`)
    .bind(modelId, input.providerId, input.remoteModel.trim(), displayName, input.apiStyle, input.enabled ? 1 : 0, sortOrder, at, at).run();
  return modelId;
}

export async function deleteD1LlmModel(db: D1Database, modelId: string): Promise<void> {
  await batch(db, [
    db.prepare("DELETE FROM llm_model_role_access WHERE model_id=?").bind(modelId),
    db.prepare("DELETE FROM llm_model_user_access WHERE model_id=?").bind(modelId),
    db.prepare("DELETE FROM llm_models WHERE model_id=?").bind(modelId),
  ]);
}

export async function setD1DefaultLlmModel(db: D1Database, modelId: string | null): Promise<void> {
  const statements = [db.prepare("UPDATE llm_models SET is_default=0 WHERE is_default=1")];
  if (modelId) statements.push(db.prepare("UPDATE llm_models SET is_default=1,enabled=1 WHERE model_id=?").bind(modelId));
  await batch(db, statements);
}

export async function listD1LlmRoleAccess(db: D1Database): Promise<LlmAccessGrant[]> {
  const rows = await all(db.prepare("SELECT role,model_id FROM llm_model_role_access ORDER BY role,model_id"));
  return rows.map((row) => ({ role: assertRole(text(row.role)), modelId: text(row.model_id) }));
}

/** Replaces the complete model set a role receives by default. */
export async function setD1LlmRoleAccess(db: D1Database, role: string, modelIds: readonly string[], actor: string): Promise<void> {
  const target = assertRole(role);
  if (modelIds.length > 200) invalid("Too many models.");
  const at = now();
  await batch(db, [
    db.prepare("DELETE FROM llm_model_role_access WHERE role=?").bind(target),
    ...[...new Set(modelIds)].map((modelId) => db.prepare(`INSERT INTO llm_model_role_access(role,model_id,granted_at,granted_by)
      SELECT ?,model_id,?,? FROM llm_models WHERE model_id=?`).bind(target, at, actor, modelId)),
  ]);
}

export async function listD1LlmUserOverrides(db: D1Database): Promise<LlmUserOverride[]> {
  const rows = await all(db.prepare(`SELECT u.clerk_user_id,u.verified_email,a.model_id,a.effect
    FROM llm_model_user_access a JOIN users u ON u.user_id=a.user_id ORDER BY lower(coalesce(u.verified_email,'')),a.model_id`));
  return rows.map((row) => ({
    clerkUserId: text(row.clerk_user_id),
    email: text(row.verified_email),
    modelId: text(row.model_id),
    effect: row.effect === "deny" ? "deny" : "allow",
  }));
}

/** Sets or clears (`effect: null`) a per-user override on top of role defaults. */
export async function setD1LlmUserOverride(db: D1Database, input: {
  readonly clerkUserId: string;
  readonly modelId: string;
  readonly effect: "allow" | "deny" | null;
  readonly actor: string;
}): Promise<void> {
  const clerkUserId = boundedText(input.clerkUserId, "User", 512);
  if (input.effect === null) {
    await db.prepare("DELETE FROM llm_model_user_access WHERE model_id=? AND user_id IN (SELECT user_id FROM users WHERE clerk_user_id=?)")
      .bind(input.modelId, clerkUserId).run();
    return;
  }
  if (input.effect !== "allow" && input.effect !== "deny") invalid("Override effect is invalid.");
  const result = await db.prepare(`INSERT INTO llm_model_user_access(user_id,model_id,effect,granted_at,granted_by)
    SELECT u.user_id,m.model_id,?,?,? FROM users u JOIN llm_models m ON m.model_id=? WHERE u.clerk_user_id=?
    ON CONFLICT(user_id,model_id) DO UPDATE SET effect=excluded.effect,granted_at=excluded.granted_at,granted_by=excluded.granted_by`)
    .bind(input.effect, now(), input.actor, input.modelId, clerkUserId).run();
  if (result.meta?.changes === 0) invalid("Choose an existing user and model.");
}

/**
 * Models a user may call: enabled model on an active provider with a stored key, granted by an
 * active role (and not denied for the user) or explicitly allowed for the user.
 */
export async function resolveD1LlmModelsForUser(db: D1Database, clerkUserId: string): Promise<ResolvedLlmModel[]> {
  const rows = await all(db.prepare(`SELECT m.model_id,m.provider_id,m.remote_model,m.display_name,m.api_style,m.enabled,m.is_default,m.sort_order,
      p.display_name AS provider_display_name,p.base_url,p.api_key_ciphertext
    FROM llm_models m
    JOIN llm_providers p ON p.provider_id=m.provider_id
    JOIN users u ON u.clerk_user_id=? AND u.status='active'
    LEFT JOIN llm_model_user_access o ON o.user_id=u.user_id AND o.model_id=m.model_id
    WHERE m.enabled=1 AND p.status='active' AND p.api_key_ciphertext IS NOT NULL
      AND (o.effect='allow' OR (o.effect IS NULL AND EXISTS (
        SELECT 1 FROM llm_model_role_access g JOIN user_roles r ON r.role=g.role
        WHERE g.model_id=m.model_id AND r.user_id=u.user_id AND r.revoked_at IS NULL)))
    ORDER BY m.is_default DESC,m.sort_order,lower(m.display_name)`).bind(clerkUserId));
  return rows.map((row) => ({
    ...modelFrom(row),
    providerDisplayName: text(row.provider_display_name),
    baseUrl: text(row.base_url),
    apiKeyCiphertext: text(row.api_key_ciphertext),
  }));
}
