// End-to-end tests of the HTTP API against an in-memory iCloud CalDAV server. These run the real
// tsdav client, calendar layer, Guard Durable Object and confirmation flow; only Apple is simulated.
// They cover the full lifecycle the live test repeats on a temporary iCloud calendar.

import { env as workerEnv } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi, type ApiEnv } from "../src/api";
import { fingerprint, issueConfirmation } from "../src/confirm";
import { FakeICloud } from "./support/fake-icloud";

const USERNAME = "owner@example.com";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const TOKENS = {
  tester: "tester-token-0123456789abcdefghijklmnopqrstuv",
  reader: "reader-token-0123456789abcdefghijklmnopqrstuv",
  shared: "shared-token-0123456789abcdefghijklmnopqrstuv",
  expired: "expired-token-0123456789abcdefghijklmnopqrstu",
  auditor: "auditor-token-0123456789abcdefghijklmnopqrstu",
};
const ALL_EVENTS = ["events:read", "events:create", "events:update", "events:delete"];

const fake = new FakeICloud(USERNAME, PASSWORD, [
  { slug: "home", name: "Home", timeZone: "Asia/Jerusalem" },
  { slug: "claude-test", name: "Claude Test", timeZone: "Asia/Jerusalem" },
  { slug: "family", name: "Family", timeZone: "Asia/Jerusalem", readOnly: true },
  { slug: "tasks", name: "Reminders", components: ["VTODO"] },
]);

const REAL_EVENT = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//iPhone OS//EN",
  "BEGIN:VEVENT", "UID:real-1", "DTSTAMP:20261101T000000Z", "DTSTART:20261201T080000Z", "DTEND:20261201T090000Z", "SUMMARY:Real appointment", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const env: ApiEnv = {
  ICLOUD_USERNAME: USERNAME,
  ICLOUD_APP_PASSWORD: PASSWORD,
  CALENDAR_TIME_ZONE: "Asia/Jerusalem",
  RATE_LIMIT_PER_MINUTE: "5000",
  RATE_LIMIT_WRITES_PER_MINUTE: "5000",
  API_KEYS: JSON.stringify({
    tester: { token: TOKENS.tester, scopes: ALL_EVENTS, calendars: ["Claude Test"] },
    reader: { token: TOKENS.reader, scopes: ["events:read"], calendars: ["Claude Test"] },
    shared: { token: TOKENS.shared, scopes: ALL_EVENTS, calendars: ["Family"] },
    expired: { token: TOKENS.expired, scopes: ALL_EVENTS, expiresAt: "2020-01-01T00:00:00Z" },
    auditor: { token: TOKENS.auditor, scopes: ["audit:read"] },
  }),
  GUARD: (workerEnv as unknown as Env).GUARD,
} as ApiEnv;

const BASE = "https://calendar.example.workers.dev";

interface CallOptions {
  key?: keyof typeof TOKENS | null;
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
}

async function call(method: string, path: string, options: CallOptions = {}) {
  const url = new URL(path, BASE);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(name, entry);
  }
  const key = options.key === undefined ? "tester" : options.key;
  const headers: Record<string, string> = { ...(key ? { authorization: `Bearer ${TOKENS[key]}` } : {}), ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers };
  if (headers.authorization === "") delete headers.authorization;
  fake.log.length = 0;
  const response = await handleApi(new Request(url, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) }), env);
  const subrequests = fake.log.length;
  const text = await response.text();
  // biome-ignore lint: test helper
  const json = text ? (JSON.parse(text) as any) : undefined;
  return { status: response.status, json, headers: response.headers, subrequests };
}

let testCalendarId = "";
let homeCalendarId = "";
let familyCalendarId = "";

