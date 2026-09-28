import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  fetchStats: vi.fn(),
  fetchDraft: vi.fn(),
  saveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  publishDraft: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/TiptapEditor", () => ({
  default: () => <div data-testid="editor" />,
}));

import ComposeModal from "./ComposeModal";

const DRAFT = {
  id: "w1",
  contextKey: "jmap:abc",
  fromAddress: "support@e2e.test",
  toAddress: "alice@example.test",
  cc: null,
  subject: "From my phone",
  bodyHtml: "<p>Hi</p>",
  bodyText: "Hi",
  replyToEmailId: null,
  updatedAt: 1_800_000_000,
};

describe("ComposeModal with a shared draft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.fetchStats.mockResolvedValue({
      recipients: ["support@e2e.test"],
      senderIdentities: [],
    });
    api.saveDraft.mockResolvedValue(DRAFT);
    api.publishDraft.mockResolvedValue({ status: "unchanged" });
  });

  it("lists what the draft keeps and turns Send off", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: ["a Bcc recipient", "an attachment"],
      jmapState: null,
    });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const notice = await screen.findByTestId("compose-shared-draft-notice");
    expect(notice.textContent).toContain("a Bcc recipient, an attachment");
    expect(
      (screen.getByTestId("compose-send-button") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says when the draft was sent or deleted from a mail client", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: "gone",
    });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const notice = await screen.findByTestId("compose-shared-draft-notice");
    expect(notice.textContent).toContain("sent or deleted from a mail client");
  });

  it("shows no notice for an ordinary draft", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
    });
    render(<ComposeModal open onClose={() => {}} contextKey="draft:x" />);
    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalled());
    expect(screen.queryByTestId("compose-shared-draft-notice")).toBeNull();
  });
});
