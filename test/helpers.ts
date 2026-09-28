import worker from "../src/index.ts";
import type { AppEnv } from "../src/env.ts";
import { resetSchemaCache } from "../src/schema.ts";
import { createTestD1 } from "./d1-sqlite.ts";

export const ORIGIN = "https://sermons.example.org";
export const SECRET = "test-secret-0123456789-abcdefghijklmnop";

export interface TestApp {
  readonly env: AppEnv;
  request(path: string, init?: { method?: string; form?: Record<string, string>; cookie?: string; headers?: Record<string, string> }): Promise<Response>;
}

export function createApp(overrides: Partial<AppEnv> = {}): TestApp {
  resetSchemaCache();
  const env = { DB: createTestD1(), APP_SECRET: SECRET, ...overrides } as AppEnv;
  return {
    env,
    request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.cookie) headers.set("Cookie", init.cookie);
      const method = init.method ?? (init.form ? "POST" : "GET");
      if (method === "POST" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
      const body = init.form ? new URLSearchParams(init.form) : undefined;
      return worker.fetch(new Request(ORIGIN + path, { method, headers, ...(body ? { body } : {}) }), env);
    },
  };
}

/** Returns `name=value` from a response's Set-Cookie, ready for a Cookie header. */
export function cookieFrom(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] ?? "";
}

export const ADMIN = { setupCode: SECRET, name: "Jane Admin", email: "Jane@Example.org", password: "correct horse battery", confirm: "correct horse battery" };
export const MINISTRY = { siteTitle: "Grace Sermons", churchName: "Grace Church", speakerNames: "Pastor Jane Doe, John Smith", description: "Sunday teaching", logoUrl: "" };

/** Runs the whole setup wizard and returns the admin's session cookie. */
export async function completeSetup(app: TestApp): Promise<string> {
  const created = await app.request("/setup", { form: ADMIN });
  const cookie = cookieFrom(created);
  await app.request("/setup/ministry", { form: MINISTRY, cookie });
  return cookie;
}
