import assert from "node:assert/strict";
import test from "node:test";

import { ADMIN, completeSetup, cookieFrom, createApp, MINISTRY } from "./helpers.ts";

test("a fresh deploy sends every visitor to setup", async () => {
  const app = createApp();
  for (const path of ["/", "/login"]) {
    const response = await app.request(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.headers.get("Location"), "/setup");
  }
  const setup = await app.request("/setup");
  assert.equal(setup.status, 200);
  assert.match(await setup.text(), /Create the admin account/);
});

test("setup refuses to start until APP_SECRET is set and long enough", async () => {
  for (const APP_SECRET of [undefined, "short-secret"]) {
    const app = createApp({ APP_SECRET } as never);
    const page = await app.request("/setup");
    assert.equal(page.status, 503);
    assert.match(await page.text(), /wrangler secret put APP_SECRET/);
    assert.equal((await app.request("/setup", { form: ADMIN })).status, 503);
  }
});

test("a wrong setup code creates nothing and is rate limited", async () => {
  const app = createApp();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.request("/setup", { form: { ...ADMIN, setupCode: "wrong" }, headers: { "CF-Connecting-IP": "203.0.113.9" } });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /doesn&#39;t match APP_SECRET/);
  }
  const blocked = await app.request("/setup", { form: ADMIN, headers: { "CF-Connecting-IP": "203.0.113.9" } });
  assert.equal(blocked.status, 429);
  const other = await app.request("/setup", { form: ADMIN, headers: { "CF-Connecting-IP": "203.0.113.10" } });
  assert.equal(other.status, 303);
});

test("setup validates the admin fields and keeps what was typed", async () => {
  const app = createApp();
  const response = await app.request("/setup", { form: { ...ADMIN, email: "not-an-email", password: "short", confirm: "short" } });
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /Enter a valid email address/);
  assert.match(body, /at least 12 characters/);
  assert.match(body, /value="Jane Admin"/);
  assert.doesNotMatch(body, /value="short"/);

  const mismatch = await app.request("/setup", { form: { ...ADMIN, confirm: "something else entirely" } });
  assert.match(await mismatch.text(), /passwords don&#39;t match/);
});

test("setup creates the admin, signs them in, then collects ministry details", async () => {
  const app = createApp();
  const created = await app.request("/setup", { form: ADMIN });
  assert.equal(created.status, 303);
  assert.equal(created.headers.get("Location"), "/setup/ministry");
  const cookie = cookieFrom(created);
  assert.match(created.headers.get("Set-Cookie") ?? "", /^__Host-sr_session=[\w-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);

  assert.equal((await app.request("/admin", { cookie })).headers.get("Location"), "/setup/ministry");
  const invalid = await app.request("/setup/ministry", { form: { ...MINISTRY, siteTitle: "", logoUrl: "http://insecure.example" }, cookie });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.text();
  assert.match(invalidBody, /Enter a site title/);
  assert.match(invalidBody, /Use an https:\/\/ address/);

  const finished = await app.request("/setup/ministry", { form: MINISTRY, cookie });
  assert.equal(finished.headers.get("Location"), "/setup/podcast");
  assert.equal((await app.request("/admin", { cookie })).headers.get("Location"), "/setup/podcast");
  assert.equal((await app.request("/setup/ministry", { cookie })).headers.get("Location"), "/setup/podcast");
});

test("after the whole wizard, the admin overview shows every connection", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const admin = await app.request("/admin", { cookie });
  assert.equal(admin.status, 200);
  const body = await admin.text();
  assert.match(body, /<title>Admin · Grace Sermons<\/title>/);
  assert.match(body, /jane@example\.org/);
  assert.match(body, /Pastor Jane Doe, John Smith/);
  assert.match(body, /Grace Church Sermons · 2 episodes/);
  assert.match(body, /gpt-test at api\.openai\.com · key ending 1234/);
  assert.match(body, /Off \(password sign-in only\)/);
  assert.equal((await app.request("/setup/ministry", { cookie })).headers.get("Location"), "/admin");
});

test("setup cannot be run again once an admin exists", async () => {
  const app = createApp();
  await completeSetup(app);
  assert.equal((await app.request("/setup")).headers.get("Location"), "/login");
  const again = await app.request("/setup", { form: { ...ADMIN, email: "intruder@example.org" } });
  assert.equal(again.headers.get("Location"), "/login");
  const admins = await app.env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
  assert.equal(admins?.n, 1);
});

test("ministry details can be edited later and are escaped on every page", async () => {
  const app = createApp();
  const cookie = await completeSetup(app);
  const saved = await app.request("/admin/ministry", { form: { ...MINISTRY, siteTitle: "<script>alert(1)</script>" }, cookie });
  assert.equal(saved.headers.get("Location"), "/admin?saved=1");
  const home = await (await app.request("/", { cookie })).text();
  assert.match(home, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(home, /<script>/);
});

test("pages carry a strict content security policy", async () => {
  const app = createApp();
  const response = await app.request("/setup");
  assert.match(response.headers.get("Content-Security-Policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const css = await app.request("/assets/app.css");
  assert.equal(css.headers.get("Content-Type"), "text/css; charset=utf-8");
});
