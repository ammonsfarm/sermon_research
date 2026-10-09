import { chrome, type Context, redirect, requireAdmin } from "./context.ts";
import { field, html, type Html, page } from "./html.ts";
import { getKey, putKey } from "./keys.ts";
import {
  availableModels, type CatalogModel, checkTarget, describeModel, EFFORT_LABELS, fetchCatalog, fitEffort, getDefaults, getProvider, KIND_NAMES, KIND_NOTES,
  LLM_ACTIONS, type LlmChoice, type LlmDefaults, type LlmModel, type LlmProvider, listModels, listProviders, modelKey, parseModelKey,
  removeModel, saveDefaults, saveModel, saveUserModels, userModelKeys,
} from "./llm.ts";
import { isHttpsUrl, isReasoningEffort, ProviderError, REASONING_EFFORTS, type ReasoningEffort } from "./providers.ts";
import { getSetupStep } from "./settings.ts";

/** Slugs for custom providers: lowercase letters, digits and dashes, never containing a slash. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 30);
}

function levels(efforts: readonly ReasoningEffort[]): Html {
  return efforts.length ? html`${efforts.map((effort) => html`<span class="chip">${EFFORT_LABELS[effort]}</span> `)}` : html`<span class="hint">Not sent</span>`;
}

function shell(context: Context, title: string, body: Html, status = 200): Response {
  return page(title, body, { status, ...chrome(context) });
}

type Notice = { readonly error?: string; readonly ok?: string };

const NOTICES: Record<string, string> = {
  key: "Key saved. Pull the model list to choose which models to offer.",
  removed: "Removed.",
  added: "Models added.",
  saved: "Saved.",
};

function alerts(notice: Notice): Html {
  return html`${notice.error ? html`<p class="alert">${notice.error}</p>` : ""}${notice.ok ? html`<div class="alert-ok"><p>${notice.ok}</p></div>` : ""}`;
}

// ---------------------------------------------------------------- the main page

async function overview(context: Context, notice: Notice = {}, status = 200): Promise<Response> {
  const { db } = context;
  const [providers, models, defaults, usable] = await Promise.all([listProviders(db), listModels(db), getDefaults(db), availableModels(db)]);
  const ok = notice.ok ?? NOTICES[context.url.searchParams.get("notice") ?? ""];
  const byProvider = (id: string) => models.filter((model) => model.providerId === id);
  return shell(context, "Answers AI", html`<h1>Answers AI</h1>
<p class="lead">Connect the AI providers you want to use, add the models to offer, and choose which model handles each job. Everything is called through each provider's OpenAI-compatible API, with the differences handled for you.</p>
${alerts({ ...(notice.error ? { error: notice.error } : {}), ...(ok ? { ok } : {}) })}
<h2>Providers</h2>
${providers.map((provider) => providerSection(provider, byProvider(provider.id).length))}
<details class="add-provider"><summary>Add another provider</summary>
<p class="hint">Any service with an OpenAI-compatible chat API: a company gateway, Mistral, Groq, Together and so on. It must be reachable on the public internet over HTTPS.</p>
<form method="post" action="/admin/llm/provider">
${field({ name: "name", label: "Name", required: true })}
${field({ name: "baseUrl", label: "API base address", type: "url", hint: "For example https://api.mistral.ai/v1", required: true })}
${field({ name: "apiKey", label: "API key", type: "password", autocomplete: "new-password", required: true })}
<button type="submit">Add provider</button>
</form></details>
<h2 id="models">Supported models</h2>
<p class="hint">Only models listed here can be chosen below or by members. Reasoning levels are what the site will send for the model.</p>
${models.length ? modelTable(models, providers) : html`<p class="empty">No models yet. Save a provider's key, then pull its model list.</p>`}
<h3>Add a model by name</h3>
<form method="post" action="/admin/llm/model/add" class="row" data-busy="Testing the model…">
<select name="provider" aria-label="Provider">${providers.filter((provider) => provider.keyLast4).map((provider) => html`<option value="${provider.id}">${provider.name}</option>`)}</select>
<input name="modelId" aria-label="Model name" placeholder="Model name, such as gpt-5-mini" required>
<button class="quiet" type="submit">Test and add</button>
</form>
<h2 id="defaults">Which model for which job</h2>
${defaultsForm(defaults, usable, providerNames(providers))}
<h2>Models per person</h2>
<p>By default everyone can use every model above. <a href="/admin/llm/users">Limit the models for particular people</a>.</p>`, status);
}

function providerSection(provider: LlmProvider, modelCount: number): Html {
  const custom = provider.kind === "custom";
  return html`<section class="provider" id="p-${provider.id}">
<h3>${provider.name} <span class="chip">${KIND_NAMES[provider.kind]}</span></h3>
<p class="hint">${provider.keyLast4 ? `Key ending ${provider.keyLast4} saved · ${modelCount} model${modelCount === 1 ? "" : "s"} added` : "No key yet"}. ${KIND_NOTES[provider.kind]}</p>
<form method="post" action="/admin/llm/provider/${provider.id}">
${custom ? field({ name: "baseUrl", label: "API base address", type: "url", value: provider.baseUrl, required: true }) : html`<p class="hint">Address: ${provider.baseUrl}</p>`}
${field({ name: "apiKey", label: provider.keyLast4 ? "Replace the API key" : "API key", type: "password", autocomplete: "new-password", hint: "Stored encrypted. Leave blank to keep the saved key." })}
<div class="row"><button type="submit">Save</button></div>
</form>
${provider.keyLast4 ? html`<div class="row">
<form class="inline" method="post" action="/admin/llm/provider/${provider.id}/fetch" data-busy="Asking ${provider.name} for its models…"><button type="submit">Pull the list of models</button></form>
<form class="inline" method="post" action="/admin/llm/provider/${provider.id}/remove"><button class="quiet" type="submit">${custom ? "Remove provider" : "Remove key"}</button></form>
</div>` : custom ? html`<form class="inline" method="post" action="/admin/llm/provider/${provider.id}/remove"><button class="quiet" type="submit">Remove provider</button></form>` : ""}
</section>`;
}

function modelTable(models: readonly LlmModel[], providers: readonly LlmProvider[]): Html {
  const names = new Map(providers.map((provider) => [provider.id, provider]));
  return html`<table>
<thead><tr><th>Model</th><th>Reasoning levels</th><th></th></tr></thead>
<tbody>${models.map((model) => {
    const provider = names.get(model.providerId);
    return html`<tr>
<td>${model.label}<br><span class="hint">${provider?.name ?? model.providerId}${model.label !== model.modelId ? ` · ${model.modelId}` : ""}${model.enabled ? "" : " · Off"}${provider?.keyLast4 ? "" : " · no key"}</span></td>
<td>${levels(model.efforts)}</td>
<td><div class="row">
<a href="/admin/llm/model?key=${encodeURIComponent(modelKey(model))}">Edit</a>
<form class="inline" method="post" action="/admin/llm/model/toggle"><input type="hidden" name="key" value="${modelKey(model)}"><button class="quiet" type="submit">${model.enabled ? "Turn off" : "Turn on"}</button></form>
<form class="inline" method="post" action="/admin/llm/model/remove"><input type="hidden" name="key" value="${modelKey(model)}"><button class="quiet" type="submit">Remove</button></form>
</div></td></tr>`;
  })}</tbody></table>`;
}

function effortSelect(id: string, name: string, selected: ReasoningEffort | null, modelSelectId: string): Html {
  return html`<select id="${id}" name="${name}" aria-label="Reasoning effort" data-effort-for="${modelSelectId}">
<option value="">Model's default</option>${REASONING_EFFORTS.map((effort) => html`<option value="${effort}"${effort === selected ? html` selected` : ""}>${EFFORT_LABELS[effort]}</option>`)}</select>`;
}

function providerNames(providers: readonly LlmProvider[]): Map<string, string> {
  return new Map(providers.map((provider) => [provider.id, provider.name]));
}

function defaultsForm(defaults: LlmDefaults, usable: readonly LlmModel[], providers: Map<string, string>, errors: Record<string, string> = {}): Html {
  return html`<p class="hint">Reasoning effort only applies to models that take it; the options update when you pick a model.</p>
${usable.length === 0 ? html`<p class="empty">Add at least one model first.</p>` : html`<form method="post" action="/admin/llm/defaults">
${LLM_ACTIONS.map(({ key, label, hint }) => {
    const current = defaults[key];
    const selectId = `f-${key}-model`;
    return html`<div class="field${errors[key] ? " invalid" : ""}"><label for="${selectId}">${label}</label>
<p class="hint">${hint}</p>
<div class="row"><select id="${selectId}" name="${key}Model" data-effort-select="f-${key}-effort">${usable.map((model) => html`<option value="${modelKey(model)}" data-efforts="${model.efforts.join(",")}"${current && current.provider === model.providerId && current.model === model.modelId ? html` selected` : ""}>${providers.get(model.providerId) ?? model.providerId} · ${model.label}</option>`)}</select>
${effortSelect(`f-${key}-effort`, `${key}Effort`, current?.effort ?? null, selectId)}</div>
${errors[key] ? html`<p class="error">${errors[key]}</p>` : ""}</div>`;
  })}
<button type="submit">Save choices</button>
</form>`}`;
}

// ---------------------------------------------------------------- handlers

/** Everything under /admin/llm. */
export async function llmAdmin(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (current !== "complete") return redirect(`/setup/${current}`);
  const { request, url } = context;
  const path = url.pathname.replace(/\/+$/u, "");
  const post = request.method === "POST";
  if (path === "/admin/llm") return post ? redirect("/admin/llm") : overview(context);
  if (request.method !== "GET" && !post) return redirect("/admin/llm");
  try {
    return await dispatch(context, path, post);
  } catch (error) {
    if (error instanceof ProviderError) return overview(context, { error: error.message }, 400);
    throw error;
  }
}

