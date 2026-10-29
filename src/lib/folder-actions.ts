import {
  fetchGroupedIds,
  markConversationsRead,
  markPeopleRead,
  updateMailState,
  type GroupedQuery,
  type MailItemRef,
  type MailStateUndoStep,
} from "@/lib/api";

/** Split into chunks the API accepts (100 per call). */
function chunks<T>(xs: T[], n = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Mark every unread row matching a list query as read — the whole folder,
 * not just the loaded page. Returns how many rows were affected.
 */
export async function markFolderRead(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
): Promise<number> {
  const { data } = await fetchGroupedIds({ ...query, unread: true });
  const people = data.filter((r) => r.type === "person").map((r) => r.id);
  const groups = data.filter((r) => r.type === "group").map((r) => r.id);
  await Promise.all([
    ...chunks(people).map((ids) => markPeopleRead(ids)),
    ...chunks(groups).map((ids) => markConversationsRead(ids)),
  ]);
  return data.length;
}

/**
 * Apply a mail-state patch to every row matching a list query. Returns how
 * many rows it covered and the undo steps of every call, for
 * `undoMailState`.
 */
export async function applyToFolder(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
  patch: Parameters<typeof updateMailState>[1],
): Promise<{ rows: number; undo: MailStateUndoStep[] }> {
  const { data } = await fetchGroupedIds(query);
  const refs = data.map(({ type, id }) => ({ type, id }));
  const undo: MailStateUndoStep[] = [];
  for (const c of chunks(refs))
    undo.push(...(await updateMailState(c, patch)).undo);
  return { rows: refs.length, undo };
}

/**
 * The pin half of an exact Undo: the rows whose pin a change flipped, and
 * the value to put back (pins are the caller's own, so nothing else moved).
 */
export function pinUndo(
  rows: Array<MailItemRef & { pinned: boolean }>,
  pinned: boolean | undefined,
): { items: MailItemRef[]; pinned: boolean } | null {
  if (pinned === undefined) return null;
  const items = rows
    .filter((r) => r.pinned !== pinned)
    .map(({ type, id }) => ({ type, id }));
  return items.length > 0 ? { items, pinned: !pinned } : null;
}

/**
 * Delete forever every person row matching a list query (Empty Trash).
 * Group conversations can't be hard-deleted, so they are left as they are
 * and counted in `skippedGroups`. Admins only (the server refuses others).
 */
export async function deleteFolderForever(
  query: Omit<GroupedQuery, "page" | "limit" | "withTabCounts">,
  deleteOne: (personId: string) => Promise<unknown>,
): Promise<{ deleted: number; failed: number; skippedGroups: number }> {
  const { data } = await fetchGroupedIds(query);
  const people = data.filter((r) => r.type === "person").map((r) => r.id);
  let deleted = 0;
  let failed = 0;
  // A few at a time: each delete also removes the person's attachments.
  for (const batch of chunks(people, 4)) {
    const results = await Promise.allSettled(batch.map((id) => deleteOne(id)));
    for (const r of results) {
      if (r.status === "fulfilled") deleted++;
      else failed++;
    }
  }
  return {
    deleted,
    failed,
    skippedGroups: data.length - people.length,
  };
}
