import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  spamModels,
  spamTokens,
  spamTraining,
} from "../../db/spam-filter.schema";
import type { MessageRef } from "../messages/types";
import { modelReady, score, type TokenCounts } from "./score";
import { tokenize, type TokenizableMessage } from "./tokenize";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export type SpamLabel = "spam" | "ham";

export interface SpamModel {
  inbox: string;
  enabled: boolean;
  spamMessages: number;
  hamMessages: number;
}

/** Messages trained per call: a bulk mark trains its first 50. */
export const MAX_TRAINED_PER_CALL = 50;
/** Tokens kept per inbox; the hourly prune removes the least useful. */
export const MAX_TOKENS_PER_INBOX = 100_000;
const PRUNE_BATCH = 1000;
const PRUNE_MAX_BATCHES = 10;

const normalized = (inbox: string) => inbox.trim().toLowerCase();

/** An inbox's filter, or null when it was never set up. */
export async function readSpamModel(
  db: Db,
  inbox: string,
): Promise<SpamModel | null> {
  const [row] = await db
    .select()
    .from(spamModels)
    .where(eq(spamModels.inbox, normalized(inbox)))
    .limit(1);
  return row
    ? {
        inbox: row.inbox,
        enabled: row.enabled === 1,
        spamMessages: row.spamMessages,
        hamMessages: row.hamMessages,
      }
    : null;
}

/** Every inbox's filter, by inbox. */
export async function readSpamModels(db: Db): Promise<Map<string, SpamModel>> {
  const rows = await db.select().from(spamModels);
  return new Map(
    rows.map((row) => [
      row.inbox,
      {
        inbox: row.inbox,
        enabled: row.enabled === 1,
        spamMessages: row.spamMessages,
        hamMessages: row.hamMessages,
      },
    ]),
  );
}

/** Turns an inbox's filter on or off (its training is kept either way). */
export async function setSpamFilterEnabled(
  db: Db,
  inbox: string,
  enabled: boolean,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .insert(spamModels)
    .values({
      inbox: normalized(inbox),
      enabled: enabled ? 1 : 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: spamModels.inbox,
      set: { enabled: enabled ? 1 : 0, updatedAt: now },
    });
}

/** Forgets everything an inbox's filter learned; it stays on or off. */
export async function resetSpamFilter(db: Db, inbox: string): Promise<void> {
  const key = normalized(inbox);
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.delete(spamTokens).where(eq(spamTokens.inbox, key)),
    db.delete(spamTraining).where(eq(spamTraining.inbox, key)),
    db
      .update(spamModels)
      .set({ spamMessages: 0, hamMessages: 0, updatedAt: now })
      .where(eq(spamModels.inbox, key)),
  ]);
}

/** The counts of the tokens an inbox's filter knows, in one statement. */
async function tokenCounts(
  db: Db,
  inbox: string,
  tokens: string[],
): Promise<Map<string, TokenCounts>> {
  const rows = await db.all<{
    token: string;
    spam_count: number;
    ham_count: number;
  }>(sql`
    SELECT token, spam_count, ham_count FROM spam_tokens
    WHERE inbox = ${normalized(inbox)}
      AND token IN (SELECT value FROM json_each(${JSON.stringify(tokens)}))
  `);
  return new Map(
    rows.map((row) => [
      row.token,
      { spamCount: Number(row.spam_count), hamCount: Number(row.ham_count) },
    ]),
  );
}

/**
 * The junk probability of new mail to an inbox, or null: when its filter is
 * off, not yet trained on 20 messages of each kind, or there is too little
 * evidence in the message.
 */
export async function scoreInbound(
  db: Db,
  inbox: string,
  message: TokenizableMessage,
): Promise<number | null> {
  const model = await readSpamModel(db, inbox);
  if (!model?.enabled || !modelReady(model)) return null;
  const tokens = tokenize(message);
  if (tokens.length === 0) return null;
  return score(tokens, await tokenCounts(db, inbox, tokens), model);
}

/**
 * Trains an inbox's filter with one message and the label a person gave it.
 * The same label again changes nothing; the other label takes the message's
 * counts off the old one first.
 */
