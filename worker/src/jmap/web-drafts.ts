// Shared drafts (spec 2026-09-28-shared-drafts, slice 1): the web composer's
// working copy (`drafts`) is published as a JMAP draft. JMAP content is
// immutable, so each publish is a new revision: create the new JMAP draft, link
// the working copy to it with a compare-and-set, then destroy the previous one.
// Publishing happens at coarse moments (composer close, 60 s idle), never per
// keystroke.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drafts } from "../db/drafts.schema";
import { emails } from "../db/emails.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { createEmailSender, type EmailSender } from "../lib/email-sender";
import {
  inboxFilter,
  isInboxAllowed,
  type AllowedInboxes,
} from "../lib/inbox-permissions";
import {
  contentLeaves,
  deleteContentIfUnreferenced,
  type ContentLeaf,
  type ContentPart,
} from "./content";
import { createDraftEmail, Rejection } from "./email-create";
import { listUsableIdentities } from "./mailboxes";
import { isMethodError } from "./on-success";
import { emailSubmissionSet } from "./submission";
import {
  parseDraftEmailId,
  publicBodyPartBlobId,
  publicCustomMailboxId,
  publicAccountId,
  publicDraftEmailId,
  publicIdentityId,
  publicSystemMailboxId,
} from "./public-ids";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;
type WorkingCopy = typeof drafts.$inferSelect;

export type PublishOutcome =
  /** A new revision is the JMAP draft now. */
  | { status: "published"; jmapDraftId: string }
  /**
   * No new revision: `clean` when nothing changed since the last publish,
   * otherwise another publish linked first (the copy is still dirty).
   */
  | { status: "unchanged"; jmapDraftId: string | null; clean: boolean }
  /** Not publishable yet (no From, an incomplete To, …); stays dirty. */
  | { status: "skipped"; reason: string; code: SkipCode }
  /** Its JMAP draft was sent or deleted elsewhere; publishing stopped. */
  | { status: "gone" }
  /** No working copy for this surface. */
  | { status: "notFound" };

/** Why a working copy can't be published yet. */
export type SkipCode = "noFrom" | "noIdentity" | "invalid";

