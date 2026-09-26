import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import {
  inboxScopeSql,
  isInboxAllowed,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  contentEmailObject,
  deleteContentIfUnreferenced,
  type JmapContentRow,
} from "./content";
import { systemMailboxId } from "./ids";
import { publicDraftEmailId } from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type JmapDraftRow = typeof jmapDrafts.$inferSelect;
export type DraftWithContent = { draft: JmapDraftRow; content: JmapContentRow };

const DRAFT_ID_CHUNK = 90;

/** The caller's drafts in allowed inboxes, keyed by internal draft id. */
export async function loadDraftsByIds(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  draftIds: string[],
): Promise<Map<string, DraftWithContent>> {
  const unique = [...new Set(draftIds)];
  const result = new Map<string, DraftWithContent>();
  for (let start = 0; start < unique.length; start += DRAFT_ID_CHUNK) {
    const rows = await db
      .select({ draft: jmapDrafts, content: jmapMessageContent })
      .from(jmapDrafts)
      .innerJoin(
        jmapMessageContent,
        eq(jmapMessageContent.id, jmapDrafts.contentId),
      )
      .where(
        and(
          eq(jmapDrafts.userId, userId),
          inArray(jmapDrafts.id, unique.slice(start, start + DRAFT_ID_CHUNK)),
        ),
      );
    for (const row of rows) {
      if (isInboxAllowed(allowed, row.draft.inbox))
        result.set(row.draft.id, row);
    }
  }
  return result;
}

/** The caller's drafts in allowed inboxes, newest first. */
export async function listDrafts(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  limit: number,
): Promise<DraftWithContent[]> {
  return db
    .select({ draft: jmapDrafts, content: jmapMessageContent })
    .from(jmapDrafts)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, jmapDrafts.contentId),
    )
    .where(
      and(
        eq(jmapDrafts.userId, userId),
        sql`1 = 1 ${inboxScopeSql(allowed, sql`${jmapDrafts.inbox}`)}`,
      ),
    )
    .orderBy(desc(jmapDrafts.receivedAt), desc(jmapDrafts.id))
    .limit(limit);
}

export function draftKeywords(draft: JmapDraftRow): Record<string, true> {
  const keywords: Record<string, true> = { $draft: true };
  if (draft.seen) keywords.$seen = true;
  if (draft.flagged) keywords.$flagged = true;
  return keywords;
}

export function draftMailboxIds(draft: JmapDraftRow): Record<string, true> {
  const role = draft.mailboxRole === "trash" ? "trash" : "drafts";
  return { [systemMailboxId(draft.inbox, role)]: true };
}

export function draftEmailObject(
  item: DraftWithContent,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  return contentEmailObject(
    item.content,
    {
      id: publicDraftEmailId(item.draft.id),
      mailboxIds: draftMailboxIds(item.draft),
      keywords: draftKeywords(item.draft),
      receivedAt: item.draft.receivedAt,
    },
    args,
  );
}

export async function updateDraftState(
  db: Db,
  draft: JmapDraftRow,
  next: { mailboxRole: "drafts" | "trash"; seen: boolean; flagged: boolean },
  now: number,
): Promise<void> {
  const seen = next.seen ? 1 : 0;
  const flagged = next.flagged ? 1 : 0;
  if (
    next.mailboxRole === draft.mailboxRole &&
    seen === draft.seen &&
    flagged === draft.flagged
  ) {
    return;
  }
  await db
    .update(jmapDrafts)
    .set({ mailboxRole: next.mailboxRole, seen, flagged, updatedAt: now })
    .where(
      and(eq(jmapDrafts.id, draft.id), eq(jmapDrafts.userId, draft.userId)),
    );
}

/** Delete the draft row, then its content if nothing else references it. */
export async function destroyDraft(
  db: Db,
  env: CloudflareBindings,
  draft: JmapDraftRow,
): Promise<void> {
  await db
    .delete(jmapDrafts)
    .where(
      and(eq(jmapDrafts.id, draft.id), eq(jmapDrafts.userId, draft.userId)),
    );
  try {
    await deleteContentIfUnreferenced(db, env, draft.contentId);
  } catch (error) {
    // The draft is gone either way; content GC retries the cleanup.
    console.error(
      `[jmap] content cleanup for draft ${draft.id} failed:`,
      error,
    );
  }
}
