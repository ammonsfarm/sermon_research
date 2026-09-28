import assert from "node:assert/strict";
import test from "node:test";

import { hashPassword, PBKDF2_ITERATIONS, randomToken, timingSafeEqual, verifyPassword } from "../src/crypto.ts";

test("hashes passwords with a per-user salt at the Workers iteration ceiling", async () => {
  const first = await hashPassword("correct horse battery");
  const second = await hashPassword("correct horse battery");
  assert.match(first, new RegExp(`^pbkdf2-sha256\\$${PBKDF2_ITERATIONS}\\$[\\w-]{22}\\$[\\w-]{43}$`));
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery", first), true);
  assert.equal(await verifyPassword("correct horse batterY", first), false);
});

test("rejects malformed or over-limit stored hashes instead of throwing", async () => {
  for (const stored of ["", "plain", "bcrypt$10$abc$def", "pbkdf2-sha256$999999$AAAA$AAAA", "pbkdf2-sha256$0$AAAA$AAAA"]) {
    assert.equal(await verifyPassword("anything", stored), false, stored);
  }
});

test("compares secrets of different lengths safely", async () => {
  assert.equal(await timingSafeEqual("abc", "abc"), true);
  assert.equal(await timingSafeEqual("abc", "abcd"), false);
  assert.equal(await timingSafeEqual("", "abc"), false);
});

test("generates unguessable URL-safe tokens", () => {
  const token = randomToken();
  assert.match(token, /^[\w-]{43}$/u);
  assert.notEqual(token, randomToken());
});

test("sealed keys decrypt only with the same secret and slot", async () => {
  const { seal, unseal } = await import("../src/crypto.ts");
  const sealed = await seal("secret-one-0123456789-0123456789ab", "llm", "sk-live-abc");
  assert.match(sealed, /^v1\.[\w-]{16}\.[\w-]+$/u);
  assert.doesNotMatch(sealed, /sk-live/u);
  assert.equal(await unseal("secret-one-0123456789-0123456789ab", "llm", sealed), "sk-live-abc");
  assert.equal(await unseal("secret-two-0123456789-0123456789ab", "llm", sealed), null);
  assert.equal(await unseal("secret-one-0123456789-0123456789ab", "email", sealed), null);
  assert.equal(await unseal("secret-one-0123456789-0123456789ab", "llm", "garbage"), null);
});
