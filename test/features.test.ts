// Unit tests for the integration's building blocks: local-time resolution, API keys and the calendar
// allowlist, confirmation tokens, the Guard Durable Object, recurrence edits, and MCP enforcement.

import { env as workerEnv } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import ICAL from "ical.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticate, calendarAccess, mcpScopesFor, parseAllowlist, parseApiKeys } from "../src/access";
import { canonicalJson, fingerprint, issueConfirmation, verifyConfirmation } from "../src/confirm";
import { guardFor } from "../src/guard";
import { buildEventCalendar, excludeOccurrence, patchEventCalendar, splitSeries, truncateSeries } from "../src/ical";
import { createCalendarServer } from "../src/mcp";
import { formatInZone, localToEpoch, normalizeTimeInput, zoneNow } from "../src/time";
import worker from "../src/worker";
import { FakeICloud } from "./support/fake-icloud";

const Z = "Asia/Jerusalem";

describe("local time resolution in Asia/Jerusalem", () => {
  it("uses +02:00 in winter and +03:00 in summer", () => {
    expect(normalizeTimeInput("2026-12-01T09:00", Z)).toBe("2026-12-01T09:00:00+02:00");
    expect(normalizeTimeInput("2027-07-01T09:00", Z)).toBe("2027-07-01T09:00:00+03:00");
  });

  it("moves a time in the spring-forward gap past the gap", () => {
    // 2026: clocks go from 02:00 to 03:00 on Friday 27 March.
    expect(formatInZone(localToEpoch("2026-03-27T02:30", Z), Z)).toBe("2026-03-27T03:30:00+03:00");
    expect(formatInZone(localToEpoch("2026-03-27T03:30", Z), Z)).toBe("2026-03-27T03:30:00+03:00");
  });

  it("takes the first occurrence of an ambiguous fall-back time", () => {
    // 2026: clocks go from 02:00 back to 01:00 on Sunday 25 October.
    expect(new Date(localToEpoch("2026-10-25T01:30", Z)).toISOString()).toBe("2026-10-24T22:30:00.000Z");
  });

  it("passes explicit offsets and dates through and rejects garbage", () => {
    expect(normalizeTimeInput("2026-12-01T09:00:00Z", Z)).toBe("2026-12-01T09:00:00Z");
    expect(normalizeTimeInput("2026-12-01", Z)).toBe("2026-12-01");
    expect(() => normalizeTimeInput("tomorrow at 3", Z)).toThrow(/not a supported time/);
    expect(() => normalizeTimeInput("2026-02-30T10:00", Z)).toThrow(/not a valid/);
  });

  it("describes now, including daylight saving status", () => {
    expect(zoneNow(Z, Date.parse("2026-07-01T09:00:00Z"))).toMatchObject({ now: "2026-07-01T12:00:00+03:00", daylightSavingTime: true, tomorrow: "2026-07-02", weekday: "Wednesday" });
    expect(zoneNow(Z, Date.parse("2026-11-24T10:00:00Z"))).toMatchObject({ utcOffset: "+02:00", daylightSavingTime: false });
  });

  it("writes the correct wall-clock time in the hour after a DST change", () => {
    // ical.js alone would write 02:30 here; the event is at 03:30 local (00:30Z).
    const built = buildEventCalendar({ title: "Early", start: "2027-03-26T00:30:00Z", end: "2027-03-26T01:30:00Z" }, "o@example.com", { defaultTimeZone: Z });
    expect(built.data).toContain("DTSTART;TZID=Asia/Jerusalem:20270326T033000");
    const autumn = buildEventCalendar({ title: "Late", start: "2027-10-31T00:30:00Z", end: "2027-10-31T01:00:00Z" }, "o@example.com", { defaultTimeZone: Z });
    expect(autumn.data).toContain("DTSTART;TZID=Asia/Jerusalem:20271031T023000");
  });
});

