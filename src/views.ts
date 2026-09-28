import type { ResearchSettings } from "./research.ts";
import type { User } from "./auth.ts";
import type { keyInfo } from "./keys.ts";
import { field, html, type Html } from "./html.ts";
import type { CheckedSettings, EmailSettings, LlmSettingsRecord, Ministry, PodcastSettings } from "./settings.ts";

type Errors = Readonly<Record<string, string>>;
type Values = Readonly<Record<string, string>>;


export function missingSecretView(): Html {
  return html`<h1>Finish deploying first</h1>
<p class="lead">This site needs one secret before setup can start. It proves you own this deployment, and later it encrypts the API keys you enter.</p>
<p>From the project folder, run:</p>
<pre>openssl rand -base64 32
npx wrangler secret put APP_SECRET</pre>
<p>Paste the random value when Wrangler asks, and keep a copy somewhere safe. Then reload this page.</p>`;
}

export function setupAdminView(errors: Errors = {}, values: Values = {}): Html {
  return html`<p class="steps">Setup · step 1 of 8</p>
<h1>Create the admin account</h1>
<p class="lead">You'll use this account to manage the podcast, AI settings and members.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="/setup">
${field({ name: "setupCode", label: "Setup code", type: "password", error: errors.setupCode, hint: "The APP_SECRET value you set with Wrangler.", required: true, autocomplete: "off" })}
${field({ name: "name", label: "Your name", value: values.name ?? "", error: errors.name, required: true, autocomplete: "name" })}
${field({ name: "email", label: "Email", type: "email", value: values.email ?? "", error: errors.email, required: true, autocomplete: "email" })}
${field({ name: "password", label: "Password", type: "password", error: errors.password, hint: "At least 12 characters.", required: true, autocomplete: "new-password" })}
${field({ name: "confirm", label: "Confirm password", type: "password", error: errors.confirm, required: true, autocomplete: "new-password" })}
<button type="submit">Create admin account</button>
</form>`;
}

export function ministryView(options: { action: string; step: boolean; errors?: Errors; values?: Values }): Html {
  const errors = options.errors ?? {};
  const values = options.values ?? {};
  return html`${options.step ? html`<p class="steps">Setup · step 2 of 8</p>` : ""}
<h1>About your ministry</h1>
<p class="lead">These names appear on the site and help the AI describe sermons accurately.</p>
<form method="post" action="${options.action}">
${field({ name: "siteTitle", label: "Site title", value: values.siteTitle ?? "", error: errors.siteTitle, hint: "Shown at the top of every page, for example “Grace Church Sermon Archive”.", required: true })}
${field({ name: "churchName", label: "Church or ministry name", value: values.churchName ?? "", error: errors.churchName, required: true })}
${field({ name: "speakerNames", label: "Speaker names", value: values.speakerNames ?? "", error: errors.speakerNames, hint: "Separate names with commas, for example “Pastor Jane Doe, John Smith”." })}
${field({ name: "description", label: "Short description", type: "textarea", value: values.description ?? "", error: errors.description })}
${field({ name: "logoUrl", label: "Logo address", type: "url", value: values.logoUrl ?? "", error: errors.logoUrl, hint: "Optional. An https:// link to an image." })}
<button type="submit">${options.step ? "Continue" : "Save"}</button>
</form>`;
}

export function ministryValues(ministry: Ministry): Values {
  return {
    siteTitle: ministry.siteTitle,
    churchName: ministry.churchName,
    speakerNames: ministry.speakerNames.join(", "),
    description: ministry.description,
    logoUrl: ministry.logoUrl,
  };
}

export function loginView(errors: Errors = {}, values: Values = {}, emailLinks = false): Html {
  return html`<h1>Sign in</h1>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="/login">
${field({ name: "email", label: "Email", type: "email", value: values.email ?? "", required: true, autocomplete: "email" })}
${field({ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" })}
<button type="submit">Sign in</button>
</form>
${emailLinks ? html`<h2>Or get a sign-in link</h2>
<form method="post" action="/login/link">
${field({ name: "email", label: "Email", type: "email", value: values.email ?? "", required: true, autocomplete: "email" })}
<button class="quiet" type="submit">Email me a link</button>
</form>` : ""}`;
}

