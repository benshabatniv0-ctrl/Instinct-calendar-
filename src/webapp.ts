// Browser console for assistants that can fill a website's login form from their password vault but
// cannot put a secret into an HTTP header (Instinct, for example).
//
//   GET  /app/login    sign-in form: any username, the API key as the password
//   GET  /app          request form (method, path, JSON body, confirmation token, etag, idempotency key)
//   POST /app/request  runs the request through the same HTTP API, as the signed-in key, and shows the result
//   POST /app/logout   ends the session
//
// The session is a signed, HttpOnly, SameSite=Strict __Host- cookie that names the key and expires after
// 12 hours. Each request re-checks that the key still exists, so removing or disabling the key in
// API_KEYS ends its sessions at once. Every form carries a CSRF token bound to the session. All API rules
// (scopes, calendar allowlist, confirmations, ETags, rate limits, audit) apply unchanged, because each
// request goes through handleApi.

import { authenticateSecret, principalForKeyId, type ApiPrincipal } from "./access";
import { handleApi, type ApiEnv } from "./api";
import { secretsEqual } from "./authorize";
import { clientRef, guardFor } from "./guard";

const COOKIE = "__Host-calendar-session";
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_BODY_CHARS = 100_000;
const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

interface Session {
  k: string;
  exp: number;
  c: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sessionKey(env: ApiEnv): Promise<CryptoKey> {
  const material = env.CONFIRMATION_SECRET && env.CONFIRMATION_SECRET.length >= 32 ? env.CONFIRMATION_SECRET : `derived:${env.ICLOUD_USERNAME}:${env.ICLOUD_APP_PASSWORD}`;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(material), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("apple-calendar-mcp/web-session/v1"), info: new Uint8Array() },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

async function encodeSession(env: ApiEnv, session: Session): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(session)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(env), new TextEncoder().encode(payload)));
  return `${payload}.${base64Url(signature)}`;
}

async function readSession(request: Request, env: ApiEnv): Promise<{ session: Session; principal: ApiPrincipal } | undefined> {
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie.split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value) return undefined;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined || value.length > 2048) return undefined;
  try {
    const valid = await crypto.subtle.verify("HMAC", await sessionKey(env), fromBase64Url(signature), new TextEncoder().encode(payload));
    if (!valid) return undefined;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Session;
    if (typeof session.k !== "string" || typeof session.c !== "string" || typeof session.exp !== "number") return undefined;
    if (session.exp * 1000 <= Date.now()) return undefined;
    const principal = principalForKeyId(env, session.k);
    return principal ? { session, principal } : undefined;
  } catch {
    return undefined;
  }
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const styles = `body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#222}label{display:block;margin-top:.9rem;font-weight:600}input,select,textarea{width:100%;box-sizing:border-box;font:inherit;padding:.5rem;margin-top:.25rem;border:1px solid #999;border-radius:6px}textarea{font-family:ui-monospace,Menlo,monospace;font-size:14px}button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;border-radius:6px;border:1px solid #333;background:#222;color:#fff}pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f4;padding:.8rem;border-radius:6px;font-size:14px}.status{font-size:1.1rem;font-weight:700}.ok{color:#11632b}.bad{color:#9b1c1c}.hint{color:#555;font-size:14px}`;

function page(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title><style>${styles}</style></head><body>${body}</body></html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function loginPage(message?: string, status = 200): Response {
  return page("Calendar bridge — sign in", `<h1>Calendar bridge</h1><p>Sign in with the saved login for this site. The username can be anything; the password is the API key.</p>${message ? `<p class="status bad" role="alert">${escape(message)}</p>` : ""}<form method="post" action="/app/login"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required value="token"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit" id="sign-in">Sign in</button></form>`, status);
}

interface ConsoleState {
  method?: string;
  path?: string;
  body?: string;
  confirmationToken?: string;
  etag?: string;
  idempotencyKey?: string;
  result?: { status: number; text: string; done?: boolean };
}

function consolePage(session: Session, principal: ApiPrincipal, state: ConsoleState = {}): Response {
  const method = state.method ?? "GET";
  const options = METHODS.map((name) => `<option value="${name}"${name === method ? " selected" : ""}>${name}</option>`).join("");
  let result = "";
  if (state.result) {
    let pretty = state.result.text;
    try {
      pretty = JSON.stringify(JSON.parse(state.result.text), null, 2);
    } catch {
      // Not JSON: show as text.
    }
    const outcome = state.result.done === true ? "done: true — the change or read succeeded" : state.result.status === 428 ? "done: false — CONFIRMATION REQUIRED, nothing changed yet" : "done: false — nothing was changed";
    result = `<h2 id="result">Result</h2><p class="status ${state.result.done ? "ok" : "bad"}" id="status">HTTP ${state.result.status} · ${escape(outcome)}</p><pre id="response">${escape(pretty)}</pre>`;
  }
  return page("Calendar bridge — request", `${result}<h1>Calendar bridge</h1><p class="hint">Signed in as key <b>${escape(principal.keyId)}</b>. Every request below goes through the HTTP API with the same rules: GET /api is the full reference. Only <b>done: true</b> means something happened.</p>
<form method="post" action="/app/request">
<input type="hidden" name="csrf" value="${escape(session.c)}">
<label for="method">Method</label><select id="method" name="method">${options}</select>
<label for="path">Path (with query string)</label><input id="path" name="path" required value="${escape(state.path ?? "/api")}" placeholder="/api/events?start=2026-12-01&amp;end=2026-12-02">
<label for="body">JSON body (POST and PATCH)</label><textarea id="body" name="body" rows="8" placeholder='{"calendarId":"…","title":"…","start":"2026-12-01T15:00"}'>${escape(state.body ?? "")}</textarea>
<label for="confirmationToken">Confirmation token (only after the user said yes to a 428 summary)</label><input id="confirmationToken" name="confirmationToken" value="">
<label for="etag">If-Match etag (optional; may also go in the body or query)</label><input id="etag" name="etag" value="${escape(state.etag ?? "")}">
<label for="idempotencyKey">Idempotency-Key (new events: a unique value per request)</label><input id="idempotencyKey" name="idempotencyKey" value="${escape(state.idempotencyKey ?? "")}">
<button type="submit" id="send">Send request</button>
</form>
<form method="post" action="/app/logout"><input type="hidden" name="csrf" value="${escape(session.c)}"><button type="submit">Sign out</button></form>`);
}

function redirect(location: string, cookie?: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) } });
}

