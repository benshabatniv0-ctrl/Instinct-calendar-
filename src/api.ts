// Plain HTTP API for assistants that cannot speak MCP (for example Instinct).
//
// Every route lives under /api and requires `Authorization: Bearer <token>`. Tokens are scoped API
// keys (API_KEYS) or the legacy API_TOKEN. The route table below is the single source of truth: it
// drives routing, validation, permission checks, and the self-description served at GET /api.
//
// Event operations reuse the same calendar.ts functions as the MCP tools. This file only adds the HTTP
// concerns: permissions, local-time parsing, duration preservation, confirmations for destructive
// changes, idempotency, duplicate and conflict detection, rate limits, and auditing.

import { z } from "zod";
import {
  API_SCOPES,
  authenticate,
  calendarAccess,
  hasScope,
  type ApiPrincipal,
  type ApiScope,
} from "./access";
import {
  batchGetEvents,
  createEvent,
  deleteEvent,
  getAccountProfile,
  getAvailability,
  getEvent,
  listCalendars,
  searchEvents,
  updateEvent,
  type CalendarSummary,
  type Credentials,
} from "./calendar";
import { confirmationTtl, fingerprint, issueConfirmation, verifyConfirmation } from "./confirm";
import { auditRef, clientRef, guardFor, type AuditEntry, type GuardApi, type RateRule } from "./guard";
import type { CalendarEvent, EventDraft, EventPatch, RecurrenceMutationScope } from "./ical";
import { isIanaTimeZone } from "./ical";
import {
  attendeeInputSchema,
  calendarSchema,
  credentials,
  eventSchema,
  recurrenceIdSchema,
  recurrenceSchema,
  reminderInputSchema,
  structuredLocationInputSchema,
  type ToolEnv,
} from "./mcp";
import { ageMinutes, queueCreate, readCommands, readSnapshot } from "./reminders";
import { publicError } from "./security";
import { addDays, daysBetween, formatInZone, isDateOnly, normalizeTimeInput, zoneNow } from "./time";

export type ApiEnv = ToolEnv &
  Partial<Pick<Env, "API_TOKEN" | "API_KEYS" | "CALENDAR_ALLOWLIST" | "CONFIRMATION_SECRET" | "CONFIRMATION_TTL_SECONDS" | "GUARD" | "RATE_LIMIT_PER_MINUTE" | "RATE_LIMIT_WRITES_PER_MINUTE">>;

const MAX_BODY_BYTES = 256_000;
const MAX_BULK_OPERATIONS = 8;
const MAX_CONFLICT_CALENDARS = 15;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_RATES = { perMinute: 120, writesPerMinute: 30, authFailuresPerTenMinutes: 30 };

function boundedInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function rateRules(env: ApiEnv) {
  return {
    perMinute: boundedInt(env.RATE_LIMIT_PER_MINUTE, DEFAULT_RATES.perMinute, 10_000),
    writesPerMinute: boundedInt(env.RATE_LIMIT_WRITES_PER_MINUTE, DEFAULT_RATES.writesPerMinute, 10_000),
    authFailuresPerTenMinutes: DEFAULT_RATES.authFailuresPerTenMinutes,
  };
}

// ------------------------------------------------------------------------------------------------
// Input schemas
// ------------------------------------------------------------------------------------------------

// Removes control characters (except tab and newline) that have no place in calendar text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/g;
const text = (max: number) => z.string().max(max).transform((value) => value.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim());
const requiredText = (max: number) => text(max).pipe(z.string().min(1, "Must not be empty."));
const opaqueId = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/, "Must be an id returned by this API.");
const timeInput = z.string().min(10).max(40).describe(
  "Local time in the calendar's time zone (YYYY-MM-DDTHH:MM, recommended), an RFC 3339 timestamp with an offset or Z, or YYYY-MM-DD for all-day events.",
);
const etagInput = z.string().min(1).max(512).describe("The event's current etag from the latest read. Stale values are rejected with 412.");
const scopeInput = z.enum(["this_instance", "this_and_following", "entire_series"]).describe(
  "For recurring events. Defaults to this_instance when recurrenceId is given, otherwise entire_series.",
);
const confirmationInput = z.string().min(10).max(1024).describe("Token from a 428 confirmation_required response. Also accepted as the X-Confirmation-Token header.");

const changeFields = {
  title: requiredText(500).optional(),
  start: timeInput.optional().describe("New start. If end and durationMinutes are omitted, the current duration is kept."),
  end: timeInput.optional().describe("New end. Alone, it changes the duration and keeps the start."),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 31).optional().describe("New length in minutes (days x 1440 for all-day events). Keeps the start unless start is also given."),
  timeZone: z.string().min(1).max(64).optional().describe("IANA time zone for the event's wall-clock time. Defaults to the event's current zone."),
  allDay: z.boolean().optional(),
  availability: z.enum(["busy", "free"]).optional(),
  status: z.enum(["confirmed", "tentative", "cancelled"]).optional(),
  attendees: z.array(attendeeInputSchema).max(100).nullable().optional().describe("Complete replacement list; null removes all. May send invitations."),
  reminders: z.array(reminderInputSchema).max(10).nullable().optional().describe("Alerts. Complete replacement list; null removes all alerts."),
  recurrence: recurrenceSchema.nullable().optional().describe("RRULE/RDATE/EXDATE lines. Complete replacement; null makes it non-recurring. Entire series only; always needs confirmation."),
  location: text(1000).nullable().optional().describe("Plain location; null clears it."),
  structuredLocation: structuredLocationInputSchema.nullable().optional().describe("Map location with verified coordinates only; null removes it."),
  description: text(20_000).nullable().optional().describe("Notes; null clears them."),
  url: z.url().max(2000).nullable().optional().describe("Event URL; null clears it."),
};

const CHANGE_KEYS = Object.keys(changeFields) as Array<keyof typeof changeFields>;

const createBody = z.object({
  calendarId: opaqueId,
  title: requiredText(500),
  start: timeInput,
  end: timeInput.optional().describe("Defaults to start + durationMinutes, or one hour (one day for all-day events)."),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 31).optional(),
  timeZone: z.string().min(1).max(64).optional().describe("IANA zone; defaults to the calendar's zone, then the server default."),
  allDay: z.boolean().optional().describe("Inferred as true when start is a plain date."),
  availability: z.enum(["busy", "free"]).default("busy"),
  status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"),
  attendees: z.array(attendeeInputSchema).max(100).default([]).describe("Adding attendees may send invitations through iCloud."),
  reminders: z.array(reminderInputSchema).max(10).default([]).describe("Alerts, e.g. [{\"minutesBefore\":30}]."),
  recurrence: recurrenceSchema.default([]).describe("RRULE/RDATE/EXDATE lines, e.g. [\"RRULE:FREQ=WEEKLY;BYDAY=MO\"]."),
  location: text(1000).optional(),
  structuredLocation: structuredLocationInputSchema.optional(),
  description: text(20_000).optional(),
  url: z.url().max(2000).optional(),
  idempotencyKey: z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/).optional().describe("Same as the Idempotency-Key header. A repeat returns the first result instead of creating again."),
  allowDuplicate: z.boolean().default(false).describe("Create even if an event with the same title, start and end already exists."),
  checkConflicts: z.boolean().default(true),
  rejectOnConflict: z.boolean().default(false).describe("Refuse with 409 instead of creating when the time overlaps a busy event."),
}).strict();

const patchBody = z.object({
  etag: etagInput.optional().describe("Required here or as the If-Match header."),
  scope: scopeInput.optional(),
  recurrenceId: recurrenceIdSchema.optional(),
  confirmationToken: confirmationInput.optional(),
  checkConflicts: z.boolean().default(true),
  rejectOnConflict: z.boolean().default(false),
  ...changeFields,
}).strict();

