# HTTP API (v2)

For assistants that make web requests but do not speak MCP, such as Instinct. It runs on the same Worker as the MCP endpoint and uses the same iCloud code.

**The live reference is `GET /api`.** It is generated from the route table, so it always matches the deployed code. It lists every route, its parameters, request and response schemas, the permissions your key has, and the rules below.

## Authentication and permissions

Send `Authorization: Bearer <token>` on every request. `X-API-Key: <token>` also works.

Keys live in the `API_KEYS` Worker secret, a JSON object:

```json
{
  "instinct": {
    "sha256": "<hex SHA-256 of the token>",
    "scopes": ["events:read", "events:create", "events:update", "events:delete"],
    "calendars": ["Personal", "Family"]
  },
  "instinct-test": {
    "token": "<32+ random characters>",
    "scopes": ["events:read", "events:create", "events:update", "events:delete"],
    "calendars": ["Claude Test"],
    "expiresAt": "2026-12-01T00:00:00Z"
  }
}
```

| Field | Meaning |
|---|---|
| `token` or `sha256` | The secret (at least 24 characters; 32+ recommended), or its SHA-256 in hex. `scripts/new-api-key.mjs` prints both forms. |
| `scopes` | `events:read`, `events:create`, `events:update`, `events:delete`, `reminders:read`, `reminders:write`, `audit:read`. |
| `calendars` | Optional calendar names or ids. Narrows this key further than `CALENDAR_ALLOWLIST`. |
| `expiresAt` | Optional. The key stops working after this time. |
| `disabled` | Optional. `true` turns the key off immediately. |
| `mcp` | Optional. `true` lets the key also be used on `/mcp`, with its scopes and calendars. |

`CALENDAR_ALLOWLIST` (comma- or newline-separated names or ids, or a JSON array) limits every client, MCP included. Leaving it unset allows all calendars.

The legacy `API_TOKEN` still works with its original powers: reading, creating, and reminders.

## Routes

| Method | Path | Scope | Notes |
|---|---|---|---|
| GET | `/api` | any key | Self-description. |
| GET | `/api/time` | any key | Current local time, date, weekday and DST status. |
| GET | `/api/profile` | events:read | |
| GET | `/api/calendars` | events:read | Only calendars this key may use. |
| GET | `/api/events?start&end[&calendarId…][&query][&limit][&offset]` | events:read | Each occurrence of a repeating event is listed separately, with `recurrenceId`. |
| GET | `/api/events/{calendarId}/{eventId}[?recurrenceId]` | events:read | Includes the current `etag`. |
| POST | `/api/events` | events:create | Duplicate and conflict checks; `Idempotency-Key`. |
| PATCH | `/api/events/{calendarId}/{eventId}` | events:update | Needs `etag`. Confirmation for whole-series and this-and-following changes. |
| DELETE | `/api/events/{calendarId}/{eventId}?etag[&scope][&recurrenceId]` | events:delete | Always needs confirmation. |
| POST | `/api/events/bulk` | update and/or delete | Up to 8 operations. Always needs confirmation. Not atomic. |
| GET | `/api/conflicts?start&end[&calendarId…][&excludeEventId]` | events:read | Busy events overlapping the window. |
| GET | `/api/availability?start&end[&calendarId…][&minFreeMinutes]` | events:read | Busy and free windows, without titles. |
| GET/POST | `/api/reminders` | reminders:read / reminders:write | Unchanged. |
| GET | `/api/audit[?limit][&keyId]` | audit:read | Recent activity, with no event content. |

If a client cannot send PATCH or DELETE, it can send POST with `X-HTTP-Method-Override: PATCH|DELETE` or `?_method=PATCH|DELETE`.

## Times

- **Local times are recommended:** `2026-12-01T15:00`. The server reads them in the calendar's zone (`Asia/Jerusalem` by default) and applies daylight saving. A time skipped when clocks go forward moves past the gap. A time that happens twice when clocks go back means the first occurrence.
- RFC 3339 with an offset or `Z` is also accepted.
- All-day events use `YYYY-MM-DD`. The end date is exclusive (`2026-12-24` to `2026-12-26` is two days).
- Responses give `start`/`end` in UTC and `startLocal`/`endLocal` with the local offset.

## Changing events

- Only the fields you send change. Everything else is kept, including properties this API does not model.
- **Rescheduling keeps the duration:** sending only `start` moves the whole event. Send `end` or `durationMinutes` to change its length.
- `null` clears `location`, `description`, `url`, `reminders` (alerts), `attendees`, `structuredLocation` or `recurrence`.
- The `etag` (or `If-Match`) must come from your latest read. A `412 etag_mismatch` means the event changed elsewhere: read it again and check with the user.

## Repeating events

| scope | Effect | Confirmation |
|---|---|---|
| `this_instance` (default when `recurrenceId` is given) | One occurrence. | Deletes only. |
| `this_and_following` | This occurrence and later ones. The series is split and `event` in the response is the new series, with a new id. | Always. |
| `entire_series` (default without `recurrenceId`) | Every occurrence. | Always, for repeating events. |

## Confirmation flow

1. Send the request as usual. Nothing happens yet. You get **`428`**:
   ```json
   { "done": false, "status": "confirmation_required", "summary": "Delete the event \"Dentist\" (2026-12-01 15:00–16:00 (Asia/Jerusalem)) from calendar \"Personal\".", "confirmation": { "token": "…", "expiresAt": "…", "expiresInSeconds": 300, "header": "X-Confirmation-Token" }, "preview": { … } }
   ```
2. Show `summary` to the user and get an explicit yes.
3. Repeat **exactly the same request** with `X-Confirmation-Token: <token>` (or the `confirmationToken` field or query parameter).

The token works once, for that one operation, from that one key. `410 confirmation_expired` or `409 confirmation_already_used` / `confirmation_mismatch` mean: start again from step 1.

## Responses and errors

Every response has `done`. **Only `done: true` means the change happened.** Errors look like:

```json
{ "done": false, "error": "human-readable message", "code": "etag_mismatch", "issues": [ … ] }
```

| HTTP | code | What to do |
|---|---|---|
| 400 | `invalid_input`, `invalid_id` | Fix the request (see `issues`). |
| 401 | `unauthorized` | The token is missing, wrong, expired or disabled. |
| 403 | `insufficient_scope`, `calendar_not_available`, `calendar_read_only` | Not allowed for this key or calendar. |
| 404 | `not_found`, `unknown_route` | The event or occurrence no longer exists. |
| 409 | `duplicate_suspected`, `time_conflict`, `confirmation_*`, `request_in_progress` | See the message. |
| 410 | `confirmation_expired` | Ask the user again, using a new token. |
| 412 | `etag_mismatch` | Read the event again and check with the user. |
| 422 | `idempotency_key_reused` | Use a new key for a new request. |
| 428 | `confirmation_required` / `etag_required` | Confirm with the user, or include the etag. |
| 429 | `rate_limited` | Wait for `Retry-After`. |
| 502 | `icloud_auth_failed`, `upstream_error` | Problem on the iCloud side. Report it to the owner. |
| 503 | `api_disabled`, `guard_unavailable` | Configuration problem. Report it to the owner. |

## Example

```bash
# Read the token without echoing it
read -rs TOKEN
API=https://apple-calendar-mcp.<you>.workers.dev/api
curl -s -H "Authorization: Bearer $TOKEN" "$API/events?start=2026-12-01&end=2026-12-02&query=dentist"
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"etag":"<etag from above>","start":"2026-12-01T17:30"}' "$API/events/<calendarId>/<eventId>"
```
