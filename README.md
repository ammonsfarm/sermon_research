# Sermon Research

Turn a church's sermon podcast into a searchable, citable research archive on
Cloudflare Workers.

1. **Ingest** finds new episodes in the podcast feed, copies the audio to R2,
   transcribes it (Mistral), and writes an LLM review and summary of each
   episode (Gemini or an OpenAI-compatible gateway).
2. **Index** chunks transcripts and summaries, embeds them (OpenAI), and stores
   the vectors in Vectorize with the source rows in D1.
3. **RAG** answers questions from the archive with cited excerpts, and serves
   keyword plus semantic episode search.

This code was extracted from the Abiding in Christ sermon archive, which runs
on it in production.

## Layout

| Path | What it is |
|---|---|
| `workers/ingest` | Scheduled feed discovery and the episode ingest Workflow |
| `workers/indexer` | Content indexing Workflow (chunking, embeddings, Vectorize) |
| `workers/rag` | Authenticated research API: chat, history, models, episode search |
| `packages/*` | Shared contracts, D1 repositories, AI providers, auth, storage, observability |
| `migrations/d1` | D1 schema, applied in order |

## Develop

Requires Node.js 24.7 or newer.

```sh
npm install
npm run verify   # typecheck, unit tests, generated Worker types check
```

Each worker's `wrangler.jsonc` is a local-only template with placeholder
resource IDs. Deployment configs belong to each deployment, not to this repo;
see [docs/SETUP.md](docs/SETUP.md).

## Current limitations

These are being worked on:

- Feed discovery accepts SoundCloud RSS feeds only.
- Some identifiers and prompts still carry names from the original deployment
  (for example the `pastorwood` article namespace in the D1 schema). They will
  move to per-church configuration.
- The research API requires Clerk sign-in; there is no bundled research page yet.

## License

MIT
