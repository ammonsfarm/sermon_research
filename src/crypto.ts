const encoder = new TextEncoder();

/** Cloudflare Workers reject PBKDF2 above 100,000 iterations, so this is the ceiling. */
export const PBKDF2_ITERATIONS = 100_000;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** Compares two strings without leaking where they differ. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0 && left.length === right.length;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** Returns `pbkdf2-sha256$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${base64url(salt)}$${base64url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterationText, saltText, hashText] = stored.split("$");
  const iterations = Number(iterationText);
  if (scheme !== "pbkdf2-sha256" || !saltText || !hashText || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) {
    return false;
  }
  const actual = await derive(password, fromBase64url(saltText), iterations);
  return timingSafeEqual(base64url(actual), hashText);
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Derives the AES-GCM key for stored API keys from APP_SECRET with HKDF. */
function sealingKey(appSecret: string): Promise<CryptoKey> {
  let key = keyCache.get(appSecret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(appSecret), "HKDF", false, ["deriveKey"]).then((material) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("sermon-research/provider-keys/v1") },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ));
    keyCache.set(appSecret, key);
  }
  return key;
}

/**
 * Encrypts a value for storage. `slot` is bound as associated data, so a
 * ciphertext copied into another slot will not decrypt.
 */
export async function seal(appSecret: string, slot: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(slot) }, await sealingKey(appSecret), encoder.encode(plaintext));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

/** Returns null when the value cannot be decrypted, for example after APP_SECRET changed. */
export async function unseal(appSecret: string, slot: string, sealed: string): Promise<string | null> {
  const [version, ivText, ciphertextText] = sealed.split(".");
  if (version !== "v1" || !ivText || !ciphertextText) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(ivText), additionalData: encoder.encode(slot) },
      await sealingKey(appSecret),
      fromBase64url(ciphertextText),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

const signingKeyCache = new Map<string, Promise<CryptoKey>>();

function signingKey(appSecret: string): Promise<CryptoKey> {
  let key = signingKeyCache.get(appSecret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(appSecret), "HKDF", false, ["deriveKey"]).then((material) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("sermon-research/signed-links/v1") },
        material,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      ));
    signingKeyCache.set(appSecret, key);
  }
  return key;
}

/** HMAC-SHA256 of `message` under a key derived from APP_SECRET, for short-lived signed links. */
export async function sign(appSecret: string, message: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(appSecret), encoder.encode(message))));
}