beforeAll(async () => {
  vi.stubGlobal("fetch", fake.fetch);
  fake.put("home", "real-1.ics", REAL_EVENT);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("discovery and permissions", () => {
  it("documents every route with schemas and the caller's permissions", async () => {
    const { status, json } = await call("GET", "/api");
    expect(status).toBe(200);
    expect(json.you).toMatchObject({ keyId: "tester", scopes: ALL_EVENTS });
    const routes = json.routes.map((route: { method: string; path: string }) => `${route.method} ${route.path}`);
    for (const expected of ["GET /api/events", "GET /api/events/{calendarId}/{eventId}", "POST /api/events", "PATCH /api/events/{calendarId}/{eventId}", "DELETE /api/events/{calendarId}/{eventId}", "POST /api/events/bulk", "GET /api/conflicts", "GET /api/availability", "GET /api/time"]) {
      expect(routes).toContain(expected);
    }
    const patch = json.routes.find((route: { method: string }) => route.method === "PATCH");
    expect(patch.body.properties).toHaveProperty("start");
    expect(patch.body.properties).toHaveProperty("etag");
    expect(patch.confirmation).toBeTruthy();
    expect(json.conventions.success).toMatch(/done: true/);
  });

  it("reports local time with DST status", async () => {
    const { json } = await call("GET", "/api/time");
    expect(json.timeZone).toBe("Asia/Jerusalem");
    expect(json.now).toMatch(/\+0[23]:00$/);
  });

  it("only shows allowlisted calendars", async () => {
    const { json } = await call("GET", "/api/calendars");
    expect(json.calendars.map((calendar: { name: string }) => calendar.name)).toEqual(["Claude Test"]);
    testCalendarId = json.calendars[0].id;
    const shared = await call("GET", "/api/calendars", { key: "shared" });
    familyCalendarId = shared.json.calendars[0].id;
    homeCalendarId = btoa(fake.calendarUrl("home")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  });

  it("rejects missing, wrong and expired tokens", async () => {
    expect((await call("GET", "/api/calendars", { key: null })).status).toBe(401);
    expect((await call("GET", "/api/calendars", { key: null, headers: { authorization: "Bearer not-a-real-token-at-all-000000000" } })).status).toBe(401);
    const expired = await call("GET", "/api/calendars", { key: "expired" });
    expect(expired.status).toBe(401);
    expect(expired.json.error).toMatch(/expired/);
  });

  it("refuses calendars outside the key's allowlist", async () => {
    const outside = await call("GET", "/api/events", { query: { start: "2026-12-01", end: "2026-12-02", calendarId: homeCalendarId } });
    expect(outside.status).toBe(403);
    expect(outside.json.code).toBe("calendar_not_available");
    const create = await call("POST", "/api/events", { body: { calendarId: homeCalendarId, title: "Should not exist", start: "2026-12-05T10:00" } });
    expect(create.status).toBe(403);
    expect(fake.objectsIn("home")).toHaveLength(1);
  });
});

describe("single event lifecycle", () => {
  let eventId = "";
  let etag = "";
  let firstEtag = "";

  it("1. creates an event from a local Israel time", async () => {
    const { status, json, subrequests } = await call("POST", "/api/events", {
      body: { calendarId: testCalendarId, title: "Dentist", start: "2026-12-01T15:00", end: "2026-12-01T16:00", location: "Clinic A", description: "Bring forms", reminders: [{ minutesBefore: 30 }] },
    });
    expect(status).toBe(201);
    expect(json.done).toBe(true);
    expect(json.event).toMatchObject({ title: "Dentist", start: "2026-12-01T13:00:00.000Z", startLocal: "2026-12-01T15:00:00+02:00", endLocal: "2026-12-01T16:00:00+02:00", location: "Clinic A", calendarName: "Claude Test" });
    expect(json.event.reminders).toEqual([expect.objectContaining({ minutesBefore: 30 })]);
    expect(subrequests).toBeLessThan(25);
    eventId = json.event.id;
    etag = json.event.etag;
    firstEtag = etag;
  });

  it("refuses an identical duplicate", async () => {
    const { status, json } = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "dentist", start: "2026-12-01T15:00", end: "2026-12-01T16:00" } });
    expect(status).toBe(409);
    expect(json.code).toBe("duplicate_suspected");
    expect(json.done).toBe(false);
    expect(fake.objectsIn("claude-test")).toHaveLength(1);
  });

  it("2. reads and identifies the event by search", async () => {
    const { json } = await call("GET", "/api/events", { query: { start: "2026-12-01", end: "2026-12-02", query: "dent" } });
    expect(json.events).toHaveLength(1);
    expect(json.events[0]).toMatchObject({ id: eventId, calendarId: testCalendarId, etag });
    const single = await call("GET", `/api/events/${testCalendarId}/${eventId}`);
    expect(single.json.event.title).toBe("Dentist");
  });

  it("3-4. moves the start and keeps the duration and other properties", async () => {
    const { status, json, subrequests } = await call("PATCH", `/api/events/${testCalendarId}/${eventId}`, { body: { etag, start: "2026-12-01T17:30" } });
    expect(status).toBe(200);
    expect(json.done).toBe(true);
    expect(json.event).toMatchObject({ startLocal: "2026-12-01T17:30:00+02:00", endLocal: "2026-12-01T18:30:00+02:00", title: "Dentist", location: "Clinic A", description: "Bring forms" });
    expect(json.event.reminders).toEqual([expect.objectContaining({ minutesBefore: 30 })]);
    expect(subrequests).toBeLessThan(25);
    etag = json.event.etag;
  });

  it("rejects a change based on a stale etag", async () => {
    const { status, json } = await call("PATCH", `/api/events/${testCalendarId}/${eventId}`, { body: { etag: firstEtag, title: "Stale" } });
    expect(status).toBe(412);
    expect(json.code).toBe("etag_mismatch");
  });

  it("changes the length with durationMinutes", async () => {
    const { json } = await call("PATCH", `/api/events/${testCalendarId}/${eventId}`, { body: { durationMinutes: 90 }, headers: { "if-match": etag } });
    expect(json.event).toMatchObject({ startLocal: "2026-12-01T17:30:00+02:00", endLocal: "2026-12-01T19:00:00+02:00" });
    etag = json.event.etag;
  });

  it("5. changes title and location only", async () => {
    const { json } = await call("PATCH", `/api/events/${testCalendarId}/${eventId}`, { body: { etag, title: "Dentist (check-up)", location: "Clinic B" } });
    expect(json.event).toMatchObject({ title: "Dentist (check-up)", location: "Clinic B", description: "Bring forms", startLocal: "2026-12-01T17:30:00+02:00", endLocal: "2026-12-01T19:00:00+02:00" });
    expect(json.changed.sort()).toEqual(["location", "title"]);
    etag = json.event.etag;
  });

  it("refuses an expired confirmation token", async () => {
    const operation = { op: "delete", calendarId: testCalendarId, eventId, etag, scope: "entire_series", keyId: "tester" };
    const stale = await issueConfirmation(`derived:${USERNAME}:${PASSWORD}`, "tester", await fingerprint(operation), 300, Date.now() - 3_600_000);
    const { status, json } = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag }, headers: { "x-confirmation-token": stale.token } });
    expect(status).toBe(410);
    expect(json.code).toBe("confirmation_expired");
    expect(fake.objectsIn("claude-test")).toHaveLength(1);
  });

  it("6-7. deletes only after confirmation, then verifies it is gone", async () => {
    const first = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag } });
    expect(first.status).toBe(428);
    expect(first.json).toMatchObject({ done: false, status: "confirmation_required" });
    expect(first.json.summary).toMatch(/Delete the event "Dentist \(check-up\)"/);
    expect(fake.objectsIn("claude-test")).toHaveLength(1);

    const wrongOperation = await call("PATCH", `/api/events/${testCalendarId}/${eventId}`, { body: { etag, title: "x" }, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(wrongOperation.status).toBe(200); // single-event edits need no token; a stray header is ignored
    etag = wrongOperation.json.event.etag;
    const mismatched = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag }, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(mismatched.status).toBe(409);
    expect(mismatched.json.code).toBe("confirmation_mismatch");

    const fresh = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag } });
    const confirmed = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag, confirmationToken: fresh.json.confirmation.token } });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({ done: true, deleted: true, verifiedGone: true });

    const again = await call("DELETE", `/api/events/${testCalendarId}/${eventId}`, { query: { etag, confirmationToken: fresh.json.confirmation.token } });
    expect(again.json.done).toBe(false);
    const gone = await call("GET", `/api/events/${testCalendarId}/${eventId}`);
    expect(gone.status).toBe(404);
    expect(fake.objectsIn("claude-test")).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("returns the first result for a repeated Idempotency-Key and refuses a reused key", async () => {
    const body = { calendarId: testCalendarId, title: "Gym", start: "2026-12-03T07:00", durationMinutes: 45 };
    const first = await call("POST", "/api/events", { body, headers: { "idempotency-key": "req-42" } });
    expect(first.status).toBe(201);
    expect(first.json.event.endLocal).toBe("2026-12-03T07:45:00+02:00");
    const replay = await call("POST", "/api/events", { body, headers: { "idempotency-key": "req-42" } });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replay")).toBe("true");
    expect(replay.json.event.id).toBe(first.json.event.id);
    expect(fake.objectsIn("claude-test").filter((object) => object.data.includes("SUMMARY:Gym"))).toHaveLength(1);
    const reused = await call("POST", "/api/events", { body: { ...body, title: "Swim" }, headers: { "idempotency-key": "req-42" } });
    expect(reused.status).toBe(422);
  });
});

