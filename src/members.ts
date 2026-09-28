import { createSession, endAllSessions, isRateLimited, isValidEmail, normalizeEmail, passwordProblem, recordFailure, sessionCookie } from "./auth.ts";
import { type Context, clientIp, redirect, requireAdmin, chrome } from "./context.ts";
import { hashPassword, randomToken, sha256 } from "./crypto.ts";
import { field, html, type Html, page } from "./html.ts";
import { getKey } from "./keys.ts";
import { sendEmail } from "./providers.ts";
import { type EmailSettings, getSetting } from "./settings.ts";

const INVITE_DAYS = 7;

interface MemberRow { readonly id: string; readonly name: string; readonly email: string; readonly role: "admin" | "member"; readonly password_hash: string | null; readonly created_at: string }

function membersView(context: Context, members: readonly MemberRow[], options: { errors?: Record<string, string>; values?: Record<string, string>; invite?: { name: string; link: string; emailed: boolean } } = {}): Html {
  const { errors = {}, values = {}, invite } = options;
  return html`<h1>Members</h1>
<p class="lead">Members can use the research pages when they're set to members only. Only admins can change settings.</p>
${invite ? html`<div class="alert-ok"><p><strong>${invite.name} is invited.</strong> ${invite.emailed ? "The invite was emailed, and you can also share this link:" : "Send them this link; it's shown only once:"}</p>
<pre>${invite.link}</pre><p class="hint">It works once and expires in ${INVITE_DAYS} days.</p></div>` : ""}
<table>
<thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
<tbody>${members.map((member) => html`<tr>
<td>${member.name}<br><span class="hint">${member.email}</span></td>
<td>${member.role === "admin" ? "Admin" : member.password_hash ? "Active" : "Invited"}</td>
<td>${member.role === "admin" ? "" : html`<div class="row">
<form class="inline" method="post" action="/admin/members/invite"><input type="hidden" name="id" value="${member.id}"><button class="quiet" type="submit">New invite link</button></form>
<form class="inline" method="post" action="/admin/members/remove"><input type="hidden" name="id" value="${member.id}"><button class="quiet" type="submit">Remove</button></form></div>`}</td>
</tr>`)}</tbody>
</table>
<h2>Invite someone</h2>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="/admin/members">
${field({ name: "name", label: "Name", value: values.name ?? "", error: errors.name, required: true })}
${field({ name: "email", label: "Email", type: "email", value: values.email ?? "", error: errors.email, required: true })}
<button type="submit">Create invite</button>
</form>`;
}

async function listMembers(db: D1Database): Promise<MemberRow[]> {
  return (await db.prepare("SELECT id, name, email, role, password_hash, created_at FROM users ORDER BY role, name").all<MemberRow>()).results;
}

/** Creates a single-use invite, emails it when email is set up, and returns the link. */
async function issueInvite(context: Context, user: { id: string; name: string; email: string }): Promise<{ name: string; link: string; emailed: boolean }> {
  const { db, env, url } = context;
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM invites WHERE user_id = ?").bind(user.id),
    db.prepare("INSERT INTO invites (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), user.id, new Date(now).toISOString(), new Date(now + INVITE_DAYS * 86_400_000).toISOString()),
  ]);
  const link = `${url.origin}/invite?token=${token}`;
  let emailed = false;
  const settings = await getSetting<EmailSettings>(db, "email");
  const apiKey = settings && "from" in settings ? await getKey(db, env.APP_SECRET ?? "", "email") : null;
  if (settings && "from" in settings && apiKey) {
    const site = context.ministry?.siteTitle ?? "Sermon Research";
    try {
      await sendEmail({
        apiKey, from: settings.from, to: user.email, subject: `You're invited to ${site}`,
        text: `${context.session?.user.name ?? "An admin"} invited you to ${site}, a searchable archive of sermons.\n\nOpen this link to choose a password:\n\n${link}\n\nIt works once and expires in ${INVITE_DAYS} days.`,
      });
      emailed = true;
    } catch (error) {
      console.error("invite email failed", error);
    }
  }
  return { name: user.name, link, emailed };
}