/** The home page for visitors who can't use the research pages (members-only sites, or setup not finished). */
export function homeView(ministry: Ministry | null, user: User | null, _canResearch: boolean): Html {
  return html`<section class="ask-hero">
<h1>${ministry?.siteTitle ?? "Sermon Research"}</h1>
${ministry?.description ? html`<p class="lead">${ministry.description}</p>` : ""}
${user
    ? html`<p>This site is still being set up. Check back soon.</p>`
    : html`<p>Sign in to ask questions about the sermons, read and listen along, and create outlines and study guides.</p>
<p><a class="button" href="/login">Sign in</a></p>`}
</section>`;
}

export interface AdminOverview {
  readonly user: User;
  readonly ministry: Ministry;
  readonly saved: boolean;
  readonly podcast: PodcastSettings | null;
  readonly llm: LlmSettingsRecord | null;
  readonly embeddings: CheckedSettings | null;
  readonly transcription: CheckedSettings | null;
  readonly email: EmailSettings | null;
  readonly keys: Awaited<ReturnType<typeof keyInfo>>;
  readonly research: ResearchSettings;
}

function keyLabel(info: { last4: string } | undefined): string {
  return info ? ` · key ending ${info.last4}` : "";
}

export function adminView(overview: AdminOverview): Html {
  const { user, ministry, podcast, llm, embeddings, transcription, email, keys } = overview;
  return html`<h1>Admin</h1>
<p class="lead">Signed in as ${user.name} (${user.email}).</p>
${overview.saved ? html`<p>Saved.</p>` : ""}
<h2>Ministry</h2>
<dl>
<dt>Site title</dt><dd>${ministry.siteTitle}</dd>
<dt>Church</dt><dd>${ministry.churchName}</dd>
<dt>Speakers</dt><dd>${ministry.speakerNames.join(", ") || "None yet"}</dd>
</dl>
<p><a href="/admin/ministry">Edit ministry details</a></p>
<h2>Connections</h2>
<dl>
<dt><a href="/admin/podcast">Podcast</a></dt><dd>${podcast ? `${podcast.title} · ${podcast.episodeCount} episodes` : "Not set"}</dd>
<dt><a href="/admin/llm">Answers AI</a></dt><dd>${llm ? `${llm.model} at ${new URL(llm.baseUrl).host}${keyLabel(keys.llm)}` : "Not set"}</dd>
<dt><a href="/admin/embeddings">Embeddings</a></dt><dd>${embeddings ? `${embeddings.model}${keyLabel(keys.embeddings)}` : "Not set"}</dd>
<dt><a href="/admin/transcription">Transcription</a></dt><dd>${transcription ? `Mistral ${transcription.model}${keyLabel(keys.transcription)}` : "Not set"}</dd>
<dt><a href="/admin/email">Email</a></dt><dd>${email && "from" in email ? `Resend from ${email.from}${keyLabel(keys.email)}` : "Off (password sign-in only)"}</dd>
</dl>
<h2>Episodes</h2>
<p><a href="/admin/episodes">Import progress and episodes</a> · <a href="/admin/schedule">Schedule</a></p>
<h2>Research</h2>
<dl>
<dt><a href="/admin/research">Access</a></dt><dd>${overview.research.access === "public" ? "Anyone" : "Members only"} · up to ${overview.research.dailyQuestions} questions a day</dd>
<dt><a href="/admin/members">Members</a></dt><dd>Invite and remove people</dd>
</dl>
<p><a href="/">Open the Ask page</a></p>
<h2>Sessions</h2>
<div class="row">
<form class="inline" method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form>
<form class="inline" method="post" action="/logout-all"><button class="quiet" type="submit">Sign out on all devices</button></form>
</div>`;
}

export function notFoundView(): Html {
  return html`<h1>Page not found</h1><p><a href="/">Go to the home page</a></p>`;
}