describe("permissions per operation", () => {
  it("lets a read-only key read but not change", async () => {
    const created = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Read only target", start: "2026-12-04T10:00" } });
    const { id, etag } = created.json.event;
    expect((await call("GET", `/api/events/${testCalendarId}/${id}`, { key: "reader" })).status).toBe(200);
    expect((await call("POST", "/api/events", { key: "reader", body: { calendarId: testCalendarId, title: "x", start: "2026-12-04T11:00" } })).json.code).toBe("insufficient_scope");
    expect((await call("PATCH", `/api/events/${testCalendarId}/${id}`, { key: "reader", body: { etag, title: "x" } })).status).toBe(403);
    expect((await call("DELETE", `/api/events/${testCalendarId}/${id}`, { key: "reader", query: { etag } })).status).toBe(403);
  });

  it("reports read-only shared calendars clearly", async () => {
    const { status, json } = await call("POST", "/api/events", { key: "shared", body: { calendarId: familyCalendarId, title: "Family dinner", start: "2026-12-06T19:00" } });
    expect(status).toBe(403);
    expect(json.code).toBe("calendar_read_only");
  });
});

describe("recurring events", () => {
  let seriesId = "";
  const occurrences = async (query = "standup") => (await call("GET", "/api/events", { query: { start: "2026-11-29", end: "2027-01-31", query } })).json.events as Array<Record<string, string>>;

  it("8. creates a weekly series and lists each occurrence", async () => {
    const { status, json } = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Standup", start: "2026-11-30T09:00", durationMinutes: 30, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=6"] } });
    expect(status).toBe(201);
    seriesId = json.event.id;
    const list = await occurrences();
    expect(list).toHaveLength(6);
    expect(list.every((event) => event.startLocal?.endsWith("09:00:00+02:00"))).toBe(true);
    expect(list.every((event) => event.recurrenceId)).toBe(true);
  });

  it("moves one occurrence without confirmation and keeps the rest", async () => {
    const list = await occurrences();
    const second = list[1]!;
    const { status, json } = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body: { etag: second.etag, recurrenceId: second.recurrenceId, start: "2026-12-07T10:00" } });
    expect(status).toBe(200);
    expect(json.event).toMatchObject({ startLocal: "2026-12-07T10:00:00+02:00", endLocal: "2026-12-07T10:30:00+02:00", recurrenceId: second.recurrenceId });
    const retitled = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body: { etag: json.event.etag, recurrenceId: second.recurrenceId, title: "Standup (moved)" } });
    expect(retitled.json.event).toMatchObject({ title: "Standup (moved)", startLocal: "2026-12-07T10:00:00+02:00" });
    const after = await occurrences();
    expect(after.map((event) => event.startLocal!.slice(0, 16))).toEqual(["2026-11-30T09:00", "2026-12-07T10:00", "2026-12-14T09:00", "2026-12-21T09:00", "2026-12-28T09:00", "2027-01-04T09:00"]);
  });

  it("deletes a single occurrence after confirmation", async () => {
    const third = (await occurrences())[2]!;
    const first = await call("DELETE", `/api/events/${testCalendarId}/${seriesId}`, { query: { etag: third.etag, recurrenceId: third.recurrenceId } });
    expect(first.status).toBe(428);
    expect(first.json.summary).toMatch(/this one occurrence/);
    const done = await call("DELETE", `/api/events/${testCalendarId}/${seriesId}`, { query: { etag: third.etag, recurrenceId: third.recurrenceId }, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(done.json).toMatchObject({ done: true, scope: "this_instance", verifiedGone: true });
    const after = await occurrences();
    expect(after).toHaveLength(5);
    expect(after.map((event) => event.startLocal!.slice(0, 10))).not.toContain("2026-12-14");
    expect(fake.objectsIn("claude-test").find((object) => object.data.includes("SUMMARY:Standup"))!.data).toMatch(/EXDATE;TZID=Asia\/Jerusalem:20261214T090000/);
  });

  it("changes this and following occurrences by splitting the series", async () => {
    const fourth = (await occurrences()).find((event) => event.startLocal!.startsWith("2026-12-21"))!;
    const body = { etag: fourth.etag, recurrenceId: fourth.recurrenceId, scope: "this_and_following", title: "Standup v2" };
    const first = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body });
    expect(first.status).toBe(428);
    const done = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body: { ...body, confirmationToken: first.json.confirmation.token } });
    expect(done.status).toBe(200);
    expect(done.json.event.id).not.toBe(seriesId);
    expect(done.json.note).toMatch(/split/);
    const after = await occurrences();
    expect(after.map((event) => `${event.startLocal!.slice(0, 10)} ${event.title}`)).toEqual([
      "2026-11-30 Standup",
      "2026-12-07 Standup (moved)",
      "2026-12-21 Standup v2",
      "2026-12-28 Standup v2",
      "2027-01-04 Standup v2",
    ]);
  });

  it("changing the entire series needs confirmation and keeps moved occurrences attached", async () => {
    const original = (await occurrences()).find((event) => event.id === seriesId)!;
    const body = { etag: original.etag, scope: "entire_series", start: "2026-11-30T08:30" };
    const first = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body });
    expect(first.status).toBe(428);
    expect(first.json.summary).toMatch(/every occurrence/);
    const done = await call("PATCH", `/api/events/${testCalendarId}/${seriesId}`, { body, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(done.json.done).toBe(true);
    const after = (await occurrences()).filter((event) => event.id === seriesId);
    expect(after.map((event) => event.startLocal!.slice(0, 16))).toEqual(["2026-11-30T08:30", "2026-12-07T10:00"]);
  });

  it("deletes the whole original series after confirmation", async () => {
    const original = (await occurrences()).find((event) => event.id === seriesId)!;
    const first = await call("DELETE", `/api/events/${testCalendarId}/${seriesId}`, { query: { etag: original.etag } });
    expect(first.json.summary).toMatch(/whole repeating series/);
    const done = await call("DELETE", `/api/events/${testCalendarId}/${seriesId}`, { query: { etag: original.etag }, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(done.json).toMatchObject({ done: true, verifiedGone: true });
    expect((await occurrences()).map((event) => event.title)).toEqual(["Standup v2", "Standup v2", "Standup v2"]);
  });

  it("deleting this-and-following from the first occurrence removes the series", async () => {
    const first = (await occurrences())[0]!;
    const query = { etag: first.etag, recurrenceId: first.recurrenceId, scope: "this_and_following" };
    const pending = await call("DELETE", `/api/events/${testCalendarId}/${first.id}`, { query });
    const done = await call("DELETE", `/api/events/${testCalendarId}/${first.id}`, { query: { ...query, confirmationToken: pending.json.confirmation.token } });
    expect(done.json.done).toBe(true);
    expect(await occurrences()).toHaveLength(0);
  });
});

