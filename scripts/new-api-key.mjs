#!/usr/bin/env node
// Generates a strong API key and the matching API_KEYS entry.
//
//   node scripts/new-api-key.mjs instinct events:read,events:create,events:update,events:delete
//   node scripts/new-api-key.mjs instinct-test events:read,events:create,events:update,events:delete "Claude Test" 7
//
// Arguments: key name, comma-separated scopes, optional comma-separated calendar names, optional
// lifetime in days. The entry stores only the token's SHA-256, so Cloudflare never holds the token
// itself. The token is printed once, on stderr: paste it into the assistant's secure credential form,
// then clear your terminal. Nothing is written to disk.

import { createHash, randomBytes } from "node:crypto";

const [name, scopeList, calendarList, days] = process.argv.slice(2);
if (!name || !scopeList) {
  console.error("Usage: node scripts/new-api-key.mjs <name> <scope,scope,…> [calendar,calendar,…] [days]");
  process.exit(2);
}

const token = randomBytes(32).toString("base64url");
const entry = {
  sha256: createHash("sha256").update(token).digest("hex"),
  scopes: scopeList.split(",").map((scope) => scope.trim()).filter(Boolean),
  ...(calendarList ? { calendars: calendarList.split(",").map((calendar) => calendar.trim()).filter(Boolean) } : {}),
  ...(days ? { expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") } : {}),
};

console.error(`\nToken for "${name}" (shown once; give it only to that assistant's secure form):\n\n  ${token}\n`);
console.log(`Add this entry to the API_KEYS secret (merge it into the existing JSON object):\n`);
console.log(JSON.stringify({ [name]: entry }, null, 2));
