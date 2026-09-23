import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  createAgentSession,
  deleteAgentSession,
  fetchAgentSessions,
  fetchAgentStatus,
  updateAgentSession,
  type AgentSession,
  type AgentStatus,
} from "@/lib/api";

interface AgentPanelProps {
  onClose: () => void;
}

function newestFirst(sessions: AgentSession[]): AgentSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function titleFromFirstMessage(text: string): string {
  return text.trim().slice(0, 60);
}

export default function AgentPanel({ onClose }: AgentPanelProps) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [draftMessage, setDraftMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function reloadSessions() {
    const result = await fetchAgentSessions();
    const sorted = newestFirst(result.sessions);
    setSessions(sorted);
    setActiveId((current) => {
      if (current && sorted.some((session) => session.id === current)) {
        return current;
      }
      return sorted.find((session) => session.archivedAt === null)?.id ?? null;
    });
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAgentStatus(), fetchAgentSessions()])
      .then(([nextStatus, result]) => {
        if (cancelled) return;
        const sorted = newestFirst(result.sessions);
        setStatus(nextStatus);
        setSessions(sorted);
        setActiveId(
          sorted.find((session) => session.archivedAt === null)?.id ?? null,
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleSessions = useMemo(
    () =>
      sessions.filter((session) =>
        showArchived ? true : session.archivedAt === null,
      ),
    [sessions, showArchived],
  );
  const activeSession =
    sessions.find((session) => session.id === activeId) ?? null;

  async function createSession() {
    const created = await createAgentSession();
    setSessions((current) => newestFirst([created, ...current]));
    setActiveId(created.id);
  }

  async function renameSession(session: AgentSession) {
    const next = window.prompt("Rename agent session", session.title ?? "");
    if (next === null) return;
    const updated = await updateAgentSession(session.id, {
      title: next.trim() || null,
    });
    setSessions((current) =>
      newestFirst(
        current.map((item) => (item.id === updated.id ? updated : item)),
      ),
    );
  }

  async function archiveSession(session: AgentSession) {
    const updated = await updateAgentSession(session.id, {
      archived: session.archivedAt === null,
    });
    setSessions((current) =>
      newestFirst(
        current.map((item) => (item.id === updated.id ? updated : item)),
      ),
    );
    if (updated.archivedAt !== null && activeId === updated.id) {
      setActiveId(
        sessions.find(
          (item) => item.id !== updated.id && item.archivedAt === null,
        )?.id ?? null,
      );
    }
  }

  async function removeSession(session: AgentSession) {
    if (!window.confirm("Delete this agent session? This cannot be undone.")) {
      return;
    }
    await deleteAgentSession(session.id);
    setSessions((current) => current.filter((item) => item.id !== session.id));
    if (activeId === session.id) {
      setActiveId(
        sessions.find(
          (item) => item.id !== session.id && item.archivedAt === null,
        )?.id ?? null,
      );
    }
  }

  async function handleComposerSubmit(event: React.FormEvent) {
    event.preventDefault();
    const text = draftMessage.trim();
    if (!text || !activeSession || !status?.configured) return;

    if (!activeSession.title) {
      const title = titleFromFirstMessage(text);
      if (title) {
        const updated = await updateAgentSession(activeSession.id, { title });
        setSessions((current) =>
          newestFirst(
            current.map((item) => (item.id === updated.id ? updated : item)),
          ),
        );
      }
    }

    // Commit 3 wires this composer to useAgentChat. Keep the typed text in place
    // for now so this shell never pretends a message was sent before streaming
    // exists.
  }

  return (
    <aside
      data-agent-panel
      aria-label="Mail agent"
      className="fixed inset-0 z-[70] flex min-h-0 flex-col border-l border-border bg-card md:static md:z-auto md:w-[400px] md:shrink-0"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">
            Mail agent
          </h2>
          <p className="text-[11px] text-text-tertiary">
            {status?.configured
              ? `${status.provider} · ${status.model}`
              : "Assistant workspace"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close mail agent"
          onClick={onClose}
          className="rounded-[6px] p-1.5 text-text-secondary hover:bg-bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="border-b border-border p-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="agent-new-session"
            onClick={() => void createSession()}
            className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-2.5 py-1.5 text-xs font-medium text-bg"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            New
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-secondary">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
            />
            Show archived
          </label>
        </div>

        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {visibleSessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center gap-1 rounded-[6px] px-1 py-1 ${
                activeId === session.id ? "bg-bg-muted" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setActiveId(session.id)}
                className="min-w-0 flex-1 truncate px-1.5 py-1 text-left text-xs text-text-primary"
              >
                {session.title || "New conversation"}
              </button>
              <button
                type="button"
                aria-label={`Rename ${session.title || "session"}`}
                onClick={() => void renameSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                aria-label={
                  session.archivedAt === null
                    ? `Archive ${session.title || "session"}`
                    : `Restore ${session.title || "session"}`
                }
                onClick={() => void archiveSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                {session.archivedAt === null ? (
                  <Archive className="h-3 w-3" />
                ) : (
                  <ArchiveRestore className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                aria-label={`Delete ${session.title || "session"}`}
                onClick={() => void removeSession(session)}
                className="rounded p-1 text-text-tertiary hover:bg-card"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
          {!loading && visibleSessions.length === 0 && (
            <p className="px-1 py-2 text-xs text-text-tertiary">
              No agent sessions yet.
            </p>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
        <p className="max-w-xs text-sm text-text-tertiary">
          {activeSession
            ? "Conversation messages will appear here."
            : "Create a session to start a conversation."}
        </p>
      </div>

      {!loading && status && !status.configured && (
        <div
          data-testid="agent-not-configured"
          className="mx-3 mb-2 rounded-[6px] border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-text-secondary"
        >
          The mail agent is not configured. See{" "}
          <a
            href="/docs/agent.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            docs/agent.md
          </a>{" "}
          for provider setup.
        </div>
      )}

      <form
        onSubmit={handleComposerSubmit}
        className="border-t border-border p-3"
      >
        <textarea
          data-testid="agent-composer"
          aria-label="Message the mail agent"
          value={draftMessage}
          onChange={(event) => setDraftMessage(event.target.value)}
          disabled={!status?.configured || !activeSession}
          placeholder={
            status?.configured
              ? "Ask about your mail…"
              : "Configure an agent provider to start chatting"
          }
          className="min-h-20 w-full resize-none rounded-[6px] border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="submit"
            disabled={
              !status?.configured || !activeSession || !draftMessage.trim()
            }
            className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}