async function dispatch(context: Context, path: string, post: boolean): Promise<Response> {
  if (path === "/admin/llm/provider" && post) return addProvider(context);
  const provider = /^\/admin\/llm\/provider\/([a-z0-9-]+)(\/fetch|\/add|\/remove)?$/u.exec(path);
  if (provider && post) {
    switch (provider[2]) {
      case undefined: return saveProvider(context, provider[1]!);
      case "/fetch": return pullModels(context, provider[1]!);
      case "/add": return addModels(context, provider[1]!);
      default: return removeProvider(context, provider[1]!);
    }
  }
  if (path === "/admin/llm/model" && !post) return editModelForm(context);
  if (path === "/admin/llm/model" && post) return editModel(context);
  if (path === "/admin/llm/model/add" && post) return addModelByName(context);
  if (path === "/admin/llm/model/toggle" && post) return toggleModel(context);
  if (path === "/admin/llm/model/remove" && post) return deleteModel(context);
  if (path === "/admin/llm/defaults" && post) return saveChoices(context);
  if (path === "/admin/llm/users" && !post) return usersPage(context);
  const user = /^\/admin\/llm\/users\/([0-9a-f-]{36})$/u.exec(path);
  if (user) return post ? saveUser(context, user[1]!) : userPage(context, user[1]!);
  return redirect("/admin/llm");
}

