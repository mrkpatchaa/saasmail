// The real ComposeModal inside the real DashboardLayout (API mocked): the
// handover paths the mocked-composer tests can't see.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useOutletContext,
} from "react-router-dom";

const api = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendDraft: vi.fn(),
  fetchStats: vi.fn(),
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  publishDraft: vi.fn(),
  SendDraftError: class SendDraftError extends Error {},
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/components/TiptapEditor", () => ({
  default: () => <div data-testid="editor" />,
}));
vi.mock("@/hooks/useReducedAnimations", () => ({
  useReducedAnimations: () => true,
}));
vi.mock("@/components/TopNav", () => ({ default: () => null }));
vi.mock("@/components/Breadcrumbs", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/Toaster", () => ({ default: () => null }));
vi.mock("@/components/ComposeFab", () => ({ default: () => null }));
vi.mock("@/webmcp/registerTools", () => ({ WebMcpTools: () => null }));
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ webmcpEnabled: false }),
}));
vi.mock("@/components/AgentPanel", () => ({ default: () => null }));

import DashboardLayout from "@/components/DashboardLayout";

const GONE = {
  id: "w1",
  contextKey: "jmap:X",
  fromAddress: "support@e2e.test",
  toAddress: "alice@example.test",
  cc: null,
  subject: "Copy",
  bodyHtml: "<p>Hi</p>",
  bodyText: "Hi",
  replyToEmailId: null,
  updatedAt: 1_800_000_000,
  jmapExtras: [],
  jmapState: "gone",
  bcc: [],
  storedAttachments: [],
  storedAttachmentsRev: "X",
};

function Page() {
  const { onCompose } = useOutletContext<{
    onCompose: (prefill?: unknown, contextKey?: string) => void;
  }>();
  return (
    <button onClick={() => onCompose(undefined, "jmap:X")}>Open draft</button>
  );
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/mail"]}>
      <Routes>
        <Route element={<DashboardLayout />}>
          <Route path="/mail" element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("shared drafts in the real composer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.fetchStats.mockResolvedValue({
      recipients: ["support@e2e.test"],
      senderIdentities: [],
    });
    api.publishDraft.mockResolvedValue({ status: "unchanged", draft: null });
    api.saveDraft.mockResolvedValue({ ...GONE, jmapState: null });
  });

  it("keep as a new draft writes nothing to the old surface afterwards", async () => {
    api.fetchDraft.mockImplementation(async (key: string) =>
      key === "jmap:X" ? GONE : { ...GONE, contextKey: key, jmapState: null },
    );
    api.saveDraft.mockImplementation(async (payload: { fresh?: boolean }) =>
      payload.fresh
        ? { ...GONE, contextKey: "draft:N", jmapState: null }
        : { ...GONE, jmapState: null },
    );
    renderLayout();
    fireEvent.click(screen.getByText("Open draft"));
    fireEvent.click(await screen.findByTestId("compose-keep-as-new"));
    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalledWith("draft:N"));
    // Give a stray flush from the replaced composer time to happen.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const freshCall = api.saveDraft.mock.calls.findIndex(
      ([payload]) => payload.fresh,
    );
    expect(freshCall).toBeGreaterThanOrEqual(0);
    const afterMove = api.saveDraft.mock.calls
      .slice(freshCall + 1)
      .filter(([payload]) => payload.contextKey === "jmap:X");
    expect(afterMove).toEqual([]);
    expect(
      api.publishDraft.mock.calls.filter(([key]) => key === "jmap:X"),
    ).toEqual([]);
  });

  it("re-opening the draft that is already open keeps the same composer", async () => {
    api.fetchDraft.mockResolvedValue({ ...GONE, jmapState: null });
    renderLayout();
    fireEvent.click(screen.getByText("Open draft"));
    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Open draft"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // No remount: no second restore, no close flush.
    expect(api.fetchDraft).toHaveBeenCalledTimes(1);
    expect(api.saveDraft).not.toHaveBeenCalled();
  });
});
