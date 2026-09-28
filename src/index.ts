import {
  authenticate,
  clearedSessionCookie,
  createFirstAdmin,
  createSession,
  endAllSessions,
  endSession,
  hasAdmin,
  isRateLimited,
  isValidEmail,
  normalizeEmail,
  passwordProblem,
  readCookie,
  readSession,
  recordFailure,
  SESSION_COOKIE,
  sessionCookie,
  type Session,
} from "./auth.ts";
import { timingSafeEqual } from "./crypto.ts";
import type { AppEnv } from "./env.ts";
import { page, SECURITY_HEADERS, STYLESHEET } from "./html.ts";
import { ensureSchema } from "./schema.ts";
import { getSetting, getSetupStep, parseMinistry, putSetting, type Ministry } from "./settings.ts";
import {
  adminView,
  homeView,
  loginView,
  ministryValues,
  ministryView,
  missingSecretView,
  notFoundView,
  setupAdminView,
} from "./views.ts";

/** APP_SECRET must be long enough to resist guessing, since it gates setup. */
const MIN_SECRET_LENGTH = 32;

interface Context {
  readonly request: Request;
  readonly env: AppEnv;
  readonly db: D1Database;
  readonly url: URL;
  readonly session: Session | null;
  readonly ministry: Ministry | null;
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/assets/app.css") {
      return new Response(STYLESHEET, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", ...SECURITY_HEADERS } });
    }
    if (request.method === "POST" && !isSameOrigin(request, url)) {
      return new Response("Cross-site form submissions are not allowed.", { status: 403 });
    }
    await ensureSchema(env.DB);
    const session = await readSession(env.DB, readCookie(request, SESSION_COOKIE));
    const context: Context = { request, env, db: env.DB, url, session, ministry: await getSetting<Ministry>(env.DB, "ministry") };
    const response = await route(context);
    if (session?.refreshedToken && !response.headers.has("Set-Cookie")) {
      const headers = new Headers(response.headers);
      headers.append("Set-Cookie", sessionCookie(session.refreshedToken));
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
} satisfies ExportedHandler<AppEnv>;

async function route(context: Context): Promise<Response> {
  const { request, url } = context;
  const key = `${request.method} ${url.pathname}`;
  switch (key) {
    case "GET /": return home(context);
    case "GET /setup": return setupForm(context);
    case "POST /setup": return setupSubmit(context);
    case "GET /setup/ministry": return ministryForm(context, true);
    case "POST /setup/ministry": return ministrySubmit(context, true);
    case "GET /login": return loginForm(context);
    case "POST /login": return loginSubmit(context);
    case "POST /logout": return logout(context, false);
    case "POST /logout-all": return logout(context, true);
    case "GET /admin": return admin(context);
    case "GET /admin/ministry": return ministryForm(context, false);
    case "POST /admin/ministry": return ministrySubmit(context, false);
    default:
      return page("Not found", notFoundView(), { status: 404, ...siteTitle(context) });
  }
}

function siteTitle(context: Context): { siteTitle?: string } {
  return context.ministry ? { siteTitle: context.ministry.siteTitle } : {};
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function home(context: Context): Promise<Response> {
  if (!(await hasAdmin(context.db))) return redirect("/setup");
  return page("Home", homeView(context.ministry, context.session?.user ?? null), siteTitle(context));
}

async function setupForm(context: Context): Promise<Response> {
  if (await hasAdmin(context.db)) return redirect(context.session?.user.role === "admin" ? "/admin" : "/login");
  if ((context.env.APP_SECRET ?? "").length < MIN_SECRET_LENGTH) return page("Setup", missingSecretView(), { status: 503 });
  return page("Setup", setupAdminView());
}

async function setupSubmit(context: Context): Promise<Response> {
  const { db, env, request } = context;
  if (await hasAdmin(db)) return redirect("/login");
  const secret = env.APP_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) return page("Setup", missingSecretView(), { status: 503 });

  const buckets = [`setup:${clientIp(request)}`];
  if (await isRateLimited(db, buckets)) {
    return page("Setup", setupAdminView({ form: "Too many attempts. Wait 15 minutes and try again." }), { status: 429 });
  }
  const form = await request.formData();
  const values = { name: String(form.get("name") ?? "").trim().slice(0, 120), email: normalizeEmail(String(form.get("email") ?? "")) };
  const password = String(form.get("password") ?? "");
  const errors: Record<string, string> = {};
  if (!(await timingSafeEqual(String(form.get("setupCode") ?? ""), secret))) errors.setupCode = "That setup code doesn't match APP_SECRET.";
  if (!values.name) errors.name = "Enter your name.";
  if (!isValidEmail(values.email)) errors.email = "Enter a valid email address.";
  const problem = passwordProblem(password);
  if (problem) errors.password = problem;
  else if (password !== String(form.get("confirm") ?? "")) errors.confirm = "The passwords don't match.";
  if (errors.setupCode) await recordFailure(db, buckets);
  if (Object.keys(errors).length > 0) return page("Setup", setupAdminView(errors, values), { status: 400 });

  const user = await createFirstAdmin(db, { ...values, password });
  if (!user) return redirect("/login");
  return redirect("/setup/ministry", sessionCookie(await createSession(db, user.id)));
}

async function requireAdmin(context: Context): Promise<Response | null> {
  if (!context.session) return redirect("/login");
  if (context.session.user.role !== "admin") return page("Not allowed", notFoundView(), { status: 403, ...siteTitle(context) });
  return null;
}

async function ministryForm(context: Context, step: boolean): Promise<Response> {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  if (step && (await getSetupStep(context.db)) === "complete") return redirect("/admin");
  const values = context.ministry ? ministryValues(context.ministry) : {};
  return page("Ministry", ministryView({ action: step ? "/setup/ministry" : "/admin/ministry", step, values }), siteTitle(context));
}

async function ministrySubmit(context: Context, step: boolean): Promise<Response> {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  const parsed = parseMinistry(await context.request.formData());
  if ("errors" in parsed) {
    const action = step ? "/setup/ministry" : "/admin/ministry";
    return page("Ministry", ministryView({ action, step, errors: parsed.errors, values: parsed.values }), { status: 400, ...siteTitle(context) });
  }
  await putSetting(context.db, "ministry", parsed.ministry);
  if (step) await putSetting(context.db, "setup_step", "complete");
  return redirect(step ? "/admin" : "/admin?saved=1");
}

async function admin(context: Context): Promise<Response> {
  const denied = await requireAdmin(context);
  if (denied) return denied;
  if (!context.ministry || (await getSetupStep(context.db)) !== "complete") return redirect("/setup/ministry");
  return page("Admin", adminView(context.session!.user, context.ministry, context.url.searchParams.has("saved")), siteTitle(context));
}

async function loginForm(context: Context): Promise<Response> {
  if (!(await hasAdmin(context.db))) return redirect("/setup");
  if (context.session) return redirect(context.session.user.role === "admin" ? "/admin" : "/");
  return page("Sign in", loginView(), siteTitle(context));
}

async function loginSubmit(context: Context): Promise<Response> {
  const { db, request } = context;
  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const buckets = [`login-ip:${clientIp(request)}`, `login-email:${email}`];
  if (await isRateLimited(db, buckets)) {
    return page("Sign in", loginView({ form: "Too many attempts. Wait 15 minutes and try again." }, { email }), { status: 429, ...siteTitle(context) });
  }
  const user = await authenticate(db, email, String(form.get("password") ?? ""));
  if (!user) {
    await recordFailure(db, buckets);
    return page("Sign in", loginView({ form: "That email and password don't match." }, { email }), { status: 401, ...siteTitle(context) });
  }
  if (context.session) await endSession(db, context.session.tokenHash);
  return redirect(user.role === "admin" ? "/admin" : "/", sessionCookie(await createSession(db, user.id)));
}

async function logout(context: Context, everywhere: boolean): Promise<Response> {
  if (context.session) {
    if (everywhere) await endAllSessions(context.db, context.session.user.id);
    else await endSession(context.db, context.session.tokenHash);
  }
  return redirect("/", clearedSessionCookie());
}
