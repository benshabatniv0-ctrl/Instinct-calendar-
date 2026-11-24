// Scoped API keys and the calendar allowlist.
//
// API_KEYS (a Worker secret) holds a JSON object of named keys:
//   {
//     "instinct": { "token": "<32+ random chars>", "scopes": ["events:read", "events:create", "events:update", "events:delete"] },
//     "tester":   { "sha256": "<hex digest of the token>", "scopes": ["events:read", "events:create", "events:update", "events:delete"],
//                   "calendars": ["Claude Test"], "expiresAt": "2026-12-01T00:00:00Z" }
//   }
// Each key may narrow the calendars it reaches; CALENDAR_ALLOWLIST narrows every client, MCP included.

import { presentedSecret, secretsEqual } from "./authorize";

export const API_SCOPES = [
  "events:read",
  "events:create",
  "events:update",
  "events:delete",
  "reminders:read",
  "reminders:write",
  "audit:read",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiPrincipal {
  keyId: string;
  scopes: ReadonlySet<ApiScope>;
  calendars?: readonly string[] | undefined;
  mcp: boolean;
  legacy: boolean;
}

export interface CalendarAccess {
  description: string;
  allows(calendar: { id: string; name: string }): boolean;
}

const MIN_TOKEN_LENGTH = 24;
const MIN_NEW_TOKEN_LENGTH = 24; // same as the legacy API_TOKEN, so an existing token can be reused as a scoped key
const LEGACY_SCOPES: ApiScope[] = ["events:read", "events:create", "reminders:read", "reminders:write"];
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

interface KeyConfig {
  token?: string;
  sha256?: string;
  scopes: ApiScope[];
  calendars?: string[];
  expiresAt?: string;
  mcp?: boolean;
  disabled?: boolean;
}

export type AccessEnv = Partial<Pick<Env, "API_TOKEN" | "API_KEYS" | "CALENDAR_ALLOWLIST">>;

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error("must be an array of non-empty strings");
  }
  return value.map((entry: string) => entry.trim());
}

// Parses API_KEYS. A malformed configuration disables every key rather than half-applying it.
export function parseApiKeys(raw: string | undefined): Map<string, KeyConfig> {
  const keys = new Map<string, KeyConfig>();
  if (!raw || raw.trim() === "") return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("API_KEYS is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("API_KEYS must be a JSON object of named keys.");
  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID.test(keyId)) throw new Error(`API_KEYS: "${keyId}" is not a valid key name (letters, digits, - and _).`);
    if (!value || typeof value !== "object") throw new Error(`API_KEYS.${keyId} must be an object.`);
    const entry = value as Record<string, unknown>;
    const token = typeof entry.token === "string" ? entry.token : undefined;
    const sha256 = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : undefined;
    if (!token && !sha256) throw new Error(`API_KEYS.${keyId} needs "token" or "sha256".`);
    if (token && token.length < MIN_NEW_TOKEN_LENGTH) throw new Error(`API_KEYS.${keyId}.token must be at least ${MIN_NEW_TOKEN_LENGTH} characters.`);
    if (sha256 && !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`API_KEYS.${keyId}.sha256 must be 64 hex characters.`);
    let scopes: string[];
    let calendars: string[] | undefined;
    try {
      scopes = asStringArray(entry.scopes) ?? [];
      calendars = asStringArray(entry.calendars);
    } catch (error) {
      throw new Error(`API_KEYS.${keyId}: scopes and calendars ${(error as Error).message}.`);
    }
    const unknown = scopes.filter((scope) => !(API_SCOPES as readonly string[]).includes(scope));
    if (unknown.length) throw new Error(`API_KEYS.${keyId} has unknown scopes: ${unknown.join(", ")}.`);
    if (entry.expiresAt !== undefined && (typeof entry.expiresAt !== "string" || !Number.isFinite(Date.parse(entry.expiresAt)))) {
      throw new Error(`API_KEYS.${keyId}.expiresAt must be an ISO timestamp.`);
    }
    keys.set(keyId, {
      ...(token ? { token } : {}),
      ...(sha256 ? { sha256 } : {}),
      scopes: scopes as ApiScope[],
      ...(calendars ? { calendars } : {}),
      ...(typeof entry.expiresAt === "string" ? { expiresAt: entry.expiresAt } : {}),
      mcp: entry.mcp === true,
      disabled: entry.disabled === true,
    });
  }
  return keys;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type AuthResult =
  | { ok: true; principal: ApiPrincipal }
  | { ok: false; reason: "disabled" | "missing" | "invalid" | "expired" | "misconfigured"; message: string };

// Resolves the presented bearer (or Basic password) to a principal. Every configured key is compared
// in constant time, so timing does not reveal which key names exist.
export async function authenticate(request: Request, env: AccessEnv, now = Date.now()): Promise<AuthResult> {
  return authenticateSecret(presentedSecret(request) ?? (request.headers.get("x-api-key")?.trim() || undefined), env, now);
}

