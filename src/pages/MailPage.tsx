import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Archive,
  Clock3,
  Folder,
  Inbox,
  MailOpen,
  Search,
  Send,
  Star,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  fetchMailboxes,
  fetchMessages,
  fetchStats,
  type MailMessage,
  type Mailbox,
  type Stats,
} from "@/lib/api";

const SYSTEM_FOLDERS = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "snoozed", label: "Snoozed", icon: Clock3 },
  { id: "sent", label: "Sent", icon: Send },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "junk", label: "Junk", icon: TriangleAlert },
  { id: "trash", label: "Trash", icon: Trash2 },
] as const;

type SystemFolder = (typeof SYSTEM_FOLDERS)[number]["id"];
type MobilePane = "folders" | "list" | "reader";

function isSystemFolder(value: string | undefined): value is SystemFolder {
  return SYSTEM_FOLDERS.some((folder) => folder.id === value);
}

function mailPath(inbox: string, folder: SystemFolder): string {
  return `/mail/${encodeURIComponent(inbox)}/${folder}`;
}

function mailboxPath(inbox: string, mailboxId: string): string {
  return `/mail/${encodeURIComponent(inbox)}/f/${encodeURIComponent(mailboxId)}`;
}

function counterparty(message: MailMessage): string {
  if (message.direction === "inbound") {
    return message.from?.name || message.from?.email || "Unknown sender";
  }
  return message.to.name || message.to.email;
}

