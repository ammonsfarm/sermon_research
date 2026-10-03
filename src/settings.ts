import type { ReasoningEffort } from "./providers.ts";
import { DEFAULT_SCHEME, isScheme } from "./theme.ts";

export interface Ministry {
  readonly siteTitle: string;
  readonly churchName: string;
  readonly speakerNames: readonly string[];
  readonly description: string;
  readonly logoUrl: string;
  /** One of `SCHEMES` in theme.ts. Missing on sites set up before schemes existed. */
  readonly colorScheme?: string;
  /** Put the logo on a white tile, for dark logos on the dark header. */
  readonly logoTile?: boolean;
}

/** Wizard order. Admins land on the first step not yet finished. */
export const SETUP_STEPS = ["ministry", "podcast", "llm", "embeddings", "transcription", "email", "import", "complete"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function nextStep(step: SetupStep): SetupStep {
  return SETUP_STEPS[Math.min(SETUP_STEPS.indexOf(step) + 1, SETUP_STEPS.length - 1)]!;
}

export interface PodcastSettings {
  readonly feedUrl: string;
  readonly title: string;
  readonly episodeCount: number;
  readonly newestTitle: string | null;
  readonly newestAt: string | null;
  readonly checkedAt: string;
}

export interface LlmSettingsRecord {
  readonly baseUrl: string;
  readonly model: string;
  /** Summaries, speakers and main texts. Sent only to Meta's API; missing on sites set up before it existed, which means "low". */
  readonly summaryEffort?: ReasoningEffort;
  /** Answers and documents, likewise. */
  readonly chatEffort?: ReasoningEffort;
  readonly checkedAt: string;
}

/** Which of the answers AI's reasoning efforts a call uses. */
export type EffortSetting = "summaryEffort" | "chatEffort";

export interface CheckedSettings {
  readonly model: string;
  readonly checkedAt: string;
}

export type EmailSettings = { readonly from: string; readonly checkedAt: string } | { readonly skipped: true };

export async function getSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return row ? JSON.parse(row.value_json) as T : null;
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).bind(key, JSON.stringify(value), new Date().toISOString()).run();
}

export async function getSetupStep(db: D1Database): Promise<SetupStep> {
  return (await getSetting<SetupStep>(db, "setup_step")) ?? "ministry";
}

/** Validates the ministry form. Returns field errors, or the cleaned value. */
export function parseMinistry(form: FormData): { ministry: Ministry } | { errors: Record<string, string>; values: Record<string, string> } {
  const text = (name: string, max: number) => String(form.get(name) ?? "").trim().slice(0, max);
  const values = {
    siteTitle: text("siteTitle", 120),
    churchName: text("churchName", 120),
    speakerNames: text("speakerNames", 500),
    description: text("description", 1000),
    logoUrl: text("logoUrl", 2048),
    colorScheme: text("colorScheme", 40),
    logoTile: form.get("logoTile") ? "on" : "",
  };
  const errors: Record<string, string> = {};
  if (!values.siteTitle) errors.siteTitle = "Enter a site title.";
  if (!values.churchName) errors.churchName = "Enter the church or ministry name.";
  if (values.logoUrl && !isHttpsUrl(values.logoUrl)) errors.logoUrl = "Use an https:// address.";
  if (Object.keys(errors).length > 0) return { errors, values };
  return {
    ministry: {
      siteTitle: values.siteTitle,
      churchName: values.churchName,
      speakerNames: values.speakerNames.split(",").map((name) => name.trim()).filter(Boolean),
      description: values.description,
      logoUrl: values.logoUrl,
      colorScheme: isScheme(values.colorScheme) ? values.colorScheme : DEFAULT_SCHEME,
      logoTile: values.logoTile === "on",
    },
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
