import { formatBytes } from "./audio.ts";
import { chrome, type Context, redirect, requireAdmin } from "./context.ts";
import { dispatchQueued } from "./episodes.ts";
import { field, html, type Html, page } from "./html.ts";
import { rememberOrigin } from "./imports.ts";
import { catalog, seriesList } from "./scope.ts";
import { normalizeReference } from "./scriptures.ts";
import { getSetting, getSetupStep, type Ministry } from "./settings.ts";
import { normalizeSpeaker, speakerList } from "./speakers.ts";

/**
 * Cloudflare turns away request bodies over 100 MB on its Free and Pro plans
 * before the Worker sees them, so that's the most an upload can be. A sermon
 * MP3 is usually 20 to 80 MB.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The form's other fields and the multipart wrapping around the file. */
const FORM_OVERHEAD_BYTES = 1024 * 1024;
/** The file goes to R2 this much at a time, so it never sits in memory whole. R2 wants every part but the last the same size, 5 MB or more. */
const PART_BYTES = 10 * 1024 * 1024;
const MAX_FIELD_BYTES = 64 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PARTS = 50;

/** The guid of an uploaded sermon's row. Feed episodes keep the feed's guid, so the feed check never matches these. */
export function uploadGuid(id: string): string {
  return `upload:${id}`;
}

class MalformedUpload extends Error {}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  for (let at = haystack.indexOf(needle[0]!); at !== -1 && at + needle.length <= haystack.length; at = haystack.indexOf(needle[0]!, at + 1)) {
    let same = 1;
    while (same < needle.length && haystack[at + same] === needle[same]) same += 1;
    if (same === needle.length) return at;
  }
  return -1;
}

type Sink = (chunk: Uint8Array) => Promise<void> | void;

/**
 * Reads a multipart/form-data body as it arrives, handing each part's bytes
 * to the sink `onPart` returns for it. `request.formData()` would hold the
 * whole file in memory, and a Worker has 128 MB. A sink must copy what it
 * keeps: the chunk is a view of a buffer that's reused.
 */
