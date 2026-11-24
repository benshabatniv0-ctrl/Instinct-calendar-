// Parses, creates, and patches iCalendar data while preserving fields the MCP does not explicitly model.

import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";
import { wallClock } from "./time";

export type AttendanceStatus = "needs-action" | "accepted" | "declined" | "tentative" | "delegated";
export type EventAvailability = "busy" | "free";
export type EventStatus = "confirmed" | "tentative" | "cancelled";
export type RecurrenceMutationScope = "entire_series" | "this_instance" | "this_and_following";

export interface EventAttendee {
  email: string;
  name?: string;
  role?: "required" | "optional" | "chair" | "non-participant";
  status: AttendanceStatus;
  isSelf: boolean;
}

export interface EventOrganizer {
  email: string;
  name?: string;
}

export interface EventReminder {
  action: "display" | "email" | "audio";
  minutesBefore: number;
  description?: string;
}

export interface StructuredLocation {
  title?: string | undefined;
  address?: string | undefined;
  latitude: number;
  longitude: number;
  radius?: number | undefined;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  timeZone?: string;
  startLocal?: string;
  endLocal?: string;
  allDay: boolean;
  availability: EventAvailability;
  status: EventStatus;
  attendees: EventAttendee[];
  reminders: EventReminder[];
  recurrence: string[];
  location?: string;
  structuredLocation?: StructuredLocation;
  description?: string;
  url?: string;
  color?: string;
  organizer?: EventOrganizer;
  recurrenceId?: string;
  sequence?: number;
  created?: string;
  updated?: string;
  etag?: string;
}

export interface EventAttendeeInput {
  email: string;
  name?: string | undefined;
  role?: "required" | "optional" | "chair" | "non-participant" | undefined;
}

export interface EventReminderInput {
  minutesBefore: number;
  description?: string | undefined;
}

export interface EventDraft {
  title: string;
  start: string;
  end: string;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
  availability?: EventAvailability | undefined;
  status?: EventStatus | undefined;
  attendees?: EventAttendeeInput[] | undefined;
  reminders?: EventReminderInput[] | undefined;
  recurrence?: string[] | undefined;
  location?: string | undefined;
  structuredLocation?: StructuredLocation | undefined;
  description?: string | undefined;
  url?: string | undefined;
}

export interface EventPatch {
  title?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  timeZone?: string | undefined;
  allDay?: boolean | undefined;
  availability?: EventAvailability | undefined;
  status?: EventStatus | undefined;
  attendees?: EventAttendeeInput[] | null | undefined;
  reminders?: EventReminderInput[] | null | undefined;
  recurrence?: string[] | null | undefined;
  location?: string | null | undefined;
  structuredLocation?: StructuredLocation | null | undefined;
  description?: string | null | undefined;
  url?: string | null | undefined;
}

interface ParseContext {
  calendarId: string;
  eventId: string;
  selfEmail: string;
  etag?: string;
  defaultTimeZone?: string;
}

interface BuildOptions {
  now?: Date;
  uid?: string;
  defaultTimeZone?: string;
  timeZoneData?: string;
}

interface PatchOptions {
  defaultTimeZone?: string;
  timeZoneData?: string;
}

const roleFromIcal = {
  "REQ-PARTICIPANT": "required",
  "OPT-PARTICIPANT": "optional",
  CHAIR: "chair",
  "NON-PARTICIPANT": "non-participant",
} as const;

const roleToIcal = {
  required: "REQ-PARTICIPANT",
  optional: "OPT-PARTICIPANT",
  chair: "CHAIR",
  "non-participant": "NON-PARTICIPANT",
} as const;

const statusFromIcal: Record<string, AttendanceStatus> = {
  "NEEDS-ACTION": "needs-action",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  DELEGATED: "delegated",
};

