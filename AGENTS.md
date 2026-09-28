# Guide for AI assistants

You're helping someone run **Sermon Research**, a single Cloudflare Worker
that turns a church's sermon podcast into a searchable archive. The person
may not be technical. Explain what you're about to do in plain words, and ask
before anything in the "Ask first" list below.

## Repo map

| Path | Purpose |
|---|---|
| `src/index.ts` | Worker entry point and router |
| `src/auth.ts` | Users, password sign-in, 30-day sessions, rate limits |
| `src/crypto.ts` | PBKDF2 password hashing, tokens, constant-time compare |
| `src/schema.ts` | Database migrations; the Worker applies them itself on first request |
| `src/settings.ts` | Key-value settings stored in D1 (ministry details, provider choices, wizard progress) |
| `src/steps.ts` | Wizard and admin pages for the podcast feed, answers AI, embeddings, transcription and email |
| `src/feed.ts` | Podcast RSS fetch and parse |
| `src/providers.ts` | Live checks and calls to OpenAI-compatible APIs, OpenAI embeddings, Mistral and Resend |
| `src/keys.ts` | API keys stored AES-GCM encrypted in `provider_keys` |
| `src/links.ts` | Emailed sign-in links |
| `src/imports.ts` | Import step with cost estimate, episodes dashboard, schedule page, hourly cron logic |
| `src/audio.ts` | Copies episode audio into the `AUDIO` R2 bucket, signs short-lived links for the transcription service, serves `/audio/:id` with ranges |
| `src/episodes.ts` | Episode rows from the feed, the queue, and starting workflow runs (up to the admin's "episodes at once" setting) |
| `src/pipeline.ts` | The per-episode steps: transcribe (Mistral), summarize (answers AI), chunk, embed and write to Vectorize |
| `src/workflow.ts` | The Cloudflare Workflow class that runs `pipeline.ts` for one episode |
| `src/schedule.ts` | Daily/weekly schedule in the church's time zone |
| `src/ask.ts` | Ask home page, the ask box, conversations (the `turns` table, with follow-ups) and the Library |
| `src/scope.ts` | Question scope: series (taken from the " - Series" end of a title), date range and specific sermons |
| `src/sermons.ts` | Sermons grid with search and filters, and the sermon page (player, read-along, Summary / Ask / Create panel) |
| `src/research.ts` | Retrieval (Vectorize, filtered to a scope), cited answers, sources, question limits and research access settings |
| `src/documents.ts`, `src/markdown.ts` | Markdown documents written from the sermons (outline, study questions, custom), their pages and `.md` download; a small Markdown renderer that escapes everything it doesn't handle |
| `src/members.ts` | Member invites, invite acceptance, removing members |
| `src/usage.ts` | Hourly and daily counters for questions and searches |
| `src/context.ts` | Request context and shared redirects |
| `src/views.ts`, `src/html.ts`, `src/layout.ts` | Server-rendered pages; `html` escapes every value. `layout.ts` holds the header tabs and the admin side menu (add admin pages to `ADMIN_MENU`) |
| `src/assets.ts` | The only CSS (`/assets/app.css`) and JavaScript (`/assets/app.js`): busy state on forms, tabs, the read-along. Pages work without the script |
| `test/` | `node:test` suites; `test/d1-sqlite.ts` stands in for D1 |
| `wrangler.jsonc` | Worker name, D1, Vectorize, Workflow and the hourly cron |

Commands: `npm run verify` (typecheck and tests), `npm run dev` (local),
`npx wrangler deploy` (production), `npm run cf-typegen` (after config changes).

## First deploy

1. `npm install`, then `npx wrangler login`.
2. Create the search index (Wrangler doesn't create Vectorize on deploy):
   `npx wrangler vectorize create sermon-research --dimensions=1536 --metric=cosine`, then
   `npx wrangler vectorize create-metadata-index sermon-research --property-name=episodeId --type=string`.
   The dimensions must be 1536 to match `text-embedding-3-small`.
3. `npx wrangler deploy`. Current Wrangler creates the `sermon-research` D1
   database automatically when `database_id` is missing. If yours refuses:
   run `npx wrangler d1 create sermon-research` and paste the printed
   `database_id` into `wrangler.jsonc`. The `sermon-research-audio` R2
   bucket is created the same way; if not, `npx wrangler r2 bucket create sermon-research-audio`.
4. Set the secret: `openssl rand -base64 32`, then
   `npx wrangler secret put APP_SECRET`, and paste the value. Tell the person
   to save it in a password manager: it's their setup code, and it encrypts
   their stored API keys.
5. Open the printed `https://sermon-research.<subdomain>.workers.dev` URL and
   let the person complete the wizard themselves.

**Deploying from GitHub instead:** `.github/workflows/deploy.yml` does steps
2 to 4 when run from the Actions tab. It needs the repository secrets
`CLOUDFLARE_API_TOKEN` (an API token from the "Edit Cloudflare Workers"
template, which includes Workers R2 Storage Edit, plus D1 Edit and Vectorize Edit), `CLOUDFLARE_ACCOUNT_ID` and
`APP_SECRET`. Have the person create these themselves, and never ask them to
paste the values into chat.

There's no migration command. `src/schema.ts` runs pending migrations on the
first request after each deploy.

## Common tasks

- **Custom domain:** in the Cloudflare dashboard, go to Workers & Pages →
  sermon-research → Settings → Domains & Routes → Add → Custom domain. The
  domain must already be on Cloudflare DNS. Don't hardcode the domain
  anywhere; the app uses the request's own origin.
- **Rename the Worker:** change `name` in `wrangler.jsonc` and redeploy. The
  old `workers.dev` URL stops working.
- **A member forgot their password:** an admin opens Admin → Members and
  presses "New invite link" next to them. The link lets them choose a new
  password and signs them out elsewhere.
- **Make the research page public or change the daily cap:** Admin →
  Research access. Public visitors get 20 questions an hour each; signed-in
  people get 60. The daily cap covers everyone but admins and resets at
  midnight UTC. These hourly numbers are constants at the top of
  `src/research.ts`.
- **Answers are poor or say the sources don't cover it:** check that episodes
  show Done in Admin → Episodes. A stronger answers-AI model helps most.
  `SOURCES` in `src/research.ts` sets how many passages each answer sees;
  `DOCUMENT_SOURCES` in `src/documents.ts` does the same for documents.
- **Add or change a document type:** edit `OUTPUTS` in `src/ask.ts` (the
  menu) and `INSTRUCTIONS` in `src/documents.ts` (what the AI is told).
  Documents count against the same question limits and need a signed-in person.
- **Scoped questions:** a scope of 40 sermons or fewer is filtered inside
  Vectorize (`episodeId` metadata index); larger scopes fetch more matches and
  filter afterwards. Follow-ups keep the conversation's scope and send the last
  3 exchanges to the answers AI.
- **Word highlighting is early or late:** Mistral returns sentence timings, so
  the word is estimated by spreading each sentence evenly over its words.
  Sentence highlighting is exact; true word timings would need re-transcribing.
- **The admin is locked out (forgot password):** there's no reset for admins. With the
  person's permission, generate a hash locally:
  `node -e "import('./src/crypto.ts').then(async c => console.log(await c.hashPassword(process.argv[1])))" 'new password here'`
  Then run `npx wrangler d1 execute sermon-research --remote --command "UPDATE users SET password_hash='<hash>' WHERE email='<email>'"`.
- **Too many sign-in attempts:** the limit is 10 failures per 15 minutes per IP
  and per email, and it clears on its own. To clear it now:
  `npx wrangler d1 execute sermon-research --remote --command "DELETE FROM login_attempts"`.
- **Change a provider or rotate a key:** have the person use Admin →
  Connections. A blank key field keeps the saved key. Keys can't be read back
  out of the database in plain text by design.
- **Sign-in link emails don't arrive:** the sender address must be on a domain
  verified in Resend (resend.com → Domains, which needs DNS records). Check
  the Resend dashboard's logs, then `npx wrangler tail` for
  `sign-in link email failed`.
- **A provider check fails with "didn't respond":** the Worker runs with
  `global_fetch_strictly_public`, so it can't reach private or local network
  addresses. A self-hosted AI gateway needs a public HTTPS address.
- **Change the schedule:** Admin → Episodes → Change. The cron in
  `wrangler.jsonc` stays hourly; don't edit it for schedule changes.
- **An episode failed:** the dashboard shows the provider's error. Common
  causes: the church's website sent a bot-check page instead of the MP3 (the
  Worker downloads the audio into R2 itself; ask the site owner to allow it),
  a key was revoked or ran out of credit, or the answers AI model
  doesn't return JSON (pick a stronger model). Fix the cause, then press Retry.
  Workflow runs are listed under Workers & Pages → Workflows →
  `sermon-research-episode`.
- **An episode is stuck on "Working":** runs that report nothing for 6 hours
  are marked failed by the next hourly tick, and can then be retried.
- **Process more or fewer episodes at once:** Admin → Episodes → "Episodes
  at once" (1 to 5, default 2). Use 1 for free or low-limit provider plans.
- **Transcription says the file couldn't be fetched:** Mistral downloads the
  audio from `/audio/:id` on this site using a signed link, so the site must
  be reachable publicly. The link's origin is saved as `site_origin` whenever
  an admin opens Admin → Episodes; open it once after moving to a custom domain.
- **Vectorize "dimension mismatch":** the index wasn't created with 1536
  dimensions. With permission, `npx wrangler vectorize delete sermon-research`,
  recreate it as in First deploy, then retry the episodes (retrying
  re-indexes; transcripts and summaries are kept).
- **Read logs:** `npx wrangler tail`, or the dashboard's Workers Logs.
- **Back up the database:** `npx wrangler d1 export sermon-research --remote --output backup.sql`.

## Ask first

- Deleting or recreating the D1 database, or running any `DELETE`/`UPDATE`
  beyond the recipes above. Take a backup first.
- Changing `APP_SECRET` after setup. Once provider keys exist, changing it
  makes them unreadable and they must be re-entered.
- Anything that costs money: paid plans, or importing many episodes. The
  import page's estimate uses list prices from when it was written; have the
  person check current Mistral and AI provider pricing for large imports.
- Deleting the Vectorize index.

## Never

- Commit secrets, `.dev.vars` or database exports.
- Delete D1 or Vectorize data without a backup.
- Print `APP_SECRET` or API keys back into chat logs unless the person asks.
- Skip or delete tests to get a deploy through.