// Checks a secret exactly as given (a login form may submit one containing spaces, which an
// Authorization header cannot carry).
export async function authenticateSecret(presentedValue: string | undefined, env: AccessEnv, now = Date.now()): Promise<AuthResult> {
  let keys: Map<string, KeyConfig>;
  try {
    keys = parseApiKeys(env.API_KEYS);
  } catch (error) {
    console.error("api_keys_invalid", { reason: (error as Error).message });
    return { ok: false, reason: "misconfigured", message: "The API key configuration on the Worker is invalid. The owner must fix API_KEYS." };
  }
  const legacy = env.API_TOKEN && env.API_TOKEN.length >= MIN_TOKEN_LENGTH ? env.API_TOKEN : undefined;
  if (keys.size === 0 && !legacy) {
    return { ok: false, reason: "disabled", message: "The HTTP API is disabled. Set API_KEYS (or API_TOKEN) on the Worker to enable it." };
  }
  const presented = presentedValue;
  if (!presented) return { ok: false, reason: "missing", message: "Send Authorization: Bearer <token> (or X-API-Key: <token>)." };

  const presentedHash = await sha256Hex(presented);
  let matched: { keyId: string; config: KeyConfig } | undefined;
  for (const [keyId, config] of keys) {
    const equal = config.token ? await secretsEqual(presented, config.token) : await secretsEqual(presentedHash, config.sha256 ?? "");
    if (equal && !matched) matched = { keyId, config };
  }
  const legacyMatch = legacy ? await secretsEqual(presented, legacy) : false;

  if (matched) {
    if (matched.config.disabled) return { ok: false, reason: "invalid", message: "This API key has been disabled." };
    if (matched.config.expiresAt && Date.parse(matched.config.expiresAt) <= now) {
      return { ok: false, reason: "expired", message: "This API key has expired." };
    }
    return {
      ok: true,
      principal: {
        keyId: matched.keyId,
        scopes: new Set(matched.config.scopes),
        calendars: matched.config.calendars,
        mcp: matched.config.mcp ?? false,
        legacy: false,
      },
    };
  }
  if (legacyMatch) {
    return { ok: true, principal: { keyId: "legacy-api-token", scopes: new Set(LEGACY_SCOPES), mcp: true, legacy: true } };
  }
  return { ok: false, reason: "invalid", message: "The token is not valid." };
}

export function parseAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw || raw.trim() === "" || raw.trim() === "*") return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) return parsed.map((entry) => entry.trim()).filter(Boolean);
    } catch {
      // Fall through to the line format.
    }
    throw new Error("CALENDAR_ALLOWLIST must be a JSON array of strings or a comma/newline-separated list.");
  }
  return trimmed.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

function matcher(entries: readonly string[]): (calendar: { id: string; name: string }) => boolean {
  const ids = new Set(entries);
  const names = new Set(entries.map((entry) => entry.toLocaleLowerCase()));
  return (calendar) => ids.has(calendar.id) || names.has(calendar.name.trim().toLocaleLowerCase());
}

// Combines the global allowlist with a key's own calendar list. Both must allow a calendar.
// A malformed global allowlist denies every calendar.
export function calendarAccess(env: AccessEnv, keyCalendars?: readonly string[]): CalendarAccess | undefined {
  let global: string[] | undefined;
  try {
    global = parseAllowlist(env.CALENDAR_ALLOWLIST);
  } catch (error) {
    console.error("calendar_allowlist_invalid", { reason: (error as Error).message });
    return { description: "CALENDAR_ALLOWLIST is malformed; no calendar is reachable.", allows: () => false };
  }
  const keyList = keyCalendars?.includes("*") ? undefined : keyCalendars;
  if (!global && !keyList) return undefined;
  const checks = [global, keyList].filter((list): list is string[] => Boolean(list)).map(matcher);
  const parts = [global ? `global allowlist (${global.length})` : undefined, keyList ? `key calendars (${keyList.length})` : undefined].filter(Boolean);
  return {
    description: parts.join(" and "),
    allows: (calendar) => checks.every((check) => check(calendar)),
  };
}

export function hasScope(principal: ApiPrincipal, scope: ApiScope): boolean {
  return principal.scopes.has(scope);
}

// Maps an API key to MCP scopes. Write tools need every event write scope, because the MCP write
// grant covers creation, editing and deletion together.
export function mcpScopesFor(principal: ApiPrincipal): string[] {
  const scopes: string[] = [];
  if (principal.scopes.has("events:read")) scopes.push("calendar:read");
  if (principal.legacy || (["events:create", "events:update", "events:delete"] as const).every((scope) => principal.scopes.has(scope))) {
    scopes.push("calendar:write");
  }
  return scopes;
}

// Rebuilds a principal from a key name, for browser sessions. Returns undefined when the key has since
// been removed, disabled or expired, so revoking a key also ends its sessions.
export function principalForKeyId(env: AccessEnv, keyId: string, now = Date.now()): ApiPrincipal | undefined {
  if (keyId === "legacy-api-token") {
    return env.API_TOKEN && env.API_TOKEN.length >= MIN_TOKEN_LENGTH
      ? { keyId, scopes: new Set(LEGACY_SCOPES), mcp: true, legacy: true }
      : undefined;
  }
  let keys: Map<string, KeyConfig>;
  try {
    keys = parseApiKeys(env.API_KEYS);
  } catch {
    return undefined;
  }
  const config = keys.get(keyId);
  if (!config || config.disabled || (config.expiresAt && Date.parse(config.expiresAt) <= now)) return undefined;
  return { keyId, scopes: new Set(config.scopes), calendars: config.calendars, mcp: config.mcp ?? false, legacy: false };
}
