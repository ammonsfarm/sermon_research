import { seal, unseal } from "./crypto.ts";

/** Where each provider's API key is stored. */
export type KeySlot = "llm" | "embeddings" | "transcription" | "email" | `llm:${string}`;

export interface StoredKeyInfo {
  readonly last4: string;
  readonly updatedAt: string;
}

export async function putKey(db: D1Database, appSecret: string, slot: KeySlot, apiKey: string): Promise<void> {
  await db.prepare(
    `INSERT INTO provider_keys (slot, ciphertext, last4, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(slot) DO UPDATE SET ciphertext = excluded.ciphertext, last4 = excluded.last4, updated_at = excluded.updated_at`,
  ).bind(slot, await seal(appSecret, slot, apiKey), apiKey.slice(-4), new Date().toISOString()).run();
}

/** Returns the decrypted key, or null when missing or unreadable. */
export async function getKey(db: D1Database, appSecret: string, slot: KeySlot): Promise<string | null> {
  const row = await db.prepare("SELECT ciphertext FROM provider_keys WHERE slot = ?").bind(slot).first<{ ciphertext: string }>();
  return row ? unseal(appSecret, slot, row.ciphertext) : null;
}

export async function keyInfo(db: D1Database): Promise<Partial<Record<KeySlot, StoredKeyInfo>>> {
  const { results } = await db.prepare("SELECT slot, last4, updated_at FROM provider_keys").all<{ slot: KeySlot; last4: string; updated_at: string }>();
  return Object.fromEntries(results.map((row) => [row.slot, { last4: row.last4, updatedAt: row.updated_at }]));
}
