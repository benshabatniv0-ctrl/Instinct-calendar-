// Declares the bindings available to the Worker and its workerd tests.
interface Env {
  OAUTH_KV: KVNamespace;
  REMINDERS_KV?: KVNamespace;
  GUARD?: DurableObjectNamespace<import("./src/guard").Guard>;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  MCP_HOSTNAME?: string;
  CALENDAR_TIME_ZONE: string;
  EXTERNAL_AUTHORIZATION?: string;
  APPROVAL_PASSWORD?: string;
  SHORTCUT_TOKEN?: string;
  // Legacy single bearer token: read, create, and reminders on /api; full scopes on /mcp.
  API_TOKEN?: string;
  // JSON object of named, scoped API keys. See src/access.ts and docs/http-api.md.
  API_KEYS?: string;
  // Names or ids of the calendars any client may reach (comma/newline list or JSON array). Unset = all.
  CALENDAR_ALLOWLIST?: string;
  // Optional dedicated secret for signing confirmation tokens. Derived from the iCloud secret if unset.
  CONFIRMATION_SECRET?: string;
  CONFIRMATION_TTL_SECONDS?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  RATE_LIMIT_WRITES_PER_MINUTE?: string;
  ICLOUD_USERNAME: string;
  ICLOUD_APP_PASSWORD: string;
}
