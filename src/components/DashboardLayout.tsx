import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { nanoid } from "nanoid";
import { showToast } from "@/lib/toast";
import TopNav from "@/components/TopNav";
import Breadcrumbs from "@/components/Breadcrumbs";
import Footer from "@/components/Footer";
import ComposeFab from "@/components/ComposeFab";
import ComposeModal, { type ComposePrefill } from "@/pages/ComposeModal";
import Toaster from "@/components/Toaster";
import { useReducedAnimations } from "@/hooks/useReducedAnimations";
import { useBranding } from "@/lib/branding";
import { WebMcpBridgeProvider } from "@/webmcp/bridge";
import { WebMcpTools } from "@/webmcp/registerTools";
import AgentPanel from "@/components/AgentPanel";
import { AgentContextProvider } from "@/agent/AgentContext";

const AGENT_PANEL_STORAGE_KEY = "saasmail.agentPanelOpen";

function initialAgentPanelOpen(): boolean {
  try {
    return window.localStorage.getItem(AGENT_PANEL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function DashboardLayout() {
  const navigate = useNavigate();
  const { webmcpEnabled } = useBranding();
  const [composeOpen, setComposeOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(initialAgentPanelOpen);
  const [composeContextKey, setComposeContextKey] = useState("compose");
  // One composer instance per open (and per draft): nothing of one draft's
  // state, or a late save or publish result, can reach another.
  const [composeSession, setComposeSession] = useState(0);
  // Files carried to the composer that takes over a moved draft.
  const [composeFiles, setComposeFiles] = useState<File[] | undefined>();
  // Read by openCompose without re-creating it.
  const composeState = useRef({
    open: false,
    contextKey: "compose",
    sending: false,
  });
  // Optional seed values for the compose drawer — populated when the user
  // opts into the "full compose" flow from inside a chat thread.
  const [composePrefill, setComposePrefill] = useState<ComposePrefill | null>(
    null,
  );
  const reduced = useReducedAnimations();

  const openCompose = useCallback(
    (prefill?: ComposePrefill, contextKey?: string) => {
      const current = composeState.current;
      // A send in progress keeps the tray: opening another draft now would
      // lose its outcome (an error, files not yet saved).
      if (current.open && current.sending) {
        showToast({
          kind: "info",
          message: "Finish sending this message first",
        });
        return;
      }
      // Re-opening the draft that is already open changes nothing (a remount
      // would race its own save and drop files attached in it).
      if (
        current.open &&
        !prefill &&
        (contextKey ?? "compose") === current.contextKey
      ) {
        return;
      }
      setComposeFiles(undefined);
      setComposePrefill(prefill ?? null);
      // A prefilled message is a new draft of its own, never the one saved
      // in the shared "compose" slot (whose Bcc or attachments it would pick
      // up when shared with a mail client).
      const next = contextKey ?? (prefill ? `draft:${nanoid()}` : "compose");
      composeState.current = { open: true, contextKey: next, sending: false };
      setComposeContextKey(next);
      setComposeSession((session) => session + 1);
      setComposeOpen(true);
    },
    [],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(AGENT_PANEL_STORAGE_KEY, String(agentOpen));
    } catch {
      // Storage can be unavailable in private browsing or embedded contexts.
    }
  }, [agentOpen]);

  useEffect(() => {
    function handleAgentShortcut(event: KeyboardEvent) {
      if (event.isComposing) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) {
        return;
      }
      if (event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      setAgentOpen((open) => !open);
    }
    window.addEventListener("keydown", handleAgentShortcut);
    return () => window.removeEventListener("keydown", handleAgentShortcut);
  }, []);

  const closeCompose = useCallback(() => {
    composeState.current = {
      open: false,
      contextKey: "compose",
      sending: false,
    };
    setComposeOpen(false);
    setComposePrefill(null);
    setComposeContextKey("compose");
  }, []);

  return (
    <WebMcpBridgeProvider navigate={navigate} openCompose={openCompose}>
      <AgentContextProvider>
        {webmcpEnabled && <WebMcpTools />}
        <div className="relative flex min-h-screen flex-col bg-background pt-16">
          {/* Faded gradient backdrop. Animates by default; falls back to a
            static version on low-spec devices or when the user prefers
            reduced motion. */}
          <div
            className={
              reduced
                ? "dashboard-backdrop dashboard-backdrop-static"
                : "dashboard-backdrop"
            }
            aria-hidden
          />
          <div className="dashboard-backdrop-mask" aria-hidden />

          <TopNav
            agentOpen={agentOpen}
            onAgentToggle={() => setAgentOpen((open) => !open)}
          />

          <div className="relative z-10 flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col">
              <Breadcrumbs />
              <main className="flex min-h-0 flex-1 flex-col">
                <Outlet context={{ onCompose: openCompose }} />
              </main>
              <Footer />
            </div>
            {agentOpen && (
              <AgentPanel
                onClose={() => setAgentOpen(false)}
                onOpenCompose={openCompose}
              />
            )}
          </div>

          <ComposeFab onClick={() => openCompose()} />

          {composeOpen && (
            <ComposeModal
              key={`${composeContextKey}#${composeSession}`}
              open
              onClose={closeCompose}
              prefill={composePrefill}
              contextKey={composeContextKey}
              initialFiles={composeFiles}
              onSendingChange={(sending) => {
                composeState.current.sending = sending;
              }}
              onContextKeyChange={(next, { files }) => {
                // "Keep as a new draft" moved the draft to its own surface; the
                // composer there takes over, with the files attached here.
                composeState.current.contextKey = next;
                setComposePrefill(null);
                setComposeFiles(files);
                setComposeContextKey(next);
              }}
            />
          )}

          <Toaster />
        </div>
      </AgentContextProvider>
    </WebMcpBridgeProvider>
  );
}
