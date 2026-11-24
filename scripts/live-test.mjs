#!/usr/bin/env node
// Live end-to-end test of the deployed HTTP API against a TEMPORARY iCloud calendar.
//
// Safety: it refuses to run unless the key it is given can see exactly one calendar, named
// TEST_CALENDAR (default "Claude Test"). Create that empty calendar in Apple Calendar first and give
// this script a key restricted to it (see docs/operations.md). Your other calendars stay untouched.
//
// Usage (Node 18+; nothing to install):
//   export CALENDAR_API_BASE="https://apple-calendar-mcp.<you>.workers.dev/api"
//   read -rs CALENDAR_API_TOKEN && export CALENDAR_API_TOKEN     # paste the test key; it is not echoed
//   node scripts/live-test.mjs [--skip-expiry-wait]
//
// The token is only ever sent in the Authorization header. It is never printed or written to disk.

const BASE = (process.env.CALENDAR_API_BASE ?? "").replace(/\/+$/, "");
const TOKEN = process.env.CALENDAR_API_TOKEN ?? "";
const TEST_CALENDAR = process.env.TEST_CALENDAR ?? "Claude Test";
const SKIP_EXPIRY_WAIT = process.argv.includes("--skip-expiry-wait");
const RUN = `LT${Date.now().toString(36).toUpperCase()}`;

if (!(/^https:\/\/.+\/api$/.test(BASE) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/api$/.test(BASE)) || TOKEN.length < 24) {
  console.error("Set CALENDAR_API_BASE (https://…/api) and CALENDAR_API_TOKEN (the test-calendar key). See the header of this file.");
  process.exit(2);
}

const results = [];
let failed = 0;

function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  — ${detail}` : ""}`);
}

// Honours the API's rate limits: on 429 it waits for Retry-After and tries again.
async function api(method, path, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await rawApi(method, path, options);
    if (result.status !== 429 || attempt >= 3 || options.auth === false) return result;
    const wait = Math.min(65, Number(result.headers.get("retry-after") ?? "30"));
    console.log(`      rate limited by the API (working as intended); waiting ${wait}s…`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
}

async function rawApi(method, path, { body, query, headers = {}, auth = true } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json, headers: response.headers };
}

// Two-step confirmation, as an assistant would do it after the user says yes. If the token expired
// meanwhile (for example while waiting out a rate limit), it starts over once with a fresh token.
async function confirmAndRun(method, path, options) {
  for (let attempt = 0; ; attempt += 1) {
    const first = await api(method, path, options);
    if (first.status !== 428) return { first, second: first };
    const token = first.json.confirmation.token;
    const second = await api(method, path, { ...options, headers: { ...(options.headers ?? {}), "x-confirmation-token": token } });
    if (second.status !== 410 || attempt >= 1) return { first, second, token };
  }
}

const created = new Set();
let calendarId;

