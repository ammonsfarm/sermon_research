export interface Schedule {
  readonly frequency: "daily" | "weekly";
  /** 0 = Sunday … 6 = Saturday; used when weekly. */
  readonly weekday: number;
  /** Local hour, 0–23. */
  readonly hour: number;
  readonly timeZone: string;
}

export const DEFAULT_SCHEDULE: Schedule = { frequency: "weekly", weekday: 1, hour: 6, timeZone: "UTC" };
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value.length > 0;
  } catch {
    return false;
  }
}

/** The local hour a moment falls in, like "2026-09-28T06", plus its weekday and hour. */
export function localSlot(at: Date, timeZone: string): { slot: string; weekday: number; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  return {
    slot: `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? ""),
    hour,
  };
}

/** True during the scheduled local hour, once per slot. */
export function isDue(schedule: Schedule, at: Date, lastSlot: string | null): boolean {
  const local = localSlot(at, schedule.timeZone);
  if (local.hour !== schedule.hour) return false;
  if (schedule.frequency === "weekly" && local.weekday !== schedule.weekday) return false;
  return local.slot !== lastSlot;
}

export function parseSchedule(form: FormData): { schedule: Schedule } | { error: string } {
  const frequency = String(form.get("frequency") ?? "");
  const weekday = Number(form.get("weekday"));
  const hour = Number(form.get("hour"));
  const timeZone = String(form.get("timeZone") ?? "").trim();
  if (frequency !== "daily" && frequency !== "weekly") return { error: "Choose daily or weekly." };
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: "Choose a day of the week." };
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { error: "Choose an hour." };
  if (!isValidTimeZone(timeZone)) return { error: "Enter a time zone like America/Chicago." };
  return { schedule: { frequency, weekday, hour, timeZone } };
}

export function describeSchedule(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:00 ${schedule.timeZone}`;
  return schedule.frequency === "daily" ? `Every day at ${time}` : `Every ${WEEKDAYS[schedule.weekday]} at ${time}`;
}
