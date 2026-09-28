export interface Ministry {
  readonly siteTitle: string;
  readonly churchName: string;
  readonly speakerNames: readonly string[];
  readonly description: string;
  readonly logoUrl: string;
}

export type SetupStep = "ministry" | "complete";

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
