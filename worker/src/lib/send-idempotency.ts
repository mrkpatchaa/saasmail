import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { ParsedFile } from "./multipart-send";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** How long a key is remembered: Resend's and Stripe's window. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/**
 * A request still marked running after this long is taken to have died
 * mid-send, and a retry may take its key over.
 */
export const IDEMPOTENCY_STALE_SECONDS = 5 * 60;
/** Rows deleted per prune statement, and statements per hourly pass. */
export const IDEMPOTENCY_PRUNE_BATCH = 1000;
export const IDEMPOTENCY_PRUNE_MAX_BATCHES = 10;

/** Printable ASCII without spaces, 1 to 255 characters. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export class IdempotencyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  constructor(readonly key: string) {
    super(
      `The idempotency key "${key}" was already used for a different request. Use a new key for a new message.`,
    );
    this.name = "IdempotencyReusedError";
  }
}

export class IdempotencyInProgressError extends Error {
  readonly code = "IDEMPOTENCY_IN_PROGRESS";
  constructor(readonly key: string) {
    super(
      `A request with the idempotency key "${key}" is still running. Retry in a few seconds.`,
    );
    this.name = "IdempotencyInProgressError";
  }
}

/**
 * The key of a send request, or why it is unusable. The `Idempotency-Key`
 * header wins over a key in the payload. No key at all is fine: keys are
 * optional.
 */