const bulkOperation = z.object({
  action: z.enum(["update", "delete"]),
  calendarId: opaqueId,
  eventId: opaqueId,
  etag: etagInput,
  scope: z.enum(["this_instance", "entire_series"]).optional().describe("this_and_following is not available in bulk; do it as a single PATCH or DELETE."),
  recurrenceId: recurrenceIdSchema.optional(),
  changes: z.object(changeFields).strict().optional().describe("For update: the same change fields as PATCH."),
}).strict();

const bulkBody = z.object({
  operations: z.array(bulkOperation).min(1).max(MAX_BULK_OPERATIONS),
  confirmationToken: confirmationInput.optional(),
  stopOnError: z.boolean().default(true).describe("Stop at the first failed operation. Earlier operations are not rolled back."),
}).strict();

const listQuery = z.object({
  start: timeInput,
  end: timeInput.describe("At most 366 days after start."),
  calendarId: z.union([opaqueId, z.array(opaqueId).max(20)]).optional().describe("Repeatable. Omit to search every allowed calendar."),
  query: z.string().max(200).optional().describe("Case-insensitive match on title, notes, location, organizer, attendees."),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
}).strict();

const getQuery = z.object({ recurrenceId: recurrenceIdSchema.optional() }).strict();

const deleteQuery = z.object({
  etag: etagInput.optional().describe("Required here or as the If-Match header."),
  scope: scopeInput.optional(),
  recurrenceId: recurrenceIdSchema.optional(),
  confirmationToken: confirmationInput.optional(),
}).strict();

const rangeQuery = z.object({
  start: timeInput,
  end: timeInput,
  calendarId: z.union([opaqueId, z.array(opaqueId).max(20)]).optional().describe("Repeatable. Omit for every allowed calendar."),
}).strict();

const conflictQuery = rangeQuery.extend({
  excludeEventId: opaqueId.optional().describe("Ignore this event (for example the one being moved)."),
}).strict();

const availabilityQuery = rangeQuery.extend({
  minFreeMinutes: z.coerce.number().int().min(1).max(1440).default(15).describe("Shortest free window to report."),
}).strict();

const auditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50), keyId: z.string().max(40).optional() }).strict();

const reminderBody = z.object({
  title: requiredText(1000),
  list: z.string().max(200).optional(),
  due: z.string().max(40).optional(),
  notes: text(20_000).optional(),
  priority: z.enum(["none", "low", "medium", "high"]).optional(),
}).strict();

const remindersQuery = z.object({ list: z.string().max(200).optional(), query: z.string().max(200).optional() }).strict();

// Response schemas (documentation only).
const apiEventSchema = eventSchema.extend({ calendarName: z.string().optional() });
const conflictSchema = z.object({ calendarId: z.string(), calendarName: z.string().optional(), eventId: z.string(), recurrenceId: z.string().optional(), title: z.string(), start: z.string(), end: z.string(), startLocal: z.string().optional(), endLocal: z.string().optional(), allDay: z.boolean() });
const confirmationSchema = z.object({
  done: z.literal(false),
  status: z.literal("confirmation_required"),
  summary: z.string().describe("Read this to the user and get an explicit yes before confirming."),
  confirmation: z.object({ token: z.string(), expiresAt: z.string(), expiresInSeconds: z.number(), header: z.literal("X-Confirmation-Token") }),
  preview: z.unknown(),
});
const errorSchema = z.object({ done: z.literal(false), error: z.string(), code: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() });

// ------------------------------------------------------------------------------------------------
// Errors and responses
// ------------------------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
}

function failure(error: ApiError): Response {
  return json({ done: false, error: error.message, code: error.code, ...error.extra }, error.status, error.headers);
}

