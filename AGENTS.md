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
| `src/context.ts` | Request context and shared redirects |
| `src/views.ts`, `src/html.ts` | Server-rendered pages; `html` escapes every value |
| `test/` | `node:test` suites; `test/d1-sqlite.ts` stands in for D1 |
| `wrangler.jsonc` | Worker name, D1 binding |

Commands: `npm run verify` (typecheck and tests), `npm run dev` (local),
`npx wrangler deploy` (production), `npm run cf-typegen` (after config changes).

## First deploy

1. `npm install`, then `npx wrangler login`.
2. `npx wrangler deploy`. Current Wrangler creates the `sermon-research` D1
   database automatically when `database_id` is missing. If yours refuses:
   run `npx wrangler d1 create sermon-research` and paste the printed
   `database_id` into `wrangler.jsonc`.
3. Set the secret: `openssl rand -base64 32`, then
   `npx wrangler secret put APP_SECRET`, and paste the value. Tell the person
   to save it in a password manager: it's their setup code, and in a later
   release it encrypts their stored API keys.
4. Open the printed `https://sermon-research.<subdomain>.workers.dev` URL and
   let the person complete the wizard themselves.

There's no migration command. `src/schema.ts` runs pending migrations on the
first request after each deploy.

## Common tasks

- **Custom domain:** in the Cloudflare dashboard, go to Workers & Pages →
  sermon-research → Settings → Domains & Routes → Add → Custom domain. The
  domain must already be on Cloudflare DNS. Don't hardcode the domain
  anywhere; the app uses the request's own origin.
- **Rename the Worker:** change `name` in `wrangler.jsonc` and redeploy. The
  old `workers.dev` URL stops working.
- **Locked out (forgot password):** no reset flow exists yet. With the
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
- **Read logs:** `npx wrangler tail`, or the dashboard's Workers Logs.
- **Back up the database:** `npx wrangler d1 export sermon-research --remote --output backup.sql`.

## Ask first

- Deleting or recreating the D1 database, or running any `DELETE`/`UPDATE`
  beyond the recipes above. Take a backup first.
- Changing `APP_SECRET` after setup. Once provider keys exist, changing it
  makes them unreadable and they must be re-entered.
- Anything that costs money: paid plans, or large podcast imports once that
  feature exists.

## Never

- Commit secrets, `.dev.vars` or database exports.
- Print `APP_SECRET` or API keys back into chat logs unless the person asks.
- Skip or delete tests to get a deploy through.