/** The bare `id` of a `<id>` Message-ID header value. */
function bareMessageId(value: string | null): string | null {
  const trimmed = value?.trim().replace(/^<|>$/g, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The web reply's threading, as `replyToEmail` sends it: In-Reply-To and
 * References are the original's Message-ID (received or sent).
 */
async function replyThreading(
  db: Db,
  replyToEmailId: string | null,
): Promise<string | null> {
  if (!replyToEmailId) return null;
  const [received] = await db
    .select({ messageId: emails.messageId })
    .from(emails)
    .where(eq(emails.id, replyToEmailId))
    .limit(1);
  if (received) return bareMessageId(received.messageId);
  const [sent] = await db
    .select({ messageId: sentEmails.messageId })
    .from(sentEmails)
    .where(eq(sentEmails.id, replyToEmailId))
    .limit(1);
  return sent ? bareMessageId(sent.messageId) : null;
}

function parseCc(
  value: string | null,
): { email: string; name?: string | null }[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** A stored upload the next revision attaches. */
export type ExtraAttachment = { blobId: string; type: string; name: string };

/** Comma- or semicolon-separated addresses, as the web To field holds them. */
function splitAddresses(value: string | null): string[] {
  return (value ?? "")
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

async function loadContent(db: Db, contentId: string) {
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, contentId))
    .limit(1);
  return content ?? null;
}

/** The Email/set create a working copy publishes as, or why it can't yet. */
async function createInput(
  db: Db,
  allowed: AllowedInboxes,
  row: WorkingCopy,
  previous: typeof jmapDrafts.$inferSelect | null,
  extraAttachments: ExtraAttachment[] = [],
  appendHtml: string | null = null,
): Promise<{
  input: Record<string, unknown> | null;
  reason: string | null;
  code: SkipCode | null;
}> {
  const from = row.fromAddress?.trim().toLowerCase();
  // Spec S7: a draft with no From isn't published until it has one.
  if (!from) return { input: null, reason: "no From yet", code: "noFrom" };
  const identity = (await listUsableIdentities(db, allowed)).find(
    (candidate) => candidate.email.trim().toLowerCase() === from,
  );
  if (!identity) {
    return {
      input: null,
      reason: "From isn't a usable identity",
      code: "noIdentity",
    };
  }

  // Slice 2: a revision is a patch on the previous one. Everything the web
  // composer can't show (Bcc, Reply-To, threading, attachments, To names) rides
  // along from the previous revision's content untouched.
  const prior = previous ? await loadContent(db, previous.contentId) : null;
  const priorTo = prior
    ? (JSON.parse(prior.toJson) as { name: string | null; email: string }[])
    : [];
  const to = splitAddresses(row.toAddress).map((email) => {
    const known = priorTo.find(
      (address) => address.email.toLowerCase() === email.toLowerCase(),
    );
    return known?.name ? { email, name: known.name } : { email };
  });
  const cc = parseCc(row.cc)
    .map((entry) => ({
      email: entry.email.trim(),
      ...(entry.name ? { name: entry.name } : {}),
    }))
    .filter((entry) => entry.email.length > 0);
  // A send adds the signature to the revision it sends, never to the working
  // copy, so a failed send can't sign twice.
  const html = appendHtml
    ? `${row.bodyHtml ?? ""}${appendHtml}`
    : (row.bodyHtml ?? "");
  const text = row.bodyText ?? "";
  const bodyValues: Record<string, { value: string }> = {};
  const textBody: Record<string, unknown>[] = [];
  const htmlBody: Record<string, unknown>[] = [];
  if (text.length > 0 || html.length === 0) {
    bodyValues.t = { value: text };
    textBody.push({ partId: "t", type: "text/plain" });
  }
  if (html.length > 0) {
    bodyValues.h = { value: html };
    htmlBody.push({ partId: "h", type: "text/html" });
  }

  const mailboxIds: Record<string, true> = {
    [publicSystemMailboxId(from, "drafts")]: true,
  };
  // A new revision stays in the custom folders the last one was filed in, as
  // long as it stays in that inbox (folders belong to one inbox).
  if (previous && previous.inbox === from) {
    for (const folder of JSON.parse(previous.folderIds) as string[]) {
      mailboxIds[publicCustomMailboxId(folder)] = true;
    }
  }
  const keywords: Record<string, true> = { $draft: true, $seen: true };
  if (previous?.flagged) keywords.$flagged = true;

  const inReplyTo = await replyThreading(db, row.replyToEmailId);
  const carried: Record<string, unknown> = {};
  if (prior && previous) {
    // Bcc: the composer's once it has set them, else the revision's.
    const bcc =
      row.bcc !== null
        ? (JSON.parse(row.bcc) as { email: string; name?: string | null }[])
        : (JSON.parse(prior.bccJson) as unknown[]);
    if (bcc.length > 0) carried.bcc = bcc;
    if (prior.replyToJson) carried.replyTo = JSON.parse(prior.replyToJson);
    // The draft keeps one Message-ID across revisions.
    carried.messageId = [prior.messageId];
    if (!inReplyTo) {
      if (prior.inReplyToJson)
        carried.inReplyTo = JSON.parse(prior.inReplyToJson);
      if (prior.referencesJson)
        carried.references = JSON.parse(prior.referencesJson);
    }
    const leaves = new Map(
      contentLeaves(JSON.parse(prior.partsJson) as ContentPart).map((leaf) => [
        leaf.partId,
        leaf,
      ]),
    );
    // The stored attachments the composer kept (all, until it chose).
    const kept = keptParts(row);
    const attachments = (JSON.parse(prior.attachmentsJson) as string[])
      .map((partId) => leaves.get(partId))
      .filter((leaf): leaf is ContentLeaf => leaf !== undefined)
      // Inline parts are always kept: the HTML refers to them.
      .filter(
        (leaf) => isInlinePart(leaf) || kept === null || kept.has(leaf.partId),
      )
      .map((leaf) => ({
        blobId: publicBodyPartBlobId(
          publicDraftEmailId(previous.id),
          leaf.partId,
        ),
        type: leaf.type,
        ...(leaf.name ? { name: leaf.name } : {}),
        ...(leaf.disposition ? { disposition: leaf.disposition } : {}),
        ...(leaf.cid ? { cid: leaf.cid } : {}),
      }));
    if (attachments.length > 0) carried.attachments = attachments;
  }
  // A draft published for the first time: the composer's Bcc.
  if (!prior && row.bcc !== null) {
    const bcc = JSON.parse(row.bcc) as unknown[];
    if (bcc.length > 0) carried.bcc = bcc;
  }
  // Files the web composer added (slice 4: uploaded at send time).
  if (extraAttachments.length > 0) {
    carried.attachments = [
      ...((carried.attachments as unknown[] | undefined) ?? []),
      ...extraAttachments,
    ];
  }
  return {
    input: {
      mailboxIds,
      keywords,
      from: [
        {
          email: from,
          ...(identity.displayName ? { name: identity.displayName } : {}),
        },
      ],
      to,
      cc,
      subject: row.subject ?? "",
      ...(inReplyTo ? { inReplyTo: [inReplyTo], references: [inReplyTo] } : {}),
      ...carried,
      bodyValues,
      textBody,
      htmlBody,
    },
    reason: null,
    code: null,
  };
}

/**
 * A part the HTML body may refer to by Content-ID (inline image): it stays
 * with the HTML, whatever its disposition says.
 */
function isInlinePart(leaf: ContentLeaf): boolean {
  // Some mailers give every attachment a Content-ID: one marked as an
  // attachment is a real attachment (a chip), whatever its Content-ID.
  return leaf.cid !== null && leaf.disposition !== "attachment";
}

/**
 * The part ids a working copy keeps, if it chose on the revision it is linked
 * to; null keeps them all. A choice made on another revision is ignored: part
 * ids renumber on every publish.
 */
function keptParts(
  row: Pick<WorkingCopy, "attachmentsJson" | "jmapDraftId">,
): Set<string> | null {
  if (!row.attachmentsJson || !row.jmapDraftId) return null;
  try {
    const choice = JSON.parse(row.attachmentsJson) as {
      rev?: unknown;
      ids?: unknown;
    };
    if (choice.rev !== row.jmapDraftId || !Array.isArray(choice.ids)) {
      return null;
    }
    return new Set(
      choice.ids.filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return null;
  }
}

/** A JMAP draft that is no longer a draft the web may replace. */
function isGoneDraft(
  draft:
    | Pick<typeof jmapDrafts.$inferSelect, "submitState" | "mailboxRole">
    | undefined,
): boolean {
  // Deleted, being sent (claimed or queued) or moved to Trash in a client.
  return !draft || draft.submitState !== null || draft.mailboxRole !== "drafts";
}

/**
 * Destroy a JMAP draft only while no submission holds it: the check and the
 * delete are one statement, so a client claiming it to send always wins.
 */
async function destroyIfIdle(
  db: Db,
  env: CloudflareBindings,
  jmapDraftId: string,
): Promise<void> {
  const deleted = await env.DB.prepare(
    `DELETE FROM jmap_drafts WHERE id = ? AND submit_state IS NULL RETURNING content_id`,
  )
    .bind(jmapDraftId)
    .first<{ content_id: string }>();
  if (!deleted) return;
  try {
    await deleteContentIfUnreferenced(db, env, deleted.content_id);
  } catch (error) {
    // The draft is gone either way; content GC retries the cleanup.
    console.error(`[drafts] content cleanup for ${jmapDraftId} failed:`, error);
  }
}

/**
 * Publish one working copy (by compose surface) as a new JMAP draft revision.
 * Idempotent and safe to race: only the publish whose compare-and-set links it
 * keeps its revision; a loser destroys what it created.
 */
export async function publishWebDraft(
  db: Db,
  env: CloudflareBindings,
  allowed: AllowedInboxes,
  userId: string,
  contextKey: string,
  options: {
    extraAttachments?: ExtraAttachment[];
    /** HTML appended to the published body only (a send's signature). */
    appendHtml?: string | null;
  } = {},
): Promise<PublishOutcome> {
  const extraAttachments = options.extraAttachments ?? [];
  const appendHtml = options.appendHtml ?? null;
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);
  if (!row) return { status: "notFound" };

  // Spec S6, read live every time (never stored: a draft moved back out of
  // Trash, or whose send was undone, is a draft again): sent (claimed or
  // filed into Sent), deleted or trashed in a mail client.
  let previous: typeof jmapDrafts.$inferSelect | null = null;
  if (row.jmapDraftId) {
    [previous] = await db
      .select()
      .from(jmapDrafts)
      .where(
        and(eq(jmapDrafts.id, row.jmapDraftId), eq(jmapDrafts.userId, userId)),
      )
      .limit(1);
    if (isGoneDraft(previous)) return { status: "gone" };
  }
  if (
    !row.dirty &&
    row.jmapDraftId &&
    extraAttachments.length === 0 &&
    !appendHtml
  ) {
    return { status: "unchanged", jmapDraftId: row.jmapDraftId, clean: true };
  }

  const { input, reason, code } = await createInput(
    db,
    allowed,
    row,
    previous,
    extraAttachments,
    appendHtml,
  );
  if (!input) return { status: "skipped", reason: reason!, code: code! };
  const now = Math.floor(Date.now() / 1000);
  const created = await createDraftEmail(
    {
      db,
      env,
      allowed,
      userId,
      maxAttachmentBytes: createEmailSender(env).maxAttachmentBytes(),
      now,
    },
    input,
  );
  if (created instanceof Rejection) {
    // An address still being typed, a subject too long, …: try again later.
    return {
      status: "skipped",
      reason: `invalid ${(created.error.properties ?? []).join(", ") || created.error.type}`,
      code: "invalid",
    };
  }
  const newId = parseDraftEmailId(created.id)!;

  // Link with a compare-and-set on the revision we replaced; clear `dirty` only
  // if nothing was saved while we published.
  const result = await env.DB.prepare(
    `UPDATE drafts
        SET jmap_draft_id = ?,
            dirty = CASE WHEN ? = 0 AND from_address IS ? AND to_address IS ? AND cc IS ? AND subject IS ?
                               AND body_html IS ? AND body_text IS ? AND reply_to_email_id IS ?
                               AND bcc IS ? AND attachments_json IS ?
                         THEN 0 ELSE 1 END,
            -- The new revision holds exactly the kept attachments.
            attachments_json = CASE WHEN attachments_json IS ? THEN NULL ELSE attachments_json END
      WHERE id = ? AND jmap_draft_id IS ?`,
  )
    .bind(
      newId,
      // A revision that isn't the working copy (it carries a send's signature)
      // leaves the copy dirty.
      appendHtml ? 1 : 0,
      row.fromAddress,
      row.toAddress,
      row.cc,
      row.subject,
      row.bodyHtml,
      row.bodyText,
      row.replyToEmailId,
      row.bcc,
      row.attachmentsJson,
      row.attachmentsJson,
      row.id,
      row.jmapDraftId,
    )
    .run();
  const [fresh] = await db
    .select()
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, newId))
    .limit(1);
  if ((result.meta.changes ?? 0) === 0) {
    // Another publish linked first: ours is a duplicate.
    if (fresh) await destroyIfIdle(db, env, fresh.id);
    const [current] = await db
      .select({ jmapDraftId: drafts.jmapDraftId })
      .from(drafts)
      .where(eq(drafts.id, row.id))
      .limit(1);
    return {
      status: "unchanged",
      jmapDraftId: current?.jmapDraftId ?? null,
      clean: false,
    };
  }
  // The previous revision goes. If a mail client claimed it to send meanwhile,
  // that send wins: ours would repeat its Message-ID, so it goes instead and
  // the copy is gone.
  if (previous) {
    const [still] = await db
      .select()
      .from(jmapDrafts)
      .where(eq(jmapDrafts.id, previous.id))
      .limit(1);
    if (still && still.submitState !== null) {
      // The copy now links to a destroyed revision: it reads as gone.
      if (fresh) await destroyIfIdle(db, env, fresh.id);
      return { status: "gone" };
    }
    if (still) await destroyIfIdle(db, env, still.id);
  }
  return { status: "published", jmapDraftId: newId };
}