function invalid(error: z.ZodError): ApiError {
  return new ApiError(400, "invalid_input", "Invalid input.", {
    issues: error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

// Classifies errors raised by the shared calendar layer into stable HTTP codes.
function classify(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = publicError(error);
  const rules: Array<[RegExp, number, string]> = [
    [/Invalid credentials|returned 401|rejected the app-specific password/i, 502, "icloud_auth_failed"],
    [/changed since it was read|changed before/i, 412, "etag_mismatch"],
    [/not on this client's calendar allowlist|Calendar identifier is not available/i, 403, "calendar_not_available"],
    [/does not allow/i, 403, "calendar_read_only"],
    [/occurrence was not found|was not found|no longer exists/i, 404, "not_found"],
    [/does not belong|Invalid DAV identifier|Blocked a CalDAV request|must not contain credentials/i, 400, "invalid_id"],
    [/Invalid|must|required|cannot|only be changed|not a valid|requires|limited to|not supported|No VTIMEZONE|is not a/i, 400, "invalid_input"],
  ];
  for (const [pattern, status, code] of rules) {
    if (pattern.test(message)) {
      const hint = code === "etag_mismatch" ? " Read the event again (GET) and ask the user before retrying with the new etag." : "";
      return new ApiError(status, code, `${message}${hint}`);
    }
  }
  return new ApiError(502, "upstream_error", message);
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "body_too_large", "Request body too large.");
  if (!request.body) throw new ApiError(400, "invalid_input", "Request body must be JSON.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "Request body too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_input", "Request body must be valid JSON.");
  }
}

function queryObject(url: URL): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    if (key === "_method") continue;
    const values = url.searchParams.getAll(key);
    result[key] = values.length > 1 ? values : values[0] ?? "";
  }
  return result;
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ------------------------------------------------------------------------------------------------
// Request context
// ------------------------------------------------------------------------------------------------

interface Context {
  request: Request;
  env: ApiEnv;
  url: URL;
  params: Record<string, string>;
  principal: ApiPrincipal;
  guard: GuardApi | undefined;
  credentials: Credentials;
  audit: Partial<AuditEntry>;
  calendarsCache?: Promise<CalendarSummary[]>;
}

function calendars(context: Context): Promise<CalendarSummary[]> {
  context.calendarsCache ??= listCalendars(context.credentials);
  return context.calendarsCache;
}

async function calendarById(context: Context, calendarId: string): Promise<CalendarSummary> {
  const calendar = (await calendars(context)).find((candidate) => candidate.id === calendarId);
  if (!calendar) throw new ApiError(403, "calendar_not_available", "Calendar identifier is not available: it no longer exists or is not on this client's calendar allowlist.");
  return calendar;
}

async function withCalendarNames<T extends { calendarId: string }>(context: Context, events: T[]): Promise<Array<T & { calendarName?: string }>> {
  const names = new Map((await calendars(context)).map((calendar) => [calendar.id, calendar.name]));
  return events.map((event) => {
    const name = names.get(event.calendarId);
    return name ? { ...event, calendarName: name } : event;
  });
}

function defaultZone(context: Context): string {
  return context.credentials.defaultTimeZone;
}

function normalizeTime(value: string, timeZone: string, field: string): string {
  try {
    return normalizeTimeInput(value, timeZone);
  } catch (error) {
    throw new ApiError(400, "invalid_input", `${field}: ${(error as Error).message}`);
  }
}

function requireZone(timeZone: string | undefined): void {
  if (timeZone !== undefined && !isIanaTimeZone(timeZone)) throw new ApiError(400, "invalid_input", "timeZone must be an IANA zone such as Asia/Jerusalem.");
}

function etagFrom(context: Context, bodyValue: string | undefined): string {
  const header = context.request.headers.get("if-match")?.trim();
  const etag = bodyValue ?? (header || undefined);
  if (!etag) throw new ApiError(428, "etag_required", "Send the event's current etag (from GET) as `etag` or the If-Match header.");
  return etag;
}

function confirmationFrom(context: Context, value: string | undefined): string | undefined {
  return value ?? (context.request.headers.get("x-confirmation-token")?.trim() || undefined);
}

function confirmationSecret(env: ApiEnv): string {
  if (env.CONFIRMATION_SECRET && env.CONFIRMATION_SECRET.length >= 32) return env.CONFIRMATION_SECRET;
  return `derived:${env.ICLOUD_USERNAME}:${env.ICLOUD_APP_PASSWORD}`;
}

function describeWhen(event: Pick<CalendarEvent, "allDay" | "start" | "end" | "startLocal" | "endLocal" | "timeZone">): string {
  if (event.allDay) {
    const days = daysBetween(event.start, event.end);
    return days <= 1 ? `all day on ${event.start}` : `all day from ${event.start} to ${addDays(event.end, -1)}`;
  }
  const start = event.startLocal ?? event.start;
  const end = event.endLocal ?? event.end;
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return `${start.slice(0, 10)} ${start.slice(11, 16)}–${sameDay ? end.slice(11, 16) : `${end.slice(0, 10)} ${end.slice(11, 16)}`} (${event.timeZone ?? "UTC"})`;
}

// Runs the server-side confirmation step for a destructive operation. Without a token it returns a
// 428 response carrying a fresh token; with a valid token it consumes it (once) and returns undefined.
async function requireConfirmation(context: Context, operation: unknown, token: string | undefined, summary: string, preview: unknown): Promise<Response | undefined> {
  const opFingerprint = await fingerprint({ ...(operation as object), keyId: context.principal.keyId });
  const secret = confirmationSecret(context.env);
  if (!token) {
    const issued = await issueConfirmation(secret, context.principal.keyId, opFingerprint, confirmationTtl(context.env.CONFIRMATION_TTL_SECONDS));
    context.audit.outcome = "confirmation_issued";
    return json({
      done: false,
      status: "confirmation_required",
      summary,
      instructions: "Nothing has changed yet. Show the summary to the user. Only if they explicitly agree, repeat exactly the same request with this token in the X-Confirmation-Token header (or confirmationToken field). The token works once and expires soon.",
      confirmation: { ...issued, header: "X-Confirmation-Token" },
      preview,
    }, 428);
  }
  const check = await verifyConfirmation(secret, token, context.principal.keyId, opFingerprint);
  if (!check.ok) throw new ApiError(check.code === "confirmation_expired" ? 410 : 409, check.code, check.message);
  if (!context.guard) throw new ApiError(503, "guard_unavailable", "Confirmation storage is unavailable, so destructive operations are refused. Check the GUARD Durable Object binding.");
  const fresh = await context.guard.consumeNonce(check.claims.n, check.claims.exp);
  if (!fresh) throw new ApiError(409, "confirmation_already_used", "This confirmation token was already used. The operation will not run twice. Read the event again to see its current state.");
  return undefined;
}

// ------------------------------------------------------------------------------------------------
// Event time handling
// ------------------------------------------------------------------------------------------------

interface TimeChange {
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string | undefined;
}

function durationMs(event: Pick<CalendarEvent, "start" | "end">): number {
  return Date.parse(event.end) - Date.parse(event.start);
}

// Works out the new start and end. Rescheduling keeps the current duration unless end or
// durationMinutes say otherwise.
function resolveTimeChange(current: CalendarEvent, changes: z.infer<typeof patchBody> | z.infer<z.ZodObject<typeof changeFields>>, calendarZone: string): TimeChange | undefined {
  const touches = changes.start !== undefined || changes.end !== undefined || changes.durationMinutes !== undefined || changes.allDay !== undefined || changes.timeZone !== undefined;
  if (!touches) return undefined;
  requireZone(changes.timeZone);
  const allDay = changes.allDay ?? (changes.start !== undefined ? isDateOnly(changes.start) : current.allDay);
  const zone = changes.timeZone ?? current.timeZone ?? calendarZone;

  if (allDay) {
    const toDate = (value: string) => (isDateOnly(value) ? value : normalizeTime(value, zone, "start").slice(0, 10));
    const currentStart = current.allDay ? current.start : (current.startLocal ?? current.start).slice(0, 10);
    const currentDays = current.allDay ? Math.max(1, daysBetween(current.start, current.end)) : 1;
    const start = changes.start !== undefined ? toDate(changes.start) : currentStart;
    let end: string;
    if (changes.end !== undefined) end = toDate(changes.end);
    else if (changes.durationMinutes !== undefined) end = addDays(start, Math.max(1, Math.round(changes.durationMinutes / 1440)));
    else end = addDays(start, currentDays);
    if (end <= start) throw new ApiError(400, "invalid_input", "For all-day events the end date is exclusive and must be after the start date.");
    return { start, end, allDay: true };
  }

  if (changes.start !== undefined && isDateOnly(changes.start)) throw new ApiError(400, "invalid_input", "start is a date; set allDay true for an all-day event or give a time.");
  const fromCurrent = (value: string) => normalizeTime(value, zone, "start");
  const start = changes.start !== undefined ? fromCurrent(changes.start) : current.allDay ? normalizeTime(`${current.start}T09:00`, zone, "start") : formatInZone(Date.parse(current.start), zone);
  const keep = current.allDay ? 60 * 60_000 : durationMs(current);
  let endMs: number;
  if (changes.end !== undefined) endMs = Date.parse(normalizeTime(changes.end, zone, "end"));
  else if (changes.durationMinutes !== undefined) endMs = Date.parse(start) + changes.durationMinutes * 60_000;
  else endMs = Date.parse(start) + keep;
  if (endMs <= Date.parse(start)) throw new ApiError(400, "invalid_input", "The event must end after it starts.");
  return { start, end: formatInZone(endMs, zone), allDay: false, ...(changes.timeZone ? { timeZone: changes.timeZone } : {}) };
}

function buildPatch(changes: Partial<Record<keyof typeof changeFields, unknown>>, time: TimeChange | undefined): EventPatch {
  const patch: EventPatch = {};
  for (const key of CHANGE_KEYS) {
    if (key === "start" || key === "end" || key === "durationMinutes" || key === "allDay" || key === "timeZone") continue;
    if (changes[key] !== undefined) (patch as Record<string, unknown>)[key] = changes[key];
  }
  if (time) {
    patch.start = time.start;
    patch.end = time.end;
    patch.allDay = time.allDay;
    if (time.timeZone) patch.timeZone = time.timeZone;
  }
  return patch;
}

function hasChanges(changes: Partial<Record<string, unknown>>): boolean {
  return CHANGE_KEYS.some((key) => changes[key] !== undefined);
}

function resolveScope(scope: RecurrenceMutationScope | undefined, recurrenceId: string | undefined, current: CalendarEvent): RecurrenceMutationScope {
  const resolved = scope ?? (recurrenceId ? "this_instance" : "entire_series");
  if (resolved === "entire_series" && recurrenceId) throw new ApiError(400, "invalid_input", "Omit recurrenceId when scope is entire_series.");
  if (resolved !== "entire_series" && !recurrenceId) throw new ApiError(400, "invalid_input", "recurrenceId is required for this_instance and this_and_following.");
  if (resolved !== "entire_series" && current.recurrence.length === 0 && !current.recurrenceId) {
    throw new ApiError(400, "invalid_input", "This event does not repeat; use scope entire_series without recurrenceId.");
  }
  return resolved;
}

function isRecurring(event: CalendarEvent): boolean {
  return event.recurrence.length > 0 || Boolean(event.recurrenceId);
}

// ------------------------------------------------------------------------------------------------
// Conflicts and duplicates
// ------------------------------------------------------------------------------------------------

interface ConflictCheck {
  conflicts: Array<z.infer<typeof conflictSchema>>;
  duplicates: CalendarEvent[];
  skipped?: string;
}

async function findOverlaps(
  context: Context,
  window: { start: string; end: string; allDay: boolean },
  options: { calendarIds?: string[] | undefined; exclude?: { eventId: string; recurrenceId?: string | undefined }; duplicateOf?: { calendarId: string; title: string } },
): Promise<ConflictCheck> {
  const all = await calendars(context);
  const ids = options.calendarIds?.length ? options.calendarIds : all.filter((calendar) => calendar.components.length === 0 || calendar.components.includes("VEVENT")).map((calendar) => calendar.id);
  if (ids.length > MAX_CONFLICT_CALENDARS) return { conflicts: [], duplicates: [], skipped: `Conflict check skipped: more than ${MAX_CONFLICT_CALENDARS} calendars. Use CALENDAR_ALLOWLIST to narrow them.` };
  const searchStart = window.allDay ? `${window.start}T00:00:00Z` : window.start;
  const searchEnd = window.allDay ? `${window.end}T00:00:00Z` : window.end;
  const padded = window.allDay ? { start: new Date(Date.parse(searchStart) - 14 * 3_600_000).toISOString(), end: new Date(Date.parse(searchEnd) + 14 * 3_600_000).toISOString() } : { start: searchStart, end: searchEnd };
  const found = await searchEvents(context.credentials, { calendarIds: ids, start: padded.start, end: padded.end, limit: 200, offset: 0 });
  const names = new Map(all.map((calendar) => [calendar.id, calendar.name]));
  const windowStart = Date.parse(searchStart);
  const windowEnd = Date.parse(searchEnd);
  const conflicts: ConflictCheck["conflicts"] = [];
  const duplicates: CalendarEvent[] = [];
  for (const event of found.events) {
    if (options.exclude && event.id === options.exclude.eventId && (!options.exclude.recurrenceId || event.recurrenceId === options.exclude.recurrenceId)) continue;
    if (options.duplicateOf && event.calendarId === options.duplicateOf.calendarId && event.title.trim().toLocaleLowerCase() === options.duplicateOf.title.trim().toLocaleLowerCase()
      && (window.allDay ? event.allDay && event.start === window.start && event.end === window.end : !event.allDay && Date.parse(event.start) === windowStart && Date.parse(event.end) === windowEnd)) {
      duplicates.push(event);
      continue;
    }
    if (window.allDay || event.availability !== "busy" || event.status === "cancelled") continue;
    const eventStart = event.allDay ? Date.parse(`${event.start}T00:00:00Z`) : Date.parse(event.start);
    const eventEnd = event.allDay ? Date.parse(`${event.end}T00:00:00Z`) : Date.parse(event.end);
    if (eventStart < windowEnd && eventEnd > windowStart) {
      const name = names.get(event.calendarId);
      conflicts.push({
        calendarId: event.calendarId,
        ...(name ? { calendarName: name } : {}),
        eventId: event.id,
        ...(event.recurrenceId ? { recurrenceId: event.recurrenceId } : {}),
        title: event.title,
        start: event.start,
        end: event.end,
        ...(event.startLocal ? { startLocal: event.startLocal } : {}),
        ...(event.endLocal ? { endLocal: event.endLocal } : {}),
        allDay: event.allDay,
      });
    }
  }
  return { conflicts, duplicates };
}

function mergeWindows(windows: Array<{ start: string; end: string }>): Array<{ start: string; end: string }> {
  const sorted = windows.map((window) => ({ start: Date.parse(window.start), end: Date.parse(window.end) })).filter((window) => Number.isFinite(window.start) && Number.isFinite(window.end)).sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const window of sorted) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }
  return merged.map((window) => ({ start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() }));
}