describe("API keys", () => {
  const token = "k".repeat(40);
  const request = (secret?: string) => new Request("https://x.example/api", { headers: secret ? { authorization: `Bearer ${secret}` } : {} });

  it("validates the configuration strictly", () => {
    expect(() => parseApiKeys("{nope")).toThrow(/JSON/);
    expect(() => parseApiKeys(JSON.stringify({ a: { token: "short", scopes: [] } }))).toThrow(/24/);
    expect(() => parseApiKeys(JSON.stringify({ a: { token, scopes: ["events:everything"] } }))).toThrow(/unknown scopes/);
    expect(() => parseApiKeys(JSON.stringify({ "bad name!": { token, scopes: [] } }))).toThrow(/key name/);
    expect(parseApiKeys(JSON.stringify({ a: { token, scopes: ["events:read"] } })).get("a")?.scopes).toEqual(["events:read"]);
  });

  it("accepts sha256-stored keys, refuses disabled, expired and malformed setups", async () => {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const hashed = await authenticate(request(token), { API_KEYS: JSON.stringify({ hashed: { sha256: digest, scopes: ["events:read"] } }) });
    expect(hashed).toMatchObject({ ok: true, principal: { keyId: "hashed" } });
    expect(await authenticate(request(token), { API_KEYS: JSON.stringify({ off: { token, scopes: [], disabled: true } }) })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await authenticate(request(token), { API_KEYS: JSON.stringify({ old: { token, scopes: [], expiresAt: "2020-01-01T00:00:00Z" } }) })).toMatchObject({ ok: false, reason: "expired" });
    expect(await authenticate(request(token), { API_KEYS: "{broken" })).toMatchObject({ ok: false, reason: "misconfigured" });
    expect(await authenticate(request(), { API_KEYS: JSON.stringify({ a: { token, scopes: [] } }) })).toMatchObject({ ok: false, reason: "missing" });
  });

  it("maps keys to MCP scopes without widening them", () => {
    const principal = (scopes: string[]) => ({ keyId: "k", scopes: new Set(scopes), mcp: true, legacy: false }) as Parameters<typeof mcpScopesFor>[0];
    expect(mcpScopesFor(principal(["events:read"]))).toEqual(["calendar:read"]);
    expect(mcpScopesFor(principal(["events:read", "events:create"]))).toEqual(["calendar:read"]);
    expect(mcpScopesFor(principal(["events:read", "events:create", "events:update", "events:delete"]))).toEqual(["calendar:read", "calendar:write"]);
  });
});

describe("calendar allowlist", () => {
  it("parses lists and matches by name or id; both lists must allow", () => {
    expect(parseAllowlist("Work, Family\nClaude Test")).toEqual(["Work", "Family", "Claude Test"]);
    expect(parseAllowlist('["A","B"]')).toEqual(["A", "B"]);
    expect(parseAllowlist("*")).toBeUndefined();
    const access = calendarAccess({ CALENDAR_ALLOWLIST: "Work, Family" }, ["family"])!;
    expect(access.allows({ id: "x", name: "Family" })).toBe(true);
    expect(access.allows({ id: "x", name: "Work" })).toBe(false);
    expect(calendarAccess({})).toBeUndefined();
  });

  it("fails closed when the allowlist is malformed", () => {
    const access = calendarAccess({ CALENDAR_ALLOWLIST: "[not json" })!;
    expect(access.allows({ id: "x", name: "Anything" })).toBe(false);
  });
});

describe("confirmation tokens", () => {
  const secret = "s".repeat(40);

  it("binds a token to one key and one operation and expires it", async () => {
    const operation = await fingerprint({ op: "delete", eventId: "e1", etag: "\"1\"" });
    const issued = await issueConfirmation(secret, "instinct", operation, 300);
    expect(await verifyConfirmation(secret, issued.token, "instinct", operation)).toMatchObject({ ok: true });
    expect(await verifyConfirmation(secret, issued.token, "other", operation)).toMatchObject({ ok: false, code: "confirmation_mismatch" });
    expect(await verifyConfirmation(secret, issued.token, "instinct", await fingerprint({ op: "delete", eventId: "e2", etag: "\"1\"" }))).toMatchObject({ code: "confirmation_mismatch" });
    expect(await verifyConfirmation(secret, issued.token, "instinct", operation, Date.now() + 301_000)).toMatchObject({ code: "confirmation_expired" });
    expect(await verifyConfirmation("t".repeat(40), issued.token, "instinct", operation)).toMatchObject({ code: "confirmation_invalid" });
    const [payload, signature] = issued.token.split(".");
    const forged = `${btoa(JSON.stringify({ v: 1, k: "instinct", f: operation, exp: 9_999_999_999, n: "x" })).replace(/=+$/, "")}.${signature}`;
    expect(await verifyConfirmation(secret, forged, "instinct", operation)).toMatchObject({ code: "confirmation_invalid" });
    expect(payload).toBeTruthy();
  });

  it("fingerprints are independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, undefined] } })).toBe('{"a":{"c":[1,null],"d":2},"b":1}');
  });
});

