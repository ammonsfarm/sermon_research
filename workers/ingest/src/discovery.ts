import {
  createProcessingIdempotencyKey,
  createProcessingRevisionHash,
  type JsonValue,
  type ProcessingRequestInput,
  type ProcessingStateStore,
} from "@aic/contracts";
import {
  type DiscoveryRunReceipt,
  type DiscoveryRunStore,
} from "./discovery-store.ts";
import {
  SoundCloudSourceError,
  type SoundCloudDiscoveryRecord,
  type SoundCloudEpisode,
  type SoundCloudSource,
} from "./soundcloud.ts";
import { WorkflowDispatchError } from "./dispatch.ts";

export type DiscoveryProcessingStateStore = Pick<
  ProcessingStateStore,
  "createOrGetRequest" | "createOrGetInitialExecution"
>;

export type DiscoveryDispatch = (requestId: string) => Promise<unknown>;

export interface RunEpisodeDiscoveryInput {
  readonly source: SoundCloudSource;
  readonly stateStore: DiscoveryProcessingStateStore;
  readonly discoveryStore: DiscoveryRunStore;
  readonly dispatch: DiscoveryDispatch;
  readonly scheduledSlot: string;
  readonly scheduledUtcMinute: string;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly maxItems: number;
  /**
   * "published" makes each discovered episode public and searchable when its workflow finishes;
   * "draft" (default) stops at publish_ready for editorial review.
   */
  readonly desiredPublication?: "draft" | "published";
}

export interface ScheduledDiscoveryController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

export interface ScheduledDiscoveryHandlerOptions extends Omit<
  RunEpisodeDiscoveryInput,
  "scheduledSlot" | "scheduledUtcMinute" | "requestedAt" | "requestedBy"
> {
  readonly now?: () => string;
}

export type ScheduledDiscoveryHandler = (
  controller: ScheduledDiscoveryController,
) => Promise<DiscoveryRunReceipt>;

const DAILY_DISCOVERY_CRONS = new Set(["15 8 * * *", "15 9 * * *"]);
const EASTERN_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Cloudflare cron is UTC, so two triggers plus this guard preserve 04:15 Eastern across DST. */
export function shouldRunDailyDiscovery(controller: Pick<ScheduledDiscoveryController, "cron" | "scheduledTime">): boolean {
  if (!DAILY_DISCOVERY_CRONS.has(controller.cron) || !Number.isSafeInteger(controller.scheduledTime)) return false;
  const scheduled = new Date(controller.scheduledTime);
  if (Number.isNaN(scheduled.getTime())) return false;
  const parts = EASTERN_CLOCK.formatToParts(scheduled);
  return parts.find(({ type }) => type === "hour")?.value === "04"
    && parts.find(({ type }) => type === "minute")?.value === "15";
}

/** Calls the real discovery boundary only for the matching 04:15 Eastern invocation. */
export function scheduleDailyDiscovery(controller: ScheduledDiscoveryController, run: () => void): boolean {
  controller.noRetry();
  if (!shouldRunDailyDiscovery(controller)) return false;
  run();
  return true;
}

function requireBound(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError("Episode discovery maxItems must be between 1 and 100.");
  }
  return value;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && value.length <= max
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function validSoundCloudEpisode(episode: SoundCloudEpisode): boolean {
  const snapshot = episode.snapshot;
  return /^[1-9]\d*$/u.test(episode.episodeId)
    && snapshot.source === "soundcloud-rss"
    && snapshot.episodeId === episode.episodeId
    && validText(snapshot.title, 1_024)
    && /^\d{4}-\d{2}-\d{2}$/u.test(snapshot.publishDate)
    && validText(snapshot.pubDateRaw, 256)
    && validText(snapshot.guid, 1_024)
    && validText(snapshot.enclosureUrl, 2_048)
    && (() => {
      try {
        const url = new URL(snapshot.enclosureUrl);
        return url.protocol === "https:" && !url.username && !url.password && !url.hash;
      } catch {
        return false;
      }
    })();
}

async function processingInput(
  episode: SoundCloudEpisode,
  discoveryRunId: string,
  desiredPublication: "draft" | "published",
): Promise<ProcessingRequestInput> {
  if (!validSoundCloudEpisode(episode)) throw new TypeError("SoundCloud episode record is invalid.");
  const snapshot = episode.snapshot as Readonly<Record<string, JsonValue>>;
  const revisionHash = await createProcessingRevisionHash(snapshot);
  const idempotencyKey = await createProcessingIdempotencyKey({
    operation: "episode_ingest",
    entityType: "episode",
    entityId: episode.episodeId,
    revisionHash,
  });
  const digest = idempotencyKey.slice(idempotencyKey.lastIndexOf(":") + 1);
  return {
    requestId: `p6r-${digest}`,
    workflow: "episode",
    entityType: "episode",
    entityId: episode.episodeId,
    revisionId: `soundcloud:${episode.episodeId}:${revisionHash.slice(7)}`,
    revisionHash,
    operation: "episode_ingest",
    idempotencyKey,
    snapshot,
    desiredPublication,
    requestedBy: `discovery:${discoveryRunId}`,
    correlationId: discoveryRunId,
  };
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof SoundCloudSourceError || error instanceof WorkflowDispatchError) return error.message;
  if (error instanceof TypeError) return "Discovery rejected invalid bounded input.";
  return "Discovery failed; inspect structured Worker diagnostics.";
}

