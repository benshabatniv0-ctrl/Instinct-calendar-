// Verifies the browser console: sign-in with the API key as password, CSRF, session revocation,
// the full confirmation flow through forms, and escaping of event text.

import { env as workerEnv } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { FakeICloud } from "./support/fake-icloud";

const TOKEN = "instinct-browser-token-0123456789abcdef";
const fake = new FakeICloud("owner@example.com", "pw", [{ slug: "claude-test", name: "Claude Test", timeZone: "Asia/Jerusalem" }]);
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
const BASE = "https://instinct-calendar.example.workers.dev";

function makeEnv(keys: Record<string, unknown>) {
  return { ICLOUD_USERNAME: "owner@example.com", ICLOUD_APP_PASSWORD: "pw", CALENDAR_TIME_ZONE: "Asia/Jerusalem", APPROVAL_PASSWORD: "p".repeat(30), API_KEYS: JSON.stringify(keys), RATE_LIMIT_WRITES_PER_MINUTE: "1000", RATE_LIMIT_PER_MINUTE: "1000", GUARD: (workerEnv as unknown as Env).GUARD } as unknown as Env;
}
let env = makeEnv({ instinct: { token: TOKEN, scopes: ["events:read", "events:create", "events:update", "events:delete"] } });

async function send(path: string, init: { method?: string; form?: Record<string, string>; cookie?: string; ip?: string } = {}) {
  const body = init.form ? new URLSearchParams(init.form) : undefined;
  return worker.fetch(new Request(`${BASE}${path}`, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), "cf-connecting-ip": init.ip ?? "192.0.2.1" },
    ...(body ? { body } : {}),
    redirect: "manual",
  }), env, ctx);
}

function sessionFrom(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function csrfOf(cookie: string): Promise<string> {
  const html = await (await send("/app", { cookie })).text();
  return /name="csrf" value="([^"]+)"/.exec(html)![1]!;
}

function responseJson(html: string) {
  const pre = /<pre id="response">([\s\S]*?)<\/pre>/.exec(html)![1]!;
  return JSON.parse(pre.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
}

beforeAll(() => vi.stubGlobal("fetch", fake.fetch));
afterAll(() => vi.unstubAllGlobals());

describe("browser console", () => {
  it("shows a login form that password managers can fill", async () => {
    const html = await (await send("/app/login")).text();
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('type="password"');
    expect((await send("/app")).headers.get("location")).toBe("/app/login");
  });

  it("refuses a wrong password and signs in with the key", async () => {
    expect((await send("/app/login", { form: { username: "token", password: "wrong-password-000000000000" } })).status).toBe(401);
    const ok = await send("/app/login", { form: { username: "token", password: TOKEN } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("set-cookie")).toMatch(/^__Host-calendar-session=.+; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  });

  it("runs the full create, confirm-delete flow through the form, with CSRF and escaping", async () => {
    const cookie = sessionFrom(await send("/app/login", { form: { username: "token", password: TOKEN } }));
    const csrf = await csrfOf(cookie);
    expect((await send("/app/request", { cookie, form: { csrf: "forged", method: "GET", path: "/api/calendars" } })).status).toBe(403);

    const calendars = responseJson(await (await send("/app/request", { cookie, form: { csrf, method: "GET", path: "/api/calendars" } })).text());
    const calendarId = calendars.calendars[0].id;
    const createdHtml = await (await send("/app/request", { cookie, form: { csrf, method: "POST", path: "/api/events", idempotencyKey: "web-1", body: JSON.stringify({ calendarId, title: "<script>alert(1)</script> Lunch", start: "2026-12-15T13:00" }) } })).text();
    expect(createdHtml).not.toContain("<script>alert(1)</script>");
    expect(createdHtml).toContain("HTTP 201");
    const event = responseJson(createdHtml).event;
    expect(event.startLocal).toBe("2026-12-15T13:00:00+02:00");

    const pendingHtml = await (await send("/app/request", { cookie, form: { csrf, method: "DELETE", path: `/api/events/${calendarId}/${event.id}?etag=${encodeURIComponent(event.etag)}` } })).text();
    expect(pendingHtml).toContain("CONFIRMATION REQUIRED");
    const token = responseJson(pendingHtml).confirmation.token;
    expect(fake.objectsIn("claude-test")).toHaveLength(1);
    const doneHtml = await (await send("/app/request", { cookie, form: { csrf, method: "DELETE", path: `/api/events/${calendarId}/${event.id}?etag=${encodeURIComponent(event.etag)}`, confirmationToken: token } })).text();
    expect(responseJson(doneHtml)).toMatchObject({ done: true, verifiedGone: true });
    expect(fake.objectsIn("claude-test")).toHaveLength(0);
  });

  it("rejects paths outside the API and ends sessions when the key is revoked", async () => {
    const cookie = sessionFrom(await send("/app/login", { form: { username: "token", password: TOKEN } }));
    const csrf = await csrfOf(cookie);
    expect(await (await send("/app/request", { cookie, form: { csrf, method: "GET", path: "https://evil.example/x" } })).text()).toContain("Path must start with /api");
    env = makeEnv({ instinct: { token: TOKEN, scopes: ["events:read"], disabled: true } });
    expect((await send("/app/request", { cookie, form: { csrf, method: "GET", path: "/api/calendars" } })).status).toBe(401);
    env = makeEnv({ instinct: { token: TOKEN, scopes: ["events:read", "events:create", "events:update", "events:delete"] } });
  });

  it("accepts a key that contains spaces or arrives with stray whitespace", async () => {
    env = makeEnv({ spaced: { token: "abcd-efgh-ijkl abcd-efgh-ijkl xyz", scopes: ["events:read"] } });
    expect((await send("/app/login", { ip: "192.0.2.50", form: { username: "token", password: "abcd-efgh-ijkl abcd-efgh-ijkl xyz" } })).status).toBe(303);
    expect((await send("/app/login", { ip: "192.0.2.50", form: { username: "token", password: " abcd-efgh-ijkl abcd-efgh-ijkl xyz\n" } })).status).toBe(303);
    env = makeEnv({ instinct: { token: TOKEN, scopes: ["events:read", "events:create", "events:update", "events:delete"] } });
  });

  it("limits password guessing", async () => {
    let status = 0;
    for (let index = 0; index < 11; index += 1) status = (await send("/app/login", { ip: "198.51.100.200", form: { username: "x", password: "nope-nope-nope-nope-nope-nope" } })).status;
    expect(status).toBe(429);
  });
});
