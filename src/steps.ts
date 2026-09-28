import { type Context, redirect, requireAdmin, siteTitle } from "./context.ts";
import { FeedError, fetchFeed, type Feed } from "./feed.ts";
import { field, html, page, type Html } from "./html.ts";
import { getKey, keyInfo, putKey, type KeySlot } from "./keys.ts";
import {
  checkEmbeddings,
  checkLlm,
  checkTranscription,
  EMBEDDING_MODEL,
  isHttpsUrl,
  MISTRAL_TRANSCRIPTION_MODEL,
  OPENAI_BASE_URL,
  ProviderError,
  sendEmail,
} from "./providers.ts";
import {
  type CheckedSettings,
  type EmailSettings,
  getSetting,
  getSetupStep,
  type LlmSettingsRecord,
  nextStep,
  type PodcastSettings,
  putSetting,
  SETUP_STEPS,
  type SetupStep,
} from "./settings.ts";

export type ProviderStep = "podcast" | "llm" | "embeddings" | "transcription" | "email";

export function isProviderStep(value: string): value is ProviderStep {
  return value === "podcast" || value === "llm" || value === "embeddings" || value === "transcription" || value === "email";
}

const TITLES: Record<ProviderStep, string> = {
  podcast: "Podcast feed",
  llm: "Answers AI",
  embeddings: "Search embeddings",
  transcription: "Transcription",
  email: "Email",
};

type Errors = Record<string, string>;
type Values = Record<string, string>;

interface StepState {
  readonly context: Context;
  readonly step: ProviderStep;
  readonly wizard: boolean;
  readonly keys: Awaited<ReturnType<typeof keyInfo>>;
}

function stepHeader(state: StepState): Html {
  const index = SETUP_STEPS.indexOf(state.step) + 1;
  return state.wizard ? html`<p class="steps">Setup · step ${index + 1} of ${SETUP_STEPS.length}</p>` : html`<p class="steps"><a href="/admin">Admin</a></p>`;
}

function action(state: StepState): string {
  return `${state.wizard ? "/setup" : "/admin"}/${state.step}`;
}

function keyHint(state: StepState, slot: KeySlot, base: string): string {
  const stored = state.keys[slot];
  return stored ? `${base} A key ending in ${stored.last4} is saved; leave this blank to keep it.` : base;
}

function render(state: StepState, body: Html, status = 200): Response {
  return page(TITLES[state.step], html`${stepHeader(state)}${body}`, { status, ...siteTitle(state.context) });
}

function podcastForm(state: StepState, errors: Errors = {}, values: Values = {}): Html {
  return html`<h1>Your podcast feed</h1>
<p class="lead">Paste the RSS address of your sermon podcast. You'll find it in your podcast host's settings, often labelled "RSS feed".</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="${action(state)}">
<input type="hidden" name="intent" value="check">
${field({ name: "feedUrl", label: "RSS feed address", type: "url", value: values.feedUrl ?? "", error: errors.feedUrl, required: true })}
<button type="submit">Check feed</button>
</form>`;
}

function podcastPreview(state: StepState, feedUrl: string, feed: Feed): Html {
  const newest = newestEpisode(feed);
  return html`<h1>Is this your podcast?</h1>
<dl>
<dt>Podcast</dt><dd>${feed.title}</dd>
<dt>Episodes</dt><dd>${feed.episodes.length}</dd>
<dt>Newest</dt><dd>${newest ? `${newest.title}${newest.publishedAt ? ` (${newest.publishedAt.slice(0, 10)})` : ""}` : "None yet"}</dd>
</dl>
<div class="row">
<form class="inline" method="post" action="${action(state)}">
<input type="hidden" name="intent" value="save">
<input type="hidden" name="feedUrl" value="${feedUrl}">
<button type="submit">Yes, use this feed</button>
</form>
<a href="${action(state)}">Use a different feed</a>
</div>`;
}

function llmForm(state: StepState, errors: Errors = {}, values: Values = {}): Html {
  return html`<h1>Answers AI</h1>
<p class="lead">This AI writes episode summaries and answers research questions. Any provider with an OpenAI-compatible API works, such as OpenAI, Google Gemini, OpenRouter or Anthropic.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="${action(state)}">
${field({ name: "baseUrl", label: "API base address", type: "url", value: values.baseUrl ?? OPENAI_BASE_URL, error: errors.baseUrl, hint: "For OpenAI keep the default. Gemini: https://generativelanguage.googleapis.com/v1beta/openai", required: true })}
${field({ name: "model", label: "Model", value: values.model ?? "", error: errors.model, hint: "For example gpt-5-mini or gemini-2.5-flash.", required: true })}
${field({ name: "apiKey", label: "API key", type: "password", error: errors.apiKey, hint: keyHint(state, "llm", "Stored encrypted."), autocomplete: "new-password" })}
<button type="submit">Test and save</button>
</form>`;
}