export async function readMultipart(body: ReadableStream<Uint8Array>, boundary: string, onPart: (part: { name: string; filename: string | null }) => Sink): Promise<void> {
  const encoder = new TextEncoder();
  const reader = body.getReader();
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const headersEnd = encoder.encode("\r\n\r\n");
  // The first boundary has no line break before it; adding one lets it match like the rest.
  let buffer: Uint8Array = encoder.encode("\r\n");
  const more = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) throw new MalformedUpload("The upload ended early.");
    const joined = new Uint8Array(buffer.length + value.length);
    joined.set(buffer);
    joined.set(value, buffer.length);
    buffer = joined;
  };
  /** Passes everything before `pattern` to the sink and leaves the buffer just after it. */
  const until = async (pattern: Uint8Array, sink: Sink | null, limit = Infinity): Promise<void> => {
    let passed = 0;
    for (;;) {
      const at = indexOf(buffer, pattern);
      // What can't be the start of the pattern is safe to pass on; the rest waits for more bytes.
      const safe = at === -1 ? buffer.length - (pattern.length - 1) : at;
      if (safe > 0) {
        passed += safe;
        if (passed > limit) throw new MalformedUpload("A form field is too long.");
        await sink?.(buffer.subarray(0, safe));
      }
      if (at !== -1) {
        buffer = buffer.subarray(at + pattern.length);
        return;
      }
      if (safe > 0) buffer = buffer.subarray(safe);
      await more();
    }
  };
  try {
    await until(delimiter, null, MAX_HEADER_BYTES);
    for (let count = 0; ; count++) {
      while (buffer.length < 2) await more();
      if (buffer[0] === 45 && buffer[1] === 45) break; // "--" after the boundary ends the form.
      if (count >= MAX_PARTS) throw new MalformedUpload("The form has too many fields.");
      const head: Uint8Array[] = [];
      await until(headersEnd, (chunk) => { head.push(chunk.slice()); }, MAX_HEADER_BYTES);
      const disposition = /^content-disposition:(.*)$/imu.exec(new TextDecoder().decode(await new Blob(head).arrayBuffer()))?.[1] ?? "";
      const name = /\bname="([^"]*)"/iu.exec(disposition)?.[1];
      if (name === undefined) throw new MalformedUpload("A form field has no name.");
      await until(delimiter, onPart({ name, filename: /\bfilename="([^"]*)"/iu.exec(disposition)?.[1] ?? null }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** True for a file that starts like an MP3: an ID3 tag, or an MPEG audio frame (which an AAC file's frames aren't). */
export function looksLikeMp3(start: Uint8Array): boolean {
  let at = 0;
  while (at < start.length && at < 8192 && start[at] === 0) at += 1; // Some encoders pad the front.
  if (start[at] === 0x49 && start[at + 1] === 0x44 && start[at + 2] === 0x33) return true; // "ID3"
  const second = start[at + 1] ?? 0;
  return start[at] === 0xff && (second & 0xe0) === 0xe0 && ((second >> 3) & 3) !== 1 && ((second >> 1) & 3) !== 0;
}

export type UploadProblem = "not_mp3" | "too_large";

/**
 * Writes an uploaded MP3 into R2 as it arrives: a small one in a single put,
 * a larger one as a multipart upload a part at a time. Nothing is stored for
 * a file that isn't an MP3 or is over the limit.
 */
export class AudioUpload {
  /** Bytes received, whether or not they were kept. */
  bytes = 0;
  problem: UploadProblem | null = null;
  /** Set to drop the file without storing it, when the form is already known to be wrong. */
  skip = false;
  private part: Uint8Array;
  private filled = 0;
  private upload: R2MultipartUpload | null = null;
  private readonly parts: R2UploadedPart[] = [];
  private stored = false;
  private readonly bucket: R2Bucket;
  private readonly key: string;
  private readonly maxBytes: number;

  constructor(bucket: R2Bucket, key: string, options: { maxBytes?: number; partBytes?: number } = {}) {
    this.bucket = bucket;
    this.key = key;
    this.maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
    this.part = new Uint8Array(options.partBytes ?? PART_BYTES);
  }

  private get metadata() {
    return { httpMetadata: { contentType: "audio/mpeg" } };
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.bytes += chunk.length;
    if (this.problem || this.skip) return;
    if (this.bytes > this.maxBytes) {
      this.problem = "too_large";
      await this.discard();
      return;
    }
    // Once the first part turns out not to be an MP3, the rest is dropped.
    for (let offset = 0; offset < chunk.length && !this.problem;) {
      const take = Math.min(chunk.length - offset, this.part.length - this.filled);
      this.part.set(chunk.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.part.length) await this.flush();
    }
  }

  /** Checks the first part is an MP3 before anything is stored. */
  private isMp3(): boolean {
    if (this.parts.length > 0 || looksLikeMp3(this.part.subarray(0, this.filled))) return true;
    this.problem = "not_mp3";
    return false;
  }

  private async flush(): Promise<void> {
    if (!this.isMp3()) return;
    this.upload ??= await this.bucket.createMultipartUpload(this.key, this.metadata);
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, this.part.subarray(0, this.filled)));
    this.filled = 0;
  }

  /** Finishes the object in R2. Returns true when the file is stored. */
  async finish(): Promise<boolean> {
    if (this.problem || this.skip || this.bytes === 0) return false;
    if (this.upload) {
      if (this.filled > 0) await this.flush();
      await this.upload.complete(this.parts);
      this.upload = null;
    } else {
      if (!this.isMp3()) return false;
      await this.bucket.put(this.key, this.part.slice(0, this.filled), this.metadata);
    }
    this.stored = true;
    return true;
  }

  /** Removes whatever reached R2, for a form that turned out to be wrong. */
  async discard(): Promise<void> {
    try {
      if (this.upload) await this.upload.abort();
      if (this.stored) await this.bucket.delete(this.key);
    } catch (error) {
      console.error("could not remove an abandoned upload", this.key, error);
    }
    this.upload = null;
    this.stored = false;
  }
}

export interface UploadValues {
  readonly title: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly speaker: string;
  readonly series: string;
  readonly scripture: string;
  readonly description: string;
}

type UploadErrors = Partial<Record<keyof UploadValues | "audio" | "form", string>>;

