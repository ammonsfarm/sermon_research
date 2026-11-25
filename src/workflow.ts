import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { dispatchQueued } from "./episodes.ts";
import { importBible } from "./bible.ts";
import type { AppEnv } from "./env.ts";
import { importOriginals } from "./originals.ts";
import { runEpisode } from "./pipeline.ts";
import { ensureSchema } from "./schema.ts";
import { writeDocument } from "./writing.ts";

export interface EpisodeParams {
  readonly episodeId: string;
}

/** One run per episode attempt. Starts the next queued episode when done. */
export class EpisodeWorkflow extends WorkflowEntrypoint<AppEnv, EpisodeParams> {
  override async run(event: WorkflowEvent<EpisodeParams>, step: WorkflowStep): Promise<void> {
    await ensureSchema(this.env.DB);
    await runEpisode(this.env, step, event.payload.episodeId);
    await step.do("start next episode", async () => {
      await dispatchQueued(this.env);
    });
  }
}

export interface DocumentParams {
  readonly documentId: string;
}

/** One run per document attempt: plan it, write each part, join them. */
export class DocumentWorkflow extends WorkflowEntrypoint<AppEnv, DocumentParams> {
  override async run(event: WorkflowEvent<DocumentParams>, step: WorkflowStep): Promise<void> {
    await ensureSchema(this.env.DB);
    await writeDocument(this.env, step, event.payload.documentId);
  }
}

export interface BibleParams {
  /** "originals" adds the Greek and Hebrew texts; otherwise the run adds the English Bible. */
  readonly texts?: "originals";
}

/** One run each time an admin adds the Bible (store the text, then embed its passages) or the Greek and Hebrew texts. */
export class BibleWorkflow extends WorkflowEntrypoint<AppEnv, BibleParams | undefined> {
  override async run(event: WorkflowEvent<BibleParams | undefined>, step: WorkflowStep): Promise<void> {
    await ensureSchema(this.env.DB);
    if (event.payload?.texts === "originals") await importOriginals(this.env, step);
    else await importBible(this.env, step);
  }
}
