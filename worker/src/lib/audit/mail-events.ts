import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { MessageRef } from "../messages/types";
import { currentAuditActor } from "./context";
import { AUDIT_ACTIONS, type AuditAction } from "./events";
import { recordAudit, recordBulkAudit } from "./record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

type StateMessage = { ref: MessageRef; inbox: string };
type MailboxFlags = { archived: boolean; spam: boolean; trashed: boolean };
type MailboxChanges = { archived?: boolean; spam?: boolean; trashed?: boolean };

const refId = (ref: MessageRef) => `${ref.kind}:${ref.id}`;
const messages = (n: number) => (n === 1 ? "1 message" : `${n} messages`);
const conversations = (n: number) =>
  n === 1 ? "1 conversation" : `${n} conversations`;

function byInbox<T extends { inbox: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.inbox) ?? [];
    group.push(item);
    groups.set(item.inbox, group);
  }
  return groups;
}

/**
 * Whether a shared-state change by this caller is worth a row. A person, an
 * API key, an MCP or JMAP client and the agent all pass a user id. A rule or
 * the system passes none: their per-message filing is routine and counted by
 * `rules.match_count` instead.
 */
function actedByPerson(userId: string | null): boolean {
  return userId !== null;
}

/**
 * The shared flags of these messages before a change. Only needed when a
 * change clears a flag: "restored" is true only of a message that was in
 * Trash, and a JMAP move to Inbox clears all three whatever was set.
 */
export async function mailboxFlagsBefore(
  db: Db,
  resolved: StateMessage[],
): Promise<Map<string, MailboxFlags>> {
  const before = new Map<string, MailboxFlags>();
  if (resolved.length === 0) return before;
  const rows = await db.all<{
    kind: string;
    id: string;
    archived_at: number | null;
    spam_at: number | null;
    trashed_at: number | null;
  }>(sql`
    SELECT mms.message_kind AS kind, mms.message_id AS id,
      mms.archived_at, mms.spam_at, mms.trashed_at
    FROM json_each(${JSON.stringify(
      resolved.map((message) => [message.ref.kind, message.ref.id]),
    )}) ref
    JOIN mailbox_message_state mms
      ON mms.message_kind = json_extract(ref.value, '$[0]')
      AND mms.message_id = json_extract(ref.value, '$[1]')
  `);
  for (const row of rows) {
    before.set(`${row.kind}:${row.id}`, {
      archived: row.archived_at !== null,
      spam: row.spam_at !== null,
      trashed: row.trashed_at !== null,
    });
  }
  return before;
}

/** True when recording this change needs `mailboxFlagsBefore`. */
export function needsFlagsBefore(
  userId: string | null,
  changes: MailboxChanges,
): boolean {
  return (
    actedByPerson(userId) &&
    (changes.archived === false ||
      changes.spam === false ||
      changes.trashed === false)
  );
}

const STATE_EVENTS: {
  key: keyof MailboxChanges;
  set: [AuditAction, (n: number, inbox: string) => string];
  cleared: [AuditAction, (n: number, inbox: string) => string];
}[] = [
  {
    key: "archived",
    set: [
      AUDIT_ACTIONS.mailArchived,
      (n, inbox) => `Archived ${messages(n)} in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailUnarchived,
      (n, inbox) => `Moved ${messages(n)} out of Archive in ${inbox}`,
    ],
  },
  {
    key: "spam",
    set: [
      AUDIT_ACTIONS.mailSpam,
      (n, inbox) => `Marked ${messages(n)} as junk in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailNotSpam,
      (n, inbox) => `Marked ${messages(n)} as not junk in ${inbox}`,
    ],
  },
  {
    key: "trashed",
    set: [
      AUDIT_ACTIONS.mailTrashed,
      (n, inbox) => `Moved ${messages(n)} to Trash in ${inbox}`,
    ],
    cleared: [
      AUDIT_ACTIONS.mailRestored,
      (n, inbox) => `Restored ${messages(n)} from Trash in ${inbox}`,
    ],
  },
];

/**
 * Records a `setMailboxState` call: one row per inbox and per flag that
 * changed. Setting a flag is recorded as asked; clearing one only for the
 * messages that had it. A rule is recorded only when it marks mail as junk.
 */
export async function auditMailboxState(
  db: Db,
  userId: string | null,
  resolved: StateMessage[],
  changes: MailboxChanges,
  before: Map<string, MailboxFlags> | null,
): Promise<void> {
  const person = actedByPerson(userId);
  const rule = currentAuditActor().actorType === "rule";
  if (!person && !rule) return;

  for (const event of STATE_EVENTS) {
    const value = changes[event.key];
    if (value === undefined) continue;
    if (!person && !(event.key === "spam" && value === true)) continue;

    const affected = value
      ? resolved
      : resolved.filter(
          (message) => before?.get(refId(message.ref))?.[event.key] === true,
        );
    const [action, sentence] = value ? event.set : event.cleared;
    for (const [inbox, group] of byInbox(affected)) {
      await recordBulkAudit(db, {
        action,
        targetType: "message",
        inbox,
        refs: group.map((message) => refId(message.ref)),
        summary: (n) => sentence(n, inbox),
      });
    }
  }
}