const text = (form: FormData, name: string, max = 2048) => String(form.get(name) ?? "").trim().slice(0, max);

async function addProvider(context: Context): Promise<Response> {
  const form = await context.request.formData();
  const name = text(form, "name", 60);
  const baseUrl = text(form, "baseUrl").replace(/\/+$/u, "");
  const apiKey = text(form, "apiKey", 500);
  if (!name || !slug(name)) return overview(context, { error: "Enter a name for the provider." }, 400);
  if (!isHttpsUrl(baseUrl)) return overview(context, { error: "Use an https:// address." }, 400);
  if (!apiKey) return overview(context, { error: "Enter an API key." }, 400);
  const taken = new Set((await listProviders(context.db)).map((provider) => provider.id));
  let id = slug(name);
  for (let n = 2; taken.has(id) || id === "llm"; n++) id = `${slug(name).slice(0, 26)}-${n}`;
  const position = taken.size + 10;
  await context.db.prepare("INSERT INTO llm_providers (id, kind, name, base_url, key_slot, position, created_at) VALUES (?, 'custom', ?, ?, ?, ?, ?)")
    .bind(id, name, baseUrl, `llm:${id}`, position, new Date().toISOString()).run();
  await putKey(context.db, context.env.APP_SECRET ?? "", `llm:${id}`, apiKey);
  return redirect(`/admin/llm?notice=key#p-${id}`);
}

