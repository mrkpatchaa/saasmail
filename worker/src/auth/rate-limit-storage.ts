import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** What better-auth stores per key (its `RateLimit`). */
interface RateLimitEntry {
  key: string;
  count: number;
  lastRequest: number;
}

/** Expired rows deleted per hourly pass. */
const PRUNE_BATCH = 1000;

/**
 * better-auth's rate-limit storage, in D1. The library's default keeps
 * counters in memory, i.e. per Worker isolate, so an attacker spread over
 * isolates was never limited (and it is only switched on when `NODE_ENV` is
 * "production", which Workers do not set).
 *
 * `consume` counts and decides in one statement, so concurrent requests cannot
 * all pass a stale read. The window is fixed: it opens with the first request
 * and the count starts again once it has closed.
 */
export function d1RateLimitStorage(db: Db) {
  return {
    async get(key: string): Promise<RateLimitEntry | null> {
      const [row] = await db.all<{
        count: number;
        window_start: number;
        expires_at: number;
      }>(
        sql`SELECT count, window_start, expires_at FROM auth_rate_limits WHERE key = ${key}`,
      );
      if (!row || Number(row.expires_at) <= Date.now()) return null;
      return {
        key,
        count: Number(row.count),
        lastRequest: Number(row.window_start),
      };
    },

    /**
     * Required by the storage contract, but only better-auth's non-atomic
     * fallback calls it, and `consume` takes its place here.
     */
    async set(key: string, value: RateLimitEntry): Promise<void> {
      await db.run(sql`
        INSERT INTO auth_rate_limits (key, count, window_start, expires_at)
        VALUES (${key}, ${value.count}, ${value.lastRequest}, ${value.lastRequest + 60_000})
        ON CONFLICT (key) DO UPDATE SET count = excluded.count
      `);
    },

    async consume(
      key: string,
      rule: { window: number; max: number },
    ): Promise<{ allowed: boolean; retryAfter: number | null }> {
      const now = Date.now();
      const closes = now + rule.window * 1000;
      try {
        // SQLite evaluates every SET expression against the row as it was,
        // so the three CASEs agree on whether the window had closed.
        const [row] = await db.all<{ count: number; expires_at: number }>(sql`
          INSERT INTO auth_rate_limits (key, count, window_start, expires_at)
          VALUES (${key}, 1, ${now}, ${closes})
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN expires_at <= ${now} THEN 1 ELSE count + 1 END,
            window_start = CASE WHEN expires_at <= ${now} THEN ${now} ELSE window_start END,
            expires_at = CASE WHEN expires_at <= ${now} THEN ${closes} ELSE expires_at END
          RETURNING count, expires_at
        `);
        if (Number(row.count) <= rule.max) {
          return { allowed: true, retryAfter: null };
        }
        return {
          allowed: false,
          retryAfter: Math.max(
            1,
            Math.ceil((Number(row.expires_at) - now) / 1000),
          ),
        };
      } catch (error) {
        // A limiter that cannot count must not lock everybody out of
        // signing in; the request goes on and the failure is logged.
        console.error("[auth] rate limit not checked:", error);
        return { allowed: true, retryAfter: null };
      }
    },
  };
}

/** Deletes expired counters, a bounded batch per hourly pass. */
export async function pruneAuthRateLimits(
  db: Db,
  nowMs: number,
): Promise<void> {
  await db.run(sql`
    DELETE FROM auth_rate_limits WHERE key IN (
      SELECT key FROM auth_rate_limits WHERE expires_at <= ${nowMs}
      ORDER BY expires_at LIMIT ${PRUNE_BATCH}
    )
  `);
}
