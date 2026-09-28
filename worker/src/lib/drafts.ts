import type { DrizzleD1Database } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { drafts } from "../db/drafts.schema";

export type DraftCcEntry = {
  email: string;
  name?: string | null;
};

export type DraftUpsertInput = {
  id?: string;
  contextKey: string;
  fromAddress?: string;
  to?: string;
  cc?: DraftCcEntry[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  replyToEmailId?: string | null;
  /** Shared drafts: Bcc recipients; omitted leaves them as they are. */
  bcc?: DraftCcEntry[];
  /**
   * Shared drafts: part ids of the linked JMAP revision's attachments to keep;
   * omitted leaves the choice as it is.
   */
  keptAttachments?: string[];
  /** The JMAP revision (`jmap_draft_id`) `keptAttachments` was chosen on. */
  keptAttachmentsRev?: string | null;
};

export async function getDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  contextKey: string,
): Promise<typeof drafts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);
  return row ?? null;
}

export async function upsertDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  input: DraftUpsertInput,
): Promise<typeof drafts.$inferSelect> {
  const now = Math.floor(Date.now() / 1000);
  const cc = input.cc ? JSON.stringify(input.cc) : null;
  const fromAddress = input.fromAddress?.trim().toLowerCase() ?? null;
  const bcc = input.bcc !== undefined ? JSON.stringify(input.bcc) : null;
  const kept =
    input.keptAttachments !== undefined
      ? JSON.stringify(input.keptAttachments)
      : null;

  // Shared drafts. One statement, so every expression reads the old row:
  // - `dirty` only when a field really changed (opening and closing a draft
  //   without editing makes no new JMAP revision);
  // - a Bcc or kept-attachments list the caller omits stays as it is;
  // - a kept list applies only to the revision it was chosen on (part ids
  //   renumber on every publish), otherwise it is ignored;
  // - editing a copy whose JMAP draft is gone (sent or deleted in a mail
  //   client) starts a new draft: the link and the old choices go.
  const bccSet = input.bcc !== undefined;
  const keptSet = input.keptAttachments !== undefined;
  const bccNext = bccSet ? sql`excluded.bcc` : sql`drafts.bcc`;
  const keptNext = keptSet
    ? sql`CASE WHEN drafts.jmap_draft_id IS ${input.keptAttachmentsRev ?? null}
            THEN excluded.attachments_json ELSE drafts.attachments_json END`
    : sql`drafts.attachments_json`;
  const changed = sql`NOT (drafts.from_address IS excluded.from_address
      AND drafts.to_address IS excluded.to_address AND drafts.cc IS excluded.cc
      AND drafts.subject IS excluded.subject AND drafts.body_html IS excluded.body_html
      AND drafts.body_text IS excluded.body_text
      AND drafts.reply_to_email_id IS excluded.reply_to_email_id
      AND drafts.bcc IS ${bccNext} AND drafts.attachments_json IS ${keptNext})`;
  const restart = sql`(drafts.jmap_state = 'gone' AND ${changed})`;
  await db.run(sql`
    INSERT INTO drafts (id, user_id, context_key, from_address, to_address, cc, subject,
                        body_html, body_text, reply_to_email_id, bcc, attachments_json,
                        dirty, created_at, updated_at)
    VALUES (${input.id ?? nanoid()}, ${userId}, ${input.contextKey}, ${fromAddress},
            ${input.to ?? null}, ${cc}, ${input.subject ?? null}, ${input.bodyHtml ?? null},
            ${input.bodyText ?? null}, ${input.replyToEmailId ?? null}, ${bcc}, ${kept},
            1, ${now}, ${now})
    ON CONFLICT (user_id, context_key) DO UPDATE SET
      from_address = excluded.from_address,
      to_address = excluded.to_address,
      cc = excluded.cc,
      subject = excluded.subject,
      body_html = excluded.body_html,
      body_text = excluded.body_text,
      reply_to_email_id = excluded.reply_to_email_id,
      bcc = ${bccNext},
      attachments_json = CASE WHEN ${restart} THEN NULL ELSE ${keptNext} END,
      jmap_draft_id = CASE WHEN ${restart} THEN NULL ELSE drafts.jmap_draft_id END,
      jmap_state = CASE WHEN ${restart} THEN NULL ELSE drafts.jmap_state END,
      dirty = CASE WHEN ${changed} THEN 1 ELSE drafts.dirty END,
      updated_at = excluded.updated_at
  `);

  const [row] = await db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.userId, userId), eq(drafts.contextKey, input.contextKey)),
    )
    .limit(1);

  if (!row) {
    throw new Error("Draft upsert did not return a row");
  }
  return row;
}