async function reconcileOwnedStartingRequests(
  input: RunEpisodeDiscoveryInput,
  run: DiscoveryRunReceipt,
  limit: number,
): Promise<{ readonly run: DiscoveryRunReceipt; readonly reconciled: number }> {
  if (limit < 1) return { run, reconciled: 0 };
  const requestIds = await input.discoveryStore.listStartingRequestIds(run.discoveryRunId, limit);
  for (const requestId of requestIds) {
    await input.stateStore.createOrGetInitialExecution(requestId);
    await input.dispatch(requestId);
  }
  return {
    run: await input.discoveryStore.refreshDispatchedCount(run.discoveryRunId),
    reconciled: requestIds.length,
  };
}

async function reconcilePriorStartingRequests(
  input: RunEpisodeDiscoveryInput,
  discoveryRunId: string,
  limit: number,
): Promise<number> {
  if (limit < 1) return 0;
  const pending = await input.discoveryStore.listPriorStartingDispatches(discoveryRunId, limit);
  for (const item of pending) {
    await input.stateStore.createOrGetInitialExecution(item.requestId);
    await input.dispatch(item.requestId);
    await input.discoveryStore.refreshDispatchedCount(item.discoveryRunId);
  }
  return pending.length;
}

async function repairPriorRunAccounting(
  input: RunEpisodeDiscoveryInput,
  discoveryRunId: string,
  limit: number,
): Promise<void> {
  const runIds = await input.discoveryStore.listPriorRunIdsNeedingAccounting(discoveryRunId, limit);
  for (const runId of runIds) await input.discoveryStore.refreshDispatchedCount(runId);
}

async function recordInvalid(
  input: RunEpisodeDiscoveryInput,
  run: DiscoveryRunReceipt,
  record: SoundCloudDiscoveryRecord,
): Promise<DiscoveryRunReceipt> {
  return input.discoveryStore.recordProgress({
    discoveryRunId: run.discoveryRunId,
    sourceCursor: record.sourceCursor,
    seenCount: run.seenCount + 1,
    newCount: run.newCount,
    duplicateCount: run.duplicateCount,
    invalidCount: run.invalidCount + 1,
    dispatchedCount: run.dispatchedCount,
  });
}

export async function runEpisodeDiscovery(
  input: RunEpisodeDiscoveryInput,
): Promise<DiscoveryRunReceipt> {
  const maxItems = requireBound(input.maxItems);
  let run = await input.discoveryStore.begin({
    sourceAdapter: input.source.sourceAdapter,
    scheduledSlot: input.scheduledSlot,
    scheduledUtcMinute: input.scheduledUtcMinute,
    requestedAt: input.requestedAt,
    requestedBy: input.requestedBy,
  });
  if (run.duplicateDelivery) return run;

  try {
    let invocationBudget = maxItems;
    await repairPriorRunAccounting(input, run.discoveryRunId, maxItems);
    const priorReconciled = await reconcilePriorStartingRequests(input, run.discoveryRunId, invocationBudget);
    invocationBudget -= priorReconciled;
    const owned = await reconcileOwnedStartingRequests(input, run, invocationBudget);
    run = owned.run;
    invocationBudget -= owned.reconciled;
    const remaining = Math.min(maxItems - run.seenCount, invocationBudget);
    let sourceValidator = run.sourceValidator;
    if (remaining > 0) {
      const batch = await input.source.discover({
        sourceCursor: run.sourceCursor,
        sourceValidator: run.sourceValidator,
        maxItems: remaining,
      });
      sourceValidator = batch.hasMore ? null : batch.sourceValidator;
      for (const record of batch.records) {
        if (record.kind === "invalid") {
          run = await recordInvalid(input, run, record);
          continue;
        }
        let request: ProcessingRequestInput;
        try {
          request = await processingInput(record.episode, run.discoveryRunId, input.desiredPublication ?? "draft");
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          run = await recordInvalid(input, run, record);
          continue;
        }
        const requestReceipt = await input.stateStore.createOrGetRequest(request);
        await input.stateStore.createOrGetInitialExecution(requestReceipt.requestId);
        const countsAsNew = !requestReceipt.duplicate;
        run = await input.discoveryStore.recordProgress({
          discoveryRunId: run.discoveryRunId,
          sourceCursor: record.sourceCursor,
          seenCount: run.seenCount + 1,
          newCount: run.newCount + (countsAsNew ? 1 : 0),
          duplicateCount: run.duplicateCount + (countsAsNew ? 0 : 1),
          invalidCount: run.invalidCount,
          dispatchedCount: run.dispatchedCount,
        });
        await input.dispatch(requestReceipt.requestId);
        run = await input.discoveryStore.refreshDispatchedCount(run.discoveryRunId);
      }
    }
    return await input.discoveryStore.complete(run.discoveryRunId, sourceValidator);
  } catch (error) {
    await input.discoveryStore.fail(run.discoveryRunId, safeFailureMessage(error));
    throw error;
  }
}

function scheduledUtcMinute(scheduledTime: number): string {
  if (!Number.isFinite(scheduledTime)) throw new TypeError("Scheduled discovery time is invalid.");
  const date = new Date(scheduledTime);
  if (!Number.isFinite(date.valueOf())) throw new TypeError("Scheduled discovery time is invalid.");
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

/** Creates the module-compatible Scheduled Trigger function without freezing a production Env. */
export function createScheduledDiscoveryHandler(
  options: ScheduledDiscoveryHandlerOptions,
): ScheduledDiscoveryHandler {
  return async (controller) => {
    const utcMinute = scheduledUtcMinute(controller.scheduledTime);
    return runEpisodeDiscovery({
      ...options,
      scheduledSlot: `scheduled:${utcMinute}`,
      scheduledUtcMinute: utcMinute,
      requestedAt: options.now?.() ?? new Date().toISOString(),
      requestedBy: `cron:${controller.cron}`,
    });
  };
}