/**
 * Deleting a web draft deletes the shared draft: its JMAP draft goes too,
 * unless a submission is sending it.
 */
export async function destroyLinkedJmapDraft(
  db: Db,
  env: CloudflareBindings,
  row: Pick<WorkingCopy, "jmapDraftId" | "userId">,
): Promise<void> {
  if (!row.jmapDraftId) return;
  const [linked] = await db
    .select()
    .from(jmapDrafts)
    .where(
      and(
        eq(jmapDrafts.id, row.jmapDraftId),
        eq(jmapDrafts.userId, row.userId),
      ),
    )
    .limit(1);
  if (linked) await destroyIfIdle(db, env, linked.id);
}

/** The web context key of a JMAP draft that has no working copy yet. */
export function jmapContextKey(jmapDraftId: string): string {
  return `jmap:${jmapDraftId}`;
}

/** The user's own JMAP draft, in Drafts, not being sent, in an allowed inbox. */
async function openableJmapDraft(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
) {
  const [draft] = await db
    .select()
    .from(jmapDrafts)
    .where(and(eq(jmapDrafts.id, jmapDraftId), eq(jmapDrafts.userId, userId)))
    .limit(1);
  if (!draft || draft.submitState !== null) return null;
  // Drafts only: a draft in Trash isn't listed, nor opened back into Drafts.
  if (draft.mailboxRole !== "drafts") return null;
  if (!isInboxAllowed(allowed, draft.inbox)) return null;
  return draft;
}

