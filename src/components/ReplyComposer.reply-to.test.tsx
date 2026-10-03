import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  replyToEmail: vi.fn(),
  fetchTemplates: vi.fn(),
  fetchEmail: vi.fn(),
  fetchPersonEmails: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/use-draft-autosave", () => ({
  useDraftAutosave: () => ({ clear: () => {} }),
}));
vi.mock("@/components/TiptapEditor", () => ({
  default: ({
    onUpdate,
  }: {
    onUpdate: (html: string, text: string) => void;
  }) => (
    <textarea
      data-testid="editor"
      onChange={(event) =>
        onUpdate(`<p>${event.target.value}</p>`, event.target.value)
      }
    />
  ),
}));

import ReplyComposer from "@/components/ReplyComposer";

const original = {
  id: "email-1",
  type: "received",
  personId: "person-1",
  recipient: "support@example.com",
  fromAddress: "noreply@acme.com",
  toAddress: null,
  subject: "Ticket update",
  bodyHtml: null,
  bodyText: "Your ticket changed",
  isRead: 0,
  cc: [],
  timestamp: 1_800_000_000,
};

function renderComposer() {
  return render(
    <ReplyComposer
      emailId="email-1"
      personName="Notifier"
      personEmail="noreply@acme.com"
      recipients={["support@example.com"]}
      senderIdentities={[
        {
          email: "support@example.com",
          displayName: "Support",
          signatureHtml: null,
        },
      ]}
      onClose={() => {}}
      onSent={() => {}}
    />,
  );
}

async function send() {
  api.replyToEmail.mockClear();
  fireEvent.click(screen.getByTestId("reply-send-button"));
  await waitFor(() => expect(api.replyToEmail).toHaveBeenCalledTimes(1));
  return api.replyToEmail.mock.calls[0][1] as Record<string, unknown>;
}

describe("ReplyComposer and Reply-To", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPersonEmails.mockResolvedValue({ emails: [], inboxes: [] });
    api.fetchTemplates.mockResolvedValue([]);
    api.replyToEmail.mockResolvedValue({
      id: "sent-1",
      attachmentIds: [],
      status: "sent",
      to: "help@acme.com",
      repliedTo: "reply_to",
    });
  });

  it("shows no hint when the message has no other reply address", async () => {
    api.fetchEmail.mockResolvedValue({ ...original, replyTo: null });
    renderComposer();

    // The original has loaded once its "Replying to" card is up.
    await screen.findByText("Replying to");
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();
    expect(screen.getByTestId("reply-to-address").textContent).toBe(
      "Notifier <noreply@acme.com>",
    );

    expect(await send()).not.toHaveProperty("recipient");
  });

  it("addresses the reply to the Reply-To and lets the user pick the sender", async () => {
    api.fetchEmail.mockResolvedValue({ ...original, replyTo: "help@acme.com" });
    renderComposer();

    const hint = await screen.findByTestId("reply-to-hint");
    expect(hint.textContent).toContain(
      "Replies go to help@acme.com (the sender asked for replies there)",
    );
    expect(screen.getByTestId("reply-to-address").textContent).toBe(
      "help@acme.com",
    );
    expect(await send()).not.toHaveProperty("recipient");

    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect(screen.getByTestId("reply-to-address").textContent).toBe(
      "Notifier <noreply@acme.com>",
    );
    expect((await send()).recipient).toBe("sender");

    // Flipping it back follows the Reply-To again.
    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect(await send()).not.toHaveProperty("recipient");
  });
});
