import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { emailChangesSince, maxChanges } from "./changes";
import { MAX_OBJECTS_IN_GET } from "./constants";
import { emailGet, type JmapMethodError } from "./emails";

/**
 * Thread id -> its Email ids, through Thread/get; null when Thread/get can't
 * answer (a thread over its size limit).
 */
export type ThreadEmailIdsLoader = (
  threadIds: string[],
) => Promise<Map<string, string[]> | null>;

/**
 * `Thread/changes`. Threads aren't in the change log: they are derived from
 * the Emails changed since the state. A thread is `created` when every Email in
 * it was created since, otherwise `updated`. `destroyed` is always empty: the
 * change log keeps no thread key for a destroyed Email, so a thread whose last
 * Email was destroyed is not reported (Thread/get answers `notFound` for it).
 */
export async function threadChanges(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
  threadEmailIds: ThreadEmailIdsLoader,
): Promise<Record<string, unknown> | JmapMethodError> {
  const requestedMax = maxChanges(args.maxChanges);
  if (typeof requestedMax !== "number") return requestedMax;

  const changes = await emailChangesSince(db, allowed, userId, args.sinceState);
  if (changes.error) return changes.error;
  const since = changes.changes as NonNullable<typeof changes.changes>;

  // The changed Emails that still exist, through Email/get's loading path.
  const changedIds = [...new Set([...since.createdIds, ...since.updatedIds])];
  const threadIds = new Set<string>();
  for (let start = 0; start < changedIds.length; start += MAX_OBJECTS_IN_GET) {
    const got = await emailGet(db, allowed, userId, accountId, {
      ids: changedIds.slice(start, start + MAX_OBJECTS_IN_GET),
      properties: ["threadId"],
    });
    const error = got as JmapMethodError;
    if (typeof error.type === "string") return error;
    for (const email of (got as { list: { threadId?: unknown }[] }).list) {
      if (typeof email.threadId === "string") threadIds.add(email.threadId);
    }
  }
  if (threadIds.size > requestedMax) {
    // Paging would need a thread-level position in the change log; the client
    // refetches instead.
    return { type: "cannotCalculateChanges" };
  }

  const members = await threadEmailIds([...threadIds]);
  if (!members) return { type: "cannotCalculateChanges" };

  const created = new Set(since.createdIds);
  const createdThreads: string[] = [];
  const updatedThreads: string[] = [];
  for (const threadId of threadIds) {
    const emailIds = members.get(threadId);
    if (!emailIds) continue;
    if (emailIds.every((id) => created.has(id))) createdThreads.push(threadId);
    else updatedThreads.push(threadId);
  }

  return {
    accountId,
    oldState: args.sinceState as string,
    newState: since.newState,
    hasMoreChanges: false,
    created: createdThreads,
    updated: updatedThreads,
    destroyed: [],
  };
}