/** GET/POST /admin/members */
export async function membersPage(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const { db } = context;
  if (context.request.method === "GET") return page("Members", membersView(context, await listMembers(db)), chrome(context));

  const form = await context.request.formData();
  const values = { name: String(form.get("name") ?? "").trim().slice(0, 120), email: normalizeEmail(String(form.get("email") ?? "")) };
  const errors: Record<string, string> = {};
  if (!values.name) errors.name = "Enter their name.";
  if (!isValidEmail(values.email)) errors.email = "Enter a valid email address.";
  else if (await db.prepare("SELECT 1 FROM users WHERE email = ?").bind(values.email).first()) errors.email = "Someone with that email already has an account.";
  if (Object.keys(errors).length > 0) return page("Members", membersView(context, await listMembers(db), { errors, values }), { status: 400, ...chrome(context) });

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at) VALUES (?, ?, ?, 'member', NULL, ?, ?)")
    .bind(id, values.email, values.name, now, now).run();
  const invite = await issueInvite(context, { id, ...values });
  return page("Members", membersView(context, await listMembers(db), { invite }), chrome(context));
}

async function findMember(context: Context): Promise<MemberRow | null> {
  const id = String((await context.request.formData()).get("id") ?? "");
  return context.db.prepare("SELECT id, name, email, role, password_hash, created_at FROM users WHERE id = ? AND role = 'member'").bind(id).first<MemberRow>();
}

/** POST /admin/members/invite: a fresh link, for a lost invite or a forgotten password. */
export async function reinviteMember(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const member = await findMember(context);
  if (!member) return redirect("/admin/members");
  const invite = await issueInvite(context, member);
  return page("Members", membersView(context, await listMembers(context.db), { invite }), chrome(context));
}

/** POST /admin/members/remove */
export async function removeMember(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const member = await findMember(context);
  if (member) {
    await endAllSessions(context.db, member.id);
    await context.db.batch([
      context.db.prepare("DELETE FROM invites WHERE user_id = ?").bind(member.id),
      context.db.prepare("DELETE FROM login_links WHERE user_id = ?").bind(member.id),
      context.db.prepare("DELETE FROM users WHERE id = ? AND role = 'member'").bind(member.id),
    ]);
  }
  return redirect("/admin/members");
}

async function findInvite(db: D1Database, token: string): Promise<{ token_hash: string; user_id: string; name: string } | null> {
  if (!token || token.length > 128) return null;
  return db.prepare(
    `SELECT i.token_hash, i.user_id, u.name FROM invites i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
  ).bind(await sha256(token), new Date().toISOString()).first();
}

function inviteView(name: string, token: string, errors: Record<string, string> = {}): Html {
  return html`<h1>Welcome, ${name}</h1>
<p class="lead">Choose a password to finish setting up your account.</p>
<form method="post" action="/invite">
<input type="hidden" name="token" value="${token}">
${field({ name: "password", label: "Password", type: "password", error: errors.password, hint: "At least 12 characters.", required: true, autocomplete: "new-password" })}
${field({ name: "confirm", label: "Confirm password", type: "password", error: errors.confirm, required: true, autocomplete: "new-password" })}
<button type="submit">Save password</button>
</form>`;
}

const expired = (context: Context) => page("Invite", html`<h1>This invite has expired</h1><p class="lead">It was already used or is more than ${INVITE_DAYS} days old. Ask an admin for a new link.</p><p><a href="/login">Sign in</a></p>`, { status: 410, ...chrome(context) });

/** GET /invite?token=… */
export async function showInvite(context: Context): Promise<Response> {
  const token = context.url.searchParams.get("token") ?? "";
  const invite = await findInvite(context.db, token);
  return invite ? page("Invite", inviteView(invite.name, token), chrome(context)) : expired(context);
}

/** POST /invite: sets the password, spends the invite and signs the member in. */
export async function acceptInvite(context: Context): Promise<Response> {
  const { db, request } = context;
  const buckets = [`invite:${clientIp(request)}`];
  if (await isRateLimited(db, buckets)) return page("Invite", html`<h1>Too many attempts</h1><p>Wait 15 minutes and try again.</p>`, { status: 429, ...chrome(context) });
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const invite = await findInvite(db, token);
  if (!invite) {
    await recordFailure(db, buckets);
    return expired(context);
  }
  const password = String(form.get("password") ?? "");
  const problem = passwordProblem(password);
  const errors: Record<string, string> = {};
  if (problem) errors.password = problem;
  else if (password !== String(form.get("confirm") ?? "")) errors.confirm = "The passwords don't match.";
  if (Object.keys(errors).length > 0) return page("Invite", inviteView(invite.name, token, errors), { status: 400, ...chrome(context) });

  const now = new Date().toISOString();
  const spent = await db.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, invite.token_hash).run();
  if (spent.meta.changes !== 1) return expired(context);
  await db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(password), now, invite.user_id).run();
  await endAllSessions(db, invite.user_id);
  return redirect("/", sessionCookie(await createSession(db, invite.user_id)));
}
