import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  replyToEmail: vi.fn(),
  sendEmail: vi.fn(),
  fetchDraft: vi.fn(),
  deleteDraft: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import ChatQuickReply from "@/components/ChatQuickReply";

function renderReply(replyToAddress: string | null) {
  return render(
    <ChatQuickReply
      inboxAddress="support@example.com"
      latestReceivedEmailId="email-1"
      personEmail="noreply@acme.com"
      replyToAddress={replyToAddress}
      onSent={() => {}}
    />,
  );
}

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Type a reply…"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.replyToEmail).toHaveBeenCalled());
  return api.replyToEmail.mock.calls.at(-1)![1] as Record<string, unknown>;
}

describe("ChatQuickReply and Reply-To", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchDraft.mockResolvedValue(null);
    api.deleteDraft.mockResolvedValue(undefined);
    api.replyToEmail.mockResolvedValue({
      id: "sent-1",
      attachmentIds: [],
      status: "sent",
      to: "help@acme.com",
      repliedTo: "reply_to",
    });
  });

  it("shows no hint when replies go to the sender", async () => {
    renderReply(null);
    expect(screen.queryByTestId("reply-to-hint")).toBeNull();

    const payload = await send("hello");
    expect(payload).not.toHaveProperty("recipient");
  });

  it("says where the reply goes and follows the Reply-To by default", async () => {
    renderReply("help@acme.com");
    expect(screen.getByTestId("reply-to-hint").textContent).toContain(
      "Replies go to help@acme.com (the sender asked for replies there)",
    );

    const payload = await send("hello");
    expect(payload).not.toHaveProperty("recipient");
  });

  it('sends recipient: "sender" once the toggle is on', async () => {
    renderReply("help@acme.com");
    fireEvent.click(screen.getByLabelText("Reply to the sender instead"));
    expect(screen.getByTestId("reply-to-hint").textContent).toContain(
      "This reply goes to the sender, not help@acme.com",
    );

    const payload = await send("hello");
    expect(payload.recipient).toBe("sender");
  });
});