describe("Guard Durable Object", () => {
  const guard = guardFor(workerEnv as unknown as Env)!;

  it("accepts each nonce once", async () => {
    const nonce = crypto.randomUUID();
    const expires = Math.floor(Date.now() / 1000) + 300;
    expect(await guard.consumeNonce(nonce, expires)).toBe(true);
    expect(await guard.consumeNonce(nonce, expires)).toBe(false);
  });

  it("enforces fixed-window rate limits", async () => {
    const rule = { key: `test:${crypto.randomUUID()}`, limit: 3, windowSeconds: 60 };
    const results = [];
    for (let index = 0; index < 4; index += 1) results.push((await guard.checkRate([rule])).ok);
    expect(results).toEqual([true, true, true, false]);
  });

  it("tracks idempotency state", async () => {
    const key = `idem:${crypto.randomUUID()}`;
    expect(await guard.idempotencyBegin(key, "h1", 60)).toEqual({ state: "new" });
    expect(await guard.idempotencyBegin(key, "h1", 60)).toEqual({ state: "pending" });
    expect(await guard.idempotencyBegin(key, "h2", 60)).toEqual({ state: "mismatch" });
    await guard.idempotencyFinish(key, 201, "{}");
    expect(await guard.idempotencyBegin(key, "h1", 60)).toEqual({ state: "done", status: 201, body: "{}" });
  });
});

