import type { EpisodeWorkflowStepPort } from "./workflow.ts";

export type ProviderFailureCode = "transient_dependency" | "throttled" | "provider_timeout_unknown"
  | "authentication" | "configuration" | "invalid_input" | "audio_segmentation_required" | "transcription_unavailable";
export interface ProviderFailure {
  readonly code: ProviderFailureCode;
  readonly retryAfterSeconds?: number;
}
export type ProviderAttemptResult<T> = { readonly ok: true; readonly receipt: T }
  | { readonly ok: false; readonly failure: ProviderFailure };

// The Workflow owns the total attempt budget. Native retries must never add submissions.
export const PROVIDER_ATTEMPT_CONFIG = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" }, timeout: "10 minutes",
} as const;

export async function runProviderAttempts<T>(step: EpisodeWorkflowStepPort, options: {
  readonly name: string;
  readonly submit: (attempt: number) => Promise<T>;
  readonly classify: (error: unknown) => ProviderFailure | null;
  readonly reconcile: () => Promise<T | null>;
}): Promise<ProviderAttemptResult<T>> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await step.do(`${options.name}-attempt-${attempt}`, PROVIDER_ATTEMPT_CONFIG, async (): Promise<ProviderAttemptResult<T>> => {
      try { return { ok: true, receipt: await options.submit(attempt) }; }
      catch (error) {
        const failure = options.classify(error);
        if (failure === null) throw error; // State/fence failures are not provider retries.
        return { ok: false, failure };
      }
    });
    if (result.ok) return result;
    const { code, retryAfterSeconds } = result.failure;
    if (code === "provider_timeout_unknown") {
      for (const [check, delay] of [30, 60, 120].entries()) {
        await step.sleep(`${options.name}-reconcile-wait-${attempt}-${check}`, `${delay} seconds`);
        const receipt = await step.do(`${options.name}-reconcile-${attempt}-${check}`, PROVIDER_ATTEMPT_CONFIG, options.reconcile);
        if (receipt !== null) return { ok: true, receipt };
      }
      return result; // Absence never authorizes another submission.
    }
    const limit = code === "throttled" ? 8 : code === "transient_dependency" ? 5 : 1;
    if (attempt + 1 >= limit) return result;
    const delay = code === "throttled"
      ? retryAfterSeconds ?? Math.min(600, 15 * 2 ** attempt)
      : 5 * 2 ** attempt;
    if (delay > 0) await step.sleep(`${options.name}-retry-wait-${attempt}`, `${delay} seconds`);
  }
  throw new Error("Provider attempt budget exhausted unexpectedly.");
}