describe("time zones", () => {
  it("applies Israel daylight saving time, including the spring-forward gap", async () => {
    const summer = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Summer", start: "2027-07-01T09:00" } });
    expect(summer.json.event).toMatchObject({ start: "2027-07-01T06:00:00.000Z", startLocal: "2027-07-01T09:00:00+03:00" });
    const gap = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Gap", start: "2027-03-26T02:30" } });
    expect(gap.json.event.startLocal).toBe("2027-03-26T03:30:00+03:00");
    const explicit = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Explicit", start: "2026-12-10T08:00:00Z", end: "2026-12-10T09:00:00Z" } });
    expect(explicit.json.event.startLocal).toBe("2026-12-10T10:00:00+02:00");
  });

  it("keeps a weekly event at the same wall-clock time across the DST change", async () => {
    await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Weekly across DST", start: "2027-03-15T09:00", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"] } });
    const { json } = await call("GET", "/api/events", { query: { start: "2027-03-14", end: "2027-04-05", query: "across dst" } });
    expect(json.events.map((event: { startLocal: string }) => event.startLocal)).toEqual(["2027-03-15T09:00:00+02:00", "2027-03-22T09:00:00+02:00", "2027-03-29T09:00:00+03:00"]);
  });

  it("creates all-day events from plain dates", async () => {
    const { json } = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Holiday", start: "2026-12-24", end: "2026-12-26" } });
    expect(json.event).toMatchObject({ allDay: true, start: "2026-12-24", end: "2026-12-26" });
    const moved = await call("PATCH", `/api/events/${testCalendarId}/${json.event.id}`, { body: { etag: json.event.etag, start: "2026-12-30" } });
    expect(moved.json.event).toMatchObject({ start: "2026-12-30", end: "2027-01-01" });
  });
});

