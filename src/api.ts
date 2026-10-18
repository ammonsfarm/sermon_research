import { API_REQUESTS_PER_HOUR, apiKeyFor } from "./api-keys.ts";
import type { AppEnv } from "./env.ts";
import { ProviderError } from "./providers.ts";
import { formatTime, QUESTION_MAX, retrieve } from "./research.ts";
import { catalog, type CatalogEntry, seriesOf, titleWithoutSeries } from "./scope.ts";
import { likePattern, parseList } from "./sermons.ts";
import { getSetting, getSetupStep, type Ministry } from "./settings.ts";
import { HOUR_MS, recordUse, usedSince } from "./usage.ts";

/**
 * The read-only JSON API under /api/v1, for other systems such as a Custom GPT. It hands out
 * passages and sermon details; the caller writes its own answers, so no answers-AI calls are made.
 * Every endpoint but the OpenAPI description needs an API key from Admin → API keys.
 */

const SEARCH_DEFAULT = 8;
const SEARCH_MAX = 20;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const MAX_SERMON_IDS = 50;
const ID = /^[0-9a-f-]{36}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

function failure(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, status, headers);
}

/** Handles every /api/ request. */
export async function api(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/u, "");
  if (request.method !== "GET" && request.method !== "HEAD") return failure(405, "method_not_allowed", "The API only answers GET requests.", { Allow: "GET" });
  if (path === "/api/v1/openapi.json") return json(openApi(url.origin, await getSetting<Ministry>(env.DB, "ministry")));
  if ((await getSetupStep(env.DB)) !== "complete") return failure(503, "not_ready", "This site is still being set up.");

  const key = await apiKeyFor(env.DB, request);
  if (!key) return failure(401, "unauthorized", "Send an API key from Admin → API keys as `Authorization: Bearer <key>`.", { "WWW-Authenticate": "Bearer" });
  const bucket = `api:${key.id}`;
  const now = Date.now();
  if (await usedSince(env.DB, bucket, now - HOUR_MS) >= API_REQUESTS_PER_HOUR) {
    return failure(429, "rate_limited", `This key has made ${API_REQUESTS_PER_HOUR} requests in the last hour. Try again later.`, { "Retry-After": "600" });
  }
  await recordUse(env.DB, [bucket], now);

  const params = url.searchParams;
  try {
    if (path === "/api/v1/search") return await search(env, url.origin, params);
    if (path === "/api/v1/sermons") return await sermons(env, url.origin, params);
    if (path === "/api/v1/filters") return await filters(env);
    const one = /^\/api\/v1\/sermons\/([0-9a-f-]{36})$/u.exec(path);
    if (one) return await sermon(env, url.origin, one[1]!, params);
  } catch (error) {
    if (error instanceof ProviderError) return failure(502, "search_unavailable", `Search isn't available right now: ${error.message}`);
    throw error;
  }
  return failure(404, "not_found", "No such endpoint. See /api/v1/openapi.json.");
}

// ---------------------------------------------------------------- filters

interface Filters {
  readonly series?: string;
  readonly speaker?: string;
  readonly from?: string;
  readonly to?: string;
  readonly sermonIds?: readonly string[];
}

/** Reads the shared filter parameters, or returns the reason one is malformed. */
function readFilters(params: URLSearchParams): Filters | string {
  const text = (name: string) => (params.get(name) ?? "").trim().slice(0, 120);
  const from = text("from");
  const to = text("to");
  if (from && !DATE.test(from)) return "`from` must be a date like 2024-01-31.";
  if (to && !DATE.test(to)) return "`to` must be a date like 2024-12-31.";
  const ids = params.getAll("sermon_id").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !ID.test(id))) return "Each `sermon_id` must be a sermon id from /api/v1/sermons.";
  return {
    ...(text("series") ? { series: text("series") } : {}),
    ...(text("speaker") ? { speaker: text("speaker") } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(ids.length ? { sermonIds: [...new Set(ids)].slice(0, MAX_SERMON_IDS) } : {}),
  };
}

const isEmpty = (filters: Filters) => !filters.series && !filters.speaker && !filters.from && !filters.to && !filters.sermonIds;

/**
 * Whether a sermon passes the filters. Series must match whole and speaker may be part of the name
 * ("Smith" finds "John Smith"), both ignoring case, since callers are often language models guessing.
 */
function passes(entry: CatalogEntry, filters: Filters): boolean {
  if (filters.sermonIds && !filters.sermonIds.includes(entry.id)) return false;
  if (filters.series && entry.series?.toLowerCase() !== filters.series.toLowerCase()) return false;
  if (filters.speaker && !entry.speaker?.toLowerCase().includes(filters.speaker.toLowerCase())) return false;
  const day = entry.publishedAt?.slice(0, 10);
  if (filters.from && (!day || day < filters.from)) return false;
  if (filters.to && (!day || day > filters.to)) return false;
  return true;
}