// ------------------------------------------------------------------------------------------------
// Route handlers
// ------------------------------------------------------------------------------------------------

type Handler = (context: Context) => Promise<Response>;

interface RouteDef {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  scopes: ApiScope[];
  summary: string;
  write?: boolean;
  confirmation?: string;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  handler: Handler;
}

async function parseQuery<T extends z.ZodType>(context: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(queryObject(context.url));
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

async function parseBody<T extends z.ZodType>(context: Context, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await readBody(context.request));
  if (!parsed.success) throw invalid(parsed.error);
  return parsed.data;
}

function rangeOf(context: Context, start: string, end: string): { start: string; end: string } {
  const zone = defaultZone(context);
  const normalized = {
    start: normalizeTime(isDateOnly(start) ? `${start}T00:00` : start, zone, "start"),
    end: normalizeTime(isDateOnly(end) ? `${end}T00:00` : end, zone, "end"),
  };
  if (Date.parse(normalized.end) <= Date.parse(normalized.start)) throw new ApiError(400, "invalid_input", "end must be after start.");
  return normalized;
}

async function readOne(context: Context, calendarId: string, eventId: string, recurrenceId?: string): Promise<CalendarEvent> {
  context.audit.calendarRef = await auditRef(calendarId);
  context.audit.eventRef = await auditRef(eventId);
  return getEvent(context.credentials, calendarId, eventId, fetch, recurrenceId);
}

