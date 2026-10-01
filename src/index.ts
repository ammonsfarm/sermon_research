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
} from "./auth.ts";
import { timingSafeEqual } from "./crypto.ts";
import { clientIp, type Context, redirect, requireAdmin, chrome } from "./context.ts";
import type { AppEnv } from "./env.ts";
import { APP_SCRIPT, STYLESHEET } from "./assets.ts";
import { page, SECURITY_HEADERS } from "./html.ts";
import { serveAudio } from "./audio.ts";
import { ask, conversation, deleteConversation, home, library, researchRedirect } from "./ask.ts";
import { deleteDocument, documentDownload, documentPage, retryDocument } from "./documents.ts";
import { sermonPage, sermonsPage, transcriptDownload } from "./sermons.ts";
import { checkNow, episodesDashboard, hourlyTick, importStep, queueFromDashboard, saveConcurrency, scheduleSettings } from "./imports.ts";
import { keyInfo } from "./keys.ts";
import { acceptInvite, membersPage, reinviteMember, removeMember, showInvite } from "./members.ts";
import { canViewResearch, researchAdmin, researchSettings } from "./research.ts";
import { confirmLink, emailSignInEnabled, requestLink, showLink } from "./links.ts";
import { ensureSchema } from "./schema.ts";
import { MODE_COOKIE, modeCookie, parseMode, safeBack } from "./theme.ts";
import {
  type CheckedSettings,
  type EmailSettings,
  getSetting,
  getSetupStep,
  type LlmSettingsRecord,
  type Ministry,
  nextStep,
  parseMinistry,
  type PodcastSettings,
  putSetting,
} from "./settings.ts";
import { isProviderStep, stepForm, stepSubmit } from "./steps.ts";
import {
  adminView,
  loginView,
  ministryValues,
  ministryView,
  missingSecretView,
  notFoundView,
  setupAdminView,
} from "./views.ts";

/** APP_SECRET must be long enough to resist guessing, since it gates setup. */
const MIN_SECRET_LENGTH = 32;

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/assets/app.css") {
      return new Response(STYLESHEET, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600", ...SECURITY_HEADERS } });
    }
    if (url.pathname === "/assets/app.js") {
      return new Response(APP_SCRIPT, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600", ...SECURITY_HEADERS } });
    }
    if (request.method === "POST" && !isSameOrigin(request, url)) {
      return new Response("Cross-site form submissions are not allowed.", { status: 403 });
    }
    await ensureSchema(env.DB);
    const session = await readSession(env.DB, readCookie(request, SESSION_COOKIE));
    const [ministry, research] = await Promise.all([getSetting<Ministry>(env.DB, "ministry"), getSetting<{ access?: string }>(env.DB, "research")]);
    const context: Context = { request, env, db: env.DB, url, session, ministry, researchOpen: research?.access === "public", mode: parseMode(readCookie(request, MODE_COOKIE)) };
    const response = await route(context);
    if (session?.refreshedToken && !response.headers.has("Set-Cookie")) {
      const headers = new Headers(response.headers);
      headers.append("Set-Cookie", sessionCookie(session.refreshedToken));
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },

  /** The hourly cron in wrangler.jsonc. The schedule itself lives in D1, so churches never edit the cron. */
  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    await ensureSchema(env.DB);
    await hourlyTick(env, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<AppEnv>;

export { DocumentWorkflow, EpisodeWorkflow } from "./workflow.ts";

async function route(context: Context): Promise<Response> {
  const { request, url } = context;
  const key = `${request.method} ${url.pathname}`;
  switch (key) {
    case "GET /": return home(context);
    case "GET /library": return library(context);
    case "GET /setup": return setupForm(context);
    case "POST /setup": return setupSubmit(context);
    case "GET /setup/ministry": return ministryForm(context, true);
    case "POST /setup/ministry": return ministrySubmit(context, true);
    case "GET /login": return loginForm(context);
    case "POST /login": return loginSubmit(context);
    case "POST /login/link": return requestLink(context);
    case "GET /login/link": return showLink(context);
    case "POST /login/link/confirm": return confirmLink(context);
    case "POST /appearance": return appearance(context);
    case "POST /logout": return logout(context, false);
    case "POST /logout-all": return logout(context, true);
    case "GET /admin": return admin(context);
    case "GET /admin/ministry": return ministryForm(context, false);
    case "POST /admin/ministry": return ministrySubmit(context, false);
    case "GET /setup/import":
    case "POST /setup/import": return importStep(context);
    case "GET /admin/episodes": return episodesDashboard(context);
    case "POST /admin/episodes/check": return checkNow(context);
    case "POST /admin/episodes/queue": return queueFromDashboard(context);
    case "POST /admin/episodes/concurrency": return saveConcurrency(context);
    case "GET /admin/schedule":
    case "POST /admin/schedule": return scheduleSettings(context);
    case "GET /research": return researchRedirect();
    case "POST /research": return ask(context);
    case "GET /episodes": return sermonsPage(context);
    case "GET /documents": return redirect("/library");
    case "GET /admin/research":
    case "POST /admin/research": return researchAdmin(context);
    case "GET /admin/members":
    case "POST /admin/members": return membersPage(context);
    case "POST /admin/members/invite": return reinviteMember(context);
    case "POST /admin/members/remove": return removeMember(context);
    case "GET /invite": return showInvite(context);
    case "POST /invite": return acceptInvite(context);
    default: {
      const episode = /^\/episodes\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (episode && request.method === "GET") return sermonPage(context, episode[1]!);
      const transcript = /^\/episodes\/([0-9a-f-]{36})\/transcript\.(md|txt)$/u.exec(url.pathname);
      if (transcript && request.method === "GET") return transcriptDownload(context, transcript[1]!, transcript[2] as "md" | "txt");
      const thread = /^\/ask\/([0-9a-f-]{36})(\/delete)?$/u.exec(url.pathname);
      if (thread && request.method === "GET" && !thread[2]) return conversation(context, thread[1]!);
      if (thread && request.method === "POST" && thread[2]) return deleteConversation(context, thread[1]!);
      const document = /^\/documents\/([0-9a-f-]{36})(\.md|\/delete|\/retry)?$/u.exec(url.pathname);
      if (document && request.method === "GET" && !document[2]) return documentPage(context, document[1]!);
      if (document && request.method === "GET" && document[2] === ".md") return documentDownload(context, document[1]!);
      if (document && request.method === "POST" && document[2] === "/delete") return deleteDocument(context, document[1]!);
      if (document && request.method === "POST" && document[2] === "/retry") return retryDocument(context, document[1]!);
      const audio = /^\/audio\/([0-9a-f-]{36})$/u.exec(url.pathname);
      if (audio && (request.method === "GET" || request.method === "HEAD")) return serveAudio(context, audio[1]!, () => canViewResearch(context));
      const match = /^\/(setup|admin)\/([a-z]+)$/u.exec(url.pathname);
      if (match && isProviderStep(match[2]!) && (request.method === "GET" || request.method === "POST")) {
        const wizard = match[1] === "setup";
        return request.method === "GET" ? stepForm(context, match[2], wizard) : stepSubmit(context, match[2], wizard);
      }
      return page("Not found", notFoundView(), { status: 404, ...chrome(context) });
    }
  }
}



function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
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


async function ministryForm(context: Context, step: boolean): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (step && current !== "ministry") return redirect(current === "complete" ? "/admin" : `/setup/${current}`);
  const values = context.ministry ? ministryValues(context.ministry) : {};
  return page("Ministry", ministryView({ action: step ? "/setup/ministry" : "/admin/ministry", step, values }), chrome(context));
}

async function ministrySubmit(context: Context, step: boolean): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const parsed = parseMinistry(await context.request.formData());
  if ("errors" in parsed) {
    const action = step ? "/setup/ministry" : "/admin/ministry";
    return page("Ministry", ministryView({ action, step, errors: parsed.errors, values: parsed.values }), { status: 400, ...chrome(context) });
  }
  await putSetting(context.db, "ministry", parsed.ministry);
  if (step && (await getSetupStep(context.db)) === "ministry") {
    await putSetting(context.db, "setup_step", nextStep("ministry"));
    return redirect(`/setup/${nextStep("ministry")}`);
  }
  return redirect(step ? "/admin" : "/admin?saved=1");
}

