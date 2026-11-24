# Operations: deploy, configure, test, maintain

## How it fits together

```
Instinct (iMessage / WhatsApp) ──HTTPS + scoped key──▶  Cloudflare Worker  ──CalDAV + app-specific password──▶  iCloud Calendar
Claude, ChatGPT, … ─────────────MCP + OAuth─────────▶   (free plan)        ──▶ Guard Durable Object: rate limits, confirmations,
                                                                                  idempotency, audit log (SQLite)
```

Everything runs in Cloudflare, so no personal computer has to stay on. The Worker stores no calendar data: every request reads from and writes to iCloud directly.

## Deploy

### If the fork is already deployed through Cloudflare's GitHub integration

1. Review and merge the pull request into the branch Cloudflare builds from (usually `main`).
2. Cloudflare builds and deploys automatically. The first deploy also creates the `Guard` Durable Object (migration `v1-guard`). It runs on the free plan.
3. Check the build in **Workers & Pages → apple-calendar-mcp → Deployments**.

### Fresh deployment

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → choose your fork → keep the defaults → **Deploy**.
2. The first deploy succeeds without secrets. The Worker stays locked until you add them (next section): approvals are refused, the API is disabled, and nothing reaches iCloud.
   The Worker uses no KV namespaces (state lives in the `Guard` Durable Object), so there is nothing for the build to provision or collide with.
3. Turn **off** "Protect with Cloudflare Access" for the Worker.

### From a terminal (optional)

```bash
bun install
bun run test && bun run typecheck && bun run cloudflare:check
bunx wrangler login          # opens a browser; no token is pasted anywhere
bun run deploy
```

## Configure

Open **Workers & Pages → apple-calendar-mcp → Settings → Variables and Secrets**. Add each value as a **Secret** and choose **Deploy**. You can do this from a phone.

