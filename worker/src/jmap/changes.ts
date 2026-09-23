import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export const JMAP_CHANGE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const JMAP_CHANGE_PRUNE_LIMIT = 5000;

export async function pruneJmapChanges(
  db: DrizzleD1Database<any>,
  now: number,
): Promise<void> {
  const cutoff = now - JMAP_CHANGE_RETENTION_SECONDS;
  await db.run(sql`
    DELETE FROM jmap_changes
    WHERE seq IN (
      SELECT seq
      FROM jmap_changes
      WHERE created_at < ${cutoff}
      ORDER BY seq
      LIMIT ${JMAP_CHANGE_PRUNE_LIMIT}
    )
  `);
}