/** The values of the text/plain and text/html body parts, in order. */
function bodyParts(content: typeof jmapMessageContent.$inferSelect): {
  text: string[];
  html: string[];
} {
  const values = JSON.parse(content.bodyValuesJson) as Record<string, string>;
  const leaves = new Map(
    contentLeaves(JSON.parse(content.partsJson) as ContentPart).map((leaf) => [
      leaf.partId,
      leaf,
    ]),
  );
  const of = (ids: string[], type: string) =>
    ids
      .map((id) => leaves.get(id))
      .filter((leaf): leaf is ContentLeaf => leaf?.type === type)
      .map((leaf) => values[leaf.partId] ?? "");
  return {
    text: of(JSON.parse(content.textBodyJson) as string[], "text/plain"),
    html: of(JSON.parse(content.htmlBodyJson) as string[], "text/html"),
  };
}

/** Text as HTML paragraphs, for a text-only draft opened in the HTML editor. */
function textToHtml(text: string): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escape(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export type OpenOutcome = {
  /** The working copy's context key when opened. */
  contextKey: string | null;
  /** `notFound`, or `multipart` for a body the composer can't edit whole. */
  error: "notFound" | "multipart" | null;
};

/**
 * Open a JMAP draft in the web composer (slice 2): seed a working copy linked
 * to it, not dirty, from its content. An existing working copy for it is
 * reused. A body made of several text or HTML parts (Apple Mail puts images
 * between HTML parts) opens nowhere but in a mail client: editing one part
 * would drop the others.
 */
export async function openJmapDraft(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
): Promise<OpenOutcome> {
  const draft = await openableJmapDraft(db, allowed, userId, jmapDraftId);
  const [linked] = await db
    .select({ contextKey: drafts.contextKey })
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.jmapDraftId, jmapDraftId)))
    .limit(1);
  if (linked && draft) return { contextKey: linked.contextKey, error: null };
  if (!draft) return { contextKey: null, error: "notFound" };
  const content = await loadContent(db, draft.contentId);
  if (!content) return { contextKey: null, error: "notFound" };
  const bodies = bodyParts(content);
  if (bodies.text.length > 1 || bodies.html.length > 1) {
    return { contextKey: null, error: "multipart" };
  }
  const from = (JSON.parse(content.fromJson) as { email: string }[])[0];
  const to = JSON.parse(content.toJson) as { email: string }[];
  const cc = JSON.parse(content.ccJson) as {
    email: string;
    name: string | null;
  }[];
  const bcc = JSON.parse(content.bccJson) as {
    email: string;
    name: string | null;
  }[];
  const text = bodies.text[0] ?? null;
  // The composer edits HTML: a text-only draft opens as the same text.
  const html = bodies.html[0] ?? (text !== null ? textToHtml(text) : null);
  const contextKey = jmapContextKey(jmapDraftId);
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(drafts)
    .values({
      id: nanoid(),
      userId,
      contextKey,
      fromAddress: from?.email.toLowerCase() ?? null,
      // Normalised as upsertDraft stores them ('' and [] are null), so saving
      // the draft back unchanged changes nothing.
      toAddress: to.map((address) => address.email).join(", ") || null,
      cc: cc.length > 0 ? JSON.stringify(cc) : null,
      bcc: bcc.length > 0 ? JSON.stringify(bcc) : null,
      subject: content.subject || null,
      bodyHtml: html || null,
      bodyText: text || null,
      replyToEmailId: null,
      jmapDraftId,
      dirty: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  return { contextKey, error: null };
}

export type LinkedDraftInfo = {
  /** What the draft carries that the composer can't show (kept and sent). */
  extras: string[];
  /** Its stored attachments the composer keeps, for the chips (slice 3). */
  stored: { partId: string; name: string | null; type: string; size: number }[];
  /** The revision those part ids belong to (they renumber on each publish). */
  rev: string | null;
};

/** One load of a working copy's linked revision for the composer. */
export async function linkedDraftInfo(
  db: Db,
  row: Pick<WorkingCopy, "jmapDraftId" | "attachmentsJson">,
): Promise<LinkedDraftInfo> {
  const none: LinkedDraftInfo = { extras: [], stored: [], rev: null };
  if (!row.jmapDraftId) return none;
  const [draft] = await db
    .select({ contentId: jmapDrafts.contentId })
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, row.jmapDraftId))
    .limit(1);
  const content = draft ? await loadContent(db, draft.contentId) : null;
  if (!content) return none;
  const kept = keptParts(row);
  const leaves = new Map(
    contentLeaves(JSON.parse(content.partsJson) as ContentPart).map((leaf) => [
      leaf.partId,
      leaf,
    ]),
  );
  const stored = (JSON.parse(content.attachmentsJson) as string[])
    .map((partId) => leaves.get(partId))
    .filter((leaf): leaf is ContentLeaf => leaf !== undefined)
    // Inline images stay with the HTML that shows them: not removable chips.
    .filter((leaf) => !isInlinePart(leaf))
    .filter((leaf) => kept === null || kept.has(leaf.partId))
    .map((leaf) => ({
      partId: leaf.partId,
      name: leaf.name,
      type: leaf.type,
      size: leaf.size,
    }));
  // Several To, Bcc and stored attachments show in the composer (slice 3);
  // only a Reply-To is still carried unseen.
  const extras: string[] = [];
  if (content.replyToJson) extras.push("a Reply-To address");
  return { extras, stored, rev: row.jmapDraftId };
}