function count(params: URLSearchParams, name: string, fallback: number, max: number): number | string {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= (name === "offset" ? 0 : 1) && value <= max ? value : `\`${name}\` must be a whole number from ${name === "offset" ? 0 : 1} to ${max}.`;
}

const sermonUrl = (origin: string, id: string) => `${origin}/episodes/${id}`;

// ---------------------------------------------------------------- endpoints

/** GET /api/v1/search?q= : the passages closest in meaning to `q`, each with the passages around it. */
async function search(env: AppEnv, origin: string, params: URLSearchParams): Promise<Response> {
  const query = (params.get("q") ?? "").trim();
  if (!query) return failure(400, "bad_request", "Add a question or topic as `q`.");
  if (query.length > QUESTION_MAX) return failure(400, "bad_request", `\`q\` can be at most ${QUESTION_MAX} characters.`);
  const filters = readFilters(params);
  if (typeof filters === "string") return failure(400, "bad_request", filters);
  const limit = count(params, "limit", SEARCH_DEFAULT, SEARCH_MAX);
  if (typeof limit === "string") return failure(400, "bad_request", limit);

  const episodeIds = isEmpty(filters) ? null : (await catalog(env.DB)).filter((entry) => passes(entry, filters)).map((entry) => entry.id);
  const { passages } = episodeIds?.length === 0 ? { passages: [] } : await retrieve(env, query, { topK: limit, episodeIds, mode: "search" });
  return json({
    query,
    results: passages.map((passage) => ({
      sermon_id: passage.episodeId,
      title: titleWithoutSeries(passage.title),
      series: seriesOf(passage.title),
      speaker: passage.speaker ?? null,
      date: passage.publishedAt?.slice(0, 10) ?? null,
      kind: passage.kind,
      start_seconds: passage.kind === "transcript" ? passage.start : null,
      timestamp: passage.kind === "transcript" && passage.start !== null ? formatTime(passage.start) : null,
      url: `${sermonUrl(origin, passage.episodeId)}#t-${passage.seq}`,
      text: passage.text,
    })),
  });
}

interface SermonRow {
  readonly id: string; readonly title: string; readonly published_at: string | null; readonly speaker: string | null;
  readonly duration_seconds: number | null; readonly summary: string | null; readonly main_scripture: string | null;
  readonly topics_json: string | null; readonly scriptures_json: string | null;
}

const SELECT_SERMONS = `SELECT e.id, e.title, e.published_at, e.speaker, e.duration_seconds, s.summary, s.main_scripture, s.topics_json, s.scriptures_json
  FROM episodes e LEFT JOIN summaries s ON s.episode_id = e.id WHERE e.status = 'done'`;

function sermonJson(origin: string, row: SermonRow) {
  return {
    id: row.id,
    title: titleWithoutSeries(row.title),
    series: seriesOf(row.title),
    speaker: row.speaker,
    date: row.published_at?.slice(0, 10) ?? null,
    duration_seconds: row.duration_seconds,
    // Empty means the AI found no single main passage; it's reported as null either way.
    main_scripture: row.main_scripture || null,
    scriptures: parseList(row.scriptures_json),
    topics: parseList(row.topics_json),
    summary: row.summary,
    url: sermonUrl(origin, row.id),
  };
}

/** GET /api/v1/sermons : sermons newest first, filtered, with an optional keyword match on titles, summaries, topics and scripture. */
async function sermons(env: AppEnv, origin: string, params: URLSearchParams): Promise<Response> {
  const filters = readFilters(params);
  if (typeof filters === "string") return failure(400, "bad_request", filters);
  const limit = count(params, "limit", LIST_DEFAULT, LIST_MAX);
  if (typeof limit === "string") return failure(400, "bad_request", limit);
  const offset = count(params, "offset", 0, 100_000);
  if (typeof offset === "string") return failure(400, "bad_request", offset);
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const order = params.get("sort") === "oldest" ? "ASC" : "DESC";

  const rows = query
    ? (await env.DB.prepare(`${SELECT_SERMONS} AND (e.title LIKE ?1 ESCAPE '\\' OR e.speaker LIKE ?1 ESCAPE '\\' OR s.main_scripture LIKE ?1 ESCAPE '\\' OR s.summary LIKE ?1 ESCAPE '\\' OR s.topics_json LIKE ?1 ESCAPE '\\' OR s.scriptures_json LIKE ?1 ESCAPE '\\') ORDER BY e.published_at ${order}`)
      .bind(likePattern(query)).all<SermonRow>()).results
    : (await env.DB.prepare(`${SELECT_SERMONS} ORDER BY e.published_at ${order}`).all<SermonRow>()).results;
  const matching = rows.filter((row) => passes({ id: row.id, title: row.title, publishedAt: row.published_at, series: seriesOf(row.title), speaker: row.speaker }, filters));
  return json({
    total: matching.length,
    offset,
    sermons: matching.slice(offset, offset + limit).map((row) => sermonJson(origin, row)),
  });
}

