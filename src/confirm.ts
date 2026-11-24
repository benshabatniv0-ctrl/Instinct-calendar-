// Short-lived, operation-specific confirmation tokens for destructive requests.
//
// A token is an HMAC-signed statement "key K may perform exactly operation F before time T, once".
// F is a SHA-256 fingerprint of the canonical operation (method, target, ETag, scope and changes), so
// a token issued to preview deleting one event cannot delete another, apply a different patch, or
// outlive a newer edit. Single use is enforced by the Guard Durable Object, which records each nonce.

const DEFAULT_TTL_SECONDS = 300;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 900;

export interface ConfirmationClaims {
  v: 1;
  k: string;
  f: string;
  exp: number;
  n: string;
}

export type ConfirmationCheck =
  | { ok: true; claims: ConfirmationClaims }
  | { ok: false; code: "confirmation_invalid" | "confirmation_expired" | "confirmation_mismatch"; message: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("bad encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

// Stable JSON: object keys sorted, undefined dropped, so equal operations hash equally.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export async function fingerprint(operation: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(operation)));
  return base64Url(new Uint8Array(digest));
}

async function signingKey(secretMaterial: string): Promise<CryptoKey> {
  // Derive a dedicated key so the stored secret is never used directly as an HMAC key.
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretMaterial), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("apple-calendar-mcp/confirmation/v1"), info: new Uint8Array() },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export function confirmationTtl(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(value)));
}

export async function issueConfirmation(secretMaterial: string, keyId: string, operationFingerprint: string, ttlSeconds: number, now = Date.now()) {
  const claims: ConfirmationClaims = {
    v: 1,
    k: keyId,
    f: operationFingerprint,
    exp: Math.floor(now / 1000) + ttlSeconds,
    n: base64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secretMaterial), new TextEncoder().encode(payload)));
  return { token: `${payload}.${base64Url(signature)}`, expiresAt: new Date(claims.exp * 1000).toISOString(), expiresInSeconds: ttlSeconds };
}

export async function verifyConfirmation(
  secretMaterial: string,
  token: string,
  keyId: string,
  operationFingerprint: string,
  now = Date.now(),
): Promise<ConfirmationCheck> {
  const invalid = { ok: false as const, code: "confirmation_invalid" as const, message: "The confirmation token is not valid. Request a new one by repeating the request without it." };
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || token.length > 1024) return invalid;
  let claims: ConfirmationClaims;
  try {
    const valid = await crypto.subtle.verify("HMAC", await signingKey(secretMaterial), fromBase64Url(signature), new TextEncoder().encode(payload));
    if (!valid) return invalid;
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as ConfirmationClaims;
  } catch {
    return invalid;
  }
  if (claims.v !== 1 || typeof claims.exp !== "number" || typeof claims.n !== "string") return invalid;
  if (claims.exp * 1000 <= now) {
    return { ok: false, code: "confirmation_expired", message: "The confirmation token has expired. Repeat the request without a token to get a new one, and confirm with the user again." };
  }
  if (claims.k !== keyId || claims.f !== operationFingerprint) {
    return { ok: false, code: "confirmation_mismatch", message: "The confirmation token was issued for a different operation. Repeat the exact request that produced it, or request a new token." };
  }
  return { ok: true, claims };
}