const handleCreate: Handler = async (context) => {
  const body = await parseBody(context, createBody);
  context.audit.calendarRef = await auditRef(body.calendarId);
  const calendar = await calendarById(context, body.calendarId);
  requireZone(body.timeZone);
  const zone = body.timeZone ?? calendar.timeZone ?? defaultZone(context);
  const allDay = body.allDay ?? isDateOnly(body.start);
  let start: string;
  let end: string;
  if (allDay) {
    if (!isDateOnly(body.start)) throw new ApiError(400, "invalid_input", "All-day events use YYYY-MM-DD dates.");
    start = body.start;
    end = body.end ?? addDays(start, Math.max(1, Math.round((body.durationMinutes ?? 1440) / 1440)));
    if (!isDateOnly(end) || end <= start) throw new ApiError(400, "invalid_input", "All-day end is an exclusive YYYY-MM-DD date after the start date.");
  } else {
    if (isDateOnly(body.start)) throw new ApiError(400, "invalid_input", "start is a date; set allDay true or give a time.");
    start = normalizeTime(body.start, zone, "start");
    end = body.end !== undefined ? normalizeTime(body.end, zone, "end") : formatInZone(Date.parse(start) + (body.durationMinutes ?? 60) * 60_000, zone);
    if (Date.parse(end) <= Date.parse(start)) throw new ApiError(400, "invalid_input", "The event must end after it starts.");
  }

  const idempotencyKey = body.idempotencyKey ?? context.request.headers.get("idempotency-key")?.trim() ?? undefined;
  if (idempotencyKey !== undefined && !/^[A-Za-z0-9_.:-]{1,100}$/.test(idempotencyKey)) throw new ApiError(400, "invalid_input", "Idempotency-Key must be 1-100 characters of letters, digits, _ . : -");
  const storageKey = idempotencyKey ? `${context.principal.keyId}:${idempotencyKey}` : undefined;
  if (storageKey && context.guard) {
    const { idempotencyKey: _ignored, ...hashable } = body;
    const state = await context.guard.idempotencyBegin(storageKey, await fingerprint(hashable), IDEMPOTENCY_TTL_SECONDS);
    if (state.state === "done") {
      context.audit.outcome = "idempotent_replay";
      return new Response(state.body, { status: state.status, headers: { "content-type": "application/json", "cache-control": "no-store", "idempotent-replay": "true" } });
    }
    if (state.state === "pending") throw new ApiError(409, "request_in_progress", "A request with this Idempotency-Key is still running. Wait, then read the calendar before retrying.");
    if (state.state === "mismatch") throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used for a different request.");
  }

  try {
    const check = body.checkConflicts || !body.allowDuplicate
      ? await findOverlaps(context, { start, end, allDay }, {
        calendarIds: body.checkConflicts ? undefined : [body.calendarId],
        duplicateOf: { calendarId: body.calendarId, title: body.title },
      })
      : { conflicts: [], duplicates: [] };
    if (!body.allowDuplicate && check.duplicates.length > 0) {
      throw new ApiError(409, "duplicate_suspected", "An event with the same title, start and end already exists in this calendar, so nothing was created. If the user really wants a second copy, repeat with allowDuplicate true.", {
        existing: await withCalendarNames(context, check.duplicates),
      });
    }
    if (body.rejectOnConflict && check.conflicts.length > 0) {
      throw new ApiError(409, "time_conflict", "The time overlaps other busy events, so nothing was created.", { conflicts: check.conflicts });
    }
    const draft: EventDraft = {
      title: body.title,
      start,
      end,
      allDay,
      ...(allDay ? {} : { timeZone: zone }),
      availability: body.availability,
      status: body.status,
      attendees: body.attendees,
      reminders: body.reminders,
      recurrence: body.recurrence,
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.structuredLocation !== undefined ? { structuredLocation: body.structuredLocation } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
    };
    const event = await createEvent(context.credentials, body.calendarId, draft);
    context.audit.eventRef = await auditRef(event.id);
    const [named] = await withCalendarNames(context, [event]);
    const payload = { done: true, event: named, conflicts: check.conflicts, ...("skipped" in check && check.skipped ? { conflictCheck: check.skipped } : {}) };
    const responseBody = JSON.stringify(payload);
    if (storageKey && context.guard) await context.guard.idempotencyFinish(storageKey, 201, responseBody);
    return new Response(responseBody, { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (error) {
    if (storageKey && context.guard) await context.guard.idempotencyAbort(storageKey);
    throw error;
  }
};

const handlePatch: Handler = async (context) => {
  const { calendarId, eventId } = context.params as { calendarId: string; eventId: string };
  const body = await parseBody(context, patchBody);
  if (!hasChanges(body)) throw new ApiError(400, "invalid_input", "Provide at least one field to change.");
  const etag = etagFrom(context, body.etag);
  const current = await readOne(context, calendarId, eventId, body.recurrenceId);
  if (current.etag !== etag) throw classify(new Error("The event changed since it was read."));
  const scope = resolveScope(body.scope, body.recurrenceId, current);
  context.audit.scope = scope;
  if (body.recurrence !== undefined && scope !== "entire_series") throw new ApiError(400, "invalid_input", "recurrence can only be changed with scope entire_series.");
  const calendar = await calendarById(context, calendarId);
  const time = resolveTimeChange(current, body, calendar.timeZone ?? defaultZone(context));
  const patch = buildPatch(body, time);

  const check = time && body.checkConflicts
    ? await findOverlaps(context, { start: time.start, end: time.end, allDay: time.allDay }, { exclude: { eventId } })
    : { conflicts: [], duplicates: [] };
  if (time && body.rejectOnConflict && check.conflicts.length > 0) {
    throw new ApiError(409, "time_conflict", "The new time overlaps other busy events, so nothing was changed.", { conflicts: check.conflicts });
  }

  const needsConfirmation = scope === "this_and_following" || (scope === "entire_series" && isRecurring(current)) || patch.recurrence !== undefined;
  if (needsConfirmation) {
    const after = time ? { ...current, start: time.start, end: time.end, allDay: time.allDay, startLocal: time.start, endLocal: time.end } : current;
    const scopeText = scope === "this_and_following" ? "this and all following occurrences of" : "every occurrence of";
    const changed = Object.keys(patch).filter((key) => key !== "allDay" || time?.allDay !== current.allDay);
    const summary = `Change ${scopeText} the repeating event "${current.title}" (${describeWhen(current)}): ${changed.join(", ")}${time ? ` → ${describeWhen(after)}` : ""}.`;
    const pending = await requireConfirmation(
      context,
      { op: "update", calendarId, eventId, etag, scope, recurrenceId: body.recurrenceId, patch },
      confirmationFrom(context, body.confirmationToken),
      summary,
      { before: current, changes: patch, conflicts: check.conflicts, scope },
    );
    if (pending) return pending;
  }

  const updated = await updateEvent(context.credentials, { calendarId, eventId, etag }, patch, { scope, recurrenceId: body.recurrenceId });
  context.audit.outcome = "updated";
  const [named] = await withCalendarNames(context, [updated]);
  return json({
    done: true,
    event: named,
    changed: Object.keys(patch),
    scope,
    ...(updated.splitFrom ? { note: "The series was split: the original now ends before this occurrence, and `event` is the new series carrying the change. Its id differs from the original." } : {}),
    conflicts: check.conflicts,
  });
};

const handleDelete: Handler = async (context) => {
  const { calendarId, eventId } = context.params as { calendarId: string; eventId: string };
  const query = await parseQuery(context, deleteQuery);
  const etag = etagFrom(context, query.etag);
  const current = await readOne(context, calendarId, eventId, query.recurrenceId);
  if (current.etag !== etag) throw classify(new Error("The event changed since it was read."));
  const scope = resolveScope(query.scope, query.recurrenceId, current);
  context.audit.scope = scope;
  const what = scope === "this_instance" ? "this one occurrence of" : scope === "this_and_following" ? "this and all following occurrences of" : isRecurring(current) ? "the whole repeating series" : "the event";
  const calendar = await calendarById(context, calendarId);
  const summary = `Delete ${what} "${current.title}" (${describeWhen(current)}) from calendar "${calendar.name}".${current.attendees.length ? " Attendees may be notified." : ""}`;
  const pending = await requireConfirmation(
    context,
    { op: "delete", calendarId, eventId, etag, scope, recurrenceId: query.recurrenceId },
    confirmationFrom(context, query.confirmationToken),
    summary,
    { event: current, scope },
  );
  if (pending) return pending;

  const result = await deleteEvent(context.credentials, { calendarId, eventId, etag }, { scope, recurrenceId: query.recurrenceId });
  // Confirm with iCloud that the target is gone before reporting success.
  let verified = false;
  try {
    await getEvent(context.credentials, calendarId, eventId, fetch, scope === "entire_series" ? undefined : query.recurrenceId);
  } catch (error) {
    verified = /not found|no longer exists/i.test(publicError(error));
  }
  if (scope === "entire_series" && !verified) throw new ApiError(502, "delete_unverified", "iCloud accepted the delete, but the event can still be read. Check the calendar before telling the user it is gone.");
  context.audit.outcome = "deleted";
  return json({ done: true, ...result, verifiedGone: verified });
};

const handleBulk: Handler = async (context) => {
  const body = await parseBody(context, bulkBody);
  context.audit.count = body.operations.length;
  for (const operation of body.operations) {
    const needed: ApiScope = operation.action === "delete" ? "events:delete" : "events:update";
    if (!hasScope(context.principal, needed)) throw new ApiError(403, "insufficient_scope", `This key lacks ${needed}, needed by one of the operations.`);
    if (operation.action === "update" && (!operation.changes || !hasChanges(operation.changes))) throw new ApiError(400, "invalid_input", "Every update operation needs at least one field in changes.");
    if (operation.action === "delete" && operation.changes) throw new ApiError(400, "invalid_input", "Delete operations take no changes.");
  }
  const keys = new Set(body.operations.map((operation) => `${operation.eventId}|${operation.recurrenceId ?? ""}`));
  if (keys.size !== body.operations.length) throw new ApiError(400, "invalid_input", "Each event or occurrence may appear only once per bulk request.");

  // Read every target once (single events in one multiget per calendar; occurrences individually).
  const singles = body.operations.filter((operation) => !operation.recurrenceId);
  const batch = singles.length ? await batchGetEvents(context.credentials, singles.map(({ calendarId, eventId }) => ({ calendarId, eventId }))) : [];
  const byEventId = new Map(batch.map((entry) => [entry.eventId, entry]));
  const plans = [];
  for (const operation of body.operations) {
    let current: CalendarEvent;
    if (operation.recurrenceId) current = await getEvent(context.credentials, operation.calendarId, operation.eventId, fetch, operation.recurrenceId);
    else {
      const entry = byEventId.get(operation.eventId);
      if (!entry?.event) throw classify(new Error(entry?.error ?? "Event was not found."));
      current = entry.event;
    }
    if (current.etag !== operation.etag) throw new ApiError(412, "etag_mismatch", `The event "${current.title}" changed since it was read. Read it again and ask the user before retrying.`);
    const scope = resolveScope(operation.scope, operation.recurrenceId, current);
    let patch: EventPatch | undefined;
    if (operation.action === "update") {
      const calendar = await calendarById(context, operation.calendarId);
      const changes = operation.changes ?? {};
      if (changes.recurrence !== undefined && scope !== "entire_series") throw new ApiError(400, "invalid_input", "recurrence can only be changed with scope entire_series.");
      patch = buildPatch(changes, resolveTimeChange(current, changes, calendar.timeZone ?? defaultZone(context)));
    }
    plans.push({ operation, current, scope, patch });
  }

  const summary = `Apply ${plans.length} change${plans.length === 1 ? "" : "s"}: ${plans.map(({ operation, current, scope }) => `${operation.action === "delete" ? "delete" : "edit"} "${current.title}" (${describeWhen(current)}${scope !== "entire_series" ? ", one occurrence" : isRecurring(current) ? ", whole series" : ""})`).join("; ")}.`;
  const pending = await requireConfirmation(
    context,
    { op: "bulk", operations: plans.map(({ operation, scope, patch }) => ({ action: operation.action, calendarId: operation.calendarId, eventId: operation.eventId, etag: operation.etag, recurrenceId: operation.recurrenceId, scope, patch })) },
    confirmationFrom(context, body.confirmationToken),
    summary,
    { operations: plans.map(({ operation, current, scope, patch }) => ({ action: operation.action, scope, event: current, changes: patch })) },
  );
  if (pending) return pending;

  const results: Array<Record<string, unknown>> = [];
  let failed = 0;
  for (const { operation, scope, patch } of plans) {
    try {
      if (operation.action === "delete") {
        const result = await deleteEvent(context.credentials, { calendarId: operation.calendarId, eventId: operation.eventId, etag: operation.etag }, { scope, recurrenceId: operation.recurrenceId });
        results.push({ done: true, action: "delete", ...result });
      } else {
        const event = await updateEvent(context.credentials, { calendarId: operation.calendarId, eventId: operation.eventId, etag: operation.etag }, patch ?? {}, { scope, recurrenceId: operation.recurrenceId });
        results.push({ done: true, action: "update", eventId: operation.eventId, event });
      }
    } catch (error) {
      failed += 1;
      const classified = classify(error);
      results.push({ done: false, action: operation.action, eventId: operation.eventId, error: classified.message, code: classified.code });
      if (body.stopOnError) break;
    }
  }
  const notAttempted = plans.length - results.length;
  context.audit.outcome = failed ? "bulk_partial" : "bulk_done";
  return json({
    done: failed === 0 && notAttempted === 0,
    succeeded: results.filter((result) => result.done).length,
    failed,
    notAttempted,
    results,
    ...(failed ? { note: "Some operations failed; earlier successful ones were NOT rolled back. Tell the user exactly which succeeded." } : {}),
  }, failed ? 207 : 200);
};

const routes: RouteDef[] = [
  {
    method: "GET", path: "/api", scopes: [], summary: "This description, including your key's permissions.",
    response: z.object({ name: z.string() }).loose(), handler: async (context) => json(apiSpec(context)),
  },
  {
    method: "GET", path: "/api/time", scopes: [], summary: "Current date and time in the calendar's default zone (with DST status). Use it to resolve 'today', 'tomorrow', 'next Monday'.",
    response: z.object({ timeZone: z.string(), now: z.string(), utc: z.string(), date: z.string(), weekday: z.string(), utcOffset: z.string(), daylightSavingTime: z.boolean(), tomorrow: z.string() }),
    handler: async (context) => json({ done: true, ...zoneNow(defaultZone(context)) }),
  },
  {
    method: "GET", path: "/api/profile", scopes: ["events:read"], summary: "Account email and default IANA time zone.",
    response: z.object({ profile: z.object({ email: z.string(), provider: z.string(), timeZone: z.string() }) }),
    handler: async (context) => json({ done: true, profile: await getAccountProfile(context.credentials) }),
  },
  {
    method: "GET", path: "/api/calendars", scopes: ["events:read"], summary: "Calendars this key may use, with stable ids. Shared calendars appear here; writes fail with 403 calendar_read_only where iCloud grants read access only.",
    response: z.object({ calendars: z.array(calendarSchema) }),
    handler: async (context) => json({ done: true, calendars: await calendars(context), ...(context.credentials.access ? { restrictedBy: context.credentials.access.description } : {}) }),
  },
  {
    method: "GET", path: "/api/events", scopes: ["events:read"], query: listQuery,
    summary: "List or search events in a time window. Repeating events appear once per occurrence, each with id, calendarId, recurrenceId and etag; use those ids for reads and changes.",
    response: z.object({ events: z.array(apiEventSchema), total: z.number(), offset: z.number(), hasMore: z.boolean(), nextOffset: z.number().optional() }),
    handler: async (context) => {
      const query = await parseQuery(context, listQuery);
      const range = rangeOf(context, query.start, query.end);
      const calendarIds = asList(query.calendarId);
      const result = await searchEvents(context.credentials, { ...(calendarIds.length ? { calendarIds } : {}), ...range, ...(query.query ? { query: query.query } : {}), limit: query.limit, offset: query.offset });
      return json({ done: true, ...result, events: await withCalendarNames(context, result.events) });
    },
  },
  {
    method: "GET", path: "/api/events/{calendarId}/{eventId}", scopes: ["events:read"], query: getQuery,
    summary: "Read one event (or one occurrence with recurrenceId) with its current etag.",
    response: z.object({ event: apiEventSchema }),
    handler: async (context) => {
      const query = await parseQuery(context, getQuery);
      const event = await readOne(context, context.params.calendarId!, context.params.eventId!, query.recurrenceId);
      const [named] = await withCalendarNames(context, [event]);
      return json({ done: true, event: named });
    },
  },
  {
    method: "POST", path: "/api/events", scopes: ["events:create"], write: true, body: createBody,
    summary: "Create an event. Rejects likely duplicates (409 duplicate_suspected) and reports overlapping busy events in `conflicts`. Send an Idempotency-Key header so a retried request never creates twice.",
    response: z.object({ done: z.literal(true), event: apiEventSchema, conflicts: z.array(conflictSchema) }),
    handler: handleCreate,
  },
  {
    method: "PATCH", path: "/api/events/{calendarId}/{eventId}", scopes: ["events:update"], write: true, body: patchBody,
    confirmation: "Required for scope entire_series on a repeating event, for this_and_following, and for any recurrence change.",
    summary: "Change an event: reschedule (duration kept unless end/durationMinutes given), retitle, move, change notes, alerts and more. Only the fields you send change. Requires the current etag.",
    response: z.object({ done: z.literal(true), event: apiEventSchema, changed: z.array(z.string()), scope: z.string(), conflicts: z.array(conflictSchema) }),
    handler: handlePatch,
  },
  {
    method: "DELETE", path: "/api/events/{calendarId}/{eventId}", scopes: ["events:delete"], write: true, query: deleteQuery,
    confirmation: "Always required.",
    summary: "Delete an event, one occurrence, this and following occurrences, or a whole series. Requires the current etag. The response says whether iCloud confirms it is gone.",
    response: z.object({ done: z.literal(true), deleted: z.literal(true), eventId: z.string(), scope: z.string(), verifiedGone: z.boolean() }),
    handler: handleDelete,
  },
  {
    method: "POST", path: "/api/events/bulk", scopes: [], write: true, body: bulkBody,
    confirmation: "Always required.",
    summary: `Apply up to ${MAX_BULK_OPERATIONS} updates and deletes as one confirmed batch. Needs events:update and/or events:delete for the actions used. Not atomic: results are reported per operation.`,
    response: z.object({ done: z.boolean(), succeeded: z.number(), failed: z.number(), notAttempted: z.number(), results: z.array(z.unknown()) }),
    handler: handleBulk,
  },
  {
    method: "GET", path: "/api/conflicts", scopes: ["events:read"], query: conflictQuery,
    summary: "Busy events overlapping a proposed time. Use before proposing a time to the user.",
    response: z.object({ conflicts: z.array(conflictSchema), free: z.boolean() }),
    handler: async (context) => {
      const query = await parseQuery(context, conflictQuery);
      const range = rangeOf(context, query.start, query.end);
      const result = await findOverlaps(context, { ...range, allDay: false }, { calendarIds: asList(query.calendarId), ...(query.excludeEventId ? { exclude: { eventId: query.excludeEventId } } : {}) });
      return json({ done: true, conflicts: result.conflicts, free: result.conflicts.length === 0, ...(result.skipped ? { note: result.skipped } : {}) });
    },
  },
  {
    method: "GET", path: "/api/availability", scopes: ["events:read"], query: availabilityQuery,
    summary: "Busy windows per calendar (no titles) plus combined busy and free windows across them.",
    response: z.object({ calendars: z.array(z.object({ calendarId: z.string(), busy: z.array(z.object({ start: z.string(), end: z.string() })) })), combined: z.object({ busy: z.array(z.unknown()), free: z.array(z.unknown()) }) }),
    handler: async (context) => {
      const query = await parseQuery(context, availabilityQuery);
      const range = rangeOf(context, query.start, query.end);
      let calendarIds = asList(query.calendarId);
      if (calendarIds.length === 0) calendarIds = (await calendars(context)).filter((calendar) => calendar.components.length === 0 || calendar.components.includes("VEVENT")).map((calendar) => calendar.id).slice(0, MAX_CONFLICT_CALENDARS);
      const result = await getAvailability(context.credentials, calendarIds, range.start, range.end);
      const busy = mergeWindows(result.calendars.flatMap((calendar) => calendar.busy.map((window) => isDateOnly(window.start) ? { start: `${window.start}T00:00:00Z`, end: `${window.end}T00:00:00Z` } : window)));
      const zone = defaultZone(context);
      const free: Array<{ start: string; end: string; minutes: number }> = [];
      let cursor = Date.parse(range.start);
      const finish = Date.parse(range.end);
      for (const window of [...busy, { start: range.end, end: range.end }]) {
        const windowStart = Math.min(Date.parse(window.start), finish);
        if (windowStart - cursor >= query.minFreeMinutes * 60_000) free.push({ start: formatInZone(cursor, zone), end: formatInZone(windowStart, zone), minutes: Math.round((windowStart - cursor) / 60_000) });
        cursor = Math.max(cursor, Date.parse(window.end));
      }
      return json({ done: true, ...result, combined: { busy: busy.map((window) => ({ start: formatInZone(Date.parse(window.start), zone), end: formatInZone(Date.parse(window.end), zone) })), free } });
    },
  },
  {
    method: "GET", path: "/api/reminders", scopes: ["reminders:read"], query: remindersQuery,
    summary: "Open Apple Reminders from the last iPhone sync, with syncedAt and ageMinutes.",
    response: z.object({ syncedAt: z.string(), ageMinutes: z.number(), lists: z.array(z.string()), total: z.number(), reminders: z.array(z.unknown()), pendingChanges: z.number() }),
    handler: async (context) => {
      const query = await parseQuery(context, remindersQuery);
      if (!context.env.REMINDERS_KV) throw new ApiError(503, "reminders_unavailable", "REMINDERS_KV is not bound on the Worker.");
      const snapshot = await readSnapshot(context.env.REMINDERS_KV);
      if (!snapshot) throw new ApiError(502, "reminders_unavailable", "Reminders are not available: the iPhone sync Shortcut has not posted a snapshot yet.");
      const search = query.query?.trim().toLowerCase() || undefined;
      const reminders = snapshot.items.filter((item) =>
        (!query.list || item.list === query.list) &&
        (!search || item.title.toLowerCase().includes(search) || (item.notes ?? "").toLowerCase().includes(search)));
      return json({
        done: true,
        syncedAt: snapshot.syncedAt,
        ageMinutes: ageMinutes(snapshot),
        lists: [...new Set(snapshot.items.map((item) => item.list))].sort(),
        total: reminders.length,
        reminders,
        pendingChanges: (await readCommands(context.env.REMINDERS_KV)).length,
      });
    },
  },
  {
    method: "POST", path: "/api/reminders", scopes: ["reminders:write"], write: true, body: reminderBody,
    summary: "Queue a reminder; the owner's iPhone creates it on its next sync (so say 'queued', not 'created').",
    response: z.object({ queued: z.literal(true), id: z.string(), appliesOn: z.string() }),
    handler: async (context) => {
      if (!context.env.REMINDERS_KV) throw new ApiError(503, "reminders_unavailable", "REMINDERS_KV is not bound on the Worker.");
      const body = await parseBody(context, reminderBody);
      const command = await queueCreate(context.env.REMINDERS_KV, body, new Date(), context.env.CALENDAR_TIME_ZONE);
      return json({ done: true, queued: true, id: command.id, appliesOn: "the iPhone's next Reminders sync" }, 202);
    },
  },
  {
    method: "GET", path: "/api/audit", scopes: ["audit:read"], query: auditQuery,
    summary: "Recent API activity: time, key, route, outcome, and short hashed references. Never titles, notes, or locations.",
    response: z.object({ entries: z.array(z.unknown()) }),
    handler: async (context) => {
      const query = await parseQuery(context, auditQuery);
      if (!context.guard) throw new ApiError(503, "guard_unavailable", "The audit store is unavailable.");
      return json({ done: true, entries: await context.guard.listAudit(query.limit, query.keyId) });
    },
  },
];

// Drops machine-only noise (long generated regexes, additionalProperties: false) so the description
// stays readable for an assistant.
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "pattern" && typeof entry === "string" && entry.length > 40) continue;
    if (key === "additionalProperties" && entry === false) continue;
    result[key] = compactSchema(entry);
  }
  return result;
}