function embeddingsForm(state: StepState, errors: Errors = {}, reuse = false): Html {
  return html`<h1>Search embeddings</h1>
<p class="lead">Search uses OpenAI's ${EMBEDDING_MODEL} model to find passages by meaning. This needs an OpenAI API key.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="${action(state)}">
${field({ name: "apiKey", label: "OpenAI API key", type: "password", error: errors.apiKey, hint: keyHint(state, "embeddings", reuse ? "Leave blank to reuse the key from the Answers AI step." : "Stored encrypted."), autocomplete: "new-password" })}
<button type="submit">Test and save</button>
</form>`;
}

function transcriptionForm(state: StepState, errors: Errors = {}): Html {
  return html`<h1>Transcription</h1>
<p class="lead">Sermon audio is transcribed with Mistral's ${MISTRAL_TRANSCRIPTION_MODEL} model, which handles full-length recordings. Create a key at console.mistral.ai.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="${action(state)}">
${field({ name: "apiKey", label: "Mistral API key", type: "password", error: errors.apiKey, hint: keyHint(state, "transcription", "Stored encrypted."), autocomplete: "new-password" })}
<button type="submit">Test and save</button>
</form>`;
}

function emailForm(state: StepState, errors: Errors = {}, values: Values = {}): Html {
  return html`<h1>Email (optional)</h1>
<p class="lead">With email set up, people can sign in with a link instead of a password. This uses Resend (resend.com); the sender address must be on a domain you've verified there.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="${action(state)}">
<input type="hidden" name="intent" value="save">
${field({ name: "from", label: "Send from", value: values.from ?? "", error: errors.from, hint: "For example: Grace Church <sermons@gracechurch.org>" })}
${field({ name: "apiKey", label: "Resend API key", type: "password", error: errors.apiKey, hint: keyHint(state, "email", "Stored encrypted."), autocomplete: "new-password" })}
<div class="row"><button type="submit">Send a test email and save</button></div>
</form>
${state.wizard ? html`<form method="post" action="${action(state)}"><input type="hidden" name="intent" value="skip"><p><button class="quiet" type="submit">Skip for now</button></p></form>` : ""}`;
}

/** GET /setup/<step> and /admin/<step>. */
export async function stepForm(context: Context, step: ProviderStep, wizard: boolean): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (wizard && current === "complete") return redirect(`/admin/${step}`);
  if (wizard && SETUP_STEPS.indexOf(step) > SETUP_STEPS.indexOf(current)) return redirect(`/setup/${current}`);
  if (!wizard && current !== "complete") return redirect(`/setup/${current}`);
  const state: StepState = { context, step, wizard, keys: await keyInfo(context.db) };
  const db = context.db;
  switch (step) {
    case "podcast": return render(state, podcastForm(state, {}, { feedUrl: (await getSetting<PodcastSettings>(db, "podcast"))?.feedUrl ?? "" }));
    case "llm": {
      const llm = await getSetting<LlmSettingsRecord>(db, "llm");
      return render(state, llmForm(state, {}, llm ? { baseUrl: llm.baseUrl, model: llm.model } : {}));
    }
    case "embeddings": return render(state, embeddingsForm(state, {}, await canReuseLlmKey(db)));
    case "transcription": return render(state, transcriptionForm(state));
    case "email": {
      const email = await getSetting<EmailSettings>(db, "email");
      return render(state, emailForm(state, {}, email && "from" in email ? { from: email.from } : {}));
    }
  }
}

