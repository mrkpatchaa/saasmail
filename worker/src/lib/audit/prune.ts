import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export const AUDIT_RETENTION_DEFAULT_DAYS = 180;
export const AUDIT_RETENTION_MIN_DAYS = 30;
/** Rows deleted per cron pass, so one pass never holds D1 for long. */
export const AUDIT_PRUNE_BATCH = 1000;

/**
 * How long audit events are kept: the optional `AUDIT_RETENTION_DAYS` var,
 * never less than 30 days, 180 when unset or not a number.
 */
export function auditRetentionDays(
  env: CloudflareBindings | undefined,
): number {
  const raw = Number((env as any)?.AUDIT_RETENTION_DAYS);
  if (!Number.isFinite(raw) || raw <= 0) return AUDIT_RETENTION_DEFAULT_DAYS;
  return Math.max(Math.floor(raw), AUDIT_RETENTION_MIN_DAYS);
}

/**
 * Deletes audit events older than the retention period, oldest first, at most
 * one batch per call. Returns how many went. Runs in the hourly chain.
 */
export async function pruneAuditEvents(
  db: DrizzleD1Database<any>,
  now: number,
  retentionDays: number = AUDIT_RETENTION_DEFAULT_DAYS,
): Promise<number> {
  const cutoff = now - retentionDays * 24 * 60 * 60;
  const result = await db.run(sql`
    DELETE FROM audit_events
    WHERE id IN (
      SELECT id FROM audit_events
      WHERE at < ${cutoff}
      ORDER BY at
      LIMIT ${AUDIT_PRUNE_BATCH}
    )
  `);
  return result.meta?.changes ?? 0;
}