function schemaDoc(schema: z.ZodType | undefined): unknown {
  if (!schema) return undefined;
  try {
    const document = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete document.$schema;
    return compactSchema(document);
  } catch {
    return { description: "See summary." };
  }
}

function apiSpec(context: Pick<Context, "principal" | "credentials" | "env">) {
  const { principal } = context;
  return {
    name: "Apple Calendar bridge (iCloud) — HTTP API",
    version: "2",
    you: {
      keyId: principal.keyId,
      scopes: [...principal.scopes],
      calendars: context.credentials.access ? `restricted: ${context.credentials.access.description}` : "all calendars in the account",
    },
    defaultTimeZone: defaultZone(context as Context),
    auth: "Send `Authorization: Bearer <token>` on every request (X-API-Key: <token> also works).",
    methodOverride: "If your HTTP tool cannot send PATCH or DELETE, send POST with header X-HTTP-Method-Override: PATCH|DELETE or query ?_method=PATCH|DELETE. Every header input also has a body or query equivalent: etag (If-Match), confirmationToken (X-Confirmation-Token), idempotencyKey (Idempotency-Key).",
    conventions: {
      success: "Every JSON response has `done`. Only `done: true` means the change happened. Never tell the user something was created, changed or deleted unless the response said done: true.",
      times: `Send local times as YYYY-MM-DDTHH:MM; the server converts them in the calendar's zone (default ${defaultZone(context as Context)}) with daylight saving applied. RFC 3339 with an offset also works. All-day events use YYYY-MM-DD with an exclusive end date. Responses give UTC (start/end) and local (startLocal/endLocal) values. Call GET /api/time to resolve relative dates.`,
      ids: "Events are identified by calendarId + eventId (opaque, stable while the event exists). Occurrences of repeating events add recurrenceId (the occurrence's original start). Always take ids from a list/read response; never construct them.",
      etags: "Changes and deletes require the etag from your latest read (field `etag` or If-Match header). 412 etag_mismatch means someone changed the event: read it again and check with the user.",
      ambiguity: "If several events could match what the user said, list them (title, date, time, calendar) and ask which one. Do not guess.",
      recurring: "For a repeating event, scope this_instance changes one occurrence, this_and_following changes it and later ones (the series is split and the response returns the new series), entire_series changes all.",
      confirmation: "Deletes, bulk changes, whole-series changes and this_and_following changes return 428 confirmation_required with a summary and a single-use token valid for a few minutes. Show the summary, get an explicit yes, then repeat the identical request with header X-Confirmation-Token. Expired (410) or used (409) tokens mean: start over.",
      duplicates: "POST /api/events rejects an identical event (same calendar, title, start, end) with 409 duplicate_suspected. Send an Idempotency-Key header (any unique string per user request) so retries never create twice.",
      rescheduling: "PATCH with only `start` moves the event and keeps its duration. Add `end` or `durationMinutes` to change the length.",
      errors: "Errors are JSON: { done: false, error, code, issues? }. Codes: invalid_input, unauthorized, forbidden/insufficient_scope, calendar_not_available, calendar_read_only, not_found, etag_required, etag_mismatch, confirmation_required (428), confirmation_invalid, confirmation_mismatch, confirmation_expired (410), confirmation_already_used, duplicate_suspected, time_conflict, idempotency_key_reused, request_in_progress, rate_limited (429, see Retry-After), icloud_auth_failed, upstream_error.",
    },
    limits: { ...rateRules(context.env), bulkOperations: MAX_BULK_OPERATIONS, eventQueryDays: 366, confirmationSeconds: confirmationTtl(context.env.CONFIRMATION_TTL_SECONDS) },
    scopes: API_SCOPES,
    routes: routes.map((route) => ({
      method: route.method,
      path: route.path,
      summary: route.summary,
      requires: route.scopes.length ? route.scopes : route.path === "/api/events/bulk" ? ["events:update and/or events:delete"] : ["any valid key"],
      allowedForYou: route.path === "/api/events/bulk" ? hasScope(principal, "events:update") || hasScope(principal, "events:delete") : route.scopes.every((scope) => hasScope(principal, scope)),
      ...(route.confirmation ? { confirmation: route.confirmation } : {}),
      ...(route.query ? { query: schemaDoc(route.query) } : {}),
      ...(route.body ? { body: schemaDoc(route.body) } : {}),
      response: schemaDoc(route.response),
    })),
    errorResponse: schemaDoc(errorSchema),
    confirmationResponse: schemaDoc(confirmationSchema),
  };
}