async function saveProvider(context: Context, id: string): Promise<Response> {
  const provider = await getProvider(context.db, id);
  if (!provider) return redirect("/admin/llm");
  const form = await context.request.formData();
  const apiKey = text(form, "apiKey", 500);
  if (provider.kind === "custom") {
    const baseUrl = text(form, "baseUrl").replace(/\/+$/u, "");
    if (!isHttpsUrl(baseUrl)) return overview(context, { error: "Use an https:// address." }, 400);
    await context.db.prepare("UPDATE llm_providers SET base_url = ? WHERE id = ?").bind(baseUrl, id).run();
  }
  if (apiKey) await putKey(context.db, context.env.APP_SECRET ?? "", provider.keySlot, apiKey);
  else if (!provider.keyLast4) return overview(context, { error: `Enter ${provider.name}'s API key.` }, 400);
  return redirect(`/admin/llm?notice=${apiKey ? "key" : "saved"}#p-${id}`);
}

async function removeProvider(context: Context, id: string): Promise<Response> {
  const provider = await getProvider(context.db, id);
  if (!provider) return redirect("/admin/llm");
  const statements = [context.db.prepare("DELETE FROM provider_keys WHERE slot = ?").bind(provider.keySlot)];
  if (provider.kind === "custom") {
    statements.push(
      context.db.prepare("DELETE FROM user_llm_models WHERE provider_id = ?").bind(id),
      context.db.prepare("DELETE FROM llm_models WHERE provider_id = ?").bind(id),
      context.db.prepare("DELETE FROM llm_providers WHERE id = ?").bind(id),
    );
  }
  await context.db.batch(statements);
  return redirect("/admin/llm?notice=removed");
}

async function providerKey(context: Context, provider: LlmProvider): Promise<string | null> {
  return getKey(context.db, context.env.APP_SECRET ?? "", provider.keySlot);
}

const REVIEW_LIMIT = 500;

/** Asks the provider for its models and shows them to pick from. */
async function pullModels(context: Context, id: string): Promise<Response> {
  const provider = await getProvider(context.db, id);
  if (!provider) return redirect("/admin/llm");
  const apiKey = await providerKey(context, provider);
  if (!apiKey) return overview(context, { error: `${provider.name}'s key is missing or unreadable. Enter it again.` }, 400);
  const form = await context.request.formData();
  const query = text(form, "q", 100);
  let catalog: CatalogModel[];
  try {
    catalog = await fetchCatalog(provider, apiKey);
  } catch (error) {
    if (error instanceof ProviderError) return overview(context, { error: `${error.message} If this provider doesn't list models, add one by name instead.` }, 400);
    throw error;
  }
  const have = new Set((await listModels(context.db, id)).map((model) => model.modelId));
  const shown = filterCatalog(catalog, query);
  return shell(context, `${provider.name} models`, html`<h1>${provider.name} models</h1>
<p class="lead">${catalog.length} found${query ? `, ${shown.length} match “${query}”` : ""}. ${have.size} already added. Reasoning levels are shown as the site will use them; you can change them later.</p>
<form method="post" action="/admin/llm/provider/${id}/fetch" class="row"><input name="q" value="${query}" aria-label="Filter models" placeholder="Filter by name"><button class="quiet" type="submit">Filter</button></form>
<form method="post" action="/admin/llm/provider/${id}/add">
<input type="hidden" name="q" value="${query}">
<div class="row"><button type="submit">Add selected</button><button type="submit" name="all" value="1" class="quiet">Add all ${shown.filter((model) => !have.has(model.modelId)).length} shown</button><a href="/admin/llm#p-${id}">Cancel</a></div>
<fieldset class="choices"><legend class="visually-hidden">Models</legend>
${shown.slice(0, REVIEW_LIMIT).map((model) => html`<label class="choice"><input type="checkbox" name="model" value="${model.modelId}"${have.has(model.modelId) ? html` checked disabled` : ""}>
<span><strong>${model.label}</strong>${model.label !== model.modelId ? html` <span class="hint">${model.modelId}</span>` : ""}${have.has(model.modelId) ? html` <span class="chip">Added</span>` : ""}<br>${levels(model.efforts)}${model.contextWindow ? html` <span class="hint">· ${model.contextWindow.toLocaleString("en-US")} token context</span>` : ""}</span></label>`)}
</fieldset>
${shown.length > REVIEW_LIMIT ? html`<p class="hint">Showing the first ${REVIEW_LIMIT}. Filter to narrow the list.</p>` : ""}
</form>`);
}