function addDaysIso(days) {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Live test run ${RUN} against ${new URL(BASE).host}\n`);

  // 0. Safety checks: the key must be confined to the temporary calendar.
  const spec = await api("GET", "");
  if (spec.status !== 200) throw new Error(`GET /api returned ${spec.status}: ${JSON.stringify(spec.json)}`);
  const calendars = await api("GET", "/calendars");
  const names = (calendars.json?.calendars ?? []).map((calendar) => calendar.name);
  if (!String(spec.json.you?.calendars ?? "").startsWith("restricted") || names.length !== 1 || names[0] !== TEST_CALENDAR) {
    throw new Error(`Refusing to run: this key must see only the calendar "${TEST_CALENDAR}", but it sees ${JSON.stringify(names)}. Restrict the key with "calendars": ["${TEST_CALENDAR}"].`);
  }
  calendarId = calendars.json.calendars[0].id;
  record("safety: key confined to the test calendar", true, TEST_CALENDAR);
  const scopes = spec.json.you.scopes;
  for (const scope of ["events:read", "events:create", "events:update", "events:delete"]) {
    if (!scopes.includes(scope)) throw new Error(`The test key needs ${scope}.`);
  }

  const day = addDaysIso(30);
  const title = `${RUN} Dentist`;

  // 1. Create
  const create = await api("POST", "/events", {
    body: { calendarId, title, start: `${day}T15:00`, end: `${day}T16:00`, location: "Clinic A", description: "live test", reminders: [{ minutesBefore: 30 }] },
    headers: { "idempotency-key": `${RUN}-create` },
  });
  record("1. create event", create.status === 201 && create.json.done === true, `${create.status} ${create.json?.event?.startLocal ?? JSON.stringify(create.json)}`);
  let event = create.json.event;
  created.add(event.id);

  const replay = await api("POST", "/events", { body: { calendarId, title, start: `${day}T15:00`, end: `${day}T16:00`, location: "Clinic A", description: "live test", reminders: [{ minutesBefore: 30 }] }, headers: { "idempotency-key": `${RUN}-create` } });
  record("1b. idempotent retry does not duplicate", replay.status === 201 && replay.json.event?.id === event.id && replay.headers.get("idempotent-replay") === "true");
  const duplicate = await api("POST", "/events", { body: { calendarId, title, start: `${day}T15:00`, end: `${day}T16:00` } });
  record("1c. identical event refused as duplicate", duplicate.status === 409 && duplicate.json.code === "duplicate_suspected");

  // 2. Read and identify
  const search = await api("GET", "/events", { query: { start: day, end: addDaysIso(31), query: RUN } });
  const found = (search.json.events ?? []).filter((candidate) => candidate.title === title);
  record("2. read and identify by search", found.length === 1 && found[0].id === event.id && Boolean(found[0].etag));
  event = found[0];
  const originalEtag = event.etag;

  // 3-4. Reschedule, duration and properties preserved
  const moved = await api("PATCH", `/events/${calendarId}/${event.id}`, { body: { etag: event.etag, start: `${day}T17:30` } });
  const movedEvent = moved.json.event;
  record("3. change start time", moved.status === 200 && moved.json.done === true && movedEvent?.startLocal?.slice(11, 16) === "17:30", `${moved.status} ${movedEvent?.startLocal}`);
  record("4. duration and properties preserved", movedEvent?.endLocal?.slice(11, 16) === "18:30" && movedEvent.location === "Clinic A" && movedEvent.description === "live test" && movedEvent.reminders?.[0]?.minutesBefore === 30, `${movedEvent?.startLocal} → ${movedEvent?.endLocal}`);
  event = movedEvent;

  // 10a. Concurrency: a stale etag is refused
  const stale = await api("PATCH", `/events/${calendarId}/${event.id}`, { body: { etag: originalEtag, title: "stale write" } });
  record("10a. stale etag refused (concurrent change protection)", stale.status === 412 && stale.json.code === "etag_mismatch");

  // 5. Title and location
  const renamed = await api("PATCH", `/events/${calendarId}/${event.id}`, { body: { etag: event.etag, title: `${title} (check-up)`, location: "Clinic B" } });
  record("5. change title and location", renamed.json.done === true && renamed.json.event.title === `${title} (check-up)` && renamed.json.event.location === "Clinic B" && renamed.json.event.startLocal === event.startLocal);
  event = renamed.json.event;

  // 9. Unauthorized requests
  const noToken = await api("GET", "/calendars", { auth: false });
  const badToken = await api("GET", "/calendars", { auth: false, headers: { authorization: "Bearer not-the-right-token-000000000000000" } });
  record("9a. requests without a valid token refused", noToken.status === 401 && badToken.status === 401);

  // 6. Delete after confirmation
  const unconfirmed = await api("DELETE", `/events/${calendarId}/${event.id}`, { query: { etag: event.etag } });
  const stillThere = await api("GET", `/events/${calendarId}/${event.id}`);
  record("6a. delete without confirmation changes nothing", unconfirmed.status === 428 && unconfirmed.json.done === false && stillThere.status === 200);
  const wrongToken = await api("DELETE", `/events/${calendarId}/${event.id}`, { query: { etag: event.etag }, headers: { "x-confirmation-token": `${unconfirmed.json.confirmation.token.slice(0, -4)}AAAA` } });
  record("6b. tampered confirmation token refused", wrongToken.status === 409 && wrongToken.json.code === "confirmation_invalid");
  const confirmed = await api("DELETE", `/events/${calendarId}/${event.id}`, { query: { etag: event.etag }, headers: { "x-confirmation-token": unconfirmed.json.confirmation.token } });
  record("6c. delete after confirmation", confirmed.status === 200 && confirmed.json.done === true && confirmed.json.verifiedGone === true);
  const reused = await api("DELETE", `/events/${calendarId}/${event.id}`, { query: { etag: event.etag }, headers: { "x-confirmation-token": unconfirmed.json.confirmation.token } });
  record("6d. repeating the confirmed delete does nothing", reused.json?.done === false);

  // 7. Verify gone
  const gone = await api("GET", `/events/${calendarId}/${event.id}`);
  const gone2 = await api("GET", "/events", { query: { start: day, end: addDaysIso(31), query: RUN } });
  record("7. event no longer exists", gone.status === 404 && (gone2.json.events ?? []).length === 0);
  created.delete(event.id);

  // 8. Recurring events and occurrences
  const monday = (() => {
    const date = new Date(Date.now() + 35 * 86_400_000);
    while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  })();
  const series = await api("POST", "/events", { body: { calendarId, title: `${RUN} Standup`, start: `${monday}T09:00`, durationMinutes: 30, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] } });
  created.add(series.json.event?.id);
  const seriesId = series.json.event?.id;
  const window = { start: monday, end: new Date(Date.parse(`${monday}T00:00:00Z`) + 29 * 86_400_000).toISOString().slice(0, 10), query: `${RUN} Standup` };
  let occurrences = (await api("GET", "/events", { query: window })).json.events ?? [];
  record("8a. weekly series lists 4 occurrences", series.status === 201 && occurrences.length === 4 && occurrences.every((occurrence) => occurrence.startLocal.slice(11, 16) === "09:00"));

  const second = occurrences[1];
  const movedOccurrence = await api("PATCH", `/events/${calendarId}/${seriesId}`, { body: { etag: second.etag, recurrenceId: second.recurrenceId, start: `${second.startLocal.slice(0, 10)}T10:00` } });
  occurrences = (await api("GET", "/events", { query: window })).json.events ?? [];
  record("8b. move one occurrence only", movedOccurrence.json.done === true && occurrences.map((occurrence) => occurrence.startLocal.slice(11, 16)).join(",") === "09:00,10:00,09:00,09:00");

  const third = occurrences[2];
  const deletedOccurrence = await confirmAndRun("DELETE", `/events/${calendarId}/${seriesId}`, { query: { etag: third.etag, recurrenceId: third.recurrenceId } });
  occurrences = (await api("GET", "/events", { query: window })).json.events ?? [];
  record("8c. delete one occurrence (confirmed)", deletedOccurrence.first.status === 428 && deletedOccurrence.second.json.done === true && occurrences.length === 3);

  const fourth = occurrences[2];
  const following = await confirmAndRun("PATCH", `/events/${calendarId}/${seriesId}`, { body: { etag: fourth.etag, recurrenceId: fourth.recurrenceId, scope: "this_and_following", title: `${RUN} Standup v2` } });
  if (following.second.json.event?.id) created.add(following.second.json.event.id);
  occurrences = (await api("GET", "/events", { query: { ...window, query: `${RUN} Standup` } })).json.events ?? [];
  record("8d. change this and following (confirmed)", following.first.status === 428 && following.second.json.done === true && occurrences.map((occurrence) => occurrence.title.endsWith("v2")).join(",") === "false,false,true", occurrences.map((occurrence) => `${occurrence.startLocal.slice(5, 16)} ${occurrence.title.replace(RUN, "").trim()}`).join(" | "));

  const master = occurrences.find((occurrence) => occurrence.id === seriesId);
  const wholeSeries = await confirmAndRun("DELETE", `/events/${calendarId}/${seriesId}`, { query: { etag: master.etag } });
  occurrences = (await api("GET", "/events", { query: window })).json.events ?? [];
  record("8e. delete an entire series (confirmed)", wholeSeries.second.json.done === true && occurrences.every((occurrence) => occurrence.id !== seriesId));
  created.delete(seriesId);

  // 10b. Time zones and DST
  const winter = await api("POST", "/events", { body: { calendarId, title: `${RUN} Winter`, start: "2027-01-12T09:00" } });
  const summer = await api("POST", "/events", { body: { calendarId, title: `${RUN} Summer`, start: "2027-07-12T09:00" } });
  const afterChange = await api("POST", "/events", { body: { calendarId, title: `${RUN} After DST`, start: "2027-03-26T03:30" } });
  for (const response of [winter, summer, afterChange]) if (response.json.event?.id) created.add(response.json.event.id);
  record("10b. Asia/Jerusalem winter +02:00, summer +03:00, hour after DST change", winter.json.event?.startLocal === "2027-01-12T09:00:00+02:00" && summer.json.event?.startLocal === "2027-07-12T09:00:00+03:00" && afterChange.json.event?.startLocal === "2027-03-26T03:30:00+03:00",
    [winter, summer, afterChange].map((response) => response.json.event?.startLocal).join(", "));

  // 10c. Conflicts
  const conflictDay = addDaysIso(40);
  const meeting = await api("POST", "/events", { body: { calendarId, title: `${RUN} Meeting A`, start: `${conflictDay}T10:00`, end: `${conflictDay}T11:00` } });
  if (meeting.json.event?.id) created.add(meeting.json.event.id);
  const conflicts = await api("GET", "/conflicts", { query: { start: `${conflictDay}T10:30`, end: `${conflictDay}T11:30`, calendarId } });
  const refused = await api("POST", "/events", { body: { calendarId, title: `${RUN} Meeting B`, start: `${conflictDay}T10:30`, rejectOnConflict: true } });
  record("10c. conflicts detected and can block creation", conflicts.json.free === false && conflicts.json.conflicts?.some((conflict) => conflict.title === `${RUN} Meeting A`) && refused.status === 409);

  // 9b. Expired confirmation token
  const ttl = spec.json.limits?.confirmationSeconds ?? 300;
  const expiring = await api("DELETE", `/events/${calendarId}/${meeting.json.event.id}`, { query: { etag: meeting.json.event.etag } });
  if (SKIP_EXPIRY_WAIT) {
    record("9b. expired confirmation token refused", true, "skipped (--skip-expiry-wait)");
  } else {
    console.log(`      waiting ${ttl + 5}s for a confirmation token to expire…`);
    await new Promise((resolve) => setTimeout(resolve, (ttl + 5) * 1000));
    const late = await api("DELETE", `/events/${calendarId}/${meeting.json.event.id}`, { query: { etag: meeting.json.event.etag }, headers: { "x-confirmation-token": expiring.json.confirmation.token } });
    record("9b. expired confirmation token refused", late.status === 410 && late.json.code === "confirmation_expired");
  }
}

// Searches from yesterday to the end of 2027 in windows the API accepts (at most 366 days each).
async function findRunEvents() {
  const events = [];
  let start = Date.parse(`${addDaysIso(-1)}T00:00:00Z`);
  const end = Date.parse("2028-01-01T00:00:00Z");
  while (start < end) {
    const stop = Math.min(end, start + 360 * 86_400_000);
    const page = await api("GET", "/events", { query: { start: new Date(start).toISOString(), end: new Date(stop).toISOString(), query: RUN, limit: "500" } });
    if (page.status !== 200) throw new Error(`search failed: ${page.status}`);
    events.push(...(page.json.events ?? []));
    start = stop;
  }
  return events;
}

async function cleanup() {
  // Remove everything this run created, using the API's own confirmed delete.
  let remaining = -1;
  try {
    const seen = new Set();
    for (const leftover of await findRunEvents()) {
      if (seen.has(leftover.id)) continue;
      seen.add(leftover.id);
      const fresh = await api("GET", `/events/${calendarId}/${leftover.id}`);
      if (fresh.status !== 200) continue;
      const removal = await confirmAndRun("DELETE", `/events/${calendarId}/${leftover.id}`, { query: { etag: fresh.json.event.etag } });
      if (removal.second.json?.done !== true) console.error(`cleanup could not delete one event: ${removal.second.status} ${removal.second.json?.code ?? ""}`);
    }
    remaining = (await findRunEvents()).length;
  } catch (error) {
    console.error(`cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
  record("cleanup: test events removed", remaining === 0, remaining === 0 ? "" : `check "${TEST_CALENDAR}" for events with "${RUN}" in the title`);
}

try {
  await main();
} catch (error) {
  record("run aborted", false, error instanceof Error ? error.message : String(error));
} finally {
  if (calendarId) await cleanup();
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  process.exit(failed ? 1 : 0);
}