// ------------------------------------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------------------------------------

function matchRoute(method: string, pathname: string): { route?: RouteDef; params: Record<string, string>; pathKnown: boolean } {
  const parts = pathname.replace(/\/+$/, "").split("/");
  let pathKnown = false;
  for (const route of routes) {
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const segment = pattern[index]!;
      const actual = parts[index]!;
      if (segment.startsWith("{")) {
        if (!/^[A-Za-z0-9_-]{1,2048}$/.test(actual)) {
          matched = false;
          break;
        }
        params[segment.slice(1, -1)] = actual;
      } else if (segment !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // "/api/events/bulk" must not be read as a calendarId/eventId pair, and vice versa.
    if (route.path.includes("{") && params.calendarId === "events") continue;
    pathKnown = true;
    if (route.method === method) return { route, params, pathKnown };
  }
  return { params: {}, pathKnown };
}

// Clients whose HTTP tool can only send GET and POST may tunnel PATCH and DELETE through POST with an
// X-HTTP-Method-Override header or a _method query parameter. Nothing else can be overridden.
function effectiveMethod(request: Request, url: URL): string {
  if (request.method !== "POST") return request.method;
  const override = (request.headers.get("x-http-method-override") ?? url.searchParams.get("_method") ?? "").trim().toUpperCase();
  return override === "PATCH" || override === "DELETE" ? override : "POST";
}

export function isApiRoute(url: URL): boolean {
  return url.pathname === "/api" || url.pathname.startsWith("/api/");
}

// `signedIn` is set by the browser console (src/webapp.ts), which has already verified a session
// for this principal; every other caller authenticates with the request's own credentials.
export async function handleApi(request: Request, env: ApiEnv, executionContext?: Pick<ExecutionContext, "waitUntil">, signedIn?: ApiPrincipal): Promise<Response> {
  const url = new URL(request.url);
  if (!isApiRoute(url)) return new Response("Not found", { status: 404 });
  const started = Date.now();
  const guard = guardFor(env);

  const auth = signedIn ? { ok: true as const, principal: signedIn } : await authenticate(request, env);
  if (!auth.ok) {
    if (auth.reason === "disabled" || auth.reason === "misconfigured") return failure(new ApiError(503, "api_disabled", auth.message));
    if (guard) {
      const limited = await guard.checkRate([{ key: `authfail:${await clientRef(request)}`, limit: rateRules(env).authFailuresPerTenMinutes, windowSeconds: 600 }]);
      if (!limited.ok) return failure(new ApiError(429, "rate_limited", "Too many failed sign-ins from this address.", {}, { "retry-after": String(limited.retryAfterSeconds ?? 60) }));
    }
    console.warn("api_auth_failed", { reason: auth.reason, path: url.pathname });
    return failure(new ApiError(401, "unauthorized", auth.message, {}, { "www-authenticate": 'Bearer realm="api"' }));
  }
  const principal = auth.principal;
  const pathname = url.pathname.replace(/\/+$/, "") || "/api";
  const method = effectiveMethod(request, url);
  const { route, params, pathKnown } = matchRoute(method, pathname);
  const audit: Partial<AuditEntry> = { keyId: principal.keyId, method, route: route?.path ?? "unknown", operation: route ? `${route.method} ${route.path}` : "unknown" };

  let response: Response;
  try {
    if (!route) {
      throw pathKnown
        ? new ApiError(405, "method_not_allowed", "Method not allowed for this route. GET /api lists the routes.")
        : new ApiError(404, "unknown_route", "Unknown route. GET /api lists the routes.");
    }
    const missing = route.scopes.filter((scope) => !hasScope(principal, scope));
    if (missing.length) throw new ApiError(403, "insufficient_scope", `This key lacks ${missing.join(", ")}.`);
    if (route.write && !guard) {
      throw new ApiError(503, "guard_unavailable", "The Guard Durable Object is not bound, so changes are refused (rate limits and confirmations need it).");
    }
    if (guard) {
      const rates = rateRules(env);
      const rules: RateRule[] = [{ key: `key:${principal.keyId}`, limit: rates.perMinute, windowSeconds: 60 }];
      if (route.write) rules.push({ key: `write:${principal.keyId}`, limit: rates.writesPerMinute, windowSeconds: 60 });
      const limited = await guard.checkRate(rules);
      if (!limited.ok) throw new ApiError(429, "rate_limited", "Rate limit reached. Wait and retry.", { retryAfterSeconds: limited.retryAfterSeconds }, { "retry-after": String(limited.retryAfterSeconds ?? 60) });
    }
    const context: Context = {
      request,
      env,
      url,
      params,
      principal,
      guard,
      credentials: credentials(env, calendarAccess(env, principal.calendars)),
      audit,
    };
    response = await route.handler(context);
  } catch (error) {
    const classified = classify(error);
    if (classified.status >= 500) console.error("api_error", { route: audit.route, code: classified.code, reason: classified.message.slice(0, 300) });
    response = failure(classified);
    audit.outcome ??= classified.code;
  }

  const entry: AuditEntry = {
    at: new Date(started).toISOString(),
    keyId: principal.keyId,
    method,
    route: audit.route ?? "unknown",
    operation: audit.operation ?? "unknown",
    status: response.status,
    outcome: audit.outcome ?? (response.ok ? "ok" : `http_${response.status}`),
    calendarRef: audit.calendarRef,
    eventRef: audit.eventRef,
    scope: audit.scope,
    count: audit.count,
    durationMs: Date.now() - started,
  };
  console.info("api_audit", entry);
  if (guard) {
    const write = guard.audit(entry).catch((error: unknown) => console.warn("audit_write_failed", { reason: publicError(error) }));
    if (executionContext) executionContext.waitUntil(write);
    else await write;
  }
  return response;
}

export const API_ROUTES = routes.map(({ method, path, scopes }) => ({ method, path, scopes }));
