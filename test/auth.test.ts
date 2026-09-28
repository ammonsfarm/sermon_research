import assert from "node:assert/strict";
import test from "node:test";

import { createSession, readSession, SESSION_DAYS } from "../src/auth.ts";
import { sha256 } from "../src/crypto.ts";
import { ADMIN, completeSetup, cookieFrom, createApp } from "./helpers.ts";

const DAY = 86_400_000;

test("sign in with email and password, case-insensitive email", async () => {
  const app = createApp();
  await completeSetup(app);
  const response = await app.request("/login", { form: { email: "  JANE@example.ORG ", password: ADMIN.password } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "/admin");
  assert.equal((await app.request("/admin", { cookie: cookieFrom(response) })).status, 200);
});

test("a wrong password gives one generic message and counts toward the limit", async () => {
  const app = createApp();
  await completeSetup(app);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.request("/login", { form: { email: ADMIN.email, password: "wrong password!" }, headers: { "CF-Connecting-IP": `198.51.100.${attempt}` } });
    assert.equal(response.status, 401);
    assert.match(await response.text(), /email and password don&#39;t match/);
  }
  const blocked = await app.request("/login", { form: { email: ADMIN.email, password: ADMIN.password }, headers: { "CF-Connecting-IP": "198.51.100.200" } });
  assert.equal(blocked.status, 429, "the per-email bucket blocks even from a new address");
  const unknown = await app.request("/login", { form: { email: "nobody@example.org", password: "whatever12345" } });
  assert.match(await unknown.text(), /email and password don&#39;t match/);
});

test("protected pages send visitors to sign in", async () => {
  const app = createApp();
  await completeSetup(app);
  for (const path of ["/admin", "/admin/ministry"]) {
    assert.equal((await app.request(path)).headers.get("Location"), "/login", path);
  }
  assert.equal((await app.request("/admin", { cookie: "__Host-sr_session=forged" })).headers.get("Location"), "/login");
});

test("sessions last 30 days and slide forward at most once a day", async () => {
  const app = createApp();
  await completeSetup(app);
  const user = await app.env.DB.prepare("SELECT id FROM users").first<{ id: string }>();
  const start = Date.parse("2026-01-01T00:00:00Z");
  const token = await createSession(app.env.DB, user!.id, start);
  const expiry = async () => (await app.env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(await sha256(token)).first<{ expires_at: string }>())?.expires_at;

  assert.equal(await expiry(), new Date(start + SESSION_DAYS * DAY).toISOString());
  const sameDay = await readSession(app.env.DB, token, start + 3_600_000);
  assert.equal(sameDay?.refreshedToken, undefined);
  const nextWeek = await readSession(app.env.DB, token, start + 7 * DAY);
  assert.equal(nextWeek?.refreshedToken, token);
  assert.equal(await expiry(), new Date(start + 37 * DAY).toISOString());
  assert.equal(await readSession(app.env.DB, token, start + 38 * DAY), null);
  assert.equal(await expiry(), undefined, "expired sessions are deleted");
});

test("the session cookie is re-sent when a session slides forward", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const token = cookie.split("=")[1]!;
  await app.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").bind(new Date(Date.now() - 2 * DAY).toISOString(), await sha256(token)).run();
  const response = await app.request("/admin", { cookie });
  assert.equal(cookieFrom(response), cookie);
});

test("sign out ends this session; sign out everywhere ends all of them", async () => {
  const app = createApp();
  const first = await completeSetup(app);
  const second = cookieFrom(await app.request("/login", { form: { email: ADMIN.email, password: ADMIN.password } }));
  const third = cookieFrom(await app.request("/login", { form: { email: ADMIN.email, password: ADMIN.password } }));

  const out = await app.request("/logout", { method: "POST", cookie: first });
  assert.match(out.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  assert.equal((await app.request("/admin", { cookie: first })).status, 303);
  assert.equal((await app.request("/admin", { cookie: second })).status, 200);

  await app.request("/logout-all", { method: "POST", cookie: second });
  assert.equal((await app.request("/admin", { cookie: third })).status, 303);
});

test("form posts from another site are refused", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const crossSite = await app.request("/logout-all", { method: "POST", cookie, headers: { Origin: "https://evil.example" } });
  assert.equal(crossSite.status, 403);
  const noOrigin = await app.request("/logout-all", { method: "POST", cookie, headers: { Origin: "" } });
  assert.equal(noOrigin.status, 403);
  assert.equal((await app.request("/admin", { cookie })).status, 200);
});
