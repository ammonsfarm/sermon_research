import { createSession, isRateLimited, isValidEmail, normalizeEmail, recordFailure, sessionCookie } from "./auth.ts";
import { type Context, clientIp, redirect, chrome } from "./context.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { html, page } from "./html.ts";
import { getKey } from "./keys.ts";
import { sendEmail } from "./providers.ts";
import { type EmailSettings, getSetting } from "./settings.ts";

const LINK_MINUTES = 15;
/** Every link request counts toward the limit, so nobody can flood an inbox. */
const LINK_BUCKET = (kind: string, value: string) => `link-${kind}:${value}`;

export async function emailSignInEnabled(db: D1Database): Promise<boolean> {
  const email = await getSetting<EmailSettings>(db, "email");
  return Boolean(email && "from" in email);
}

/** POST /login/link: always shows the same page, so it never reveals which emails have accounts. */
export async function requestLink(context: Context): Promise<Response> {
  const { db, env, request, url } = context;
  const form = await request.formData();
  const email = normalizeEmail(String(form.get("email") ?? ""));
  const sent = page("Check your email", html`<h1>Check your email</h1>
<p class="lead">If ${email} has an account here, a sign-in link is on its way. It works once and expires in ${LINK_MINUTES} minutes.</p>
<p><a href="/login">Back to sign in</a></p>`, chrome(context));

  const settings = await getSetting<EmailSettings>(db, "email");
  if (!settings || !("from" in settings) || !isValidEmail(email)) return sent;
  const buckets = [LINK_BUCKET("ip", clientIp(request)), LINK_BUCKET("email", email)];
  if (await isRateLimited(db, buckets)) return sent;
  await recordFailure(db, buckets);

  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  const apiKey = await getKey(db, env.APP_SECRET ?? "", "email");
  if (!user || !apiKey) return sent;

  const token = randomToken();
  const now = Date.now();
  await db.prepare("INSERT INTO login_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), user.id, new Date(now).toISOString(), new Date(now + LINK_MINUTES * 60_000).toISOString()).run();
  const site = context.ministry?.siteTitle ?? "Sermon Research";
  try {
    await sendEmail({
      apiKey, from: settings.from, to: email,
      subject: `Sign in to ${site}`,
      text: `Open this link to sign in to ${site}:\n\n${url.origin}/login/link?token=${token}\n\nIt works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
    });
  } catch (error) {
    console.error("sign-in link email failed", error);
  }
  return sent;
}

/**
 * GET /login/link?token=… only shows a button. Email scanners open links
 * automatically, so the token is spent by the POST, not by the visit.
 */
export async function showLink(context: Context): Promise<Response> {
  const token = context.url.searchParams.get("token") ?? "";
  const row = token.length <= 128
    ? await context.db.prepare("SELECT expires_at, used_at FROM login_links WHERE token_hash = ?").bind(await sha256(token)).first<{ expires_at: string; used_at: string | null }>()
    : null;
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return expired(context);
  return page("Sign in", html`<h1>Sign in</h1>
<form method="post" action="/login/link/confirm">
<input type="hidden" name="token" value="${token}">
<button type="submit">Continue signing in</button>
</form>`, chrome(context));
}

/** POST /login/link/confirm spends the token and starts a 30-day session. */
export async function confirmLink(context: Context): Promise<Response> {
  const form = await context.request.formData();
  const tokenHash = await sha256(String(form.get("token") ?? "").slice(0, 128));
  const now = new Date().toISOString();
  const spent = await context.db.prepare("UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, now).run();
  if (spent.meta.changes !== 1) return expired(context);
  const link = await context.db.prepare("SELECT l.user_id, u.role FROM login_links l JOIN users u ON u.id = l.user_id WHERE l.token_hash = ?")
    .bind(tokenHash).first<{ user_id: string; role: string }>();
  if (!link) return expired(context);
  await context.db.prepare("DELETE FROM login_links WHERE expires_at < ?").bind(now).run();
  return redirect(link.role === "admin" ? "/admin" : "/", sessionCookie(await createSession(context.db, link.user_id)));
}

function expired(context: Context): Response {
  return page("Link expired", html`<h1>That link has expired</h1>
<p class="lead">Sign-in links work once and expire after ${LINK_MINUTES} minutes.</p>
<p><a href="/login">Get a new link</a></p>`, { status: 410, ...chrome(context) });
}