export default function MailPage() {
  const navigate = useNavigate();
  const params = useParams<{
    inbox?: string;
    folder?: string;
    mailboxId?: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState<Stats | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [messages, setMessages] = useState<MailMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [mobilePane, setMobilePane] = useState<MobilePane>(
    searchParams.get("m") ? "reader" : "list",
  );

  const inbox = params.inbox;
  const folder = params.folder;
  const mailboxId = params.mailboxId;
  const selectedRef = searchParams.get("m");
  const query = searchParams.get("q") ?? "";
  const systemFolder = isSystemFolder(folder) ? folder : undefined;

  const allowedInboxes = useMemo(
    () => stats?.senderIdentities.map((identity) => identity.email) ?? [],
    [stats],
  );

  useEffect(() => {
    fetchStats()
      .then(setStats)
      .catch(() =>
        setStats({
          totalPeople: 0,
          totalEmails: 0,
          unreadCount: 0,
          recipients: [],
          senderIdentities: [],
        }),
      );
  }, []);

  useEffect(() => {
    if (!stats) return;
    const firstInbox = allowedInboxes[0];

    if (!inbox) {
      if (firstInbox) {
        navigate(mailPath(firstInbox, "inbox"), { replace: true });
      }
      return;
    }

    if (!allowedInboxes.includes(inbox)) {
      if (firstInbox) {
        navigate(mailPath(firstInbox, "inbox"), { replace: true });
      }
      return;
    }

    if (!mailboxId && !systemFolder) {
      navigate(mailPath(inbox, "inbox"), { replace: true });
    }
  }, [allowedInboxes, inbox, mailboxId, navigate, stats, systemFolder]);

  useEffect(() => {
    if (!inbox || !allowedInboxes.includes(inbox)) return;
    fetchMailboxes(inbox)
      .then(setMailboxes)
      .catch(() => setMailboxes([]));
  }, [allowedInboxes, inbox]);

  useEffect(() => {
    if (!inbox || !allowedInboxes.includes(inbox)) return;
    if (!mailboxId && !systemFolder) return;

    let cancelled = false;
    setLoading(true);

    const request = mailboxId
      ? fetchMessages({
          inbox,
          mailboxId,
          q: query || undefined,
          limit: 50,
        })
      : systemFolder === "starred"
        ? fetchMessages({
            inbox,
            starred: true,
            includeTrashed: false,
            includeSpam: false,
            q: query || undefined,
            limit: 50,
          })
        : fetchMessages({
            inbox,
            folder: systemFolder,
            q: query || undefined,
            limit: 50,
            excludeCampaignSends: systemFolder === "sent" ? true : undefined,
          });

    request
      .then((result) => {
        if (cancelled) return;
        setMessages(result.messages);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [allowedInboxes, inbox, mailboxId, query, systemFolder]);

  useEffect(() => {
    if (selectedRef) setMobilePane("reader");
  }, [selectedRef]);

  const selectedMessage =
    messages.find((message) => message.ref === selectedRef) ?? null;
  const currentMailbox = mailboxId
    ? mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null
    : null;
  const currentFolderLabel =
    currentMailbox?.name ??
    SYSTEM_FOLDERS.find((entry) => entry.id === systemFolder)?.label ??
    "Mail";

  function updateSearch(value: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set("q", value);
        else next.delete("q");
        next.delete("m");
        return next;
      },
      { replace: true },
    );
  }

  function selectMessage(ref: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("m", ref);
        return next;
      },
      { replace: true },
    );
    setMobilePane("reader");
  }

  function clearSelection() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("m");
        return next;
      },
      { replace: true },
    );
    setMobilePane("list");
  }

  function openSystemFolder(nextFolder: SystemFolder) {
    if (!inbox) return;
    navigate({
      pathname: mailPath(inbox, nextFolder),
      search: query ? `?q=${encodeURIComponent(query)}` : "",
    });
    setMobilePane("list");
  }

  function openMailbox(nextMailboxId: string) {
    if (!inbox) return;
    navigate({
      pathname: mailboxPath(inbox, nextMailboxId),
      search: query ? `?q=${encodeURIComponent(query)}` : "",
    });
    setMobilePane("list");
  }

  if (stats && allowedInboxes.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 items-center justify-center px-4 py-16 md:px-6">
        <div className="rounded-[8px] bg-card p-10 text-center ring-1 ring-border">
          <h2 className="text-base font-semibold text-text-primary">
            No inboxes assigned yet
          </h2>
          <p className="mt-2 text-sm text-text-secondary">
            Ask an admin to grant you access to an inbox.
          </p>
        </div>
      </div>
    );
  }

  if (!inbox || !stats) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
        Loading mail…
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 px-0 pb-3 pt-2 sm:px-4 md:px-6">
      <div className="flex min-h-[420px] flex-1 overflow-hidden bg-card sm:rounded-[8px] sm:ring-1 sm:ring-border">
        <aside
          className={`${mobilePane === "folders" ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-border bg-bg-subtle md:flex md:w-56`}
        >
          <div className="border-b border-border p-3">
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
              Inbox
            </label>
            <select
              aria-label="Mail inbox"
              value={inbox}
              onChange={(event) => {
                navigate(mailPath(event.target.value, "inbox"));
                setMobilePane("list");
              }}
              className="w-full rounded-[6px] border border-border bg-card px-2 py-1.5 text-xs text-text-primary outline-none focus:border-text-tertiary"
            >
              {stats.senderIdentities.map((identity) => (
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
                  onClick={() => openSystemFolder(entry.id)}
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
            {mailboxes.length === 0 ? (
              <p className="px-2.5 py-2 text-xs text-text-tertiary">
                No custom folders
              </p>
            ) : (
              mailboxes.map((mailbox) => (
                <button
                  key={mailbox.id}
                  type="button"
                  onClick={() => openMailbox(mailbox.id)}
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

        <section
          className={`${mobilePane === "list" ? "flex" : "hidden"} w-full min-w-0 flex-col border-r border-border md:flex md:w-[360px] md:shrink-0`}
        >
          <div className="border-b border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setMobilePane("folders")}
                className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted md:hidden"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Folders
              </button>
              <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
                {currentFolderLabel}
              </h1>
            </div>
            <label className="relative block">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
              <input
                aria-label="Search mail"
                value={query}
                onChange={(event) => updateSearch(event.target.value)}
                placeholder="Search this folder"
                className="w-full rounded-[6px] border border-border bg-bg-subtle py-2 pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
              />
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-4 text-sm text-text-tertiary">
                Loading messages…
              </p>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
                <MailOpen className="h-6 w-6 text-text-tertiary" />
                <p className="text-sm text-text-tertiary">No messages here.</p>
              </div>
            ) : (
              messages.map((message) => (
                <button
                  key={message.ref}
                  type="button"
                  onClick={() => selectMessage(message.ref)}
                  className={`w-full border-b border-border px-3 py-3 text-left transition-colors hover:bg-bg-subtle ${
                    selectedRef === message.ref ? "bg-bg-muted" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
                      {counterparty(message)}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {new Date(message.occurredAt * 1000).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-text-primary">
                    {message.subject || "(no subject)"}
                  </p>
                </button>
              ))
            )}
          </div>
        </section>

        <section
          className={`${mobilePane === "reader" ? "flex" : "hidden"} min-w-0 flex-1 flex-col bg-card md:flex`}
        >
          {selectedRef ? (
            <>
              <div className="flex items-center gap-2 border-b border-border px-4 py-2 md:hidden">
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
              </div>
              {selectedMessage ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-6">
                  <p className="text-xs text-text-tertiary">
                    {counterparty(selectedMessage)}
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-text-primary">
                    {selectedMessage.subject || "(no subject)"}
                  </h2>
                  <div className="mt-6 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
                    {selectedMessage.bodyText || "No plain-text body."}
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-text-tertiary">
                  The selected message is not in the current page.
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
              <MailOpen className="h-7 w-7 text-text-tertiary" />
              <p className="max-w-xs text-sm text-text-tertiary">
                Select a message to open it in the reading pane.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