| Name | Required | Value |
|---|---|---|
| `ICLOUD_USERNAME` | yes | Your Apple Account email. |
| `ICLOUD_APP_PASSWORD` | yes | An **app-specific password** from account.apple.com → Sign-In and Security → App-Specific Passwords. Never your main Apple password. |
| `APPROVAL_PASSWORD` | yes | Protects MCP client approvals. Not an Apple password. |
| `API_KEYS` | for the HTTP API | JSON of named, scoped keys. See [http-api.md](http-api.md#authentication-and-permissions). |
| `CALENDAR_ALLOWLIST` | recommended | Calendars any client may use, for example `Personal, Family, Work`. Applies to MCP too. Unset means all. |
| `CONFIRMATION_SECRET` | optional | 32+ random characters for signing confirmation tokens. If unset, a key is derived from the iCloud secret. |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_WRITES_PER_MINUTE` | optional | Defaults 120 and 30 per key. |
| `CONFIRMATION_TTL_SECONDS` | optional | Default 300 (30 to 900). |

`CALENDAR_TIME_ZONE` is set to `Asia/Jerusalem` in `wrangler.jsonc`, so it is version-controlled and survives redeploys. Calendars that publish their own zone use that zone.

Secrets in Cloudflare are write-only: you cannot read them back. Keep a copy of your `API_KEYS` JSON in your password manager.

## Test safely

1. In the Calendar app, create a new **iCloud** calendar named `Claude Test`. Leave it empty and unshared.
2. Add a test key restricted to it, ideally with an expiry:
   ```bash
   node scripts/new-api-key.mjs live-test events:read,events:create,events:update,events:delete "Claude Test" 2
   ```
   Merge the printed entry into `API_KEYS`, save and deploy.
3. Run the live lifecycle test from any computer with Node 18+:
   ```bash
   export CALENDAR_API_BASE="https://apple-calendar-mcp.<you>.workers.dev/api"
   read -rs CALENDAR_API_TOKEN && export CALENDAR_API_TOKEN   # paste; not echoed
   node scripts/live-test.mjs
   ```
   It refuses to run unless the key sees only `Claude Test`. It covers create, idempotent retry, duplicate refusal, search, rescheduling with the duration kept, a stale-ETag refusal, renaming, confirmed delete, tampered and reused tokens, verification that the event is gone, recurring occurrences (move, delete, this-and-following, whole series), Israel winter, summer and the hour after the DST change, conflicts, unauthorized requests, and an expired token (it waits about 5 minutes; `--skip-expiry-wait` skips that). It then deletes everything it created.
4. Remove the `live-test` key from `API_KEYS` (or let it expire), and delete `Claude Test` when you are done.

Offline tests run against a simulated iCloud (`test/support/fake-icloud.ts`) and never touch Apple: `bun run test`.

## Maintain

- **Updates:** make changes on a branch, run `bun run test && bun run typecheck && bun run cloudflare:check`, open a pull request, and merge to deploy. After any change to event handling, run the live test against `Claude Test`.
- **Dependencies:** `bun audit --prod` should report nothing. Upgrade with `bun add --exact <pkg>@<version>` and rerun the tests.
- **Audit log:** a key with `audit:read` can call `GET /api/audit?limit=100`. It shows time, key, route, status and outcome, with hashed event references and no event content. Entries are kept for 90 days (at most 5,000).
- **Logs:** Cloudflare → Worker → **Observability** shows `api_audit` lines (same fields) and errors. Neither ever contains tokens or event content.
- **Free plan headroom:** 100,000 requests/day. A typical edit makes about 8 calls to iCloud (50 allowed per request). Bulk is capped at 8 operations to stay within that.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503 api_disabled` | `API_KEYS` missing or invalid JSON | Fix the secret. The Worker log shows `api_keys_invalid` with the reason. |
| `401 unauthorized` | Wrong token, or the key expired or is disabled | Check the entry in `API_KEYS`, or make a new key. |
| `403 calendar_not_available` | The calendar is not on `CALENDAR_ALLOWLIST` or the key's `calendars` | Add it. Names are matched case-insensitively. |
| `403 calendar_read_only` | A shared calendar where you only have read access | Ask the owner for edit access in iCloud. |
| `502 icloud_auth_failed` | The app-specific password was revoked, or your Apple password changed | Make a new app-specific password and replace `ICLOUD_APP_PASSWORD`. |
| `412 etag_mismatch` | The event changed elsewhere | Read it again, then retry. This is protection working. |
| `428` on every delete | Expected | Confirm with the token. |
| `410 confirmation_expired` | The user took longer than 5 minutes | Start the request again. |
| `503 guard_unavailable` | The Durable Object binding is missing | Redeploy from this repository (it declares `GUARD` and its migration). |
| Times off by an hour | The calendar publishes a different zone, or a request sent the wrong offset | Send local times without an offset. Check `timeZone` in `GET /api/calendars`. |
| A shared calendar is missing | The calendar is not in iCloud, or is excluded by the allowlist | Check `GET /api/calendars` with an unrestricted key. |

## Back up

- **Calendars:** iCloud keeps archived versions automatically. Go to **icloud.com/recovery → Restore Calendars** to roll back to an earlier version. A restore replaces your current calendars on all devices and removes sharing, so note who you share with first ([Apple's guide](https://support.apple.com/102508)). For your own copy, on a Mac use Calendar → **File → Export → Calendar Archive**, or export each calendar as `.ics`. Take a copy before large bulk changes.
- **Configuration:** keep the `API_KEYS` JSON, the `CALENDAR_ALLOWLIST` value and the names of your secrets in your password manager. Cloudflare cannot show secrets again.
- **Code:** the GitHub fork is the source of truth. Cloudflare keeps previous versions under **Deployments**, so you can roll back with one click.

## Revoke credentials

| To stop… | Do this | Takes effect |
|---|---|---|
| Instinct only | In `API_KEYS`, set `"disabled": true` on its entry (or delete the entry), then save and deploy. Also remove the credential in Instinct. | Immediately after deploy |
| One key, rotating | Create a new key, give it to the client, then delete the old entry. | Immediately |
| The legacy token | Delete the `API_TOKEN` secret. | Immediately |
| Every HTTP client | Delete `API_KEYS` and `API_TOKEN`. | Immediately |
| An MCP client | Remove it in that client. Changing `APPROVAL_PASSWORD` only stops new approvals. | Per client |
| Everything, right now | Worker → Settings → Domains & Routes → disable `workers.dev` (or delete the Worker), **and** revoke the app-specific password at account.apple.com. | Immediately |
| Apple access, routine | Create a new app-specific password, replace `ICLOUD_APP_PASSWORD`, check `GET /api/calendars`, then revoke the old password at account.apple.com. | No downtime |

Changing your main Apple Account password revokes all app-specific passwords. Afterwards, create a new one and update `ICLOUD_APP_PASSWORD`.
