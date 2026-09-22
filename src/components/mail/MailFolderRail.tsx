import { useState } from "react";
import {
  Archive,
  Clock3,
  Folder,
  Inbox,
  Send,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { createMailbox, type Mailbox, type Stats } from "@/lib/api";
import { showToast } from "@/lib/toast";
import type { SystemFolder } from "@/hooks/useMailMessages";

export const SYSTEM_FOLDERS: Array<{
  id: SystemFolder;
  label: string;
  icon: React.ElementType;
}> = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "snoozed", label: "Snoozed", icon: Clock3 },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "junk", label: "Junk", icon: TriangleAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
];

interface MailFolderRailProps {
  visible: boolean;
  inbox: string;
  senderIdentities: Stats["senderIdentities"];
  mailboxes: Mailbox[];
  mailboxId?: string;
  systemFolder?: SystemFolder;
  onInboxChange: (inbox: string) => void;
  onOpenSystemFolder: (folder: SystemFolder) => void;
  onOpenMailbox: (mailboxId: string) => void;
  onMailboxCreated: (mailbox: Mailbox) => void;
}

export default function MailFolderRail({
  visible,
  inbox,
  senderIdentities,
  mailboxes,
  mailboxId,
  systemFolder,
  onInboxChange,
  onOpenSystemFolder,
  onOpenMailbox,
  onMailboxCreated,
}: MailFolderRailProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  async function createCustomFolder() {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;

    setCreatingFolder(true);
    try {
      const mailbox = await createMailbox({ inbox, name });
      onMailboxCreated(mailbox);
      setNewFolderName("");
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t create folder",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setCreatingFolder(false);
    }
  }

  return (
    <aside
      className={`${visible ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-border bg-bg-subtle md:flex md:w-56`}
    >
      <div className="border-b border-border p-3">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          Inbox
        </label>
        <select
          aria-label="Mail inbox"
          value={inbox}
          onChange={(event) => onInboxChange(event.target.value)}
          className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
        >
          {senderIdentities.map((identity) => (
            <option key={identity.email} value={identity.email}>
              {identity.displayName || identity.email}
            </option>
          ))}
        </select>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto p-2">
        {SYSTEM_FOLDERS.map((entry) => {
          const Icon = entry.icon;
          const active = !mailboxId && systemFolder === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onOpenSystemFolder(entry.id)}
              data-testid={`mail-folder-${entry.id}`}
              className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition-colors ${
                active
                  ? "bg-bg-muted font-medium text-text-primary"
                  : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
              }`}
            >
              <Icon className="h-4 w-4" />
              {entry.label}
            </button>
          );
        })}

        <div className="my-2 border-t border-border" />
        <p className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
          Folders
        </p>
        <div className="mb-2 flex gap-1 px-1">
          <input
            aria-label="New folder name"
            data-testid="mail-create-folder-input"
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void createCustomFolder();
              }
            }}
            placeholder="New folder"
            className="min-w-0 flex-1 rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
          />
          <button
            type="button"
            data-testid="mail-create-folder-button"
            disabled={!newFolderName.trim() || creatingFolder}
            onClick={() => void createCustomFolder()}
            className="rounded-[6px] border border-border px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-muted disabled:opacity-50"
          >
            {creatingFolder ? "…" : "Add"}
          </button>
        </div>
        {mailboxes.length === 0 ? (
          <p className="px-2.5 py-2 text-xs text-text-tertiary">
            No custom folders
          </p>
        ) : (
          mailboxes.map((mailbox) => (
            <button
              key={mailbox.id}
              type="button"
              onClick={() => onOpenMailbox(mailbox.id)}
              data-testid="mail-custom-folder"
              data-mailbox-id={mailbox.id}
              className={`flex w-full items-center gap-2 rounded-[6px] px-2.5 py-2 text-left text-sm transition-colors ${
                mailbox.id === mailboxId
                  ? "bg-bg-muted font-medium text-text-primary"
                  : "text-text-secondary hover:bg-bg-muted/70 hover:text-text-primary"
              }`}
            >
              <Folder className="h-4 w-4" />
              <span className="truncate">{mailbox.name}</span>
            </button>
          ))
        )}
      </nav>
    </aside>
  );
}
