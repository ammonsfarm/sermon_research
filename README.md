# Sermon Research

Turn a church's sermon podcast into a searchable, citable research archive,
running entirely in your own Cloudflare account.

> **Status:** early, feature complete for a first release: sign-in, the setup
> wizard, episode processing and the research page all work. See
> [Roadmap](#roadmap).

## Deploy

You need a Cloudflare account (the free plan is enough to start) and Node.js 22.18 or newer.

```sh
git clone https://github.com/ammonsfarm/sermon_research
cd sermon_research
npm install
npx wrangler login
npx wrangler vectorize create sermon-research --dimensions=1536 --metric=cosine
npx wrangler vectorize create-metadata-index sermon-research --property-name=episodeId --type=string
npx wrangler deploy
openssl rand -base64 32          # copy the output
npx wrangler secret put APP_SECRET   # paste it; keep a copy somewhere safe
```

**Or deploy from GitHub:** fork this repo, add the `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` and `APP_SECRET` repository secrets, then run the
**Deploy** workflow from the Actions tab. It creates the search index if
needed, creates the R2 bucket for episode audio, deploys, and sets
`APP_SECRET`. The token needs edit rights for Workers Scripts, D1, Vectorize
and R2 (the "Edit Cloudflare Workers" template plus D1 and Vectorize).

Open the `workers.dev` address Wrangler printed. The setup wizard asks for
the `APP_SECRET` value as a setup code, so only whoever deployed the site can
create the admin account. Then it walks through:

1. Your ministry's name and speakers
2. Your podcast's RSS feed. It shows the podcast title and episode count so you can confirm it's the right one.
3. The **answers AI**: any OpenAI-compatible API (OpenAI, Gemini, OpenRouter,
   Anthropic and others). Enter the base address, model and key.
4. **Search embeddings**: an OpenAI key for `text-embedding-3-small`. If step 3 was OpenAI, you can reuse that key.
5. **Transcription**: a Mistral key (Voxtral handles full-length sermon audio)
6. **Email** (optional): a Resend key and sender address, so people can sign in with an emailed link
7. **Import**: how many past episodes to process now (none, 10, 50 or all),
   each with an estimate of audio minutes and cost, and a daily or weekly
   schedule for checking the feed

Each step makes a small live request to confirm the address and key work
before saving. Keys are stored encrypted with a key derived from `APP_SECRET`.

Stuck on a step, or want a custom domain? Point Claude or another AI coding
assistant at this repo. [AGENTS.md](AGENTS.md) tells it how to help.

## What's in this release

- Email and password sign-in, with passwords hashed using PBKDF2-SHA256
- Sessions that last 30 days and extend while in use, plus "sign out on all devices"
- Rate limits on sign-in and setup attempts
- A setup wizard that can only be completed by the person who holds `APP_SECRET`
- Ministry details, podcast feed and AI connections, each editable later in Admin
- Live checks for the feed and every provider before anything is saved
- API keys encrypted at rest (AES-GCM); only the last 4 characters are ever shown
- Optional emailed sign-in links through Resend. They work once and expire after 15 minutes, and they need a button press so email scanners can't use them up.
- A database schema that installs and upgrades itself, so there's no migration step
- Episode processing: the Worker copies each episode's audio into R2 (so a
  church website's bot check can't block the transcription service), Mistral
  transcribes it from a short-lived signed link to that copy, the answers AI writes a summary with topics and scripture references,
  and the transcript is split into timestamped passages and indexed for search
- A live episodes dashboard that refreshes itself while work runs, showing
  each episode's current step, retry errors and when the background worker
  last ran, with retry (one or all failed), "check now" and importing older
  episodes later
- An "episodes at once" setting (1 to 5, default 2) for providers with low
  rate limits
- Episode pages play the audio from your own R2 copy
- A schedule set in Admin (daily or weekly, at a local hour); there's no cron
  to edit
- A clear layout: Ask, Sermons and Library tabs for everyone, and Admin with
  its own side menu for admins
- Ask: a question gets an answer drawn only from your sermons, with numbered
  citations linking to the passage and its timestamp. Narrow any question to
  a series, a date range or specific sermons. Answers become conversations
  you can follow up on, saved to your Library
- Sermons: searchable cards (title, topic, scripture or meaning) with series
  and date filters, and a page per sermon with the player and a read-along
  transcript: the sentence being played is highlighted (the word is estimated
  from sentence timings), and clicking any sentence plays from there. Beside
  it, tabs for the summary, asking about just that sermon, and creating an
  outline, study questions or anything else from it
- Documents: signed-in people can have the answers AI write a sermon outline,
  a small-group study guide or any custom document, with citations. The AI
  reads the full transcripts of the sermons a request needs, picked from
  their scripture and topics. Long requests, like a book with a chapter per
  sermon, are planned and then written one part at a time in the
  background, with the page showing progress. Each is saved to the Library
  and downloads as a Markdown (.md) file with its sources linked
- Main texts: each sermon's summary names the passage it preaches from,
  shown on its card and page apart from the other references it mentions,
  and used when the AI picks sermons for a document
- Speakers: the answers AI works out who preached each sermon from the
  feed's description and the start of the transcript. Sermons show their
  speaker and can be filtered by it, scopes can be limited to one, and a
  question like "what has Pastor Phil said about prayer?" searches only
  that speaker's sermons. Admins can correct a speaker on its sermon page
- Members-only by default: admins invite members by link (emailed too when
  email is set up). A switch in Admin makes it public, with per-visitor hourly
  limits and a daily cap on questions to control AI spending

## Roadmap

1. **Base** (done): sign-in, sessions, setup wizard, deploy docs.
2. **Providers** (done): podcast feed, answers AI, embeddings, transcription,
   and emailed sign-in links, all configured in the wizard.
3. **Pipeline** (done): import the last N episodes with a cost estimate, a schedule
   set in the admin screen, and a progress dashboard with retries.
4. **Research** (done): cited answers across all sermons, episode search and episode
   pages. It's members-only by default, with a switch to make it public.

Ideas for later: follow-up questions in a conversation, a password reset
email, and importing transcripts that feeds already publish.

## Develop

```sh
cp .dev.vars.example .dev.vars   # then fill in APP_SECRET
npm run dev                      # local Worker with a local D1 database
npm run verify                   # typecheck and tests
```

After changing `wrangler.jsonc`, run `npm run cf-typegen` to refresh the types.

## License

MIT