function filterCatalog(catalog: readonly CatalogModel[], query: string): CatalogModel[] {
  const needle = query.toLowerCase();
  return needle ? catalog.filter((model) => `${model.modelId} ${model.label}`.toLowerCase().includes(needle)) : [...catalog];
}

async function addModels(context: Context, id: string): Promise<Response> {
  const provider = await getProvider(context.db, id);
  if (!provider) return redirect("/admin/llm");
  const apiKey = await providerKey(context, provider);
  if (!apiKey) return overview(context, { error: `${provider.name}'s key is missing or unreadable. Enter it again.` }, 400);
  const form = await context.request.formData();
  const catalog = filterCatalog(await fetchCatalog(provider, apiKey), text(form, "q", 100));
  const picked = new Set(form.getAll("model").map(String));
  const have = new Set((await listModels(context.db, id)).map((model) => model.modelId));
  const chosen = catalog.filter((model) => !have.has(model.modelId) && (form.get("all") ? true : picked.has(model.modelId)));
  if (chosen.length === 0) return overview(context, { error: "Pick at least one model to add." }, 400);
  for (const model of chosen) {
    await saveModel(context.db, { providerId: id, modelId: model.modelId, label: model.label, efforts: model.efforts, defaultEffort: model.defaultEffort, contextWindow: model.contextWindow, enabled: true });
  }
  return redirect("/admin/llm?notice=added#models");
}

async function addModelByName(context: Context): Promise<Response> {
  const form = await context.request.formData();
  const provider = await getProvider(context.db, text(form, "provider", 60));
  const modelId = text(form, "modelId", 200);
  if (!provider?.keyLast4) return overview(context, { error: "Choose a provider that has a key." }, 400);
  if (!modelId) return overview(context, { error: "Enter a model name." }, 400);
  const apiKey = await providerKey(context, provider);
  if (!apiKey) return overview(context, { error: `${provider.name}'s key is missing or unreadable. Enter it again.` }, 400);
  await checkTarget({ kind: provider.kind, providerName: provider.name, baseUrl: provider.baseUrl.replace(/\/+$/u, ""), apiKey, model: modelId, effort: null });
  const details = await describeModel(provider, apiKey, modelId);
  await saveModel(context.db, { providerId: provider.id, modelId, label: details.label, efforts: details.efforts, defaultEffort: details.defaultEffort, contextWindow: details.contextWindow, enabled: true });
  return redirect("/admin/llm?notice=added#models");
}

async function findModel(context: Context, key: unknown): Promise<LlmModel | null> {
  const parsed = parseModelKey(key);
  return parsed ? (await listModels(context.db, parsed.providerId)).find((model) => model.modelId === parsed.modelId) ?? null : null;
}

async function toggleModel(context: Context): Promise<Response> {
  const model = await findModel(context, (await context.request.formData()).get("key"));
  if (model) await saveModel(context.db, { ...model, enabled: !model.enabled });
  return redirect("/admin/llm#models");
}