describe("recurring series edits", () => {
  const series = buildEventCalendar({ title: "Class", start: "2026-11-02T09:00:00+02:00", end: "2026-11-02T10:00:00+02:00", recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"] }, "o@example.com", { defaultTimeZone: Z, uid: "class" }).data;
  const third = "2026-11-16T07:00:00.000Z";

  it("excludes one occurrence with a zoned EXDATE", () => {
    const result = excludeOccurrence(series, third);
    expect(result).toContain("EXDATE;TZID=Asia/Jerusalem:20261116T090000");
    expect(() => excludeOccurrence(series, "2026-11-17T07:00:00.000Z")).toThrow(/not found/);
  });

  it("ends a series before an occurrence, converting COUNT to UNTIL", () => {
    const result = truncateSeries(series, third)!;
    expect(result).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=20261116T065959Z/);
    expect(result).not.toMatch(/COUNT=/);
    expect(truncateSeries(series, "2026-11-02T07:00:00.000Z")).toBeUndefined();
  });

  it("splits a series and carries the remaining count to the new one", () => {
    const split = splitSeries(series, third, { title: "Class (new room)" }, "o@example.com", new Date(), { defaultTimeZone: Z, uid: "class-2" });
    expect(split.created).toBeDefined();
    const created = ICAL.Component.fromString(split.created!.data).getFirstSubcomponent("vevent")!;
    expect(created.getFirstPropertyValue("uid")).toBe("class-2");
    expect(String(created.getFirstPropertyValue("summary"))).toBe("Class (new room)");
    expect(created.getFirstProperty("rrule")!.toICALString()).toBe("RRULE:FREQ=WEEKLY;COUNT=3");
    expect(split.created!.data).toContain("DTSTART;TZID=Asia/Jerusalem:20261116T090000");
  });

  it("keeps a moved occurrence's time when only its title changes", () => {
    const moved = patchEventCalendar(series, { start: "2026-11-09T11:00:00+02:00", end: "2026-11-09T12:00:00+02:00" }, "o@example.com", new Date(), "this_instance", "2026-11-09T07:00:00.000Z", { defaultTimeZone: Z });
    const retitled = patchEventCalendar(moved, { title: "Renamed" }, "o@example.com", new Date(), "this_instance", "2026-11-09T07:00:00.000Z", { defaultTimeZone: Z });
    const override = ICAL.Component.fromString(retitled).getAllSubcomponents("vevent").find((component) => component.hasProperty("recurrence-id"))!;
    expect(override.getFirstProperty("dtstart")!.toICALString()).toBe("DTSTART;TZID=Asia/Jerusalem:20261109T110000");
    expect(String(override.getFirstPropertyValue("summary"))).toBe("Renamed");
  });
});

describe("MCP enforcement of the calendar allowlist", () => {
  const fake = new FakeICloud("owner@example.com", "pw", [
    { slug: "home", name: "Home", timeZone: Z },
    { slug: "claude-test", name: "Claude Test", timeZone: Z },
  ]);
  beforeAll(() => vi.stubGlobal("fetch", fake.fetch));
  afterAll(() => vi.unstubAllGlobals());

  async function callTool(allowlist: string | undefined, name: string, args: Record<string, unknown>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCalendarServer({ ICLOUD_USERNAME: "owner@example.com", ICLOUD_APP_PASSWORD: "pw", CALENDAR_TIME_ZONE: Z, ...(allowlist ? { CALENDAR_ALLOWLIST: allowlist } : {}) }, ["calendar:read", "calendar:write"]);
    const client = new Client({ name: "allowlist-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("hides calendars outside CALENDAR_ALLOWLIST and refuses writes to them", async () => {
    const all = await callTool(undefined, "calendar_list_calendars", {});
    expect((all.structuredContent as { calendars: unknown[] }).calendars).toHaveLength(2);
    const limited = await callTool("Claude Test", "calendar_list_calendars", {});
    const calendars = (limited.structuredContent as { calendars: Array<{ name: string }> }).calendars;
    expect(calendars.map((calendar) => calendar.name)).toEqual(["Claude Test"]);
    const homeId = btoa(fake.calendarUrl("home")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const write = await callTool("Claude Test", "calendar_create_event", { calendarId: homeId, title: "Nope", start: "2026-12-01T10:00:00+02:00", end: "2026-12-01T11:00:00+02:00" });
    expect(write.isError).toBe(true);
    expect(fake.objectsIn("home")).toHaveLength(0);
  });
});

describe("worker routing for API keys on /mcp", () => {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const token = "m".repeat(40);
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const mcpRequest = () => new Request("https://calendar.example.workers.dev/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", host: "calendar.example.workers.dev", origin: "https://calendar.example.workers.dev" },
    body: initialize,
  });
  const baseEnv = { ICLOUD_USERNAME: "o@example.com", ICLOUD_APP_PASSWORD: "pw", CALENDAR_TIME_ZONE: Z, APPROVAL_PASSWORD: "p".repeat(30), OAUTH_KV: (workerEnv as unknown as Env).OAUTH_KV, GUARD: (workerEnv as unknown as Env).GUARD };

  it("serves MCP to keys that opt in and leaves others to OAuth", async () => {
    const optedIn = { ...baseEnv, API_KEYS: JSON.stringify({ hark: { token, scopes: ["events:read"], mcp: true } }) } as unknown as Env;
    expect((await worker.fetch(mcpRequest(), optedIn, ctx)).status).toBe(200);
    const notOptedIn = { ...baseEnv, API_KEYS: JSON.stringify({ instinct: { token, scopes: ["events:read"] } }) } as unknown as Env;
    expect((await worker.fetch(mcpRequest(), notOptedIn, ctx)).status).toBe(401);
  });

  it("rate limits approval password attempts", async () => {
    const env = baseEnv as unknown as Env;
    let status = 0;
    for (let index = 0; index < 11; index += 1) {
      status = (await worker.fetch(new Request("https://calendar.example.workers.dev/authorize?x=1", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" }, body: new FormData() }), env, ctx)).status;
    }
    expect(status).toBe(429);
  });
});