async function formOf(request: Request): Promise<FormData | undefined> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_CHARS * 2) return undefined;
  try {
    return await request.formData();
  } catch {
    return undefined;
  }
}

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function isWebAppRoute(url: URL): boolean {
  return url.pathname === "/app" || url.pathname.startsWith("/app/");
}

export async function handleWebApp(request: Request, env: ApiEnv, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/app";
  if (url.protocol !== "https:" && url.hostname !== "localhost") return new Response("HTTPS required", { status: 400 });

  if (path === "/app/login" && request.method === "GET") return loginPage();

  if (path === "/app/login" && request.method === "POST") {
    const guard = guardFor(env);
    if (guard) {
      const limited = await guard.checkRate([{ key: `weblogin:${await clientRef(request)}`, limit: 10, windowSeconds: 600 }]);
      if (!limited.ok) return loginPage("Too many sign-in attempts. Wait a few minutes.", 429);
    }
    const form = await formOf(request);
    const raw = form?.get("password");
    const password = typeof raw === "string" ? raw : "";
    if (!password.trim()) return loginPage("Enter the password.", 400);
    // Accept the value exactly as typed, and also without surrounding whitespace that autofill or a
    // copy-paste can add.
    let auth = await authenticateSecret(password, env);
    if (!auth.ok && password.trim() !== password) auth = await authenticateSecret(password.trim(), env);
    console.info("web_login_attempt", { ok: auth.ok, reason: auth.ok ? undefined : auth.reason, usernameFilled: Boolean(form && field(form, "username")) });
    if (!auth.ok) return loginPage(auth.reason === "disabled" || auth.reason === "misconfigured" ? auth.message : "That password is not valid.", 401);
    const session: Session = { k: auth.principal.keyId, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, c: base64Url(crypto.getRandomValues(new Uint8Array(18))) };
    const cookie = `${COOKIE}=${await encodeSession(env, session)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
    console.info("web_login", { keyId: auth.principal.keyId });
    return redirect("/app", cookie);
  }

  const signedIn = await readSession(request, env);
  if (!signedIn) return request.method === "GET" ? redirect("/app/login") : loginPage("Your session ended. Sign in again.", 401);

  if (path === "/app" && request.method === "GET") return consolePage(signedIn.session, signedIn.principal);

  if (request.method !== "POST" || (path !== "/app/request" && path !== "/app/logout")) return new Response("Not found", { status: 404 });
  const form = await formOf(request);
  if (!form || !(await secretsEqual(field(form, "csrf"), signedIn.session.c))) return page("Calendar bridge", "<p>That form expired. Go back to <a href=\"/app\">/app</a> and try again.</p>", 403);

  if (path === "/app/logout") return redirect("/app/login", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);

  const state: ConsoleState = {
    method: field(form, "method").toUpperCase(),
    path: field(form, "path"),
    body: (form.get("body") as string | null) ?? "",
    confirmationToken: field(form, "confirmationToken"),
    etag: field(form, "etag"),
    idempotencyKey: field(form, "idempotencyKey"),
  };
  if (!(METHODS as readonly string[]).includes(state.method!)) state.result = { status: 400, text: JSON.stringify({ done: false, error: "Method must be GET, POST, PATCH or DELETE." }) };
  else if (!/^\/api(?:[/?]|$)/.test(state.path!) || state.path!.length > 4096 || /[\s\\]/.test(state.path!)) state.result = { status: 400, text: JSON.stringify({ done: false, error: "Path must start with /api and contain no spaces." }) };
  else if ((state.body ?? "").length > MAX_BODY_CHARS) state.result = { status: 413, text: JSON.stringify({ done: false, error: "Body too large." }) };
  else {
    const target = new URL(state.path!, url.origin);
    const headers: Record<string, string> = { "cf-connecting-ip": request.headers.get("cf-connecting-ip") ?? "" };
    const sendsBody = (state.method === "POST" || state.method === "PATCH") && state.body!.trim() !== "";
    if (sendsBody) headers["content-type"] = "application/json";
    if (state.confirmationToken) headers["x-confirmation-token"] = state.confirmationToken;
    if (state.etag) headers["if-match"] = state.etag;
    if (state.idempotencyKey) headers["idempotency-key"] = state.idempotencyKey;
    const apiRequest = new Request(target, { method: state.method!, headers, ...(sendsBody ? { body: state.body } : {}) });
    const response = await handleApi(apiRequest, env, ctx, signedIn.principal);
    const text = await response.text();
    let done: boolean | undefined;
    try {
      done = (JSON.parse(text) as { done?: boolean }).done;
    } catch {
      done = undefined;
    }
    state.result = { status: response.status, text, ...(done !== undefined ? { done } : {}) };
  }
  return consolePage(signedIn.session, signedIn.principal, state);
}