function normalizeEmail(value: string): string {
  return value.replace(/^mailto:/i, "").trim().toLowerCase();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isIanaTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

function timeZoneComponents(data: string | undefined): ICAL.Component[] {
  if (!data) return [];
  try {
    const root = ICAL.Component.fromString(data);
    return root.name === "vtimezone" ? [root] : root.getAllSubcomponents("vtimezone");
  } catch {
    return [];
  }
}

export function calendarTimeZoneId(data: string | undefined): string | undefined {
  for (const component of timeZoneComponents(data)) {
    const candidates = [
      stringValue(component.getFirstPropertyValue("tzid")),
      stringValue(component.getFirstPropertyValue("x-lic-location")),
    ];
    const match = candidates.find(isIanaTimeZone);
    if (match) return match;
  }
  return undefined;
}

export function recurringEventTimeZoneId(data: string | undefined, fallback: string): string | undefined {
  if (!data) return undefined;
  try {
    const root = ICAL.Component.fromString(data);
    const component = primaryEvent(root);
    if (!new ICAL.Event(component).isRecurring()) return undefined;
    const property = component.getFirstProperty("dtstart");
    const parameter = stringValue(property?.getFirstParameter("tzid"));
    if (isIanaTimeZone(parameter)) return parameter;
    const embeddedTimeZone = calendarTimeZoneId(data);
    if (embeddedTimeZone) return embeddedTimeZone;
    const value = property?.getFirstValue();
    if (value instanceof ICAL.Time && value.zone.tzid === "UTC") return "UTC";
    return isIanaTimeZone(fallback) ? fallback : undefined;
  } catch {
    return undefined;
  }
}

function matchingTimeZoneComponent(data: string | undefined, timeZone: string): ICAL.Component | undefined {
  return timeZoneComponents(data).find((component) => {
    const tzid = stringValue(component.getFirstPropertyValue("tzid"));
    const location = stringValue(component.getFirstPropertyValue("x-lic-location"));
    return tzid === timeZone || location === timeZone;
  });
}

function libraryTimeZoneComponent(timeZone: string): ICAL.Component | undefined {
  const result = tzlib_get_ical_block(timeZone);
  if (!Array.isArray(result) || !result[0]) return undefined;
  return timeZoneComponents(result[0])[0];
}

const ianaZoneCache = new Map<string, ICAL.Timezone>();

function ianaTimezone(timeZone: string): ICAL.Timezone | undefined {
  if (timeZone === "UTC") return ICAL.Timezone.utcTimezone;
  const cached = ianaZoneCache.get(timeZone);
  if (cached) return cached;
  const source = libraryTimeZoneComponent(timeZone);
  if (!source) return undefined;
  const zone = new ICAL.Timezone({ component: source, tzid: timeZone });
  ianaZoneCache.set(timeZone, zone);
  return zone;
}

// ical.js reads a floating time, or a TZID whose VTIMEZONE is not embedded in the object, as if it
// were UTC, which shifts a noon New York appointment to 07:00. Reinterpret such wall-clock values in
// the property's IANA TZID when it has one, otherwise in the calendar's default zone.
function resolveWallClock(time: ICAL.Time, property: ICAL.Property | null | undefined, context: ParseContext): ICAL.Time {
  if (time.isDate) return time;
  const zone = time.zone;
  const tzid = zone?.tzid;
  const resolved = Boolean(zone) && tzid !== "floating" && (tzid === "UTC" || tzid === "Z" || Boolean(zone.component));
  if (resolved) return time;
  const parameter = stringValue(property?.getFirstParameter("tzid"));
  const target = isIanaTimeZone(parameter) ? parameter : context.defaultTimeZone;
  const iana = isIanaTimeZone(target) ? ianaTimezone(target) : undefined;
  if (!iana) return time;
  const reinterpreted = time.clone();
  reinterpreted.zone = iana;
  return reinterpreted;
}

function formatLocalTime(value: ICAL.Time, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(value.toUnixTime() * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  const offsetName = part("timeZoneName");
  const offset = offsetName === "GMT" ? "+00:00" : offsetName.replace(/^GMT/, "");
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

function formatTime(value: ICAL.Time): string {
  if (value.isDate) {
    return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
  }
  return new Date(value.toUnixTime() * 1000).toISOString();
}

function eventTimeZone(component: ICAL.Component, context: ParseContext): string | undefined {
  const property = component.getFirstProperty("dtstart");
  const propertyTimeZone = stringValue(property?.getFirstParameter("tzid"));
  if (isIanaTimeZone(propertyTimeZone)) return propertyTimeZone;
  return isIanaTimeZone(context.defaultTimeZone) ? context.defaultTimeZone : undefined;
}

function parseTimeProperty(component: ICAL.Component, name: string, context?: ParseContext): string | undefined {
  const property = component.getFirstProperty(name);
  const value = property?.getFirstValue();
  if (!(value instanceof ICAL.Time)) return undefined;
  return formatTime(context ? resolveWallClock(value, property, context) : value);
}

function parseAttendee(property: ICAL.Property, selfEmail: string): EventAttendee | undefined {
  const rawEmail = stringValue(property.getFirstValue());
  if (!rawEmail) return undefined;
  const email = normalizeEmail(rawEmail);
  const role = roleFromIcal[String(property.getFirstParameter("role") ?? "REQ-PARTICIPANT").toUpperCase() as keyof typeof roleFromIcal] ?? "required";
  const status = statusFromIcal[String(property.getFirstParameter("partstat") ?? "NEEDS-ACTION").toUpperCase()] ?? "needs-action";
  const name = stringValue(property.getFirstParameter("cn"));
  return {
    email,
    role,
    status,
    isSelf: email === normalizeEmail(selfEmail),
    ...(name ? { name } : {}),
  };
}

function parseOrganizer(component: ICAL.Component): EventOrganizer | undefined {
  const property = component.getFirstProperty("organizer");
  const rawEmail = stringValue(property?.getFirstValue());
  if (!property || !rawEmail) return undefined;
  const name = stringValue(property.getFirstParameter("cn"));
  return { email: normalizeEmail(rawEmail), ...(name ? { name } : {}) };
}

function parseReminder(component: ICAL.Component): EventReminder | undefined {
  const trigger = component.getFirstPropertyValue("trigger");
  if (!(trigger instanceof ICAL.Duration) || !trigger.isNegative) return undefined;
  const actionValue = String(component.getFirstPropertyValue("action") ?? "DISPLAY").toLowerCase();
  const action = actionValue === "email" || actionValue === "audio" ? actionValue : "display";
  const description = stringValue(component.getFirstPropertyValue("description"));
  return {
    action,
    minutesBefore: Math.max(0, Math.round(Math.abs(trigger.toSeconds()) / 60)),
    ...(description ? { description } : {}),
  };
}

function parseRecurrence(component: ICAL.Component): string[] {
  return ["rrule", "rdate", "exdate"].flatMap((name) => component.getAllProperties(name).map((property) => property.toICALString().replace(/\r?\n[ \t]/g, "")));
}

function numberParameter(property: ICAL.Property, name: string): number | undefined {
  const value = Number(property.getFirstParameter(name));
  return Number.isFinite(value) ? value : undefined;
}

function parseStructuredLocation(component: ICAL.Component): StructuredLocation | undefined {
  const property = component.getFirstProperty("x-apple-structured-location");
  const value = stringValue(property?.getFirstValue());
  if (!property || !value) return undefined;
  const match = /^geo:([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)/i.exec(value);
  if (!match?.[1] || !match[2]) return undefined;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const title = stringValue(property.getFirstParameter("x-title"));
  const address = stringValue(property.getFirstParameter("x-address"));
  const radius = numberParameter(property, "x-apple-radius");
  return {
    latitude,
    longitude,
    ...(title ? { title } : {}),
    ...(address ? { address } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
}

function parseEventComponent(component: ICAL.Component, context: ParseContext): CalendarEvent {
  const event = new ICAL.Event(component);
  const startDate = resolveWallClock(event.startDate, component.getFirstProperty("dtstart"), context);
  const endDate = resolveWallClock(event.endDate, component.getFirstProperty("dtend") ?? component.getFirstProperty("dtstart"), context);
  const start = formatTime(startDate);
  const end = formatTime(endDate);
  const timeZone = startDate.isDate ? undefined : eventTimeZone(component, context);
  const location = stringValue(component.getFirstPropertyValue("location"));
  const description = stringValue(component.getFirstPropertyValue("description"));
  const url = stringValue(component.getFirstPropertyValue("url"));
  const color = stringValue(component.getFirstPropertyValue("color"));
  const recurrenceId = parseTimeProperty(component, "recurrence-id", context);
  const created = parseTimeProperty(component, "created");
  const updated = parseTimeProperty(component, "last-modified") ?? parseTimeProperty(component, "dtstamp");
  const sequenceValue = component.getFirstPropertyValue("sequence");
  const organizer = parseOrganizer(component);
  const structuredLocation = parseStructuredLocation(component);
  const transparency = String(component.getFirstPropertyValue("transp") ?? "OPAQUE").toUpperCase();
  const statusValue = String(component.getFirstPropertyValue("status") ?? "CONFIRMED").toLowerCase();
  const status: EventStatus = statusValue === "tentative" || statusValue === "cancelled" ? statusValue : "confirmed";
  return {
    id: context.eventId,
    calendarId: context.calendarId,
    uid: event.uid,
    title: event.summary || "Untitled event",
    start,
    end,
    ...(timeZone ? { timeZone, startLocal: formatLocalTime(startDate, timeZone), endLocal: formatLocalTime(endDate, timeZone) } : {}),
    allDay: startDate.isDate,
    availability: transparency === "TRANSPARENT" ? "free" : "busy",
    status,
    attendees: component.getAllProperties("attendee").map((property) => parseAttendee(property, context.selfEmail)).filter((attendee): attendee is EventAttendee => Boolean(attendee)),
    reminders: component.getAllSubcomponents("valarm").map(parseReminder).filter((reminder): reminder is EventReminder => Boolean(reminder)),
    recurrence: parseRecurrence(component),
    ...(location ? { location } : {}),
    ...(structuredLocation ? { structuredLocation } : {}),
    ...(description ? { description } : {}),
    ...(url ? { url } : {}),
    ...(color ? { color } : {}),
    ...(organizer ? { organizer } : {}),
    ...(recurrenceId ? { recurrenceId } : {}),
    ...(typeof sequenceValue === "number" ? { sequence: sequenceValue } : {}),
    ...(created ? { created } : {}),
    ...(updated ? { updated } : {}),
    ...(context.etag ? { etag: context.etag } : {}),
  };
}

export function parseIcsEvents(data: string, context: ParseContext): CalendarEvent[] {
  const root = ICAL.Component.fromString(data);
  return root.getAllSubcomponents("vevent").map((component) => parseEventComponent(component, context));
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Parses either a plain date or a timestamp to epoch milliseconds, or NaN when it is neither.
function instantOf(value: string | undefined): number {
  if (!value) return Number.NaN;
  return new Date(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value).getTime();
}

// Derives an occurrence's end from the master's duration. iCloud's expansion occasionally mixes
// date and date-time forms, so every step is guarded and the occurrence's own end is the fallback
// rather than a thrown "Invalid time value".
function expandedOccurrenceEnd(event: CalendarEvent, start: string): string {
  const duration = instantOf(event.end) - instantOf(event.start);
  const startInstant = instantOf(start);
  if (!Number.isFinite(duration) || !Number.isFinite(startInstant)) return event.end;
  const end = new Date(startInstant + duration);
  return event.allDay ? end.toISOString().slice(0, 10) : end.toISOString();
}

// Picks the start for an expanded occurrence. The RECURRENCE-ID carries the true instant for timed
// series (iCloud's expanded DTSTART can drift across DST), but an all-day series must keep a plain
// date, so a date-time RECURRENCE-ID falls back to the occurrence's own DTSTART.
function expandedOccurrenceStart(event: CalendarEvent, exception: CalendarEvent | undefined): string {
  if (exception?.start) return exception.start;
  const recurrenceId = event.recurrenceId ?? event.start;
  if (event.allDay) return DATE_ONLY.test(recurrenceId) ? recurrenceId : event.start;
  return Number.isFinite(instantOf(recurrenceId)) ? recurrenceId : event.start;
}

export function parseExpandedIcsEvents(data: string, sourceData: string, context: ParseContext, sourceTimeZone?: string): CalendarEvent[] {
  const expanded = parseIcsEvents(data, context);
  const source = parseIcsEvents(sourceData, context);
  const master = source.find((event) => !event.recurrenceId);
  const exceptions = new Map(source.flatMap((event) => event.recurrenceId ? [[event.recurrenceId, event] as const] : []));
  return expanded.map((event) => {
    if (!event.recurrenceId) return event;
    const exception = exceptions.get(event.recurrenceId);
    const start = expandedOccurrenceStart(event, exception);
    const end = exception?.end ?? expandedOccurrenceEnd(event, start);
    const timeZone = sourceTimeZone ?? exception?.timeZone ?? master?.timeZone ?? event.timeZone;
    return {
      ...event,
      start,
      end,
      ...(timeZone && !event.allDay ? {
        timeZone,
        startLocal: formatLocalTime(ICAL.Time.fromJSDate(new Date(start), true), timeZone),
        endLocal: formatLocalTime(ICAL.Time.fromJSDate(new Date(end), true), timeZone),
      } : {}),
    };
  });
}

function parseInputTime(value: string, allDay: boolean, zone?: ICAL.Timezone): ICAL.Time {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("All-day event times must use YYYY-MM-DD dates.");
    return ICAL.Time.fromDateString(value);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Timed events require RFC3339 timestamps with Z or an explicit UTC offset.");
  }
  return zone ? instantInZone(date.getTime(), zone) : ICAL.Time.fromJSDate(date, true);
}

// Converts an instant to wall-clock time in a zone. ical.js's own UTC-to-local conversion is an hour
// off during the hour after each daylight-saving change (seen with Asia/Jerusalem), so IANA zones use
// the runtime's time zone database instead; ical.js remains in charge of local-to-UTC, which is right.
function instantInZone(epochMs: number, zone: ICAL.Timezone): ICAL.Time {
  const tzid = zone.tzid;
  if (tzid === "UTC" || tzid === "Z") return ICAL.Time.fromJSDate(new Date(epochMs), true);
  if (!isIanaTimeZone(tzid)) return ICAL.Time.fromJSDate(new Date(epochMs), true).convertToZone(zone);
  const clock = wallClock(epochMs, tzid);
  return new ICAL.Time({ year: clock.year, month: clock.month, day: clock.day, hour: clock.hour, minute: clock.minute, second: clock.second, isDate: false }, zone);
}

function validateTimeRange(start: string, end: string, allDay: boolean, zone?: ICAL.Timezone): { start: ICAL.Time; end: ICAL.Time } {
  const startTime = parseInputTime(start, allDay, zone);
  const endTime = parseInputTime(end, allDay, zone);
  if (endTime.toUnixTime() <= startTime.toUnixTime()) throw new Error("Event end must be after event start.");
  return { start: startTime, end: endTime };
}

function attachTimeZone(root: ICAL.Component, data: string | undefined, timeZone: string | undefined): ICAL.Timezone | undefined {
  if (!timeZone) return undefined;
  if (timeZone === "UTC") return ICAL.Timezone.utcTimezone;
  const existing = root.getTimeZoneByID(timeZone);
  if (existing) return existing;
  const source = matchingTimeZoneComponent(data, timeZone) ?? libraryTimeZoneComponent(timeZone);
  if (!source) return undefined;
  const component = new ICAL.Component(structuredClone(source.toJSON()));
  root.addSubcomponent(component);
  return root.getTimeZoneByID(String(component.getFirstPropertyValue("tzid")));
}

function addAttendee(
  component: ICAL.Component,
  attendee: EventAttendeeInput,
  participation?: { status?: string | undefined; rsvp?: string | undefined },
): void {
  const property = new ICAL.Property("attendee");
  property.setValue(`mailto:${normalizeEmail(attendee.email)}`);
  property.setParameter("role", roleToIcal[attendee.role ?? "required"]);
  property.setParameter("partstat", participation?.status ?? "NEEDS-ACTION");
  property.setParameter("rsvp", participation?.rsvp ?? "TRUE");
  if (attendee.name) property.setParameter("cn", attendee.name);
  component.addProperty(property);
}

function addReminder(component: ICAL.Component, reminder: EventReminderInput, title: string): void {
  const alarm = new ICAL.Component("valarm");
  alarm.addPropertyWithValue("action", "DISPLAY");
  alarm.addPropertyWithValue("trigger", ICAL.Duration.fromData({ minutes: reminder.minutesBefore, isNegative: true }));
  alarm.addPropertyWithValue("description", reminder.description ?? title);
  component.addSubcomponent(alarm);
}

function addRecurrence(component: ICAL.Component, recurrence: string[]): void {
  for (const line of recurrence) {
    if (!/^(?:RRULE|RDATE|EXDATE)(?:;[^:\r\n]+)?:[^\r\n]+$/i.test(line)) {
      throw new Error("Recurrence entries must be complete RRULE, RDATE, or EXDATE lines.");
    }
    component.addProperty(ICAL.Property.fromString(line));
  }
}

function setOptionalText(component: ICAL.Component, name: string, value: string | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") component.removeAllProperties(name);
  else component.updatePropertyWithValue(name, value);
}

function setStructuredLocation(component: ICAL.Component, value: StructuredLocation | null | undefined): void {
  if (value === undefined) return;
  component.removeAllProperties("x-apple-structured-location");
  if (value === null) return;
  const parameters: Record<string, string> = {};
  if (value.address) parameters["x-address"] = value.address;
  if (value.radius !== undefined) parameters["x-apple-radius"] = String(value.radius);
  if (value.title) parameters["x-title"] = value.title;
  component.addProperty(new ICAL.Property([
    "x-apple-structured-location",
    parameters,
    "uri",
    `geo:${value.latitude},${value.longitude}`,
  ]));
}

function setAttendees(component: ICAL.Component, attendees: EventAttendeeInput[], selfEmail: string): void {
  const participationByEmail = new Map(component.getAllProperties("attendee").flatMap((property) => {
    const email = stringValue(property.getFirstValue());
    if (!email) return [];
    return [[normalizeEmail(email), {
      status: stringValue(property.getFirstParameter("partstat")),
      rsvp: stringValue(property.getFirstParameter("rsvp")),
    }] as const];
  }));
  component.removeAllProperties("attendee");
  if (attendees.length === 0) return;
  if (!component.hasProperty("organizer")) component.addPropertyWithValue("organizer", `mailto:${normalizeEmail(selfEmail)}`);
  for (const attendee of attendees) addAttendee(component, attendee, participationByEmail.get(normalizeEmail(attendee.email)));
}

function setReminders(component: ICAL.Component, reminders: EventReminderInput[], title: string): void {
  component.removeAllSubcomponents("valarm");
  for (const reminder of reminders) addReminder(component, reminder, title);
}

function updateTimestamps(component: ICAL.Component, now: Date): void {
  const timestamp = ICAL.Time.fromJSDate(now, true);
  component.updatePropertyWithValue("dtstamp", timestamp);
  component.updatePropertyWithValue("last-modified", timestamp);
}

export function buildEventCalendar(draft: EventDraft, selfEmail: string, options: BuildOptions = {}): { data: string; filename: string; uid: string } {
  const allDay = draft.allDay ?? false;
  const now = options.now ?? new Date();
  const uid = options.uid ?? crypto.randomUUID();
  const root = new ICAL.Component("vcalendar");
  root.addPropertyWithValue("prodid", "-//Apple Calendar MCP//EN");
  root.addPropertyWithValue("version", "2.0");
  root.addPropertyWithValue("calscale", "GREGORIAN");
  const calendarTimeZone = calendarTimeZoneId(options.timeZoneData);
  const timeZone = allDay ? undefined : draft.timeZone ?? calendarTimeZone ?? options.defaultTimeZone;
  if (draft.timeZone && !isIanaTimeZone(draft.timeZone)) throw new Error("timeZone must be a valid IANA time zone such as America/New_York.");
  const zone = timeZone ? attachTimeZone(root, options.timeZoneData, timeZone) : undefined;
  if (draft.timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${draft.timeZone}.`);
  if (draft.recurrence?.length && timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${timeZone}.`);
  const range = validateTimeRange(draft.start, draft.end, allDay, zone);
  const component = new ICAL.Component("vevent");
  root.addSubcomponent(component);
  const event = new ICAL.Event(component);
  event.uid = uid;
  event.summary = draft.title;
  event.startDate = range.start;
  event.endDate = range.end;
  event.sequence = 0;
  const timestamp = ICAL.Time.fromJSDate(now, true);
  component.addPropertyWithValue("created", timestamp);
  updateTimestamps(component, now);
  component.addPropertyWithValue("transp", draft.availability === "free" ? "TRANSPARENT" : "OPAQUE");
  component.addPropertyWithValue("status", (draft.status ?? "confirmed").toUpperCase());
  setOptionalText(component, "location", draft.location ?? draft.structuredLocation?.address ?? draft.structuredLocation?.title);
  setStructuredLocation(component, draft.structuredLocation);
  setOptionalText(component, "description", draft.description);
  setOptionalText(component, "url", draft.url);
  if (draft.recurrence) addRecurrence(component, draft.recurrence);
  if (draft.attendees) setAttendees(component, draft.attendees, selfEmail);
  if (draft.reminders) setReminders(component, draft.reminders, draft.title);
  return { data: root.toString(), filename: `${uid}.ics`, uid };
}

function primaryEvent(root: ICAL.Component): ICAL.Component {
  const events = root.getAllSubcomponents("vevent");
  const component = events.find((candidate) => !candidate.hasProperty("recurrence-id")) ?? events[0];
  if (!component) throw new Error("Calendar object does not contain an event.");
  return component;
}

function patchEventComponent(root: ICAL.Component, component: ICAL.Component, patch: EventPatch, selfEmail: string, now: Date, options: PatchOptions): void {
  const event = new ICAL.Event(component);
  if (patch.title !== undefined) event.summary = patch.title;
  if (patch.timeZone !== undefined && (patch.start === undefined || patch.end === undefined)) {
    throw new Error("Changing timeZone requires both start and end.");
  }
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    if (patch.start === undefined || patch.end === undefined) throw new Error("Changing event time requires both start and end.");
    const allDay = patch.allDay ?? event.startDate.isDate;
    if (patch.timeZone && !isIanaTimeZone(patch.timeZone)) throw new Error("timeZone must be a valid IANA time zone such as America/New_York.");
    const existingTimeZone = isIanaTimeZone(event.startDate.zone.tzid) ? event.startDate.zone.tzid : undefined;
    const timeZone = allDay ? undefined : patch.timeZone ?? existingTimeZone ?? calendarTimeZoneId(options.timeZoneData) ?? options.defaultTimeZone;
    const zone = timeZone ? attachTimeZone(root, options.timeZoneData, timeZone) : undefined;
    if (patch.timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${patch.timeZone}.`);
    if (event.isRecurring() && timeZone && !zone) throw new Error(`No VTIMEZONE definition is available for ${timeZone}.`);
    const range = validateTimeRange(patch.start, patch.end, allDay, zone);
    event.startDate = range.start;
    event.endDate = range.end;
  }
  const location = patch.location === undefined && patch.structuredLocation
    ? patch.structuredLocation.address ?? patch.structuredLocation.title
    : patch.location;
  setOptionalText(component, "location", location);
  setStructuredLocation(component, patch.structuredLocation);
  setOptionalText(component, "description", patch.description);
  setOptionalText(component, "url", patch.url);
  if (patch.availability !== undefined) component.updatePropertyWithValue("transp", patch.availability === "free" ? "TRANSPARENT" : "OPAQUE");
  if (patch.status !== undefined) component.updatePropertyWithValue("status", patch.status.toUpperCase());
  if (patch.recurrence !== undefined) {
    component.removeAllProperties("rrule");
    component.removeAllProperties("rdate");
    component.removeAllProperties("exdate");
    if (patch.recurrence) addRecurrence(component, patch.recurrence);
  }
  if (patch.attendees !== undefined) setAttendees(component, patch.attendees ?? [], selfEmail);
  if (patch.reminders !== undefined) setReminders(component, patch.reminders ?? [], event.summary || "Calendar event");
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(component, now);
}

function sameRecurrenceTime(component: ICAL.Component, target: ICAL.Time): boolean {
  const value = component.getFirstPropertyValue("recurrence-id");
  return value instanceof ICAL.Time && (value.isDate ? value.toString() === target.toString() : value.toUnixTime() === target.toUnixTime());
}

function requireRecurringMaster(root: ICAL.Component): { component: ICAL.Component; event: ICAL.Event } {
  const component = primaryEvent(root);
  const event = new ICAL.Event(component);
  if (!event.isRecurring()) throw new Error("Occurrence-scoped changes require a recurring event.");
  return { component, event };
}

function occurrenceComponent(
  root: ICAL.Component,
  recurrenceId: string,
  scope: Exclude<RecurrenceMutationScope, "entire_series">,
): ICAL.Component {
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  if (!recurrenceId) throw new Error("recurrenceId is required for an occurrence-scoped change.");
  const originalStart = occurrenceTime(masterEvent, recurrenceId);
  const existing = root.getAllSubcomponents("vevent").find((candidate) => candidate !== master && sameRecurrenceTime(candidate, originalStart));
  if (existing) {
    // An existing override keeps its own (possibly moved) time and properties; only the patch changes it.
    const recurrenceProperty = existing.getFirstProperty("recurrence-id");
    if (scope === "this_and_following") recurrenceProperty?.setParameter("range", "THISANDFUTURE");
    else recurrenceProperty?.removeParameter("range");
    return existing;
  }
  if (!isOccurrence(masterEvent, originalStart)) throw new Error("The requested recurring occurrence was not found.");
  const component = new ICAL.Component(structuredClone(master.toJSON()));
  root.addSubcomponent(component);

  component.removeAllProperties("rrule");
  component.removeAllProperties("rdate");
  component.removeAllProperties("exdate");
  const event = new ICAL.Event(component);
  event.recurrenceId = originalStart;
  event.startDate = originalStart.clone();
  const end = originalStart.clone();
  end.addDuration(masterEvent.duration);
  event.endDate = end;
  const recurrenceProperty = component.getFirstProperty("recurrence-id");
  setTimeZoneParameter(recurrenceProperty, originalStart);
  if (scope === "this_and_following") recurrenceProperty?.setParameter("range", "THISANDFUTURE");
  else recurrenceProperty?.removeParameter("range");
  return component;
}

// ---------------------------------------------------------------------------------------------
// Recurring-series operations that iCloud honours. iCloud (like Apple Calendar itself) does not
// apply RANGE=THISANDFUTURE overrides, so "this and following" is done the way Apple Calendar does
// it: the original series is ended just before the occurrence and a new series starts there.
// Single-occurrence deletion adds an EXDATE to the series rather than a cancelled override.
// ---------------------------------------------------------------------------------------------

const MAX_RECURRENCE_ITERATIONS = 20_000;

function timeKey(time: ICAL.Time): string {
  return time.isDate ? time.toString().slice(0, 10) : String(time.toUnixTime());
}

function compareTimes(left: ICAL.Time, right: ICAL.Time): number {
  if (left.isDate && right.isDate) return left.toString().slice(0, 10).localeCompare(right.toString().slice(0, 10));
  return left.toUnixTime() - right.toUnixTime();
}

function setTimeZoneParameter(property: ICAL.Property | null | undefined, time: ICAL.Time): void {
  if (!property) return;
  if (time.isDate) {
    property.resetType("date");
    property.removeParameter("tzid");
    return;
  }
  const tzid = time.zone?.tzid;
  if (tzid && tzid !== "UTC" && tzid !== "Z" && tzid !== "floating") property.setParameter("tzid", tzid);
  else property.removeParameter("tzid");
}

// Parses a recurrenceId (as returned by searches) into the master's zone or date form.
function occurrenceTime(masterEvent: ICAL.Event, recurrenceId: string): ICAL.Time {
  const isDate = masterEvent.startDate.isDate;
  if (isDate && !/^\d{4}-\d{2}-\d{2}$/.test(recurrenceId)) {
    // A timed recurrenceId for an all-day series: take its calendar date in UTC, as iCloud reports it.
    const date = new Date(recurrenceId);
    if (!Number.isFinite(date.getTime())) throw new Error("recurrenceId is not a valid occurrence time.");
    return ICAL.Time.fromDateString(date.toISOString().slice(0, 10));
  }
  const parsed = parseInputTime(recurrenceId, isDate);
  return parsed.isDate ? parsed : instantInZone(parsed.toUnixTime() * 1000, masterEvent.startDate.zone);
}

function isOccurrence(masterEvent: ICAL.Event, target: ICAL.Time): boolean {
  const iterator = masterEvent.iterator();
  const wanted = timeKey(target);
  for (let index = 0; index < MAX_RECURRENCE_ITERATIONS; index += 1) {
    const next = iterator.next();
    if (!next) return false;
    if (timeKey(next) === wanted) return true;
    if (compareTimes(next, target) > 0) return false;
  }
  return false;
}

// Number of RRULE instances strictly before target, as COUNT counts them (EXDATE does not reduce COUNT).
function rruleInstancesBefore(masterEvent: ICAL.Event, recur: ICAL.Recur, target: ICAL.Time): number {
  const iterator = recur.iterator(masterEvent.startDate);
  let count = 0;
  for (let index = 0; index < MAX_RECURRENCE_ITERATIONS; index += 1) {
    const next = iterator.next();
    if (!next || compareTimes(next, target) >= 0) return count;
    count += 1;
  }
  return count;
}

// Keeps only the values of RDATE/EXDATE properties that satisfy keep(); removes empty properties.
function filterDateList(component: ICAL.Component, name: "rdate" | "exdate", keep: (time: ICAL.Time) => boolean): void {
  for (const property of component.getAllProperties(name)) {
    const values = property.getValues().filter((value) => !(value instanceof ICAL.Time) || keep(value));
    if (values.length === 0) component.removeProperty(property);
    else property.setValues(values);
  }
}

function overrides(root: ICAL.Component, master: ICAL.Component): ICAL.Component[] {
  return root.getAllSubcomponents("vevent").filter((candidate) => candidate !== master && candidate.hasProperty("recurrence-id"));
}

function recurrenceIdOf(component: ICAL.Component): ICAL.Time | undefined {
  const value = component.getFirstPropertyValue("recurrence-id");
  return value instanceof ICAL.Time ? value : undefined;
}

function untilBefore(target: ICAL.Time): ICAL.Time {
  if (target.isDate) {
    const until = target.clone();
    until.adjust(-1, 0, 0, 0);
    return until;
  }
  return ICAL.Time.fromJSDate(new Date((target.toUnixTime() - 1) * 1000), true);
}

// Ends the series immediately before the occurrence at recurrenceId. Returns undefined when that
// occurrence is the first one, meaning nothing of the series would remain.
export function truncateSeries(data: string, recurrenceId: string, now = new Date()): string | undefined {
  const root = ICAL.Component.fromString(data);
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  const target = occurrenceTime(masterEvent, recurrenceId);
  if (!isOccurrence(masterEvent, target)) throw new Error("The requested recurring occurrence was not found.");
  if (compareTimes(target, masterEvent.startDate) <= 0) return undefined;
  const until = untilBefore(target);
  for (const property of master.getAllProperties("rrule")) {
    const recur = property.getFirstValue() as ICAL.Recur;
    recur.count = null as unknown as number;
    recur.until = until;
    property.setValue(recur);
  }
  filterDateList(master, "rdate", (time) => compareTimes(time, target) < 0);
  filterDateList(master, "exdate", (time) => compareTimes(time, target) < 0);
  for (const component of overrides(root, master)) {
    const id = recurrenceIdOf(component);
    if (id && compareTimes(id, target) >= 0) root.removeSubcomponent(component);
  }
  const event = new ICAL.Event(master);
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(master, now);
  return root.toString();
}

// Removes one occurrence from a series with EXDATE and drops any override for it.
export function excludeOccurrence(data: string, recurrenceId: string, now = new Date()): string {
  const root = ICAL.Component.fromString(data);
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  const target = occurrenceTime(masterEvent, recurrenceId);
  const override = overrides(root, master).find((component) => sameRecurrenceTime(component, target));
  if (!override && !isOccurrence(masterEvent, target)) throw new Error("The requested recurring occurrence was not found.");
  if (override) root.removeSubcomponent(override);
  const property = new ICAL.Property("exdate");
  if (target.isDate) property.resetType("date");
  property.setValue(target);
  setTimeZoneParameter(property, target);
  master.addProperty(property);
  const event = new ICAL.Event(master);
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(master, now);
  return root.toString();
}

// Shifts EXDATEs and override RECURRENCE-IDs by the same amount the series start moved, so they keep
// pointing at the occurrences they described.
function shiftSeriesReferences(root: ICAL.Component, master: ICAL.Component, before: ICAL.Time, after: ICAL.Time): void {
  if (before.isDate !== after.isDate) {
    master.removeAllProperties("exdate");
    for (const component of overrides(root, master)) root.removeSubcomponent(component);
    return;
  }
  const delta = after.subtractDateTz(before);
  if (delta.toSeconds() === 0) return;
  const shift = (time: ICAL.Time) => {
    const moved = time.clone();
    moved.addDuration(delta);
    return moved;
  };
  for (const property of master.getAllProperties("exdate")) {
    property.setValues(property.getValues().map((value) => (value instanceof ICAL.Time ? shift(value) : value)));
  }
  // UNTIL bounds the occurrences, so it moves with them; otherwise a series moved earlier would gain one.
  for (const property of master.getAllProperties("rrule")) {
    const recur = property.getFirstValue() as ICAL.Recur;
    if (recur.until) {
      recur.until = shift(recur.until);
      property.setValue(recur);
    }
  }
  for (const component of overrides(root, master)) {
    const id = recurrenceIdOf(component);
    if (!id) continue;
    const property = component.getFirstProperty("recurrence-id");
    property?.setValue(shift(id));
  }
}

export interface SeriesSplit {
  original: string;
  created: { data: string; uid: string; filename: string };
}

// Applies a patch to an occurrence and every later one by splitting the series. When the occurrence
// is the first, the whole series is patched in place instead and `created` is omitted.
export function splitSeries(
  data: string,
  recurrenceId: string,
  patch: EventPatch,
  selfEmail: string,
  now = new Date(),
  options: PatchOptions & { uid?: string } = {},
): SeriesSplit | { original: string; created?: undefined } {
  const root = ICAL.Component.fromString(data);
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  const target = occurrenceTime(masterEvent, recurrenceId);
  if (!isOccurrence(masterEvent, target)) throw new Error("The requested recurring occurrence was not found.");
  if (compareTimes(target, masterEvent.startDate) <= 0) {
    return { original: patchEventCalendar(data, patch, selfEmail, now, "entire_series", undefined, options) };
  }

  const uid = options.uid ?? crypto.randomUUID();
  const newRoot = new ICAL.Component("vcalendar");
  for (const property of root.getAllProperties()) newRoot.addProperty(ICAL.Property.fromString(property.toICALString()));
  if (!newRoot.hasProperty("version")) newRoot.addPropertyWithValue("version", "2.0");
  for (const timezone of root.getAllSubcomponents("vtimezone")) newRoot.addSubcomponent(new ICAL.Component(structuredClone(timezone.toJSON())));

  const newMaster = new ICAL.Component(structuredClone(master.toJSON()));
  newRoot.addSubcomponent(newMaster);
  const newEvent = new ICAL.Event(newMaster);
  newEvent.uid = uid;
  const duration = masterEvent.duration;
  newEvent.startDate = target.clone();
  const end = target.clone();
  end.addDuration(duration);
  newEvent.endDate = end;
  setTimeZoneParameter(newMaster.getFirstProperty("dtstart"), target);
  if (newMaster.hasProperty("dtend")) setTimeZoneParameter(newMaster.getFirstProperty("dtend"), end);
  for (const property of newMaster.getAllProperties("rrule")) {
    const recur = property.getFirstValue() as ICAL.Recur;
    if (recur.count) {
      const sourceRule = master.getAllProperties("rrule")[newMaster.getAllProperties("rrule").indexOf(property)]?.getFirstValue() as ICAL.Recur | undefined;
      const before = sourceRule ? rruleInstancesBefore(masterEvent, sourceRule, target) : 0;
      recur.count = Math.max(1, recur.count - before);
      property.setValue(recur);
    }
  }
  filterDateList(newMaster, "rdate", (time) => compareTimes(time, target) >= 0);
  filterDateList(newMaster, "exdate", (time) => compareTimes(time, target) >= 0);
  newMaster.removeAllProperties("created");
  newMaster.addPropertyWithValue("created", ICAL.Time.fromJSDate(now, true));
  newEvent.sequence = 0;
  for (const component of overrides(root, master)) {
    const id = recurrenceIdOf(component);
    if (!id || compareTimes(id, target) < 0) continue;
    const copy = new ICAL.Component(structuredClone(component.toJSON()));
    new ICAL.Event(copy).uid = uid;
    copy.getFirstProperty("recurrence-id")?.removeParameter("range");
    newRoot.addSubcomponent(copy);
  }
  const newData = patchEventCalendar(newRoot.toString(), patch, selfEmail, now, "entire_series", undefined, options);
  const original = truncateSeries(data, recurrenceId, now);
  if (!original) throw new Error("Could not end the original series before the occurrence.");
  return { original, created: { data: newData, uid, filename: `${uid}.ics` } };
}

// Reads one occurrence: its override when one exists, otherwise the master's values at that time.
export function occurrenceEvent(data: string, recurrenceId: string, context: ParseContext): CalendarEvent {
  const root = ICAL.Component.fromString(data);
  const { component: master, event: masterEvent } = requireRecurringMaster(root);
  const target = occurrenceTime(masterEvent, recurrenceId);
  const override = overrides(root, master).find((component) => sameRecurrenceTime(component, target));
  if (override) return parseEventComponent(override, context);
  if (!isOccurrence(masterEvent, target)) throw new Error("The requested recurring occurrence was not found.");
  const copy = new ICAL.Component(structuredClone(master.toJSON()));
  copy.removeAllProperties("rrule");
  copy.removeAllProperties("rdate");
  copy.removeAllProperties("exdate");
  const event = new ICAL.Event(copy);
  const start = target.clone();
  const end = target.clone();
  end.addDuration(masterEvent.duration);
  event.recurrenceId = target.clone();
  event.startDate = start;
  event.endDate = end;
  const parsed = parseEventComponent(copy, context);
  return { ...parsed, recurrence: parseRecurrence(master) };
}

export function patchEventCalendar(
  data: string,
  patch: EventPatch,
  selfEmail: string,
  now = new Date(),
  scope: RecurrenceMutationScope = "entire_series",
  recurrenceId?: string,
  options: PatchOptions = {},
): string {
  const root = ICAL.Component.fromString(data);
  if (scope !== "entire_series" && patch.recurrence !== undefined) {
    throw new Error("Recurrence rules can only be changed for the entire series.");
  }
  const component = scope === "entire_series" ? primaryEvent(root) : occurrenceComponent(root, recurrenceId ?? "", scope);
  const recurringMaster = scope === "entire_series" && new ICAL.Event(component).isRecurring();
  const startBefore = recurringMaster ? new ICAL.Event(component).startDate.clone() : undefined;
  patchEventComponent(root, component, patch, selfEmail, now, options);
  if (startBefore && patch.start !== undefined) {
    shiftSeriesReferences(root, component, startBefore, new ICAL.Event(component).startDate);
  }
  return root.toString();
}

export function cancelEventOccurrence(
  data: string,
  recurrenceId: string,
  scope: Exclude<RecurrenceMutationScope, "entire_series">,
  now = new Date(),
): string {
  const root = ICAL.Component.fromString(data);
  const component = occurrenceComponent(root, recurrenceId, scope);
  const event = new ICAL.Event(component);
  component.updatePropertyWithValue("status", "CANCELLED");
  event.sequence = (event.sequence || 0) + 1;
  updateTimestamps(component, now);
  return root.toString();
}

export function respondToInvitation(data: string, selfEmail: string, status: Exclude<AttendanceStatus, "needs-action" | "delegated">, now = new Date()): string {
  const root = ICAL.Component.fromString(data);
  const component = primaryEvent(root);
  const self = component.getAllProperties("attendee").find((property) => {
    const value = stringValue(property.getFirstValue());
    return value ? normalizeEmail(value) === normalizeEmail(selfEmail) : false;
  });
  if (!self) throw new Error("The iCloud account is not an attendee on this event.");
  self.setParameter("partstat", status.toUpperCase());
  self.setParameter("rsvp", "FALSE");
  updateTimestamps(component, now);
  return root.toString();
}
