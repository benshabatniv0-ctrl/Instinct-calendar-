// Converts wall-clock times in an IANA zone to exact instants, so callers never have to work out
// UTC offsets themselves. Daylight-saving gaps move forward; ambiguous fall-back times take the
// first (earlier) occurrence, matching what Apple Calendar does when a user types such a time.

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      weekday: "long",
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export function wallClock(epochMs: number, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
  };
}

// Minutes east of UTC for the zone at the given instant.
export function offsetMinutes(epochMs: number, timeZone: string): number {
  const clock = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

// RFC 3339 string for the instant, written in the zone's local time with its offset.
export function formatInZone(epochMs: number, timeZone: string): string {
  const clock = wallClock(epochMs, timeZone);
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}${formatOffset(offsetMinutes(epochMs, timeZone))}`;
}

// Resolves a local wall-clock time in a zone to epoch milliseconds.
export function localToEpoch(local: string, timeZone: string): number {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) throw new Error("Local times must look like YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS.");
  const [, y, mo, d, h, mi, s] = match;
  const fields = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s ?? "0")] as const;
  if (fields[1] < 1 || fields[1] > 12 || fields[2] < 1 || fields[2] > 31 || fields[3] > 23 || fields[4] > 59 || fields[5] > 59) {
    throw new Error(`"${local}" is not a valid date and time.`);
  }
  const naive = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  if (new Date(naive).getUTCDate() !== fields[2]) throw new Error(`"${local}" is not a valid date.`);
  // Try each offset in force around that day; keep candidates that read back as the same wall clock.
  const offsets = new Set([offsetMinutes(naive - 86_400_000, timeZone), offsetMinutes(naive, timeZone), offsetMinutes(naive + 86_400_000, timeZone)]);
  const candidates = [...offsets]
    .map((offset) => naive - offset * 60_000)
    .filter((epoch) => {
      const clock = wallClock(epoch, timeZone);
      return clock.year === fields[0] && clock.month === fields[1] && clock.day === fields[2] && clock.hour === fields[3] && clock.minute === fields[4] && clock.second === fields[5];
    })
    .sort((left, right) => left - right);
  if (candidates[0] !== undefined) return candidates[0];
  // The time falls in a spring-forward gap: read it with the offset before the jump, which lands after it.
  const before = offsetMinutes(naive - 86_400_000, timeZone);
  return naive - before * 60_000;
}

export type TimeInputKind = "date" | "instant" | "local";

export function classifyTimeInput(value: string): TimeInputKind | undefined {
  if (DATE_ONLY.test(value)) return "date";
  if (WITH_OFFSET.test(value)) return "instant";
  if (LOCAL_DATE_TIME.test(value)) return "local";
  return undefined;
}

// Normalises an API time input: an offset timestamp passes through, a local time is resolved in
// timeZone and returned with its correct offset, and a plain date is returned unchanged.
export function normalizeTimeInput(value: string, timeZone: string): string {
  const kind = classifyTimeInput(value);
  if (kind === "date") return value;
  if (kind === "instant") {
    if (!Number.isFinite(new Date(value).getTime())) throw new Error(`"${value}" is not a valid timestamp.`);
    return value;
  }
  if (kind === "local") return formatInZone(localToEpoch(value, timeZone), timeZone);
  throw new Error(`"${value}" is not a supported time. Use YYYY-MM-DDTHH:MM (local time in ${timeZone}), an RFC 3339 timestamp with an offset, or YYYY-MM-DD for all-day events.`);
}

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function addDays(date: string, days: number): string {
  const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + days * 86_400_000;
  return new Date(epoch).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

export interface ZoneNow {
  timeZone: string;
  now: string;
  utc: string;
  date: string;
  weekday: string;
  utcOffset: string;
  daylightSavingTime: boolean;
  tomorrow: string;
}

export function zoneNow(timeZone: string, epochMs = Date.now()): ZoneNow {
  const clock = wallClock(epochMs, timeZone);
  const year = clock.year;
  const january = offsetMinutes(Date.UTC(year, 0, 15), timeZone);
  const july = offsetMinutes(Date.UTC(year, 6, 15), timeZone);
  const current = offsetMinutes(epochMs, timeZone);
  const date = `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`;
  return {
    timeZone,
    now: formatInZone(epochMs, timeZone),
    utc: new Date(epochMs).toISOString(),
    date,
    weekday: clock.weekday,
    utcOffset: formatOffset(current),
    daylightSavingTime: january !== july && current === Math.max(january, july),
    tomorrow: addDays(date, 1),
  };
}