const tidy = (value: string | undefined, max: number) => (value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

function readValues(fields: ReadonlyMap<string, string>): UploadValues {
  return {
    title: tidy(fields.get("title"), 200),
    date: tidy(fields.get("date"), 10),
    speaker: tidy(fields.get("speaker"), 100),
    // seriesOf only reads a series of 80 characters or fewer from a title.
    series: tidy(fields.get("series"), 80),
    scripture: tidy(fields.get("scripture"), 100),
    description: (fields.get("description") ?? "").trim().slice(0, 2_000),
  };
}

function problems(values: UploadValues, now = Date.now()): UploadErrors {
  const errors: UploadErrors = {};
  if (!values.title) errors.title = "Enter the sermon's title.";
  const time = /^\d{4}-\d{2}-\d{2}$/u.test(values.date) ? Date.parse(`${values.date}T12:00:00.000Z`) : Number.NaN;
  if (!values.date) errors.date = "Enter the date it was preached.";
  else if (Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== values.date || values.date < "1900-01-01") errors.date = "Enter the date as year, month and day, like 2026-03-15.";
  else if (time > now + 2 * 86_400_000) errors.date = "That date is in the future.";
  return errors;
}

async function uploadForm(context: Context, values: Partial<UploadValues> = {}, errors: UploadErrors = {}, status = 200): Promise<Response> {
  const entries = await catalog(context.db);
  const ministry = await getSetting<Ministry>(context.db, "ministry");
  const speakers = [...new Set([...(ministry?.speakerNames ?? []), ...speakerList(entries)])];
  const options = (id: string, names: readonly string[]): Html => html`<datalist id="${id}">${names.map((name) => html`<option value="${name}"></option>`)}</datalist>`;
  const limit = formatBytes(MAX_UPLOAD_BYTES).replace(".0", "");
  return page("Upload a sermon", html`<h1>Upload a sermon</h1>
<p class="lead">Add a sermon that isn't in the podcast feed. It's transcribed, summarized and made searchable like any other episode.</p>
${errors.form ? html`<p class="alert">${errors.form}</p>` : ""}
<form method="post" action="/admin/episodes/upload" enctype="multipart/form-data" data-busy="Uploading… keep this page open until it finishes. A large file can take a few minutes.">
${field({ name: "title", label: "Title", value: values.title ?? "", error: errors.title, required: true })}
${field({ name: "date", label: "Date preached", type: "date", value: values.date ?? "", error: errors.date, required: true })}
${field({ name: "speaker", label: "Preacher", value: values.speaker ?? "", list: "speakers", hint: "Optional. Left blank, the AI works it out from the description and the start of the sermon." })}
${options("speakers", speakers)}
${field({ name: "series", label: "Series", value: values.series ?? "", list: "series-names", hint: "Optional. Use the same name as the series' other sermons so they group together." })}
${options("series-names", seriesList(entries))}
${field({ name: "scripture", label: "Main Scripture passage", value: values.scripture ?? "", hint: "Optional, like Matthew 5:21-26. Left blank, the AI chooses it from the sermon." })}
${field({ name: "description", label: "Description", type: "textarea", value: values.description ?? "", hint: "Optional notes about the sermon. They help the AI name the preacher when you leave that blank." })}
<div class="field${errors.audio ? " invalid" : ""}">
<label for="f-audio">MP3 file</label>
<p class="hint">An MP3 of up to ${limit}.${status === 200 ? "" : " Choose the file again: a browser doesn't keep it after an error."}</p>
<input id="f-audio" name="audio" type="file" accept=".mp3,audio/mpeg" data-max-bytes="${MAX_UPLOAD_BYTES}" data-too-large="That file is over ${limit}. Export it at a lower bitrate (64 kbps mono is plenty for speech) and choose it again." required>
${errors.audio ? html`<p class="error">${errors.audio}</p>` : ""}
</div>
<div class="row"><button type="submit">Upload and process</button> <a href="/admin/episodes">Cancel</a></div>
</form>`, { status, ...chrome(context) });
}

/** GET and POST /admin/episodes/upload */
export async function uploadSermon(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  const current = await getSetupStep(context.db);
  if (current !== "complete") return redirect(`/setup/${current}`);
  const { request, env, db } = context;
  if (request.method === "GET") return uploadForm(context, { date: new Date().toISOString().slice(0, 10) });

  const limit = formatBytes(MAX_UPLOAD_BYTES).replace(".0", "");
  const tooLarge = `That file is over ${limit}, the most this site can take in one upload. Export it at a lower bitrate (64 kbps mono is plenty for speech) and upload it again.`;
  const boundary = /^multipart\/form-data;.*\bboundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(request.headers.get("Content-Type") ?? "");
  if (!boundary || !request.body) return uploadForm(context, {}, { form: "The form didn't arrive as an upload. Try again." }, 400);
  // Answering before reading saves receiving a file that will be turned away anyway.
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_UPLOAD_BYTES + FORM_OVERHEAD_BYTES) return uploadForm(context, {}, { audio: tooLarge }, 413);

  const id = crypto.randomUUID();
  const audio = new AudioUpload(env.AUDIO, `episodes/${id}.mp3`);
  const fields = new Map<string, string>();
  let sawFile = false;
  try {
    await readMultipart(request.body, (boundary[1] ?? boundary[2])!, ({ name, filename }) => {
      if (name === "audio" && filename !== null && !sawFile) {
        sawFile = true;
        // The form sends the details first. When they're already wrong, the file is read past rather than stored.
        if (fields.has("title") && Object.keys(problems(readValues(fields))).length > 0) audio.skip = true;
        return (chunk) => audio.write(chunk);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      return (chunk) => {
        size += chunk.length;
        if (size > MAX_FIELD_BYTES) throw new MalformedUpload("A form field is too long.");
        chunks.push(chunk.slice());
        const bytes = new Uint8Array(size);
        chunks.reduce((at, each) => (bytes.set(each, at), at + each.length), 0);
        fields.set(name, new TextDecoder().decode(bytes));
      };
    });
  } catch (error) {
    await audio.discard();
    if (!(error instanceof MalformedUpload)) console.error("upload failed", error);
    return uploadForm(context, readValues(fields), { form: "The upload didn't finish. Check your connection and try again." }, 400);
  }

  const values = readValues(fields);
  const errors = problems(values);
  let stored = false;
  try {
    stored = await audio.finish();
  } catch (error) {
    console.error("could not store an upload", error);
    await audio.discard();
    return uploadForm(context, values, { ...errors, form: "The file couldn't be saved. Try again in a minute." }, 500);
  }
  if (audio.problem === "too_large") errors.audio = tooLarge;
  else if (audio.problem === "not_mp3") errors.audio = "That file isn't an MP3. Convert it to MP3 and upload it again.";
  else if (audio.bytes === 0) errors.audio = "Choose the sermon's MP3 file.";
  if (Object.keys(errors).length > 0) {
    await audio.discard();
    return uploadForm(context, values, errors, audio.problem === "too_large" ? 413 : 400);
  }
  if (!stored) return uploadForm(context, values, { form: "The file couldn't be saved. Try again in a minute." }, 500);

  const ministry = await getSetting<Ministry>(db, "ministry");
  const known = [...(ministry?.speakerNames ?? []), ...speakerList(await catalog(db))];
  const speaker = normalizeSpeaker(values.speaker, known);
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `INSERT INTO episodes (id, guid, title, published_at, audio_url, status, created_at, updated_at, description, speaker, speaker_source, audio_key, audio_bytes, main_scripture)
       VALUES (?, ?, ?, ?, NULL, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, uploadGuid(id), values.series ? `${values.title} - ${values.series}` : values.title, `${values.date}T12:00:00.000Z`, now, now,
      values.description || null, speaker, speaker ? "admin" : null, `episodes/${id}.mp3`, audio.bytes, normalizeReference(values.scripture),
    ).run();
  } catch (error) {
    console.error("could not record an upload", error);
    await audio.discard();
    return uploadForm(context, values, { form: "The sermon couldn't be saved. Try again in a minute." }, 500);
  }
  // Mistral fetches the audio from this site, so the site's address has to be known before the run starts.
  await rememberOrigin(context);
  await dispatchQueued(env);
  return redirect(`/admin/episodes?notice=${encodeURIComponent(`“${values.title}” was uploaded (${formatBytes(audio.bytes)}). It's in the list below and will show Done when it's ready.`)}`);
}
