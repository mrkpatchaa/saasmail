import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { mailboxes } from "../db/mailboxes.schema";
import { inboxScopeSql, type AllowedInboxes } from "../lib/inbox-permissions";
import { SYSTEM_MAILBOX_ROLES } from "./constants";
import { customMailboxId, systemMailboxId } from "./ids";
import {
  currentJmapState,
  formatJmapState,
  parseJmapState,
  type ParsedJmapState,
} from "./state";
import type { JmapMethodError } from "./emails";

export const JMAP_CHANGE_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const JMAP_CHANGE_STATE_MAX_AGE_SECONDS = 29 * 24 * 60 * 60;
export const JMAP_CHANGE_PRUNE_LIMIT = 5000;
export const JMAP_CHANGE_WINDOW_LIMIT = 10_000;
export const JMAP_MAX_CHANGES = 256;

type ChangeRow = {
  object_id: string;
  first_seq: number;
  first_op: string;
  last_seq: number;
  last_op: string;
};

type ChangeSets = {
  created: string[];
  updated: string[];
  destroyed: string[];
};

function classify(rows: ChangeRow[]): ChangeSets {
  const result: ChangeSets = { created: [], updated: [], destroyed: [] };
  for (const row of rows) {
    if (row.first_op === "c" && row.last_op === "d") continue;
    if (row.first_op === "c") result.created.push(row.object_id);
    else if (row.last_op === "d") result.destroyed.push(row.object_id);
    else result.updated.push(row.object_id);
  }
  return result;
}

function maxChanges(value: unknown): number | JmapMethodError {
  if (value === undefined || value === null) return JMAP_MAX_CHANGES;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { type: "invalidArguments", properties: ["maxChanges"] };
  }
  return Math.min(value, JMAP_MAX_CHANGES);
}

async function validateSinceState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  value: unknown,
  now: number,
): Promise<
  | {
      since: ParsedJmapState;
      current: Awaited<ReturnType<typeof currentJmapState>>;
    }
  | JmapMethodError
> {
  const since = parseJmapState(value);
  if (!since) return { type: "cannotCalculateChanges" };

  const current = await currentJmapState(db, allowed, userId, now);
  if (
    since.fp !== current.parts.fp ||
    since.issuedAt < now - JMAP_CHANGE_STATE_MAX_AGE_SECONDS
  ) {
    return { type: "cannotCalculateChanges" };
  }

  const inboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const rows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count
    FROM (
      SELECT 1
      FROM jmap_changes jc
      WHERE jc.seq > ${since.seq}
        ${inboxScope}
        AND (jc.user_id IS NULL OR jc.user_id = ${userId})
      ORDER BY jc.seq
      LIMIT ${JMAP_CHANGE_WINDOW_LIMIT + 1}
    )
  `);
  if (Number(rows[0]?.count ?? 0) > JMAP_CHANGE_WINDOW_LIMIT) {
    return { type: "cannotCalculateChanges" };
  }

  return { since, current };
}

function groupedChangesSql(
  allowed: AllowedInboxes,
  userId: string,
  sinceSeq: number,
  objectType: "email" | "mailbox",
  limit?: number,
) {
  const inboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const limitSql = limit === undefined ? sql`` : sql`LIMIT ${limit}`;
  return sql`
    WITH scoped AS (
      SELECT jc.seq, jc.object_id, jc.op
      FROM jmap_changes jc
      WHERE jc.seq > ${sinceSeq}
        AND jc.object_type = ${objectType}
        ${inboxScope}
        AND (jc.user_id IS NULL OR jc.user_id = ${userId})
    ),
    grouped AS (
      SELECT
        object_id,
        MIN(seq) AS first_seq,
        MAX(seq) AS last_seq
      FROM scoped
      GROUP BY object_id
    )
    SELECT
      g.object_id,
      g.first_seq,
      (SELECT s.op FROM scoped s WHERE s.seq = g.first_seq) AS first_op,
      g.last_seq,
      (SELECT s.op FROM scoped s WHERE s.seq = g.last_seq) AS last_op
    FROM grouped g
    ORDER BY g.last_seq
    ${limitSql}
  `;
}

export async function emailChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    args.sinceState,
    now,
  );
  if ("type" in validation) return validation;

  const rows = await db.all<ChangeRow>(
    groupedChangesSql(
      allowed,
      userId,
      validation.since.seq,
      "email",
      requestedMax + 1,
    ),
  );
  const hasMoreChanges = rows.length > requestedMax;
  const page = hasMoreChanges ? rows.slice(0, requestedMax) : rows;
  const sets = classify(page);
  const lastSeq = page.at(-1)?.last_seq ?? validation.since.seq;
  const newState = hasMoreChanges
    ? formatJmapState(lastSeq, validation.since.issuedAt, validation.since.fp)
    : validation.current.state;

  return {
    accountId,
    oldState: args.sinceState as string,
    newState,
    hasMoreChanges,
    created: sets.created,
    updated: sets.updated,
    destroyed: sets.destroyed,
    updatedProperties: null,
  };
}

export async function mailboxChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;
  const now = Math.floor(Date.now() / 1000);
  const validation = await validateSinceState(
    db,
    allowed,
    userId,
    args.sinceState,
    now,
  );
  if ("type" in validation) return validation;

  const mailboxRows = await db.all<ChangeRow>(
    groupedChangesSql(allowed, userId, validation.since.seq, "mailbox"),
  );
  const sets = classify(mailboxRows);
  const created = new Set(sets.created);
  const destroyed = new Set(sets.destroyed);
  const updated = new Set(sets.updated);

  const inboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const changedInboxes = await db.all<{ inbox: string }>(sql`
    SELECT DISTINCT jc.inbox AS inbox
    FROM jmap_changes jc
    WHERE jc.seq > ${validation.since.seq}
      AND jc.object_type = 'email'
      AND jc.inbox IS NOT NULL
      ${inboxScope}
      AND (jc.user_id IS NULL OR jc.user_id = ${userId})
    ORDER BY jc.inbox
  `);

  const currentMailboxes = await db.select().from(mailboxes);
  for (const row of changedInboxes) {
    const inbox = row.inbox.toLowerCase();
    for (const role of SYSTEM_MAILBOX_ROLES) {
      updated.add(systemMailboxId(inbox, role));
    }
    for (const mailbox of currentMailboxes) {
      if (mailbox.inbox.toLowerCase() === inbox) {
        updated.add(customMailboxId(mailbox.id));
      }
    }
  }

  for (const id of created) updated.delete(id);
  for (const id of destroyed) updated.delete(id);

  const total = created.size + updated.size + destroyed.size;
  if (total > requestedMax) return { type: "cannotCalculateChanges" };

  return {
    accountId,
    oldState: args.sinceState as string,
    newState: validation.current.state,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
    updatedProperties:
      mailboxRows.length === 0
        ? ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]
        : null,
  };
}

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
