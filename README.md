# Sermon Research

Turn a church's sermon podcast into a searchable, citable research archive,
running entirely in your own Cloudflare account.

> **Status:** early. This release has the base site: sign-in, sessions and the
> first two setup steps. Podcast import, AI settings and the research page are
> coming next; see [Roadmap](#roadmap).

## Deploy

You need a Cloudflare account (the free plan is enough to start) and Node.js 22.18 or newer.

```sh
git clone https://github.com/ammonsfarm/sermon_research
cd sermon_research
npm install
npx wrangler login
npx wrangler deploy
openssl rand -base64 32          # copy the output
npx wrangler secret put APP_SECRET   # paste it; keep a copy somewhere safe
```

Open the `workers.dev` address Wrangler printed. The setup wizard asks for
the `APP_SECRET` value as a setup code, so only whoever deployed the site can
create the admin account. Then it asks for your ministry's name and speakers.

Stuck on a step, or want a custom domain? Point Claude or another AI coding
assistant at this repo. [AGENTS.md](AGENTS.md) tells it how to help.

## What's in this release

- Email and password sign-in, with passwords hashed using PBKDF2-SHA256
- Sessions that last 30 days and extend while in use, plus "sign out on all devices"
- Rate limits on sign-in and setup attempts
- A setup wizard that can only be completed by the person who holds `APP_SECRET`
- Ministry details (site title, church name, speakers), editable later in Admin
- A database schema that installs and upgrades itself, so there's no migration step

## Roadmap

1. **Base** (this release): sign-in, sessions, setup wizard, deploy docs.
2. **Providers:** podcast RSS feed, an answers LLM (any OpenAI-compatible
   endpoint), OpenAI embeddings, Mistral transcription, and optional emailed
   sign-in links through Resend. Keys are entered in the wizard and stored
   encrypted.
3. **Pipeline:** import the last N episodes with a cost estimate, a schedule
   set in the admin screen, and a progress dashboard with retries.
4. **Research:** cited answers across all sermons, episode search and episode
   pages. It's members-only by default, with a switch to make it public.

## Develop

```sh
cp .dev.vars.example .dev.vars   # then fill in APP_SECRET
npm run dev                      # local Worker with a local D1 database
npm run verify                   # typecheck and tests
```

After changing `wrangler.jsonc`, run `npm run cf-typegen` to refresh the types.

## License

MIT
