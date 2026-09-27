# Deploying for a church

This is the manual setup until per-church configuration lands.

## 1. Cloudflare resources

In your Cloudflare account, create:

- a D1 database, then apply `migrations/d1` with `wrangler d1 migrations apply`
- an R2 bucket for podcast audio
- a Vectorize index with 1536 dimensions (OpenAI `text-embedding-3-small`)

## 2. Worker configs

For each worker, copy `wrangler.jsonc` to a private deploy config (for example
`wrangler.production.jsonc`, kept out of this repo) and set:

- `account_id`, the D1 `database_id` and `database_name`, the R2 `bucket_name`,
  and the Vectorize `index_name`
- remove the `"remote": false` lines and the local-only names
- ingest: `SOUNDCLOUD_FEED_URL`, `R2_AUDIO_S3_ENDPOINT`
  (`https://<account-id>.r2.cloudflarestorage.com/`), model choices and crons
- rag: `AIC_CANONICAL_ORIGIN`, the public origin allowed to call the API

## 3. Secrets

Set with `wrangler secret put <NAME> --config <your deploy config>`.

| Worker | Secrets |
|---|---|
| ingest | `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `R2_AUDIO_PRESIGN_ACCESS_KEY_ID`, `R2_AUDIO_PRESIGN_SECRET_ACCESS_KEY`, optional `SILO_TEMP_KEY` |
| indexer | `OPENAI_API_KEY` |
| rag | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `AIC_PROVIDER_KEY_SECRET`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_KEY` (PEM), `AIC_CLERK_AUTHORIZED_PARTIES` (comma-separated origins), optional `SILO_TEMP_KEY` |

## 4. Deploy

```sh
npx wrangler deploy --config workers/indexer/<your deploy config>
npx wrangler deploy --config workers/ingest/<your deploy config>
npx wrangler deploy --config workers/rag/<your deploy config>
```

