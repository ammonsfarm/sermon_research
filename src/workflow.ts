import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { dispatchQueued } from "./episodes.ts";
import type { AppEnv } from "./env.ts";
import { runEpisode } from "./pipeline.ts";
import { ensureSchema } from "./schema.ts";

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