export function idempotencyKeyOf(
  header: string | null | undefined,
  payload: unknown,
): { key: string | null; error: string | null } {
  const raw =
    header !== undefined && header !== null
      ? header
      : payload === undefined || payload === null
        ? null
        : payload;
  if (raw === null) return { key: null, error: null };
  return typeof raw === "string" && KEY_PATTERN.test(raw)
    ? { key: raw, error: null }
    : {
        key: null,
        error:
          "The idempotency key must be 1 to 255 printable ASCII characters, without spaces.",
      };
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** JSON with object keys sorted at every depth, and undefined left out. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/**
 * What identifies a send request, as SHA-256 hex: the parsed fields (never
 * the raw body, whose multipart boundary differs between retries) and each
 * attachment's name, size and content hash. The idempotency key itself is
 * not part of it.
 */
export async function sendFingerprint(
  fields: Record<string, unknown>,
  files: ParsedFile[] = [],
): Promise<string> {
  const attachments = await Promise.all(
    files.map(async (file) => ({
      filename: file.filename,
      size: file.size,
      sha256: await sha256Hex(file.bytes),
    })),
  );
  return sha256Hex(canonicalJson({ ...fields, attachments }));
}

/** What a send route or tool answered. Only a 2xx answer is remembered. */
export interface IdempotentResponse<T = unknown> {
  status: number;
  body: T;
  sentEmailId?: string | null;
}

export interface IdempotentOutcome<T = unknown> extends IdempotentResponse<T> {
  /** True when this is the stored answer to an earlier request. */
  replayed: boolean;
}

type StoredRow = {
  fingerprint: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
  sent_email_id: string | null;
};

/**
 * Runs a send at most once per key. The first request with a key claims it
 * and runs; its 2xx answer is stored. A retry with the same key and the same
 * request gets that answer back (`replayed`); with a different request it
 * throws `IdempotencyReusedError`; while the first is still running it
 * throws `IdempotencyInProgressError`. A request that throws or answers with
 * an error releases the key, so a retry runs again. A key is remembered for
 * 24 hours, and a request still running after 5 minutes is taken to have
 * died: the same request may then take its key over.
 */
export async function withIdempotency<T>(
  db: Db,
  claim: { userId: string; key: string; fingerprint: string; now?: number },
  run: () => Promise<IdempotentResponse<T>>,
): Promise<IdempotentOutcome<T>> {
  const { userId, key, fingerprint } = claim;
  const now = claim.now ?? Math.floor(Date.now() / 1000);

  // One statement claims a free key, an expired one, or the same request's
  // abandoned one; anything else is left as it is and read below.
  const claimed = await db.all<{ key: string }>(sql`
    INSERT INTO send_idempotency (user_id, key, fingerprint, status, created_at)
    VALUES (${userId}, ${key}, ${fingerprint}, 'pending', ${now})
    ON CONFLICT (user_id, key) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      status = 'pending',
      response_status = NULL,
      response_body = NULL,
      sent_email_id = NULL,
      created_at = excluded.created_at,
      completed_at = NULL
    WHERE send_idempotency.created_at < ${now - IDEMPOTENCY_TTL_SECONDS}
      OR (
        send_idempotency.status = 'pending'
        AND send_idempotency.created_at < ${now - IDEMPOTENCY_STALE_SECONDS}
        AND send_idempotency.fingerprint = excluded.fingerprint
      )
    RETURNING key
  `);

  if (claimed.length === 0) {
    const [row] = await db.all<StoredRow>(sql`
      SELECT fingerprint, status, response_status, response_body, sent_email_id
      FROM send_idempotency
      WHERE user_id = ${userId} AND key = ${key}
    `);
    // Released between the claim and this read: the earlier request failed.
    // Try once more rather than refusing a request that may now run.
    if (!row) return withIdempotency(db, { ...claim, now }, run);
    if (row.fingerprint !== fingerprint) throw new IdempotencyReusedError(key);
    if (row.status !== "completed") throw new IdempotencyInProgressError(key);
    return {
      status: row.response_status ?? 200,
      body: JSON.parse(row.response_body ?? "null") as T,
      sentEmailId: row.sent_email_id,
      replayed: true,
    };
  }

  // Only this claim: a later takeover has a later created_at.
  const ours = sql`user_id = ${userId} AND key = ${key}
    AND status = 'pending' AND created_at = ${now}`;
  const release = () => db.run(sql`DELETE FROM send_idempotency WHERE ${ours}`);

  let response: IdempotentResponse<T>;
  try {
    response = await run();
  } catch (error) {
    await release().catch((releaseError) =>
      console.warn(`[idempotency] key ${key} not released:`, releaseError),
    );
    throw error;
  }

  if (response.status < 200 || response.status >= 300) {
    await release();
    return { ...response, replayed: false };
  }

  // The message is out: failing here must not fail the request. A retry then
  // finds the key still running for 5 minutes, then may send again.
  try {
    await db.run(sql`
      UPDATE send_idempotency SET
        status = 'completed',
        response_status = ${response.status},
        response_body = ${JSON.stringify(response.body)},
        sent_email_id = ${response.sentEmailId ?? null},
        completed_at = ${Math.floor(Date.now() / 1000)}
      WHERE ${ours}
    `);
  } catch (error) {
    console.error(`[idempotency] key ${key} not completed:`, error);
  }
  return { ...response, replayed: false };
}

/**
 * The HTTP answer for a key that cannot be used now: 422 for a key reused
 * with another request, 409 (retry after 2 seconds) for one still running.
 * Null for any other error.
 */
export function idempotencyFailure(error: unknown): {
  status: 409 | 422;
  body: { error: string; code: string };
  retryAfter?: string;
} | null {
  if (error instanceof IdempotencyReusedError) {
    return { status: 422, body: { error: error.message, code: error.code } };
  }
  if (error instanceof IdempotencyInProgressError) {
    return {
      status: 409,
      body: { error: error.message, code: error.code },
      retryAfter: "2",
    };
  }
  return null;
}

/**
 * Deletes keys older than 24 hours, oldest first, in batches up to a bound
 * per pass. Returns how many went. Runs in the hourly chain.
 */
export async function pruneSendIdempotency(
  db: Db,
  now: number,
): Promise<number> {
  const cutoff = now - IDEMPOTENCY_TTL_SECONDS;
  let deleted = 0;
  for (let batch = 0; batch < IDEMPOTENCY_PRUNE_MAX_BATCHES; batch += 1) {
    const result = await db.run(sql`
      DELETE FROM send_idempotency
      WHERE rowid IN (
        SELECT rowid FROM send_idempotency
        WHERE created_at < ${cutoff}
        ORDER BY created_at
        LIMIT ${IDEMPOTENCY_PRUNE_BATCH}
      )
    `);
    const changes = result.meta?.changes ?? 0;
    deleted += changes;
    if (changes < IDEMPOTENCY_PRUNE_BATCH) break;
  }
  return deleted;
}