/** GET /api/v1/sermons/:id : one sermon's details, with its whole transcript when `transcript=true`. */
async function sermon(env: AppEnv, origin: string, id: string, params: URLSearchParams): Promise<Response> {
  const row = await env.DB.prepare(`${SELECT_SERMONS} AND e.id = ?`).bind(id).first<SermonRow>();
  if (!row) return failure(404, "not_found", "No sermon has that id.");
  const wantsTranscript = ["true", "1", "yes"].includes((params.get("transcript") ?? "").toLowerCase());
  const transcript = wantsTranscript ? await env.DB.prepare("SELECT text FROM transcripts WHERE episode_id = ?").bind(id).first<{ text: string }>() : null;
  return json({ ...sermonJson(origin, row), ...(wantsTranscript ? { transcript: transcript?.text ?? null } : {}) });
}

/** GET /api/v1/filters : the series and speakers to filter by, and the dates the sermons span. */
async function filters(env: AppEnv): Promise<Response> {
  const entries = await catalog(env.DB);
  const tally = (pick: (entry: CatalogEntry) => string | null) => {
    const counts = new Map<string, number>();
    for (const entry of entries) { const value = pick(entry); if (value) counts.set(value, (counts.get(value) ?? 0) + 1); }
    return [...counts].map(([name, sermons]) => ({ name, sermons }));
  };
  const days = entries.flatMap((entry) => entry.publishedAt?.slice(0, 10) ?? []).sort();
  return json({
    sermon_count: entries.length,
    earliest: days[0] ?? null,
    latest: days.at(-1) ?? null,
    // The catalog is newest first, so series come most recently preached first.
    series: tally((entry) => entry.series),
    speakers: tally((entry) => entry.speaker).sort((a, b) => b.sermons - a.sermons || a.name.localeCompare(b.name)),
  });
}

// ---------------------------------------------------------------- OpenAPI