describe("conflicts and availability", () => {
  it("detects overlaps and can refuse them", async () => {
    await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Meeting A", start: "2026-12-02T10:00", end: "2026-12-02T11:00" } });
    const check = await call("GET", "/api/conflicts", { query: { start: "2026-12-02T10:30", end: "2026-12-02T11:30" } });
    expect(check.json).toMatchObject({ free: false });
    expect(check.json.conflicts[0].title).toBe("Meeting A");
    const refused = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Meeting B", start: "2026-12-02T10:30", rejectOnConflict: true } });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("time_conflict");
    const allowed = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Meeting B", start: "2026-12-02T10:30" } });
    expect(allowed.status).toBe(201);
    expect(allowed.json.conflicts).toHaveLength(1);
    const availability = await call("GET", "/api/availability", { query: { start: "2026-12-02T08:00", end: "2026-12-02T14:00" } });
    expect(availability.json.combined.busy).toEqual([{ start: "2026-12-02T10:00:00+02:00", end: "2026-12-02T11:30:00+02:00" }]);
    expect(availability.json.combined.free.map((window: { start: string }) => window.start)).toEqual(["2026-12-02T08:00:00+02:00", "2026-12-02T11:30:00+02:00"]);
  });
});

describe("concurrent changes", () => {
  it("stops a write when the event was edited elsewhere after it was read", async () => {
    const created = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Contested", start: "2026-12-08T12:00" } });
    const path = fake.objectsIn("claude-test").find((object) => object.data.includes("SUMMARY:Contested"))!.path;
    fake.touch(path, (data) => data.replace("SUMMARY:Contested", "SUMMARY:Edited on iPhone"));
    const { status, json } = await call("PATCH", `/api/events/${testCalendarId}/${created.json.event.id}`, { body: { etag: created.json.event.etag, start: "2026-12-08T13:00" } });
    expect(status).toBe(412);
    expect(json.code).toBe("etag_mismatch");
    expect(fake.objects.get(path)!.data).toContain("SUMMARY:Edited on iPhone");
  });

  it("stops a write when the event changes between the check and the save", async () => {
    const created = await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Race", start: "2026-12-09T12:00" } });
    const path = fake.objectsIn("claude-test").find((object) => object.data.includes("SUMMARY:Race"))!.path;
    fake.beforeWrite = (target) => {
      if (target === path) fake.touch(path);
      fake.beforeWrite = undefined;
    };
    const { status } = await call("PATCH", `/api/events/${testCalendarId}/${created.json.event.id}`, { body: { etag: created.json.event.etag, title: "Race (renamed)" } });
    expect(status).toBe(412);
    expect(fake.objects.get(path)!.data).toContain("SUMMARY:Race");
  });
});