/**
 * Spec S6 on read, computed from the linked draft every time (a stored flag
 * would outlive a draft restored from Trash or a send that was undone): the
 * copy reads as gone while its JMAP draft is missing, being sent or trashed.
 */
export async function refreshGone(
  db: Db,
  row: WorkingCopy,
): Promise<WorkingCopy> {
  if (!row.jmapDraftId) return { ...row, jmapState: null };
  const [draft] = await db
    .select({
      submitState: jmapDrafts.submitState,
      mailboxRole: jmapDrafts.mailboxRole,
    })
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, row.jmapDraftId))
    .limit(1);
  return { ...row, jmapState: isGoneDraft(draft) ? "gone" : null };
}

export type JmapDraftListItem = {
  id: string;
  contextKey: string;
  fromAddress: string;
  toAddress: string | null;
  subject: string | null;
  replyToEmailId: null;
  updatedAt: number;
};

/** The user's JMAP drafts no working copy is linked to (the web lists them too). */
export async function listJmapOnlyDrafts(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  inbox: string | undefined,
): Promise<JmapDraftListItem[]> {
  // Filter by inbox access in SQL, before the limit.
  const scope = inboxFilter(allowed, jmapDrafts.inbox);
  const rows = await db
    .select({
      id: jmapDrafts.id,
      inbox: jmapDrafts.inbox,
      updatedAt: jmapDrafts.updatedAt,
      toJson: jmapMessageContent.toJson,
      subject: jmapMessageContent.subject,
    })
    .from(jmapDrafts)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, jmapDrafts.contentId),
    )
    .where(
      and(
        eq(jmapDrafts.userId, userId),
        eq(jmapDrafts.mailboxRole, "drafts"),
        isNull(jmapDrafts.submitState),
        ...(inbox ? [eq(jmapDrafts.inbox, inbox)] : []),
        ...(scope ? [scope] : []),
        sql`NOT EXISTS (SELECT 1 FROM drafts d WHERE d.user_id = ${userId} AND d.jmap_draft_id = ${jmapDrafts.id})`,
      ),
    )
    .orderBy(desc(jmapDrafts.updatedAt))
    .limit(100);
  return rows.map((row) => {
    const to = JSON.parse(row.toJson) as { email: string }[];
    return {
      id: jmapContextKey(row.id),
      contextKey: jmapContextKey(row.id),
      fromAddress: row.inbox,
      toAddress: to.map((address) => address.email).join(", ") || null,
      subject: row.subject || null,
      replyToEmailId: null,
      updatedAt: row.updatedAt,
    };
  });
}

