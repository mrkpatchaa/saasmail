import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import MailFolderRail, {
  SYSTEM_FOLDERS,
} from "@/components/mail/MailFolderRail";
import MailMessageList from "@/components/mail/MailMessageList";
import MailReadingPane from "@/components/mail/MailReadingPane";
import MailSelectionBar from "@/components/mail/MailSelectionBar";
import {
  fetchMailboxes,
  fetchStats,
  type Mailbox,
  type Stats,
} from "@/lib/api";
import { type SystemFolder, useMailMessages } from "@/hooks/useMailMessages";

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
  const [mobilePane, setMobilePane] = useState<MobilePane>(
    searchParams.get("m") ? "reader" : "list",
  );
  const [selectedRefs, setSelectedRefs] = useState<Set<string>>(new Set());

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

  const internalDomains = useMemo(
    () =>
      stats?.senderIdentities
        .map((identity) => identity.email.split("@")[1]?.toLowerCase())
        .filter((domain): domain is string => Boolean(domain)) ?? [],
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
    if (selectedRef) setMobilePane("reader");
  }, [selectedRef]);

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

  useEffect(() => {
    setSelectedRefs(new Set());
  }, [inbox, mailboxId, systemFolder]);

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

  const mail = useMailMessages({
    inbox,
    allowedInboxes,
    mailboxId,
    systemFolder,
    query,
    selectedRef,
    onClearSelected: clearSelection,
  });

  const selectedMessages = mail.messages.filter((message) =>
    selectedRefs.has(message.ref),
  );
  const allSelected =
    mail.messages.length > 0 &&
    mail.messages.every((message) => selectedRefs.has(message.ref));
  const canArchiveSpam =
    selectedMessages.length > 0 &&
    selectedMessages.every((message) => message.direction === "inbound");
  const markSeen =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.seen);
  const star =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.starredAt !== null);
  const archive =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.archivedAt !== null);
  const spam =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.spamAt !== null);
  const trash =
    selectedMessages.length > 0 &&
    !selectedMessages.every((message) => message.state.trashedAt !== null);

  function toggleSelected(ref: string) {
    setSelectedRefs((current) => {
      const next = new Set(current);
      if (next.has(ref)) next.delete(ref);
      else next.add(ref);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedRefs((current) => {
      const next = new Set(current);
      if (allSelected) {
        for (const message of mail.messages) next.delete(message.ref);
      } else {
        for (const message of mail.messages) next.add(message.ref);
      }
      return next;
    });
  }

  async function runBulk(action: () => Promise<boolean>) {
    if (await action()) setSelectedRefs(new Set());
  }

  const currentMailbox = mailboxId
    ? (mailboxes.find((mailbox) => mailbox.id === mailboxId) ?? null)
    : null;
  const currentFolderLabel =
    currentMailbox?.name ??
    SYSTEM_FOLDERS.find((entry) => entry.id === systemFolder)?.label ??
    "Mail";

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
        <MailFolderRail
          visible={mobilePane === "folders"}
          inbox={inbox}
          senderIdentities={stats.senderIdentities}
          mailboxes={mailboxes}
          mailboxId={mailboxId}
          systemFolder={systemFolder}
          onInboxChange={(nextInbox) => {
            navigate(mailPath(nextInbox, "inbox"));
            setMobilePane("list");
          }}
          onOpenSystemFolder={openSystemFolder}
          onOpenMailbox={openMailbox}
          onMailboxCreated={(mailbox) =>
            setMailboxes((current) => [...current, mailbox])
          }
          onMailboxUpdated={(mailbox) =>
            setMailboxes((current) =>
              current.map((item) => (item.id === mailbox.id ? mailbox : item)),
            )
          }
          onMailboxDeleted={(deletedId) => {
            const removed = new Set([deletedId]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const mailbox of mailboxes) {
                if (
                  mailbox.parentId &&
                  removed.has(mailbox.parentId) &&
                  !removed.has(mailbox.id)
                ) {
                  removed.add(mailbox.id);
                  changed = true;
                }
              }
            }
            setMailboxes((current) =>
              current.filter((mailbox) => !removed.has(mailbox.id)),
            );
            if (mailboxId && removed.has(mailboxId)) {
              navigate(mailPath(inbox, "inbox"));
              setMobilePane("list");
            }
          }}
        />

        <MailMessageList
          visible={mobilePane === "list"}
          currentFolderLabel={currentFolderLabel}
          systemFolder={systemFolder}
          query={query}
          showCampaignSends={mail.showCampaignSends}
          onShowCampaignSendsChange={mail.setShowCampaignSends}
          showNewMessages={mail.showNewMessages}
          listScrollRef={mail.listScrollRef}
          loading={mail.loading}
          loadingMore={mail.loadingMore}
          messages={mail.messages}
          nextCursor={mail.nextCursor}
          selectedRef={selectedRef}
          actionBusyRef={mail.actionBusyRef}
          selectedRefs={selectedRefs}
          selectionBar={
            <MailSelectionBar
              count={selectedMessages.length}
              busy={mail.bulkBusy}
              canArchiveSpam={canArchiveSpam}
              markSeen={markSeen}
              star={star}
              archive={archive}
              spam={spam}
              trash={trash}
              mailboxes={mailboxes}
              onSeen={() =>
                void runBulk(() => mail.bulkSetSeen(selectedMessages, markSeen))
              }
              onStar={() =>
                void runBulk(() => mail.bulkSetStarred(selectedMessages, star))
              }
              onArchive={() =>
                void runBulk(() =>
                  mail.bulkSetArchived(selectedMessages, archive),
                )
              }
              onSpam={() =>
                void runBulk(() => mail.bulkSetSpam(selectedMessages, spam))
              }
              onTrash={() =>
                void runBulk(() => mail.bulkSetTrashed(selectedMessages, trash))
              }
              onSnooze={(until) =>
                void runBulk(() => mail.bulkSnooze(selectedMessages, until))
              }
              onMove={(targetId) =>
                void runBulk(() =>
                  mail.bulkMoveToMailbox(selectedMessages, targetId),
                )
              }
              onClear={() => setSelectedRefs(new Set())}
            />
          }
          onBackToFolders={() => setMobilePane("folders")}
          onSearch={updateSearch}
          onReachedTop={() => mail.setShowNewMessages(false)}
          onRefreshNewMessages={() => {
            mail.listScrollRef.current?.scrollTo({ top: 0 });
            void mail.loadMessages(null, false);
          }}
          onSelectMessage={selectMessage}
          onToggleSelected={toggleSelected}
          onToggleSelectAll={toggleSelectAll}
          onToggleStar={(message) => void mail.toggleStar(message)}
          onLoadMore={(cursor) => void mail.loadMessages(cursor, true)}
        />

        <MailReadingPane
          visible={mobilePane === "reader"}
          selectedRef={selectedRef}
          selectedMessage={mail.selectedMessage}
          actionBusyRef={mail.actionBusyRef}
          mailboxes={mailboxes}
          mailboxId={mailboxId}
          currentMailboxName={currentMailbox?.name}
          senderIdentities={stats.senderIdentities}
          internalDomains={internalDomains}
          onBack={clearSelection}
          onToggleStar={(message) => void mail.toggleStar(message)}
          onToggleArchive={(message) => void mail.toggleArchive(message)}
          onToggleSpam={(message) => void mail.toggleSpam(message)}
          onToggleTrash={(message) => void mail.toggleTrash(message)}
          onSnooze={(message, until) => void mail.snoozeMessage(message, until)}
          onMoveToMailbox={(message, targetId) =>
            void mail.moveToMailbox(message, targetId)
          }
          onRemoveFromCurrentMailbox={(message) =>
            void mail.removeFromCurrentMailbox(message)
          }
          onOpenCustomer={(message) => {
            if (!message.personId) return;
            navigate(
              `/inbox/${encodeURIComponent(message.inbox)}/${encodeURIComponent(message.personId)}`,
            );
          }}
          onRefresh={() => void mail.loadMessages(null, false)}
        />
      </div>
    </div>
  );
}
