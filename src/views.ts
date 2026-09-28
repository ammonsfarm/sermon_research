import type { User } from "./auth.ts";
import { field, html, type Html } from "./html.ts";
import type { Ministry } from "./settings.ts";

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
  return html`<p class="steps">Setup · step 1 of 2</p>
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
  return html`${options.step ? html`<p class="steps">Setup · step 2 of 2</p>` : ""}
<h1>About your ministry</h1>
<p class="lead">These names appear on the site and help the AI describe sermons accurately.</p>
<form method="post" action="${options.action}">
${field({ name: "siteTitle", label: "Site title", value: values.siteTitle ?? "", error: errors.siteTitle, hint: "Shown at the top of every page, for example “Grace Church Sermon Archive”.", required: true })}
${field({ name: "churchName", label: "Church or ministry name", value: values.churchName ?? "", error: errors.churchName, required: true })}
${field({ name: "speakerNames", label: "Speaker names", value: values.speakerNames ?? "", error: errors.speakerNames, hint: "Separate names with commas, for example “Pastor Jane Doe, John Smith”." })}
${field({ name: "description", label: "Short description", type: "textarea", value: values.description ?? "", error: errors.description })}
${field({ name: "logoUrl", label: "Logo address", type: "url", value: values.logoUrl ?? "", error: errors.logoUrl, hint: "Optional. An https:// link to an image." })}
<button type="submit">${options.step ? "Finish setup" : "Save"}</button>
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

export function loginView(errors: Errors = {}, values: Values = {}): Html {
  return html`<h1>Sign in</h1>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="/login">
${field({ name: "email", label: "Email", type: "email", value: values.email ?? "", required: true, autocomplete: "email" })}
${field({ name: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" })}
<button type="submit">Sign in</button>
</form>`;
}

export function homeView(ministry: Ministry | null, user: User | null): Html {
  return html`<h1>${ministry?.siteTitle ?? "Sermon Research"}</h1>
${ministry?.description ? html`<p class="lead">${ministry.description}</p>` : ""}
<p>The sermon research page is coming soon.</p>
<div class="row">
${user
    ? html`${user.role === "admin" ? html`<a href="/admin">Admin</a>` : ""}
<form class="inline" method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form>`
    : html`<a href="/login">Sign in</a>`}
</div>`;
}

export function adminView(user: User, ministry: Ministry, saved: boolean): Html {
  return html`<h1>Admin</h1>
<p class="lead">Signed in as ${user.name} (${user.email}).</p>
${saved ? html`<p>Saved.</p>` : ""}
<h2>Ministry</h2>
<dl>
<dt>Site title</dt><dd>${ministry.siteTitle}</dd>
<dt>Church</dt><dd>${ministry.churchName}</dd>
<dt>Speakers</dt><dd>${ministry.speakerNames.join(", ") || "None yet"}</dd>
</dl>
<p><a href="/admin/ministry">Edit ministry details</a></p>
<h2>Next steps</h2>
<p>Podcast feed, AI providers and the episode import arrive in the next release.</p>
<h2>Sessions</h2>
<div class="row">
<form class="inline" method="post" action="/logout"><button class="quiet" type="submit">Sign out</button></form>
<form class="inline" method="post" action="/logout-all"><button class="quiet" type="submit">Sign out on all devices</button></form>
</div>`;
}

export function notFoundView(): Html {
  return html`<h1>Page not found</h1><p><a href="/">Go to the home page</a></p>`;
}