export async function trainMessage(
  db: Db,
  input: {
    inbox: string;
    emailId: string;
    label: SpamLabel;
    userId: string | null;
    message: TokenizableMessage;
  },
): Promise<boolean> {
  const inbox = normalized(input.inbox);
  const [previous] = await db
    .select({ label: spamTraining.label })
    .from(spamTraining)
    .where(
      sql`${spamTraining.inbox} = ${inbox} AND ${spamTraining.emailId} = ${input.emailId}`,
    )
    .limit(1);
  if (previous?.label === input.label) return false;

  const tokens = JSON.stringify(tokenize(input.message));
  const now = Math.floor(Date.now() / 1000);
  const spam = input.label === "spam" ? 1 : 0;
  const ham = 1 - spam;
  if (previous) {
    const column = previous.label === "spam" ? sql`spam_count` : sql`ham_count`;
    await db.run(sql`
      UPDATE spam_tokens SET ${column} = MAX(${column} - 1, 0), updated_at = ${now}
      WHERE inbox = ${inbox}
        AND token IN (SELECT value FROM json_each(${tokens}))
    `);
  }
  // Every token in one statement: the list is bound as one JSON value.
  await db.run(sql`
    INSERT INTO spam_tokens (inbox, token, spam_count, ham_count, updated_at)
    SELECT ${inbox}, value, ${spam}, ${ham}, ${now} FROM json_each(${tokens}) WHERE true
    ON CONFLICT (inbox, token) DO UPDATE SET
      spam_count = spam_count + excluded.spam_count,
      ham_count = ham_count + excluded.ham_count,
      updated_at = excluded.updated_at
  `);
  await db.run(sql`
    INSERT INTO spam_models (inbox, enabled, spam_messages, ham_messages, updated_at)
    VALUES (${inbox}, 0, ${spam}, ${ham}, ${now})
    ON CONFLICT (inbox) DO UPDATE SET
      spam_messages = MAX(spam_messages + ${spam} - ${previous?.label === "spam" ? 1 : 0}, 0),
      ham_messages = MAX(ham_messages + ${ham} - ${previous?.label === "ham" ? 1 : 0}, 0),
      updated_at = ${now}
  `);
  await db
    .insert(spamTraining)
    .values({
      inbox,
      emailId: input.emailId,
      label: input.label,
      trainedBy: input.userId,
      trainedAt: now,
    })
    .onConflictDoUpdate({
      target: [spamTraining.inbox, spamTraining.emailId],
      set: { label: input.label, trainedBy: input.userId, trainedAt: now },
    });
  return true;
}

/**
 * Trains the filters of the given received messages' inboxes, where on,
 * with a label a person gave them; at most the first 50. Best-effort: a
 * failure is logged, never thrown, so it cannot fail the person's action.
 */
export async function trainMessages(
  db: Db,
  input: {
    refs: MessageRef[];
    label: SpamLabel;
    userId: string | null;
  },
): Promise<number> {
  try {
    const refs = input.refs
      .filter((ref) => ref.kind === "received")
      .slice(0, MAX_TRAINED_PER_CALL);
    if (refs.length === 0) return 0;
    const models = await readSpamModels(db);
    const enabled = [...models.values()].filter((model) => model.enabled);
    if (enabled.length === 0) return 0;

    // Loaded here, not at the top: the state services import this module.
    const { queryMessages, MESSAGE_REFS_PER_QUERY } =
      await import("../messages/query");
    const scope = {
      isAdmin: false as const,
      inboxes: enabled.map((model) => model.inbox),
    };
    let trained = 0;
    for (let start = 0; start < refs.length; start += MESSAGE_REFS_PER_QUERY) {
      const page = await queryMessages(db, scope, {
        messageRefs: refs.slice(start, start + MESSAGE_REFS_PER_QUERY),
        limit: null,
        includeArchived: true,
        includeSnoozed: true,
        withAttachmentCounts: true,
      });
      for (const message of page.messages) {
        const changed = await trainMessage(db, {
          inbox: message.inbox,
          emailId: message.ref.id,
          label: input.label,
          userId: input.userId,
          message: {
            fromAddress: message.from?.email ?? null,
            subject: message.subject,
            bodyText: message.bodyText,
            bodyHtml: message.bodyHtml,
            hasAttachments: (message.attachmentCount ?? 0) > 0,
          },
        });
        if (changed) trained++;
      }
    }
    return trained;
  } catch (error) {
    console.warn("[spam] training failed:", error);
    return 0;
  }
}

/**
 * Keeps each inbox under its token cap: the tokens seen least, and longest
 * ago, go first. Hourly; a bounded number of rows per pass.
 */
export async function pruneSpamTokens(
  db: Db,
  cap: number = MAX_TOKENS_PER_INBOX,
): Promise<number> {
  const over = await db.all<{ inbox: string; n: number }>(sql`
    SELECT inbox, COUNT(*) AS n FROM spam_tokens GROUP BY inbox
    HAVING COUNT(*) > ${cap}
  `);
  let deleted = 0;
  for (const { inbox, n } of over) {
    let excess = Number(n) - cap;
    for (let batch = 0; batch < PRUNE_MAX_BATCHES && excess > 0; batch++) {
      const take = Math.min(PRUNE_BATCH, excess);
      const result = await db.run(sql`
        DELETE FROM spam_tokens WHERE inbox = ${inbox} AND token IN (
          SELECT token FROM spam_tokens WHERE inbox = ${inbox}
          ORDER BY spam_count + ham_count ASC, updated_at ASC LIMIT ${take}
        )
      `);
      const changes = Number(
        (result as { meta?: { changes?: number } }).meta?.changes ?? 0,
      );
      deleted += changes;
      excess -= changes;
      if (changes < take) break;
    }
  }
  return deleted;
}
