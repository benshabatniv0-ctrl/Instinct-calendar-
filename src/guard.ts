// One SQLite-backed Durable Object that keeps the small amount of state the API needs:
// fixed-window rate limits, single-use confirmation nonces, idempotency records, and a
// privacy-conscious audit log (no titles, notes, locations, attendees, or raw identifiers).
// It runs on the Workers Free plan, which supports SQLite-backed Durable Objects.

import { DurableObject } from "cloudflare:workers";

export interface RateRule {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateResult {
  ok: boolean;
  retryAfterSeconds?: number;
  rule?: string;
}

export type IdempotencyState =
  | { state: "new" }
  | { state: "pending" }
  | { state: "mismatch" }
  | { state: "done"; status: number; body: string };

export interface AuditEntry {
  at: string;
  keyId: string;
  method: string;
  route: string;
  operation: string;
  status: number;
  outcome: string;
  calendarRef?: string | undefined;
  eventRef?: string | undefined;
  scope?: string | undefined;
  count?: number | undefined;
  durationMs?: number | undefined;
}

export interface GuardApi {
  checkRate(rules: RateRule[], now?: number): Promise<RateResult>;
  consumeNonce(nonce: string, expiresAtSeconds: number, now?: number): Promise<boolean>;
  idempotencyBegin(key: string, requestHash: string, ttlSeconds: number, now?: number): Promise<IdempotencyState>;
  idempotencyFinish(key: string, status: number, body: string): Promise<void>;
  idempotencyAbort(key: string): Promise<void>;
  audit(entry: AuditEntry): Promise<void>;
  listAudit(limit: number, keyId?: string): Promise<AuditEntry[]>;
}

const AUDIT_RETENTION_DAYS = 90;
const AUDIT_MAX_ROWS = 5000;

export class Guard extends DurableObject<Env> implements GuardApi {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nonce (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS idem (key TEXT PRIMARY KEY, hash TEXT NOT NULL, status INTEGER, body TEXT, expires INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, key_id TEXT NOT NULL, entry TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`);
  }

  private prune(now: number): void {
    const seconds = Math.floor(now / 1000);
    this.sql.exec(`DELETE FROM rate WHERE expires <= ?`, seconds);
    this.sql.exec(`DELETE FROM nonce WHERE expires <= ?`, seconds);
    this.sql.exec(`DELETE FROM idem WHERE expires <= ?`, seconds);
  }

  async checkRate(rules: RateRule[], now = Date.now()): Promise<RateResult> {
    const seconds = Math.floor(now / 1000);
    if (Math.random() < 0.05) this.prune(now);
    const buckets = rules.map((rule) => {
      const window = Math.floor(seconds / rule.windowSeconds);
      const bucket = `${rule.key}|${rule.windowSeconds}|${window}`;
      const row = this.sql.exec<{ count: number }>(`SELECT count FROM rate WHERE bucket = ?`, bucket).toArray()[0];
      return { rule, bucket, count: row?.count ?? 0, resetAt: (window + 1) * rule.windowSeconds };
    });
    const blocked = buckets.find((bucket) => bucket.count >= bucket.rule.limit);
    if (blocked) return { ok: false, retryAfterSeconds: Math.max(1, blocked.resetAt - seconds), rule: blocked.rule.key.split(":")[0] ?? "rate" };
    for (const bucket of buckets) {
      this.sql.exec(
        `INSERT INTO rate (bucket, count, expires) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
        bucket.bucket,
        bucket.resetAt,
      );
    }
    return { ok: true };
  }

  // Returns true the first time a nonce is seen, false on every replay.
  async consumeNonce(nonce: string, expiresAtSeconds: number, now = Date.now()): Promise<boolean> {
    this.prune(now);
    const existing = this.sql.exec(`SELECT 1 FROM nonce WHERE nonce = ?`, nonce).toArray();
    if (existing.length > 0) return false;
    this.sql.exec(`INSERT INTO nonce (nonce, expires) VALUES (?, ?)`, nonce, expiresAtSeconds + 60);
    return true;
  }

  async idempotencyBegin(key: string, requestHash: string, ttlSeconds: number, now = Date.now()): Promise<IdempotencyState> {
    this.prune(now);
    const row = this.sql.exec<{ hash: string; status: number | null; body: string | null }>(`SELECT hash, status, body FROM idem WHERE key = ?`, key).toArray()[0];
    if (!row) {
      this.sql.exec(`INSERT INTO idem (key, hash, status, body, expires) VALUES (?, ?, NULL, NULL, ?)`, key, requestHash, Math.floor(now / 1000) + ttlSeconds);
      return { state: "new" };
    }
    if (row.hash !== requestHash) return { state: "mismatch" };
    if (row.status === null || row.body === null) return { state: "pending" };
    return { state: "done", status: row.status, body: row.body };
  }

  async idempotencyFinish(key: string, status: number, body: string): Promise<void> {
    this.sql.exec(`UPDATE idem SET status = ?, body = ? WHERE key = ?`, status, body, key);
  }

  async idempotencyAbort(key: string): Promise<void> {
    this.sql.exec(`DELETE FROM idem WHERE key = ?`, key);
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.sql.exec(`INSERT INTO audit (at, key_id, entry) VALUES (?, ?, ?)`, entry.at, entry.keyId, JSON.stringify(entry));
    if (Math.random() < 0.05) {
      const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86_400_000).toISOString();
      this.sql.exec(`DELETE FROM audit WHERE at < ?`, cutoff);
      this.sql.exec(`DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)`, AUDIT_MAX_ROWS);
    }
  }

  async listAudit(limit: number, keyId?: string): Promise<AuditEntry[]> {
    const bounded = Math.min(500, Math.max(1, Math.floor(limit)));
    const rows = keyId
      ? this.sql.exec<{ entry: string }>(`SELECT entry FROM audit WHERE key_id = ? ORDER BY id DESC LIMIT ?`, keyId, bounded).toArray()
      : this.sql.exec<{ entry: string }>(`SELECT entry FROM audit ORDER BY id DESC LIMIT ?`, bounded).toArray();
    return rows.map((row) => JSON.parse(row.entry) as AuditEntry);
  }
}

export function guardFor(env: { GUARD?: DurableObjectNamespace<Guard> | undefined }): GuardApi | undefined {
  if (!env.GUARD) return undefined;
  return env.GUARD.get(env.GUARD.idFromName("guard")) as unknown as GuardApi;
}

// Short, non-reversible reference for audit entries, so the log can correlate operations on the same
// event without storing the iCloud URL (which embeds the account's DSID).
export async function auditRef(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`audit:${value}`)));
  return [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function clientRef(request: Request): Promise<string> {
  return (await auditRef(request.headers.get("cf-connecting-ip") ?? "unknown")) ?? "unknown";
}
