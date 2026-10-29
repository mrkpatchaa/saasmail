import { and, eq, gt, ne, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { deliveryEvents } from "../../db/delivery-events.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { bracketedMessageId } from "../message-id";
import type {
  DeliveryCorrelation,
  DeliveryEvent,
  DeliveryEventOutcome,
  DeliverySuppressionReason,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Soft bounces for one address within the window that suppress it. */
export const SOFT_BOUNCE_THRESHOLD = 3;
export const SOFT_BOUNCE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** The stored id of an event: a redelivery conflicts on it. */
export function deliveryEventId(event: DeliveryEvent): string {
  return `${event.provider}:${event.providerEventId}`;
}

/**
 * The sent message an event is about: one indexed read on
 * `sent_emails.message_id`. Null without a message id or a match.
 */
export async function correlateDeliveryEvent(
  db: Db,
  event: DeliveryEvent,
): Promise<DeliveryCorrelation | null> {
  const messageId = event.messageId?.trim();
  if (!messageId) return null;
  const [row] = await db
    .select({ id: sentEmails.id, campaignId: sentEmails.campaignId })
    .from(sentEmails)
    .where(eq(sentEmails.messageId, bracketedMessageId(messageId)))
    .limit(1);
  return row ? { sentEmailId: row.id, campaignId: row.campaignId } : null;
}

/** Statements an event adds to its batch; each must carry `guard`. */
export type DeliveryBatchExtension = (context: {
  db: Db;
  outcome: DeliveryEventOutcome;
  /** `NOT EXISTS (the event row)`: put it in the statement's WHERE. */
  guard: SQL;
}) => unknown[];

export interface RecordDeliveryEventOptions {
  /** A correlation the caller already looked up (undefined: look it up). */
  correlation?: DeliveryCorrelation | null;
  /** More guarded statements for the same batch, before the event row. */
  extend?: DeliveryBatchExtension;
  now?: number;
}

function suppressionFor(
  event: DeliveryEvent,
  earlierBounces: number,
): DeliverySuppressionReason | null {
  if (event.kind === "bounced" && event.bounceType === "hard") {
    return "hard_bounce";
  }
  if (event.kind === "bounced" && event.bounceType === "soft") {
    return earlierBounces + 1 >= SOFT_BOUNCE_THRESHOLD ? "soft_bounce" : null;
  }
  if (event.kind === "complained") return "complaint";
  if (event.kind === "rejected" && event.rejectionReason === "suppressed") {
    return "provider";
  }
  return null;
}

/**
 * Record one delivery event and apply what it means (docs/suppressions.md):
 * the event row, the suppression and the list unsubscribes commit in one D1
 * batch. Every effect is guarded by the event row's absence and the row goes
 * in last, so a redelivered event changes nothing and returns null, and a
 * failed batch leaves nothing for the queue's retry to trip over.
 */
export async function recordDeliveryEvent(
  db: Db,
  event: DeliveryEvent,
  opts: RecordDeliveryEventOptions = {},
): Promise<DeliveryEventOutcome | null> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const id = deliveryEventId(event);
  const correlation =
    opts.correlation !== undefined
      ? opts.correlation
      : await correlateDeliveryEvent(db, event);

  let earlierBounces = 0;
  if (event.kind === "bounced" && event.bounceType === "soft") {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(deliveryEvents)
      .where(
        and(
          eq(deliveryEvents.recipient, event.recipient),
          gt(
            deliveryEvents.occurredAt,
            event.occurredAt - SOFT_BOUNCE_WINDOW_SECONDS,
          ),
          eq(deliveryEvents.kind, "bounced"),
          ne(deliveryEvents.id, id),
        ),
      );
    earlierBounces = row?.count ?? 0;
  }

  const suppression = suppressionFor(event, earlierBounces);
  const leavesLists =
    suppression === "hard_bounce" || suppression === "complaint";
  const outcome: DeliveryEventOutcome = {
    event,
    sentEmailId: correlation?.sentEmailId ?? null,
    campaignId: correlation?.campaignId ?? null,
    suppression,
    listsLeft: 0,
  };

  const guard = sql`NOT EXISTS (SELECT 1 FROM delivery_events WHERE id = ${id})`;
  const statements: unknown[] = [];
  if (suppression) {
    // A hard bounce outranks whatever reason the address had; the others
    // keep an existing row as it is.
    const onConflict =
      suppression === "hard_bounce"
        ? sql`ON CONFLICT(email) DO UPDATE SET reason = 'hard_bounce', source = excluded.source, note = excluded.note`
        : sql`ON CONFLICT(email) DO NOTHING`;
    statements.push(
      db.run(sql`
        INSERT INTO suppressions (id, email, reason, source, note, created_at)
        SELECT ${nanoid()}, ${event.recipient}, ${suppression}, ${event.provider}, ${event.smtpStatus}, ${now}
        WHERE ${guard}
        ${onConflict}`),
    );
  }
  const listIndex = statements.length;
  if (leavesLists) {
    statements.push(
      db.run(sql`
        UPDATE list_members
           SET status = 'unsubscribed', unsubscribed_at = ${now}, unsubscribe_reason = ${suppression}
         WHERE email = ${event.recipient} AND status = 'subscribed' AND ${guard}`),
    );
  }
  if (opts.extend) statements.push(...opts.extend({ db, outcome, guard }));
  statements.push(
    db
      .insert(deliveryEvents)
      .values({
        id,
        provider: event.provider,
        kind: event.kind,
        bounceType: event.bounceType,
        sentEmailId: outcome.sentEmailId,
        campaignId: outcome.campaignId,
        messageId: event.messageId?.trim()
          ? bracketedMessageId(event.messageId)
          : null,
        recipient: event.recipient,
        sender: event.sender,
        smtpStatus: event.smtpStatus,
        detail: event.detail,
        occurredAt: event.occurredAt,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: deliveryEvents.id }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = (await db.batch(statements as any)) as unknown[];
  const inserted = results[results.length - 1] as { id: string }[];
  if (inserted.length === 0) return null;
  if (leavesLists) {
    const changed = results[listIndex] as { meta?: { changes?: number } };
    outcome.listsLeft = changed?.meta?.changes ?? 0;
  }

  await recordAudit(db, {
    action:
      AUDIT_ACTIONS[
        event.kind === "bounced"
          ? "mailBounced"
          : event.kind === "complained"
            ? "mailComplained"
            : event.kind === "rejected"
              ? "mailRejected"
              : "mailFailed"
      ],
    targetType: "message",
    targetId: outcome.sentEmailId ? `sent:${outcome.sentEmailId}` : null,
    inbox: event.sender,
    // Never the recipient's address (docs/audit-log.md).
    summary: summaryOf(event, outcome),
  });
  return outcome;
}

function summaryOf(
  event: DeliveryEvent,
  outcome: DeliveryEventOutcome,
): string {
  const what =
    event.kind === "bounced"
      ? `${event.bounceType === "hard" ? "Hard" : event.bounceType === "soft" ? "Soft" : "A"} bounce`
      : event.kind === "complained"
        ? "Spam complaint"
        : event.kind === "rejected"
          ? "Rejected by the provider"
          : "Delivery failed";
  const parts = [
    `${what}${event.smtpStatus ? ` (${event.smtpStatus})` : ""}`,
    outcome.sentEmailId ? null : "no matching sent message",
    outcome.suppression ? `suppressed as ${outcome.suppression}` : null,
    outcome.listsLeft > 0 ? `left ${outcome.listsLeft} list(s)` : null,
  ].filter(Boolean);
  return parts.join("; ");
}