async function deleteModel(context: Context): Promise<Response> {
  const model = await findModel(context, (await context.request.formData()).get("key"));
  if (model) await removeModel(context.db, model.providerId, model.modelId);
  return redirect("/admin/llm?notice=removed#models");
}

async function editModelForm(context: Context, error = "", status = 200, form?: FormData): Promise<Response> {
  const key = form ? form.get("key") : context.url.searchParams.get("key");
  const model = await findModel(context, key);
  if (!model) return redirect("/admin/llm");
  const efforts = form ? new Set(form.getAll("effort").map(String)) : new Set<string>(model.efforts);
  const label = form ? text(form, "label", 120) : model.label;
  const defaultEffort = form ? text(form, "defaultEffort", 20) : model.defaultEffort ?? "";
  const provider = await getProvider(context.db, model.providerId);
  return shell(context, "Edit model", html`<h1>${model.label}</h1>
<p class="meta"><a href="/admin/llm">Answers AI</a> · ${provider?.name ?? model.providerId} · ${model.modelId}</p>
${error ? html`<p class="alert">${error}</p>` : ""}
<form method="post" action="/admin/llm/model">
<input type="hidden" name="key" value="${modelKey(model)}">
${field({ name: "label", label: "Display name", value: label, required: true })}
<fieldset class="choices"><legend>Reasoning levels this model takes</legend>
<p class="hint">The site sends a level only if it's ticked here. ${provider ? KIND_NOTES[provider.kind] : ""} Leave all unticked for a model that doesn't reason or rejects the setting.</p>
${REASONING_EFFORTS.map((effort) => html`<label class="choice"><input type="checkbox" name="effort" value="${effort}"${efforts.has(effort) ? html` checked` : ""}><span>${EFFORT_LABELS[effort]}</span></label>`)}
</fieldset>
<div class="field"><label for="f-defaultEffort">Level to use when none is chosen</label>
<select id="f-defaultEffort" name="defaultEffort"><option value="">None</option>${REASONING_EFFORTS.map((effort) => html`<option value="${effort}"${effort === defaultEffort ? html` selected` : ""}>${EFFORT_LABELS[effort]}</option>`)}</select></div>
<button type="submit">Save</button>
</form>`, status);
}

async function editModel(context: Context): Promise<Response> {
  const form = await context.request.formData();
  const model = await findModel(context, form.get("key"));
  if (!model) return redirect("/admin/llm");
  const label = text(form, "label", 120);
  const efforts = REASONING_EFFORTS.filter((effort) => form.getAll("effort").map(String).includes(effort));
  const wanted = text(form, "defaultEffort", 20);
  const defaultEffort = isReasoningEffort(wanted) ? wanted : null;
  if (!label) return editModelForm(context, "Enter a display name.", 400, form);
  if (defaultEffort && !efforts.includes(defaultEffort)) return editModelForm(context, "The default level must be one of the ticked levels.", 400, form);
  await saveModel(context.db, { ...model, label, efforts, defaultEffort });
  return redirect("/admin/llm?notice=saved#models");
}

async function saveChoices(context: Context): Promise<Response> {
  const form = await context.request.formData();
  const usable = await availableModels(context.db);
  const byKey = new Map(usable.map((model) => [modelKey(model), model]));
  const chosen: Record<string, LlmChoice> = {};
  const errors: Record<string, string> = {};
  for (const { key } of LLM_ACTIONS) {
    const model = byKey.get(text(form, `${key}Model`, 300));
    const wanted = text(form, `${key}Effort`, 20);
    if (!model) {
      errors[key] = "Choose a model from the list.";
    } else if (wanted && !isReasoningEffort(wanted)) {
      errors[key] = "Choose a reasoning effort from the list.";
    } else if (wanted && model.efforts.length > 0 && !model.efforts.includes(wanted as ReasoningEffort)) {
      errors[key] = `${model.label} doesn't take ${EFFORT_LABELS[wanted as ReasoningEffort].toLowerCase()} effort. It takes ${model.efforts.map((effort) => EFFORT_LABELS[effort].toLowerCase()).join(", ")}.`;
    } else {
      chosen[key] = { provider: model.providerId, model: model.modelId, effort: fitEffort(model, wanted ? wanted as ReasoningEffort : null) };
    }
  }
  if (Object.keys(errors).length > 0) {
    const names = providerNames(await listProviders(context.db));
    return shell(context, "Answers AI", html`<h1>Answers AI</h1><p class="alert">Some choices couldn't be saved.</p>${defaultsForm(await getDefaults(context.db), usable, names, errors)}<p><a href="/admin/llm">Back</a></p>`, 400);
  }
  await saveDefaults(context.db, chosen as LlmDefaults);
  return redirect("/admin/llm?notice=saved#defaults");
}

