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
  /**
   * "Keep as a new draft": start over, unlinked from the JMAP draft (which
   * stays where it is); on a `jmap:` surface the copy also moves to its own.
   */
  fresh?: boolean;
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

/** Empty text is no value: '' and null compare equal after this. */
function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

/** An empty recipient list is no value, like a missing one. */
function listOrNull(value: DraftCcEntry[] | null | undefined): string | null {
  return value && value.length > 0 ? JSON.stringify(value) : null;
}

/**
 * The kept-attachments choice, stored with the JMAP revision it was made on:
 * part ids renumber on every publish, so a choice for another revision is
 * ignored by its readers (web-drafts `keptParts`).
 */
export function keptChoiceJson(
  ids: string[],
  rev: string | null | undefined,
): string | null {
  return rev ? JSON.stringify({ rev, ids }) : null;
}

export async function upsertDraft(
  db: DrizzleD1Database<any>,
  userId: string,
  input: DraftUpsertInput,
): Promise<typeof drafts.$inferSelect> {
  const now = Math.floor(Date.now() / 1000);
  // Normalised, so a save that repeats what the draft holds changes nothing:
  // the composer sends '' and [] where a seeded draft holds null.
  const fromAddress = textOrNull(input.fromAddress?.trim().toLowerCase());
  const to = textOrNull(input.to?.trim());
  const cc = listOrNull(input.cc);
  const subject = textOrNull(input.subject);
  const bodyHtml = textOrNull(input.bodyHtml);
  const bodyText = textOrNull(input.bodyText);
  const replyToEmailId = textOrNull(input.replyToEmailId);
  const bcc = input.bcc !== undefined ? listOrNull(input.bcc) : null;
  // Sent only once the user removed a chip, with the revision it saw.
  const kept =
    input.keptAttachments !== undefined
      ? keptChoiceJson(input.keptAttachments, input.keptAttachmentsRev)
      : null;
  const fresh = input.fresh === true ? 1 : 0;

  // Shared drafts. One statement, so every expression reads the old row:
  // - `dirty` only when a field really changed (opening and closing a draft
  //   without editing makes no new JMAP revision);
  // - a Bcc or kept choice the caller omits stays as it is;
  // - `fresh` (the user's "keep as a new draft") starts a new draft: the link
  //   and the old choices go, and the previous JMAP draft stays where it is.
  const bccNext = input.bcc !== undefined ? sql`excluded.bcc` : sql`drafts.bcc`;
  const keptNext =
    input.keptAttachments !== undefined && kept !== null
      ? sql`excluded.attachments_json`
      : sql`drafts.attachments_json`;
  const changed = sql`NOT (drafts.from_address IS excluded.from_address
      AND drafts.to_address IS excluded.to_address AND drafts.cc IS excluded.cc
      AND drafts.subject IS excluded.subject AND drafts.body_html IS excluded.body_html
      AND drafts.body_text IS excluded.body_text
      AND drafts.reply_to_email_id IS excluded.reply_to_email_id
      AND drafts.bcc IS ${bccNext} AND drafts.attachments_json IS ${keptNext})`;
  await db.run(sql`
    INSERT INTO drafts (id, user_id, context_key, from_address, to_address, cc, subject,
                        body_html, body_text, reply_to_email_id, bcc, attachments_json,
                        dirty, created_at, updated_at)
    VALUES (${input.id ?? nanoid()}, ${userId}, ${input.contextKey}, ${fromAddress},
            ${to}, ${cc}, ${subject}, ${bodyHtml}, ${bodyText}, ${replyToEmailId},
            ${bcc}, ${kept}, 1, ${now}, ${now})
    ON CONFLICT (user_id, context_key) DO UPDATE SET
      from_address = excluded.from_address,
      to_address = excluded.to_address,
      cc = excluded.cc,
      subject = excluded.subject,
      body_html = excluded.body_html,
      body_text = excluded.body_text,
      reply_to_email_id = excluded.reply_to_email_id,
      bcc = ${bccNext},
      attachments_json = CASE WHEN ${fresh} = 1 THEN NULL ELSE ${keptNext} END,
      jmap_draft_id = CASE WHEN ${fresh} = 1 THEN NULL ELSE drafts.jmap_draft_id END,
      jmap_state = CASE WHEN ${fresh} = 1 THEN NULL ELSE drafts.jmap_state END,
      dirty = CASE WHEN ${fresh} = 1 OR ${changed} THEN 1 ELSE drafts.dirty END,
      updated_at = excluded.updated_at
  `);
  // "Keep as a new draft" on a mail-client draft's surface (jmap:<id>) moves
  // the copy to a surface of its own, so the mail-client draft, if it comes
  // back, is listed under its own key and never shares one with the copy.
  let contextKey = input.contextKey;
  if (input.fresh === true && contextKey.startsWith("jmap:")) {
    const moved = `draft:${nanoid()}`;
    await db
      .update(drafts)
      .set({ contextKey: moved })
      .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)));
    contextKey = moved;
  }

  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);

  if (!row) {
    throw new Error("Draft upsert did not return a row");
  }
  return row;
}
