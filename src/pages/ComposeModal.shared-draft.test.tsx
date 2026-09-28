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
  SendDraftError: class SendDraftError extends Error {
    constructor(
      message: string,
      readonly draft: unknown,
      readonly gone: boolean = false,
      readonly filesStored: boolean = false,
    ) {
      super(message);
    }
  },
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
    expect(notice.textContent).toContain(
      "sent, deleted or moved to Trash from a mail client",
    );
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

  it("shows the draft's Bcc and stored attachments, and saves which are kept", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
      bcc: [{ email: "boss@example.test", name: null }],
      storedAttachments: [
        { partId: "3", name: "figures.csv", type: "text/csv", size: 12 },
        { partId: "4", name: "notes.txt", type: "text/plain", size: 5 },
      ],
      storedAttachmentsRev: "rev1",
    });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const chips = await screen.findAllByTestId("compose-stored-attachment");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "figures.csv",
      "notes.txt",
    ]);
    expect(screen.getByTestId("compose-bcc-input")).toBeTruthy();
    expect(screen.getByLabelText("Remove boss@example.test")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Remove notes.txt"));
    await waitFor(
      () =>
        expect(api.saveDraft).toHaveBeenCalledWith(
          expect.objectContaining({
            contextKey: "jmap:abc",
            keptAttachments: ["3"],
            keptAttachmentsRev: "rev1",
            bcc: [{ email: "boss@example.test", name: null }],
          }),
        ),
      { timeout: 4000 },
    );
  });

  it("never auto-deletes a mail-client draft that only has attachments", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      toAddress: null,
      subject: null,
      bodyHtml: null,
      bodyText: null,
      jmapExtras: [],
      jmapState: null,
      bcc: [],
      storedAttachments: [
        { partId: "2", name: "scan.pdf", type: "application/pdf", size: 9 },
      ],
      storedAttachmentsRev: "rev1",
    });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    await screen.findByTestId("compose-stored-attachment");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it("sends the signature separately, and none for a mail-client draft", async () => {
    api.fetchStats.mockResolvedValue({
      recipients: ["support@e2e.test"],
      senderIdentities: [
        { email: "support@e2e.test", signatureHtml: "<p>Sig</p>" },
      ],
    });
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      contextKey: "draft:x",
      jmapExtras: [],
      jmapState: null,
    });
    api.sendDraft.mockResolvedValue({ fallback: false });
    const { unmount } = render(
      <ComposeModal open onClose={() => {}} contextKey="draft:x" />,
    );
    await screen.findByTestId("compose-signature-preview");
    const send = screen.getByTestId("compose-send-button") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(api.sendDraft).toHaveBeenCalled());
    expect(api.sendDraft.mock.calls[0][0]).toMatchObject({
      bodyHtml: "<p>Hi</p>",
      signatureHtml: "<p>Sig</p>",
    });
    unmount();

    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
    });
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("compose-signature-preview")).toBeNull();
  });

  it("a refused send shows the saved files as stored and doesn't attach them again", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
      storedAttachments: [],
      storedAttachmentsRev: "rev1",
    });
    api.sendDraft.mockRejectedValue(
      new api.SendDraftError(
        "Too many recipients",
        {
          ...DRAFT,
          jmapExtras: [],
          jmapState: null,
          storedAttachments: [
            { partId: "3", name: "notes.txt", type: "text/plain", size: 3 },
          ],
          storedAttachmentsRev: "rev2",
        },
        false,
        true,
      ),
    );
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const send = (await screen.findByTestId(
      "compose-send-button",
    )) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText("Too many recipients")).toBeTruthy();
    const chips = await screen.findAllByTestId("compose-stored-attachment");
    expect(chips.map((chip) => chip.textContent)).toEqual(["notes.txt"]);
  });

  it("says a gone draft wasn't sent and offers to keep it as a new draft", async () => {
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
      storedAttachmentsRev: "rev1",
    });
    api.sendDraft.mockRejectedValue(
      new api.SendDraftError("Sent elsewhere", null, true, false),
    );
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    const send = (await screen.findByTestId(
      "compose-send-button",
    )) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    fireEvent.click(await screen.findByTestId("compose-keep-as-new"));
    await waitFor(() =>
      expect(api.saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({ contextKey: "jmap:abc", fresh: true }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("compose-shared-draft-notice")).toBeNull(),
    );
  });

  it("a new message never inherits the previous draft's chips or notice", async () => {
    api.fetchDraft.mockResolvedValueOnce({
      ...DRAFT,
      jmapExtras: [],
      jmapState: "gone",
      storedAttachments: [
        { partId: "2", name: "scan.pdf", type: "application/pdf", size: 9 },
      ],
      storedAttachmentsRev: "rev1",
    });
    const { rerender } = render(
      <ComposeModal open onClose={() => {}} contextKey="jmap:abc" />,
    );
    await screen.findByTestId("compose-stored-attachment");
    rerender(
      <ComposeModal open={false} onClose={() => {}} contextKey="jmap:abc" />,
    );
    api.fetchDraft.mockResolvedValue(null);
    rerender(<ComposeModal open onClose={() => {}} contextKey="compose" />);
    await waitFor(() => expect(api.fetchDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("compose-stored-attachment")).toBeNull();
    expect(screen.queryByTestId("compose-shared-draft-notice")).toBeNull();
  });

  it("forgets a removal once the draft no longer has that attachment", async () => {
    const both = [
      { partId: "3", name: "figures.csv", type: "text/csv", size: 12 },
      { partId: "4", name: "notes.txt", type: "text/plain", size: 5 },
    ];
    api.fetchDraft.mockResolvedValue({
      ...DRAFT,
      jmapExtras: [],
      jmapState: null,
      storedAttachments: both,
      storedAttachmentsRev: "rev1",
    });
    // A refused send hands back the draft as it is now: the removal applied.
    api.sendDraft.mockRejectedValue(
      new api.SendDraftError(
        "Refused",
        {
          ...DRAFT,
          jmapExtras: [],
          jmapState: null,
          storedAttachments: [both[0]],
          storedAttachmentsRev: "rev2",
        },
        false,
        false,
      ),
    );
    render(<ComposeModal open onClose={() => {}} contextKey="jmap:abc" />);
    await screen.findAllByTestId("compose-stored-attachment");
    fireEvent.click(screen.getByLabelText("Remove notes.txt"));
    const send = screen.getByTestId("compose-send-button") as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(api.sendDraft).toHaveBeenCalled());
    expect(api.sendDraft.mock.calls[0]?.[0]).toMatchObject({
      keptAttachments: ["3"],
      keptAttachmentsRev: "rev1",
    });
    await screen.findByText("Refused");
    // The next save carries no kept list: nothing left to choose.
    api.saveDraft.mockClear();
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Changed" },
    });
    await waitFor(() => expect(api.saveDraft).toHaveBeenCalled(), {
      timeout: 4000,
    });
    expect(api.saveDraft.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "keptAttachments",
    );
  });
});