/** Delete a JMAP-only draft from the web (no working copy exists for it). */
export async function destroyJmapDraftFromWeb(
  db: Db,
  env: CloudflareBindings,
  allowed: AllowedInboxes,
  userId: string,
  jmapDraftId: string,
): Promise<void> {
  const draft = await openableJmapDraft(db, allowed, userId, jmapDraftId);
  if (draft) await destroyIfIdle(db, env, draft.id);
}

export type WebSendOutcome = {
  /** `sent`, or why not: the caller maps these to HTTP answers. */
  status: "sent" | "fallback" | "invalid" | "busy" | "gone" | "refused";
  /** A human-readable reason for everything but `sent`. */
  reason: string | null;
  /** The accepted submission's public id, when sent. */
  submissionId: string | null;
};

/**
 * Send a web draft through the JMAP submission path (spec S4, slice 4): publish
 * its final revision (with any new files, and the signature, on that revision
 * only), then submit it with the draft filed into Sent (the alias), exactly as
 * a JMAP client would. The working copy goes once the submission is created.
 *
 * Only the revision this send built is submitted: a concurrent publish (the
 * idle timer, a second tab) that wins the link makes the send publish again.
 * A copy whose JMAP draft was sent, deleted or trashed elsewhere is `gone`:
 * never sent again from here (a client may still be sending it); the user
 * keeps it as a new draft first. An unedited draft is submitted as it is.
 * An inbox without a sender identity can't send through JMAP: `fallback`.
 */
