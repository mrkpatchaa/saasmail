import { fetchGroupedIds } from "@/lib/api";
import {
  markFolderRead as markQueryRead,
  purgeRows,
} from "@/lib/folder-actions";
import { dispatchInboxRefresh } from "@/lib/inbox-events";
import { showToast } from "@/lib/toast";
import { folderQuery } from "./lib";
import type { FolderTarget } from "./FolderList";

/** Mark every unread conversation in a folder read (folder right-click). */
export async function markFolderRead(t: FolderTarget): Promise<number> {
  try {
    const n = await markQueryRead({
      ...folderQuery(t.folder),
      recipient: t.label,
    });
    showToast({
      kind: n ? "success" : "info",
      message: n
        ? `Marked ${n} conversation${n === 1 ? "" : "s"} as read`
        : "Everything here is already read",
    });
    dispatchInboxRefresh();
    return n;
  } catch {
    showToast({ kind: "error", message: "Couldn't mark all as read" });
    return 0;
  }
}

/**
 * Empty Deleted Items: permanently delete every message in Trash, for
 * everyone in the inbox (asks first; admin-only on the server, so callers
 * offer it to admins only). The contacts stay.
 */
export async function emptyTrash(): Promise<number> {
  try {
    const { data } = await fetchGroupedIds({ folder: "trash" });
    if (!data.length) {
      showToast({ kind: "info", message: "Deleted Items is already empty" });
      return 0;
    }
    if (
      !window.confirm(
        `Permanently delete the ${data.length} conversation${data.length === 1 ? "" : "s"} in Deleted Items? This removes the mail for everyone in the inbox and can't be undone. Contacts stay.`,
      )
    )
      return 0;
    const res = await purgeRows(data.map(({ type, id }) => ({ type, id })));
    if (res.failed > 0)
      throw new Error("Some messages were not deleted. Try again.");
    showToast({
      kind: "success",
      message: `Deleted ${res.deleted} conversation${res.deleted === 1 ? "" : "s"} permanently`,
    });
    dispatchInboxRefresh();
    return res.deleted;
  } catch (e) {
    showToast({
      kind: "error",
      message: e instanceof Error ? e.message : "Couldn't empty Deleted Items",
    });
    dispatchInboxRefresh();
    return 0;
  }
}