/** Records a `setMailboxMembership` call: one row per folder and direction. */
export async function auditMailboxMembership(
  db: Db,
  userId: string | null,
  resolved: StateMessage[],
  folders: { id: string; name: string; inbox: string }[],
  direction: "added" | "removed",
): Promise<void> {
  if (!actedByPerson(userId)) return;
  for (const folder of folders) {
    await recordBulkAudit(db, {
      action: AUDIT_ACTIONS.mailMoved,
      targetType: "message",
      inbox: folder.inbox,
      refs: resolved.map((message) => refId(message.ref)),
      summary: (n) =>
        direction === "added"
          ? `Filed ${messages(n)} into '${folder.name}'`
          : `Removed ${messages(n)} from '${folder.name}'`,
      details: { folderId: folder.id, folder: folder.name, direction },
    });
  }
}

/** Records a snooze or an unsnooze, one row per inbox. */
export async function auditSnooze(
  db: Db,
  userId: string | null,
  resolved: { inbox: string; conversationKey: string }[],
  until: number | null,
): Promise<void> {
  if (!actedByPerson(userId)) return;
  for (const [inbox, group] of byInbox(resolved)) {
    await recordBulkAudit(db, {
      action:
        until === null
          ? AUDIT_ACTIONS.mailUnsnoozed
          : AUDIT_ACTIONS.mailSnoozed,
      targetType: "conversation",
      inbox,
      refs: group.map((conversation) => conversation.conversationKey),
      summary: (n) =>
        until === null
          ? `Unsnoozed ${conversations(n)} in ${inbox}`
          : `Snoozed ${conversations(n)} in ${inbox} until ${new Date(until * 1000).toISOString()}`,
      ...(until === null ? {} : { details: { until } }),
    });
  }
}

/** Records an assignment or an unassignment, one row per inbox. */
export async function auditAssign(
  db: Db,
  actorUserId: string | null,
  resolved: { inbox: string; conversationKey: string }[],
  assignee: { id: string; email: string } | null,
): Promise<void> {
  if (!actedByPerson(actorUserId)) return;
  for (const [inbox, group] of byInbox(resolved)) {
    await recordBulkAudit(db, {
      action: assignee
        ? AUDIT_ACTIONS.mailAssigned
        : AUDIT_ACTIONS.mailUnassigned,
      targetType: "conversation",
      inbox,
      refs: group.map((conversation) => conversation.conversationKey),
      summary: (n) =>
        assignee
          ? `Assigned ${conversations(n)} in ${inbox} to ${assignee.email}`
          : `Unassigned ${conversations(n)} in ${inbox}`,
      ...(assignee
        ? { details: { assigneeUserId: assignee.id, assignee: assignee.email } }
        : {}),
    });
  }
}

/**
 * Records a message handed to the provider or to the outbox's retries. A
 * send the provider refused, or one dropped because every recipient is
 * suppressed, sent nothing and is not recorded.
 */
export async function auditMailSent(
  db: Db,
  sent: {
    id: string;
    from: string;
    to: string;
    /** Recipients besides `to`: further To, Cc and Bcc. */
    otherRecipients?: number;
    subject: string | null;
    status: string;
    templateSlug?: string | null;
    /** For a reply: whether it followed the original's Reply-To. */
    repliedTo?: "reply_to" | "sender";
  },
): Promise<void> {
  if (!["sent", "retrying", "scheduled"].includes(sent.status)) return;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.mailSent,
    targetType: "message",
    targetId: `sent:${sent.id}`,
    inbox: sent.from,
    summary: `Sent '${sent.subject ?? ""}' to ${sent.to} from ${sent.from}`,
    details: {
      sentEmailId: sent.id,
      to: sent.to,
      otherRecipients: sent.otherRecipients ?? 0,
      status: sent.status,
      ...(sent.templateSlug ? { templateSlug: sent.templateSlug } : {}),
      ...(sent.repliedTo ? { repliedTo: sent.repliedTo } : {}),
    },
  });
}

/**
 * Records hard-deleted messages, one row per inbox. A single message is named
 * by its subject: after the delete nothing else says what it was.
 */
export async function auditMailDeleted(
  db: Db,
  deleted: { ref: MessageRef; inbox: string; subject?: string | null }[],
): Promise<void> {
  for (const [inbox, group] of byInbox(deleted)) {
    const subject = group.length === 1 ? group[0].subject : null;
    await recordBulkAudit(db, {
      action: AUDIT_ACTIONS.mailDeleted,
      targetType: "message",
      inbox,
      refs: group.map((message) => refId(message.ref)),
      summary: (n) =>
        n === 1 && subject
          ? `Deleted '${subject}' from ${inbox}`
          : `Deleted ${messages(n)} from ${inbox}`,
    });
  }
}
