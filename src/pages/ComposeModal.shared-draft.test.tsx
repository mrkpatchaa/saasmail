import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendDraft: vi.fn(),
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

  it("lists what the draft keeps and sends it with them", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: ["a Bcc recipient", "an attachment"],
      jmapState: null,
    });
    api.sendDraft.mockResolvedValue({ fallback: false });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const notice = await screen.findByTestId("compose-shared-draft-notice");
    expect(notice.textContent).toContain("a Bcc recipient, an attachment");
    expect(notice.textContent).toContain("sent with it");
    const send = screen.getByTestId("compose-send-button") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(api.sendDraft).toHaveBeenCalled());
    expect(api.sendDraft.mock.calls[0][0]).toMatchObject({
      contextKey: "jmap:abc",
      to: "alice@example.test",
      subject: "From my phone",
    });
    expect(api.sendEmail).not.toHaveBeenCalled();
  });

  it("falls back to the direct send when the inbox can't send through JMAP", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
    });
    api.sendDraft.mockResolvedValue({ fallback: true });
    api.sendEmail.mockResolvedValue({
      id: "s",
      attachmentIds: [],
      status: "sent",
    });
    render(<ComposeModal open onClose={() => {}} contextKey="draft:x" />);
    const send = (await screen.findByTestId(
      "compose-send-button",
    )) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(api.sendEmail).toHaveBeenCalled());
    expect(api.sendEmail.mock.calls[0][0]).toMatchObject({
      to: "alice@example.test",
      subject: "From my phone",
    });
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