/** The OpenAPI 3.1 description a Custom GPT imports from /api/v1/openapi.json. Operation descriptions stay under 300 characters, GPT Actions' limit. */
export function openApi(origin: string, ministry: Ministry | null): unknown {
  const church = ministry?.churchName || "the church";
  const filterParams = [
    { name: "series", in: "query", required: false, schema: { type: "string" }, description: "Only sermons in this series (exact name from /api/v1/filters, any case)." },
    { name: "speaker", in: "query", required: false, schema: { type: "string" }, description: "Only sermons by this speaker; part of the name is enough." },
    { name: "from", in: "query", required: false, schema: { type: "string", format: "date" }, description: "Only sermons preached on or after this date (YYYY-MM-DD)." },
    { name: "to", in: "query", required: false, schema: { type: "string", format: "date" }, description: "Only sermons preached on or before this date (YYYY-MM-DD)." },
    { name: "sermon_id", in: "query", required: false, schema: { type: "string" }, description: "Only these sermons: one id, or several separated by commas." },
  ];
  const errors = {
    "400": { description: "A parameter is malformed.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    "401": { description: "The API key is missing or revoked.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    "429": { description: "This key made too many requests this hour.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  };
  const nullable = (type: string, description: string) => ({ type: [type, "null"], description });
  return {
    openapi: "3.1.0",
    info: {
      title: `${ministry?.siteTitle || "Sermon Research"} API`,
      version: "1.0.0",
      description: `Search and read the sermons of ${church}: transcripts, summaries, scripture and topics. Cite sermons by title and date, and link each one's url.`,
    },
    servers: [{ url: origin }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/v1/search": {
        get: {
          operationId: "searchSermons",
          summary: "Find sermon passages about a question or topic",
          description: "Semantic search over the sermon transcripts and summaries. Returns the closest passages with the text around them, title, speaker, date and a link to that moment. Use it before answering any question about what was preached.",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string", maxLength: QUESTION_MAX }, description: "The question or topic, in plain words." },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: SEARCH_MAX, default: SEARCH_DEFAULT }, description: "How many passages to return." },
            ...filterParams,
          ],
          responses: { "200": { description: "Passages, closest first.", content: { "application/json": { schema: { $ref: "#/components/schemas/SearchResults" } } } }, ...errors },
        },
      },
      "/api/v1/sermons": {
        get: {
          operationId: "listSermons",
          summary: "List sermons with their summaries",
          description: "Sermons newest first, with title, series, speaker, date, main scripture, topics and summary. Filter by series, speaker or dates, or match words in titles, summaries, topics and scripture with q.",
          parameters: [
            { name: "q", in: "query", required: false, schema: { type: "string" }, description: "Words to match in titles, speakers, summaries, topics or scripture references (not a semantic search)." },
            ...filterParams,
            { name: "sort", in: "query", required: false, schema: { type: "string", enum: ["newest", "oldest"], default: "newest" } },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: LIST_MAX, default: LIST_DEFAULT } },
            { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 }, description: "How many matching sermons to skip, for paging." },
          ],
          responses: { "200": { description: "Matching sermons.", content: { "application/json": { schema: { $ref: "#/components/schemas/SermonList" } } } }, ...errors },
        },
      },
      "/api/v1/sermons/{id}": {
        get: {
          operationId: "getSermon",
          summary: "Get one sermon, optionally with its full transcript",
          description: "One sermon's details and summary. Set transcript=true for the whole transcript, to read or quote a sermon in full.",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "The sermon id." },
            { name: "transcript", in: "query", required: false, schema: { type: "boolean", default: false }, description: "Include the full transcript." },
          ],
          responses: {
            "200": { description: "The sermon.", content: { "application/json": { schema: { $ref: "#/components/schemas/SermonDetail" } } } },
            "404": { description: "No sermon has that id.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            ...errors,
          },
        },
      },
      "/api/v1/filters": {
        get: {
          operationId: "listFilters",
          summary: "List the series and speakers to filter by",
          description: "Every series and speaker with how many sermons each has, plus the total number of sermons and the dates they span. Use it to find exact series names before filtering.",
          responses: { "200": { description: "Series, speakers and dates.", content: { "application/json": { schema: { $ref: "#/components/schemas/Filters" } } } }, ...errors },
        },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "An API key from Admin → API keys." } },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" } }, required: ["code", "message"] } },
          required: ["error"],
        },
        Passage: {
          type: "object",
          properties: {
            sermon_id: { type: "string" },
            title: { type: "string" },
            series: nullable("string", "The series the sermon belongs to."),
            speaker: nullable("string", "Who preached it."),
            date: nullable("string", "The date it was preached (YYYY-MM-DD)."),
            kind: { type: "string", enum: ["summary", "transcript"], description: "Whether this passage is from the sermon's summary or its transcript." },
            start_seconds: nullable("number", "Where the passage starts in the audio."),
            timestamp: nullable("string", "start_seconds as m:ss or h:mm:ss."),
            url: { type: "string", description: "A link to this passage on the sermon's page." },
            text: { type: "string" },
          },
          required: ["sermon_id", "title", "kind", "url", "text"],
        },
        SearchResults: {
          type: "object",
          properties: { query: { type: "string" }, results: { type: "array", items: { $ref: "#/components/schemas/Passage" } } },
          required: ["query", "results"],
        },
        Sermon: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            series: nullable("string", "The series the sermon belongs to."),
            speaker: nullable("string", "Who preached it."),
            date: nullable("string", "The date it was preached (YYYY-MM-DD)."),
            duration_seconds: nullable("integer", "The length of the recording."),
            main_scripture: nullable("string", "The passage the sermon preaches from."),
            scriptures: { type: "array", items: { type: "string" }, description: "Scripture references mentioned." },
            topics: { type: "array", items: { type: "string" } },
            summary: nullable("string", "A summary of the sermon."),
            url: { type: "string", description: "The sermon's page, with audio and the transcript." },
          },
          required: ["id", "title", "url"],
        },
        SermonDetail: {
          allOf: [{ $ref: "#/components/schemas/Sermon" }, { type: "object", properties: { transcript: nullable("string", "The full transcript, when asked for.") } }],
        },
        SermonList: {
          type: "object",
          properties: {
            total: { type: "integer", description: "How many sermons match, across all pages." },
            offset: { type: "integer" },
            sermons: { type: "array", items: { $ref: "#/components/schemas/Sermon" } },
          },
          required: ["total", "offset", "sermons"],
        },
        Filters: {
          type: "object",
          properties: {
            sermon_count: { type: "integer" },
            earliest: nullable("string", "The earliest sermon's date."),
            latest: nullable("string", "The latest sermon's date."),
            series: { type: "array", items: { $ref: "#/components/schemas/Facet" }, description: "Most recently preached first." },
            speakers: { type: "array", items: { $ref: "#/components/schemas/Facet" }, description: "Most sermons first." },
          },
          required: ["sermon_count", "series", "speakers"],
        },
        Facet: { type: "object", properties: { name: { type: "string" }, sermons: { type: "integer" } }, required: ["name", "sermons"] },
      },
    },
  };
}