describe("bulk changes", () => {
  it("requires confirmation and reports each result", async () => {
    const a = (await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Bulk A", start: "2026-12-11T09:00" } })).json.event;
    const b = (await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Bulk B", start: "2026-12-11T11:00" } })).json.event;
    const body = { operations: [
      { action: "update", calendarId: testCalendarId, eventId: a.id, etag: a.etag, changes: { start: "2026-12-11T09:30" } },
      { action: "delete", calendarId: testCalendarId, eventId: b.id, etag: b.etag },
    ] };
    const first = await call("POST", "/api/events/bulk", { body });
    expect(first.status).toBe(428);
    expect(first.json.summary).toMatch(/Apply 2 changes/);
    const done = await call("POST", "/api/events/bulk", { body, headers: { "x-confirmation-token": first.json.confirmation.token } });
    expect(done.json).toMatchObject({ done: true, succeeded: 2, failed: 0 });
    expect(done.subrequests).toBeLessThan(45);
    expect(done.json.results[0].event.endLocal).toBe("2026-12-11T10:30:00+02:00");
  });
});

describe("clients limited to GET and POST", () => {
  it("can update and delete through a POST method override and X-API-Key", async () => {
    const created = (await call("POST", "/api/events", { body: { calendarId: testCalendarId, title: "Override me", start: "2026-12-12T09:00" } })).json.event;
    const headers = { authorization: "", "x-api-key": TOKENS.tester };
    const patched = await call("POST", `/api/events/${testCalendarId}/${created.id}`, { key: null, headers: { ...headers, "x-http-method-override": "PATCH" }, body: { etag: created.etag, title: "Overridden" } });
    expect(patched.json).toMatchObject({ done: true, event: { title: "Overridden" } });
    const pending = await call("POST", `/api/events/${testCalendarId}/${created.id}`, { key: null, headers, query: { _method: "DELETE", etag: patched.json.event.etag } });
    expect(pending.status).toBe(428);
    const done = await call("POST", `/api/events/${testCalendarId}/${created.id}`, { key: null, headers, query: { _method: "DELETE", etag: patched.json.event.etag, confirmationToken: pending.json.confirmation.token } });
    expect(done.json).toMatchObject({ done: true, verifiedGone: true });
  });
});

describe("audit log and isolation", () => {
  it("records operations without event content", async () => {
    const { json } = await call("GET", "/api/audit", { key: "auditor", query: { limit: "200" } });
    expect(json.entries.length).toBeGreaterThan(10);
    const serialized = JSON.stringify(json.entries);
    expect(serialized).not.toMatch(/Dentist|Clinic|Standup|Bring forms/);
    expect(serialized).not.toContain(PASSWORD);
    expect(json.entries.some((entry: { outcome: string }) => entry.outcome === "deleted")).toBe(true);
  });

  it("never touched the real calendar", () => {
    const home = fake.objectsIn("home");
    expect(home).toHaveLength(1);
    expect(home[0]!.data).toBe(REAL_EVENT);
  });
});

describe("rate limiting", () => {
  beforeEach(() => fake.log.splice(0));

  it("limits repeated failed sign-ins per address", async () => {
    let last = 0;
    for (let index = 0; index < 32; index += 1) {
      last = (await call("GET", "/api/time", { key: null, headers: { authorization: "Bearer wrong-token-xxxxxxxxxxxxxxxxxxxxxxxx", "cf-connecting-ip": "203.0.113.9" } })).status;
    }
    expect(last).toBe(429);
  });
});