async function admin(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (!context.ministry || current !== "complete") return redirect(`/setup/${current}`);
  const { db } = context;
  const [podcast, llm, embeddings, transcription, email, keys, research] = await Promise.all([
    getSetting<PodcastSettings>(db, "podcast"),
    getSetting<LlmSettingsRecord>(db, "llm"),
    getSetting<CheckedSettings>(db, "embeddings"),
    getSetting<CheckedSettings>(db, "transcription"),
    getSetting<EmailSettings>(db, "email"),
    keyInfo(db),
    researchSettings(db),
  ]);
  return page("Admin", adminView({
    user: context.session!.user, ministry: context.ministry, saved: context.url.searchParams.has("saved"),
    podcast, llm, embeddings, transcription, email, keys, research,
  }), chrome(context));
}

async function loginForm(context: Context): Promise<Response> {
  if (!(await hasAdmin(context.db))) return redirect("/setup");
  if (context.session) return redirect(context.session.user.role === "admin" ? "/admin" : "/");
  return page("Sign in", loginView({}, {}, await emailSignInEnabled(context.db)), chrome(context));
}

async function loginSubmit(context: Context): Promise<Response> {
  const { db, request } = context;
  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const buckets = [`login-ip:${clientIp(request)}`, `login-email:${email}`];
  if (await isRateLimited(db, buckets)) {
    return page("Sign in", loginView({ form: "Too many attempts. Wait 15 minutes and try again." }, { email }, await emailSignInEnabled(db)), { status: 429, ...chrome(context) });
  }
  const user = await authenticate(db, email, String(form.get("password") ?? ""));
  if (!user) {
    await recordFailure(db, buckets);
    return page("Sign in", loginView({ form: "That email and password don't match." }, { email }, await emailSignInEnabled(db)), { status: 401, ...chrome(context) });
  }
  if (context.session) await endSession(db, context.session.tokenHash);
  return redirect(user.role === "admin" ? "/admin" : "/", sessionCookie(await createSession(db, user.id)));
}

/** Saves the visitor's light / dark / system choice and returns them to the page they were on. */
async function appearance(context: Context): Promise<Response> {
  const form = await context.request.formData();
  return redirect(safeBack(form.get("back")), modeCookie(parseMode(form.get("mode"))));
}

async function logout(context: Context, everywhere: boolean): Promise<Response> {
  if (context.session) {
    if (everywhere) await endAllSessions(context.db, context.session.user.id);
    else await endSession(context.db, context.session.tokenHash);
  }
  return redirect("/", clearedSessionCookie());
}
