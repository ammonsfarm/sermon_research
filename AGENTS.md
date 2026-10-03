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
| `src/feed.ts` | Podcast RSS fetch and parse, including each episode's description and author |
| `src/providers.ts` | Live checks and calls to OpenAI-compatible APIs, OpenAI embeddings, Mistral, Muse transcription (with its error messages) and Resend |
| `src/keys.ts` | API keys stored AES-GCM encrypted in `provider_keys` |
| `src/links.ts` | Emailed sign-in links |
| `src/imports.ts` | Import step with cost estimate, episodes dashboard, schedule page, hourly cron logic |
| `src/audio.ts` | Copies episode audio into the `AUDIO` R2 bucket, signs short-lived links for the transcription service, serves `/audio/:id` with ranges |
| `src/episodes.ts` | Episode rows from the feed, the queue, and starting workflow runs (up to the admin's "episodes at once" setting) |
| `src/pipeline.ts` | The per-episode steps: transcribe (Mistral in one step, or Muse a part at a time) into `transcripts_draft`, clean up into `transcripts`, summarize and identify the speaker (answers AI), chunk, embed and write to Vectorize |
| `src/mp3.ts`, `src/mp3.wasm` | Decodes the stored MP3 to 16 kHz mono for Muse, inside the Worker. The `.wasm` is minimp3 (public domain, `vendor/minimp3`) with the small wrapper in `wasm/mp3.c`; it's committed, and `scripts/build-mp3-wasm.sh` rebuilds it with Zig |
| `src/muse.ts` | Muse's side of transcription: WAV files, ending each part at a pause, and turning Muse's turns into timed segments |
| `src/cleanup.ts` | Transcript cleanup: the prompt, batching, and keeping the draft wherever the answers AI's change looks like more than a correction |
| `src/workflow.ts` | The Cloudflare Workflow classes: one runs `pipeline.ts` for an episode, the other runs `writing.ts` for a document |
| `src/schedule.ts` | Daily/weekly schedule in the church's time zone |
| `src/ask.ts` | Ask home page, the ask box, conversations (the `turns` table, with follow-ups) and the Library |
| `src/scope.ts` | Question scope: series (taken from the " - Series" end of a title), speaker, date range and specific sermons |
| `src/scriptures.ts` | Each sermon's main passage (`summaries.main_scripture`): the hourly catch-up for sermons summarized before it was kept, and reference cleanup |
| `src/speakers.ts` | Who preached each sermon: the answers AI reads the feed's description and author and the start of the transcript (pipeline step for new sermons, hourly for older ones); name cleanup; spotting a speaker named in a question |
| `src/sermons.ts` | Sermons grid with search and filters, and the sermon page (player, read-along, Summary / Ask / Create panel) |
| `src/research.ts` | Retrieval (Vectorize, filtered to a scope), cited answers, sources, question limits and research access settings |
| `src/documents.ts`, `src/markdown.ts` | Markdown documents written from the sermons (outline, study questions, custom): starting one, its page (live progress while it's written, Try again if it failed) and `.md` download; a small Markdown renderer that escapes everything it doesn't handle |
| `src/writing.ts` | How a document is written, in the background: the answers AI picks the sermons from a catalog (titles, dates, scripture, topics) and splits long requests into parts, then each part is written from the full transcripts of its sermons, and the parts are joined with their citations renumbered |
| `src/members.ts` | Member invites, invite acceptance, removing members |
| `src/usage.ts` | Hourly and daily counters for questions and searches |
| `src/context.ts` | Request context and shared redirects |
| `src/views.ts`, `src/html.ts`, `src/layout.ts` | Server-rendered pages; `html` escapes every value. `layout.ts` holds the header tabs and the admin side menu (add admin pages to `ADMIN_MENU`) |
| `src/theme.ts` | Color schemes admins pick in Admin → Ministry (add one to `SCHEMES`: header, button and highlight colors), and each visitor's light / dark / device switch (`sr_mode` cookie) |
| `src/assets.ts` | The only CSS (`/assets/app.css`) and JavaScript (`/assets/app.js`): busy state on forms, tabs, the read-along. Pages work without the script |
| `public/fonts/` | Self-hosted Inter and Source Serif 4 (SIL Open Font License), served as static assets before the Worker runs |
| `test/` | `node:test` suites; `test/d1-sqlite.ts` stands in for D1 |
| `wrangler.jsonc` | Worker name, D1, Vectorize, the two Workflows and the hourly cron |

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
  `SOURCES` in `src/research.ts` sets how many passages each answer sees.
  Documents read whole transcripts instead (see the next item).
- **How documents are written:** in a Workflow run
  (`sermon-research-document`), so the person can leave the page. First the
  answers AI gets a catalog of the sermons in scope (title, date, scripture,
  topics) and chooses the ones the request needs. A long request (a book, a
  course) is split into up to `MAX_PARTS` parts with a word count each, and
  each part is its own AI call with the full transcripts of its sermons, the
  whole plan and the end of the part before. Outlines and study guides of
  chosen sermons (the sermon page's Create buttons) skip the planning call.
  A part's sources are capped at `PART_SOURCE_CHARS` (about 60k tokens);
  past that it keeps every summary plus the closest passages. Lower it for
  a model with a small context window. A long book is many calls, so it
  takes minutes and costs more than an answer, but it counts as one
  question against the limits. A run that reports nothing for 2 hours is
  marked failed by the hourly tick, and the document page offers Try again.
- **Add or change a document type:** edit `OUTPUTS` in `src/ask.ts` (the
  menu) and `INSTRUCTIONS` in `src/writing.ts` (what the AI is told).
  Documents count against the same question limits and need a signed-in person.
- **Speakers:** each sermon's `episodes.speaker` is set by the answers AI
  (`speaker_source = 'ai'`) from the feed's description and author and the
  first 1,500 characters of the transcript, using the spellings in Admin →
  Ministry → Speaker names. New sermons get it as a pipeline step; older ones
  are done by the hourly tick or Admin → Episodes → "Identify now". An admin
  can set or clear one on its sermon page (`speaker_source = 'admin'`), and
  the AI never changes those. To have the AI look again at everything it
  named: `npx wrangler d1 execute sermon-research --remote --command
  "UPDATE episodes SET speaker_source = NULL WHERE speaker_source = 'ai'"`.
  A question that names exactly one speaker ("Pastor Phil's sermons",
  "Friesen") is scoped to their sermons automatically; first names count
  only after a title or as a possessive, and Bible book names never do.
- **Transcript cleanup:** the transcript (Mistral's or Muse's) is saved as it came back in
  `transcripts_draft`. The answers AI then corrects it (`CLEANUP_PROMPT` in
  `src/cleanup.ts`: proper nouns, stray periods at pauses, capitals) about
  8,000 characters at a time, sending the segments as JSON with IDs, and the
  result goes to `transcripts` with the original timings. It uses the "Summary
  reasoning effort" from Admin → Answers AI. Everything after that
  (summary, speaker, main text, search, read-along, documents) reads the
  cleaned one. A segment keeps its draft text when the reply leaves it out,
  isn't JSON, or changes more than about a fifth of its words. Each batch is
  saved in `transcripts_draft.cleaned_json`, so a retry carries on from there.
  `transcripts.cleaned_by` names the model; it's null for sermons transcribed
  before cleanup existed, which aren't cleaned.
- **Main texts:** the summary step asks the answers AI for the passage a
  sermon preaches from (`summaries.main_scripture`) as well as every
  reference it mentions. Sermons summarized before that are caught up by
  the hourly tick or Admin → Episodes → "Choose now", which reads the start
  of each transcript, where the text is usually announced. An empty string
  means the AI found no single main passage (a topical sermon); null means
  it hasn't been checked. To check everything again:
  `npx wrangler d1 execute sermon-research --remote --command "UPDATE summaries SET main_scripture = NULL"`.
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
- **Muse and reasoning effort:** when the answers AI's base address is on
  `api.meta.ai`, every chat call sends `reasoning_effort`. Admin → Answers AI
  has two, both Low by default: "Summary" for sermon processing (the
  full-text transcript review, summaries, speakers, main texts) and "Chat" for answers and documents. A new `chat()`
  caller picks one with its `effort` option; the connection check always uses
  Low. Other providers never get the field, since some reject unknown fields
  with a 400.
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
- **Transcription service:** Admin → Transcription chooses Mistral (the
  default; sites set up before the choice existed have no `provider` and
  read as Mistral) or Muse (`muse-voice-transcribe-1.0`). Both use the same
  `transcription` key slot, so switching needs the other service's key; the
  Muse check transcribes one second of silence. Mistral fetches the audio
  itself from a signed link. Muse only takes mono 16-bit WAV of up to 10
  minutes and 32 MB, and Workers can't run ffmpeg, so each part is its own
  workflow step that decodes the R2 copy of the MP3 from the start with the
  WebAssembly decoder in `src/mp3.ts`, keeps up to 9.5 minutes
  (`MUSE_LIMITS` in `src/muse.ts`) as 16 kHz mono, ends it at the quietest
  quarter second in its last 30 seconds, and sends it. Turns come back in
  milliseconds from the start of the part and are offset into the sermon.
  Progress is saved in `transcription_progress`, so a retry carries on from
  the last finished part. Decoding a 45-minute sermon's last part takes
  about 3 seconds of CPU and 45 MB of memory, inside the Workers Paid
  plan's 30-second default. Muse can't take M4A, AAC or other non-MP3
  feeds; those episodes fail with a message saying to switch to Mistral.
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
  person check current transcription (Mistral or Muse) and AI provider pricing for large imports.
- Deleting the Vectorize index.

## Never

- Commit secrets, `.dev.vars` or database exports.
- Delete D1 or Vectorize data without a backup.
- Print `APP_SECRET` or API keys back into chat logs unless the person asks.
- Skip or delete tests to get a deploy through.