export async function sendWebDraft(
  db: Db,
  env: CloudflareBindings,
  allowed: AllowedInboxes,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any,
  contextKey: string,
  extraAttachments: ExtraAttachment[],
  sender?: EmailSender,
  appendHtml: string | null = null,
): Promise<WebSendOutcome> {
  let jmapDraftId: string | null = null;
  for (let attempt = 0; attempt < 3 && !jmapDraftId; attempt++) {
    const published = await publishWebDraft(
      db,
      env,
      allowed,
      user.id,
      contextKey,
      { extraAttachments, appendHtml },
    );
    if (published.status === "published") {
      jmapDraftId = published.jmapDraftId;
    } else if (published.status === "gone") {
      return {
        status: "gone",
        reason:
          "This draft was sent, deleted or moved to Trash from a mail client",
        submissionId: null,
      };
    } else if (
      published.status === "unchanged" &&
      published.clean &&
      published.jmapDraftId
    ) {
      // Nothing to add: send the revision as it is (a mail-client draft keeps
      // its exact body structure).
      jmapDraftId = published.jmapDraftId;
    } else if (published.status === "skipped") {
      return {
        status:
          published.code === "noIdentity" || published.code === "noFrom"
            ? "fallback"
            : "invalid",
        reason: published.reason,
        submissionId: null,
      };
    } else if (published.status === "notFound") {
      return {
        status: "invalid",
        reason: "No draft to send",
        submissionId: null,
      };
    } else {
      // Lost the link to a concurrent publish: mark the copy dirty and publish
      // this send's own revision again.
      await db
        .update(drafts)
        .set({ dirty: 1 })
        .where(
          and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)),
        );
    }
  }
  if (!jmapDraftId) {
    return {
      status: "busy",
      reason: "The draft was being saved at the same time; try again",
      submissionId: null,
    };
  }
  const [draft] = await db
    .select()
    .from(jmapDrafts)
    .where(eq(jmapDrafts.id, jmapDraftId))
    .limit(1);
  if (!draft) {
    return {
      status: "busy",
      reason: "The draft changed while sending; try again",
      submissionId: null,
    };
  }
  const draftsMailbox = publicSystemMailboxId(draft.inbox, "drafts");
  const sentMailbox = publicSystemMailboxId(draft.inbox, "sent");
  const outcome = await emailSubmissionSet(
    db,
    allowed,
    user,
    {
      accountId: publicAccountId(user.id),
      create: {
        s: {
          identityId: publicIdentityId(draft.inbox),
          emailId: publicDraftEmailId(jmapDraftId),
        },
      },
      onSuccessUpdateEmail: {
        "#s": {
          "keywords/$draft": null,
          [`mailboxIds/${draftsMailbox}`]: null,
          [`mailboxIds/${sentMailbox}`]: true,
        },
      },
    },
    { env, createdIds: new Map(), sender },
  );
  if (isMethodError(outcome)) {
    return {
      status: "refused",
      reason: outcome.description ?? outcome.type,
      submissionId: null,
    };
  }
  const response = outcome.response as {
    created: Record<string, { id: string }> | null;
    notCreated: Record<string, { type: string; description?: string }> | null;
  };
  const created = response.created?.s;
  if (!created) {
    const error = response.notCreated?.s;
    return {
      status: "refused",
      reason: error?.description ?? error?.type ?? "The message wasn't sent",
      submissionId: null,
    };
  }
  // Sent: the working copy is done (its JMAP draft is the Sent Email now).
  await db
    .delete(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)));
  return { status: "sent", reason: null, submissionId: created.id };
}
