// Composes Cloudflare OAuth with the stateless Apple Calendar MCP endpoint.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { defaultHandler } from "./authorize";
import { createCalendarMcpHandler } from "./mcp";
import { handleApi, isApiRoute } from "./api";
import { handleWebApp, isWebAppRoute } from "./webapp";
import { authenticate, calendarAccess, mcpScopesFor } from "./access";
import { clientRef, guardFor, withDurableKv } from "./guard";
import { handleShortcut, isShortcutRoute } from "./shortcut";
import { installChatGptMetadataFallback } from "./cimd";
import { publicError } from "./security";

interface AuthProps {
  userId: string;
  scopes: string[];
}

class McpApiHandler extends WorkerEntrypoint<Env, AuthProps> {
  fetch(request: Request): Promise<Response> {
    if (!this.ctx.props.scopes.includes("calendar:read")) {
      return Promise.resolve(new Response("Insufficient scope", { status: 403 }));
    }
    // OAuth clients are bound by the global CALENDAR_ALLOWLIST.
    const env = withDurableKv(this.env);
    return createCalendarMcpHandler(env, this.ctx.props.scopes, calendarAccess(env))(request, env, this.ctx);
  }
}

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: McpApiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["calendar:read", "calendar:write"],
  resourceMetadata: {
    scopes_supported: ["calendar:read", "calendar:write"],
    resource_name: "Apple Calendar",
  },
  // ChatGPT insists on CIMD even when it is not advertised, so it stays on. chatgpt.com refuses the
  // Worker's fetch of its metadata document, which src/cimd.ts works around with a pinned fallback.
  clientIdMetadataDocumentEnabled: true,
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  tokenExchangeCallback: ({ clientId, grantType }) => {
    const clientKind = URL.canParse(clientId) ? new URL(clientId).hostname : "dynamically-registered";
    console.info("oauth_token_exchange", { clientKind, grantType });
  },
  onError: ({ code, internal, status }) => {
    console.warn("oauth_provider_error", { code, internalCategory: internal?.category, status });
  },
});

// The iPhone Shortcut endpoint and the plain HTTP API authenticate with their own bearer secrets and never reach OAuth.

// Clients that cannot complete OAuth may present a key on /mcp instead, as a bearer token or as the
// password of a Basic login with any username: the legacy API_TOKEN (full MCP scopes, as before) or an
// API_KEYS entry with "mcp": true (its scopes and calendars). Anything else falls through to OAuth.
async function mcpKeyHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  const auth = await authenticate(request, env);
  if (!auth.ok || !auth.principal.mcp) return undefined;
  const scopes = mcpScopesFor(auth.principal);
  if (!scopes.includes("calendar:read")) return new Response("Insufficient scope", { status: 403 });
  return createCalendarMcpHandler(env, scopes, calendarAccess(env, auth.principal.calendars))(request, env, ctx);
}

// The approval password is human-chosen, so password attempts on /authorize are rate limited per address.
async function approvalRateLimited(request: Request, env: Env): Promise<Response | undefined> {
  const guard = guardFor(env);
  if (!guard) return undefined;
  const client = await clientRef(request);
  const result = await guard.checkRate([
    { key: `approval:${client}`, limit: 10, windowSeconds: 600 },
    { key: "approval:all", limit: 60, windowSeconds: 3600 },
  ]);
  if (result.ok) return undefined;
  return new Response("Too many approval attempts. Try again later.", { status: 429, headers: { "retry-after": String(result.retryAfterSeconds ?? 600), "cache-control": "no-store" } });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (isShortcutRoute(url)) return handleShortcut(request, env);
  if (isApiRoute(url)) return handleApi(request, env, ctx);
  if (isWebAppRoute(url)) return handleWebApp(request, env, ctx);
  if (url.pathname === "/mcp" && request.headers.has("authorization")) {
    const handled = await mcpKeyHandler(request, env, ctx);
    if (handled) return handled;
  }
  if (url.pathname === "/authorize" && request.method === "POST") {
    const limited = await approvalRateLimited(request, env);
    if (limited) return limited;
  }
  return oauthProvider.fetch(request, env, ctx);
}

export { Guard } from "./guard";

export default {
  async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
    installChatGptMetadataFallback();
    const env = withDurableKv(rawEnv);
    try {
      return await route(request, env, ctx);
    } catch (error) {
      // Never surface Cloudflare's generic 1101 page: log the reason by path and return a readable error.
      const reason = publicError(error);
      console.error("unhandled_exception", { path: new URL(request.url).pathname, method: request.method, reason });
      return Response.json({ error: "The calendar bridge hit an unexpected error.", reason }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  },
} satisfies ExportedHandler<Env>;