// ---------------------------------------------------------------- per person

interface UserRow { readonly id: string; readonly name: string; readonly email: string; readonly role: string }

async function usersPage(context: Context): Promise<Response> {
  const { results } = await context.db.prepare(
    `SELECT u.id, u.name, u.email, u.role, (SELECT count(*) FROM user_llm_models m WHERE m.user_id = u.id) AS limited FROM users u ORDER BY u.role, u.name`,
  ).all<UserRow & { limited: number }>();
  return shell(context, "Models per person", html`<h1>Models per person</h1>
<p class="meta"><a href="/admin/llm">Answers AI</a></p>
<p class="lead">Everyone follows the site's model list unless you limit them here. Someone who is limited can only choose from, and is only answered by, the models you tick. Sermon processing always uses the site's choice.</p>
<table><thead><tr><th>Person</th><th>Models</th><th></th></tr></thead>
<tbody>${results.map((user) => html`<tr><td>${user.name}<br><span class="hint">${user.email}${user.role === "admin" ? " · Admin" : ""}</span></td>
<td>${user.limited ? `${user.limited} chosen` : "Site list"}</td>
<td><a href="/admin/llm/users/${user.id}">Change</a></td></tr>`)}</tbody></table>`);
}

async function userPage(context: Context, id: string, error = ""): Promise<Response> {
  const user = await context.db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!user) return redirect("/admin/llm/users");
  const [usable, limit, providers] = await Promise.all([availableModels(context.db), userModelKeys(context.db, id), listProviders(context.db)]);
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  return shell(context, "Models per person", html`<h1>${user.name}</h1>
<p class="meta"><a href="/admin/llm/users">Models per person</a> · ${user.email}</p>
${error ? html`<p class="alert">${error}</p>` : ""}
<form method="post" action="/admin/llm/users/${id}">
<label class="choice"><input type="radio" name="mode" value="site"${limit ? "" : html` checked`}><span><strong>Follow the site's list</strong><br><span class="hint">Every model that's on and has a key.</span></span></label>
<label class="choice"><input type="radio" name="mode" value="only"${limit ? html` checked` : ""}><span><strong>Only these models</strong></span></label>
<fieldset class="choices"><legend class="visually-hidden">Models</legend>
${usable.map((model) => html`<label class="choice"><input type="checkbox" name="model" value="${modelKey(model)}"${limit?.has(modelKey(model)) ? html` checked` : ""}><span>${names.get(model.providerId) ?? model.providerId} · ${model.label}</span></label>`)}
</fieldset>
<button type="submit">Save</button>
</form>`, error ? 400 : 200);
}

async function saveUser(context: Context, id: string): Promise<Response> {
  if (!(await context.db.prepare("SELECT 1 FROM users WHERE id = ?").bind(id).first())) return redirect("/admin/llm/users");
  const form = await context.request.formData();
  if (text(form, "mode", 10) === "only") {
    const usable = new Set((await availableModels(context.db)).map(modelKey));
    const keys = form.getAll("model").map(String).filter((key) => usable.has(key));
    if (keys.length === 0) return userPage(context, id, "Tick at least one model, or choose to follow the site's list.");
    await saveUserModels(context.db, id, keys);
  } else {
    await saveUserModels(context.db, id, []);
  }
  return redirect("/admin/llm/users");
}
