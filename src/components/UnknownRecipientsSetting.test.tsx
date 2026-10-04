import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAdminSettings: vi.fn(),
  updateAdminSettings: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

import UnknownRecipientsSetting from "@/components/UnknownRecipientsSetting";

describe("UnknownRecipientsSetting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAdminSettings.mockResolvedValue({
      rejectUnknownRecipients: false,
    });
    api.updateAdminSettings.mockResolvedValue({
      rejectUnknownRecipients: true,
    });
  });

  it("shows the catch-all default and turns rejection on", async () => {
    render(<UnknownRecipientsSetting />);
    const box = (await screen.findByRole("checkbox", {
      name: /Reject mail to addresses that aren't inboxes/,
    })) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(screen.getByText(/stored \(catch-all\)/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() =>
      expect(api.updateAdminSettings).toHaveBeenCalledWith({
        rejectUnknownRecipients: true,
      }),
    );
    await waitFor(() => expect(box.checked).toBe(true));
  });
});