/** POST /setup/<step> and /admin/<step>. */
export async function stepSubmit(context: Context, step: ProviderStep, wizard: boolean): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (wizard ? current === "complete" || SETUP_STEPS.indexOf(step) > SETUP_STEPS.indexOf(current) : current !== "complete") {
    return redirect(current === "complete" ? "/admin" : `/setup/${current}`);
  }
  const secret = context.env.APP_SECRET ?? "";
  const state: StepState = { context, step, wizard, keys: await keyInfo(context.db) };
  const form = await context.request.formData();
  const text = (name: string, max = 2048) => String(form.get(name) ?? "").trim().slice(0, max);
  const { db } = context;

  const done = async (): Promise<Response> => {
    if (!wizard) return redirect("/admin?saved=1");
    const next: SetupStep = nextStep(step);
    // Only move forward; revisiting an earlier step must not rewind progress.
    if (SETUP_STEPS.indexOf(next) > SETUP_STEPS.indexOf(current)) await putSetting(db, "setup_step", next);
    const resume = SETUP_STEPS.indexOf(next) > SETUP_STEPS.indexOf(current) ? next : current;
    return redirect(resume === "complete" ? "/admin" : `/setup/${resume}`);
  };

  const keyOrStored = async (slot: KeySlot): Promise<string | null> => text("apiKey", 500) || await getKey(db, secret, slot);

  try {
    switch (step) {
      case "podcast": {
        const feedUrl = text("feedUrl");
        let feed: Feed;
        try {
          feed = await fetchFeed(feedUrl);
        } catch (error) {
          if (error instanceof FeedError) return render(state, podcastForm(state, { feedUrl: error.message }, { feedUrl }), 400);
          throw error;
        }
        if (text("intent") !== "save") return render(state, podcastPreview(state, feedUrl, feed));
        const newest = newestEpisode(feed);
        await putSetting(db, "podcast", {
          feedUrl, title: feed.title, episodeCount: feed.episodes.length,
          newestTitle: newest?.title ?? null, newestAt: newest?.publishedAt ?? null, checkedAt: new Date().toISOString(),
        } satisfies PodcastSettings);
        return done();
      }
      case "llm": {
        const values = { baseUrl: text("baseUrl").replace(/\/+$/u, ""), model: text("model", 200) };
        const errors: Errors = {};
        if (!isHttpsUrl(values.baseUrl)) errors.baseUrl = "Use an https:// address.";
        if (!values.model) errors.model = "Enter a model name.";
        const apiKey = await keyOrStored("llm");
        if (!apiKey) errors.apiKey = "Enter an API key.";
        if (Object.keys(errors).length > 0 || !apiKey) return render(state, llmForm(state, errors, values), 400);
        try {
          await checkLlm(values, apiKey);
        } catch (error) {
          if (error instanceof ProviderError) return render(state, llmForm(state, { form: error.message }, values), 400);
          throw error;
        }
        await putKey(db, secret, "llm", apiKey);
        await putSetting(db, "llm", { ...values, checkedAt: new Date().toISOString() } satisfies LlmSettingsRecord);
        return done();
      }
      case "embeddings": {
        const reuse = await canReuseLlmKey(db);
        const apiKey = text("apiKey", 500) || await getKey(db, secret, "embeddings") || (reuse ? await getKey(db, secret, "llm") : null);
        if (!apiKey) return render(state, embeddingsForm(state, { apiKey: "Enter an OpenAI API key." }, reuse), 400);
        try {
          await checkEmbeddings(apiKey);
        } catch (error) {
          if (error instanceof ProviderError) return render(state, embeddingsForm(state, { form: error.message }, reuse), 400);
          throw error;
        }
        await putKey(db, secret, "embeddings", apiKey);
        await putSetting(db, "embeddings", { model: EMBEDDING_MODEL, checkedAt: new Date().toISOString() } satisfies CheckedSettings);
        return done();
      }
      case "transcription": {
        const apiKey = await keyOrStored("transcription");
        if (!apiKey) return render(state, transcriptionForm(state, { apiKey: "Enter a Mistral API key." }), 400);
        try {
          await checkTranscription(apiKey);
        } catch (error) {
          if (error instanceof ProviderError) return render(state, transcriptionForm(state, { form: error.message }), 400);
          throw error;
        }
        await putKey(db, secret, "transcription", apiKey);
        await putSetting(db, "transcription", { model: MISTRAL_TRANSCRIPTION_MODEL, checkedAt: new Date().toISOString() } satisfies CheckedSettings);
        return done();
      }
      case "email": {
        if (text("intent") === "skip" && wizard) {
          if (!(await getSetting<EmailSettings>(db, "email"))) await putSetting(db, "email", { skipped: true } satisfies EmailSettings);
          return done();
        }
        const values = { from: text("from", 320) };
        const errors: Errors = {};
        if (!/^(?:[^<>]{1,100}<)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/u.test(values.from)) errors.from = "Enter an address like sermons@yourchurch.org or Name <sermons@yourchurch.org>.";
        const apiKey = await keyOrStored("email");
        if (!apiKey) errors.apiKey = "Enter a Resend API key.";
        // Password managers like to fill the site password into this field.
        else if (!apiKey.startsWith("re_")) errors.apiKey = "Resend keys start with re_. If your browser filled this in, clear it and paste the key from Resend.";
        if (Object.keys(errors).length > 0 || !apiKey) return render(state, emailForm(state, errors, values), 400);
        try {
          await sendEmail({
            apiKey, from: values.from, to: context.session!.user.email,
            subject: "Sermon Research email is working",
            text: "This test message confirms your site can send sign-in links.",
          });
        } catch (error) {
          if (error instanceof ProviderError) return render(state, emailForm(state, { form: error.message }, values), 400);
          throw error;
        }
        await putKey(db, secret, "email", apiKey);
        await putSetting(db, "email", { from: values.from, checkedAt: new Date().toISOString() } satisfies EmailSettings);
        return done();
      }
    }
  } catch (error) {
    console.error("setup step failed", step, error);
    return render(state, html`<h1>${TITLES[step]}</h1><p class="alert">Something went wrong saving this step. Try again; if it keeps happening, check the Worker logs.</p><p><a href="${action(state)}">Back</a></p>`, 500);
  }
}

async function canReuseLlmKey(db: D1Database): Promise<boolean> {
  const llm = await getSetting<LlmSettingsRecord>(db, "llm");
  return llm?.baseUrl === OPENAI_BASE_URL;
}

function newestEpisode(feed: Feed): Feed["episodes"][number] | undefined {
  return [...feed.episodes].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0];
}
