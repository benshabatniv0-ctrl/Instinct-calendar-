# Security review: HTTP API v2 for Instinct

Reviewed: the whole Worker (`src/`), its configuration, its dependencies, and the new HTTP API. Date: November 2026.

## Scope and threat model

The Worker holds one Apple Account's app-specific password. Anyone who can drive the Worker can read and change that account's calendars. The main risks:

1. **Leaked or overpowered client tokens.** A token sitting in an AI assistant can be misused or exfiltrated.
2. **Assistant mistakes.** An assistant might delete or rewrite the wrong event, repeat a request, or act on an instruction planted in an event's text (prompt injection).
3. **Upstream data corruption.** A write that iCloud interprets differently from what we meant.
4. **Abuse of the public endpoint.** Brute force, resource exhaustion, oversized input.
5. **Credential exposure** through the repository, logs, or errors.

## Findings and resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | One bearer secret (`API_TOKEN`) gave full access to every calendar over HTTP and MCP. | Scoped keys in `API_KEYS`: `events:read`, `events:create`, `events:update` and `events:delete` are separate, and there are also reminders and audit scopes. Each key can be limited to named calendars and given an expiry. Keys can be stored as SHA-256 hashes. The legacy `API_TOKEN` keeps exactly its old HTTP powers (read and create). |
| 2 | High | No way to keep clients away from particular calendars. | `CALENDAR_ALLOWLIST` and per-key calendar lists are enforced inside the shared CalDAV layer (`calendar.ts`), so MCP (OAuth or key) and HTTP are covered by the same check. A malformed allowlist denies everything (fails closed). |
| 3 | High | Nothing on the server stopped an assistant from deleting or bulk-changing events in a single call. | Deletes, bulk changes, whole-series and "this and following" changes need a server-issued confirmation token. Each token is HMAC-signed, tied to one key and one exact operation (including the ETag and the patch), lasts 5 minutes by default, and can be used once (nonce kept in a Durable Object). |
| 4 | Medium | A repeated create could produce duplicates. | `Idempotency-Key` support (results kept 24 h). A create that matches an existing event's title, start and end is refused with `duplicate_suspected` unless `allowDuplicate` is set. |
| 5 | Medium | The approval password (chosen by a person) had no attempt limit. | 10 attempts per 10 minutes per address, plus 60 per hour overall. |
| 6 | Medium | The API had no rate limits or audit trail. | Per-key limits (120 requests/min, 30 writes/min, configurable), a limit on failed sign-ins per address, and an audit log in SQLite. The log keeps time, key, route, status and short hashed event references. It never stores titles, notes, locations, attendees, or raw iCloud URLs (which contain the account's DSID). |
| 7 | Medium | The request body limit trusted `Content-Length`, so a chunked body could be any size. | The body is now read as a stream with a hard 256 KB cap. |
| 8 | Medium | Code that ships in the Worker used dependencies with published advisories: MCP server SDK 2.0.0 (one client's messages could reach another; memory exhaustion) and zod < 4.6.6 (memory exhaustion). | Upgraded to `@modelcontextprotocol/server` 2.4.0, zod 4.6.7 and agents 0.34.0. `bun audit --prod` now reports no vulnerabilities. Development-only advisories (vite, launch-editor and others in test tooling) remain; that code is never deployed. |
| 9 | Medium (integrity) | "This and following" edits and deletes wrote a `RANGE=THISANDFUTURE` override. iCloud and Apple Calendar do not apply those, so the change would reach only one occurrence. | The series is now split the way Apple Calendar does it: the original ends with `UNTIL` just before the occurrence, and a new series starts there. The new series is created before the original is ended (guarded by its ETag) and is rolled back if ending the original fails. |
| 10 | Medium (integrity) | ical.js converts UTC to local time an hour off during the hour after each daylight-saving change (shown for Asia/Jerusalem). Events at those times were saved at the wrong time. | UTC-to-local conversion now uses the runtime's IANA time zone database. ical.js still handles local-to-UTC, which it gets right. Regression tests added. |
| 11 | Medium (integrity) | Editing an occurrence that had already been moved put it back at its original time. | An existing override keeps its own time and properties; only the fields sent change. |
| 12 | Low (integrity) | Deleting one occurrence wrote a `STATUS:CANCELLED` copy of it, which some clients display as cancelled. | It now adds an `EXDATE` carrying the series' time zone. Without that zone, ical.js would write a floating time that iCloud would not match. |
| 13 | Low (integrity) | Moving a whole series left its moved occurrences, excluded dates and end date (`UNTIL`) pointing at the old times. | These references now shift with the series. |
| 14 | Low (availability) | On the free plan (50 outbound requests per call), account discovery plus one `supported-report-set` request per calendar, repeated for every read inside a write, could use up the budget. | One iCloud session per request, and the unused report-set requests are skipped. Measured: about 8 outbound requests for an edit, about 35 for an 8-operation bulk change. |
| 15 | Low | A deleted event's 404 from iCloud surfaced as a 502. | Now reported as `not_found`. Deletes are checked by reading the event back (`verifiedGone`). |
| 16 | Info | `src/cimd.ts` replaces the global `fetch` to work around chatgpt.com. | Reviewed. It affects only the exact ChatGPT metadata URLs, and the pinned document limits redirects to chatgpt.com. Acceptable. |
| 17 | Info | MCP write tools depend on the MCP client asking the user before destructive calls (`destructiveHint`). | Unchanged on purpose to keep existing MCP clients working. The confirmation tokens apply to the HTTP API. The allowlist applies to MCP too. |

## Controls that were already sound

- Outbound requests go only to Apple CalDAV hosts over HTTPS (`assertAppleCalDavUrl`). Tool or API input cannot pick the upstream host. `global_fetch_strictly_public` is enabled.
- Opaque calendar and event IDs are checked against the discovered calendar before use, and an event must belong to its calendar.
- Optimistic concurrency: every change needs the current ETag, and the PUT or DELETE to iCloud also sends `If-Match`, so a change made between our check and our write still fails safely (tested).
- Secrets are compared in constant time over SHA-256 digests. Errors redact Basic credentials and token query parameters.
- The OAuth approval page uses a strict CSP, `frame-ancestors 'none'`, and no-referrer.

## Input validation

Every route has a strict zod schema (unknown fields are rejected) with length limits. Control characters are removed from text fields, and IDs must be base64url. Recurrence lines must be complete `RRULE`, `RDATE` or `EXDATE` lines with no line breaks, and URLs must parse. Structured-location parameters are escaped with RFC 6868 by ical.js (verified), so iCalendar injection through titles, notes or locations is not possible.

## Remaining risks for the owner to accept or manage

- **An Apple app-specific password cannot be limited to Calendar.** Revoking it at account.apple.com is the ultimate kill switch. The Worker never asks for, and must never be given, the main Apple Account password.
- **Prompt injection through calendar content.** Invitations can carry text written by someone else. The confirmation step limits the damage from destructive actions, and the Instinct configuration tells it to treat event text as data, but an assistant can still be misled into creating or editing events. Give Instinct only the calendars it needs.
- **Bulk changes are not atomic.** Each operation is reported separately. If a later operation fails, the earlier ones are not rolled back, and the response says so.
- **Shared calendars** are writable only where iCloud grants write access; otherwise the API returns `calendar_read_only`.
- Changing attendees can send email invitations or cancellations through iCloud.
