import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AgentPanel from "@/components/AgentPanel";
import * as api from "@/lib/api";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    fetchAgentStatus: vi.fn(),
    fetchAgentSessions: vi.fn(),
    createAgentSession: vi.fn(),
    updateAgentSession: vi.fn(),
    deleteAgentSession: vi.fn(),
  };
});

const session = (
  id: string,
  title: string | null,
  updatedAt: number,
  archivedAt: number | null = null,
): api.AgentSession => ({
  id,
  title,
  createdAt: updatedAt,
  updatedAt,
  archivedAt,
  instanceName: `u-user-s-${id}`,
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(api.fetchAgentStatus).mockResolvedValue({
    configured: true,
    provider: "openai",
    model: "gpt-5.6-sol",
  });
  vi.mocked(api.fetchAgentSessions).mockResolvedValue({
    sessions: [session("older", "Older", 1), session("newer", "Newer", 2)],
  });
});

describe("AgentPanel", () => {
  it("supports session create, rename, archive, delete, and archived visibility", async () => {
    vi.mocked(api.createAgentSession).mockResolvedValue(
      session("new", null, 3),
    );
    vi.mocked(api.updateAgentSession)
      .mockResolvedValueOnce(session("new", "Renamed", 4))
      .mockResolvedValueOnce(session("new", "Renamed", 5, 5));
    vi.mocked(api.deleteAgentSession).mockResolvedValue({ success: true });
    vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<AgentPanel onClose={() => {}} />);

    expect(await screen.findByText("Newer")).toBeTruthy();
    const labels = screen
      .getAllByRole("button")
      .map((button) => button.textContent)
      .filter(Boolean);
    expect(labels.indexOf("Newer")).toBeLessThan(labels.indexOf("Older"));

    fireEvent.click(screen.getByTestId("agent-new-session"));
    await waitFor(() => expect(api.createAgentSession).toHaveBeenCalled());

    fireEvent.click(
      await screen.findByRole("button", { name: "Rename session" }),
    );
    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("new", {
        title: "Renamed",
      }),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Archive Renamed" }),
    );
    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("new", {
        archived: true,
      }),
    );
    expect(screen.queryByText("Renamed")).toBeNull();

    fireEvent.click(screen.getByLabelText("Show archived"));
    expect(await screen.findByText("Renamed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete Renamed" }));
    await waitFor(() =>
      expect(api.deleteAgentSession).toHaveBeenCalledWith("new"),
    );
  });

  it("titles an untitled session from the first composer message at 60 characters", async () => {
    const untitled = session("untitled", null, 3);
    vi.mocked(api.fetchAgentSessions).mockResolvedValue({
      sessions: [untitled],
    });
    vi.mocked(api.updateAgentSession).mockImplementation(async (id, patch) => ({
      ...untitled,
      id,
      title: patch.title ?? null,
      updatedAt: 4,
    }));

    render(<AgentPanel onClose={() => {}} />);

    const composer = (await screen.findByTestId(
      "agent-composer",
    )) as HTMLTextAreaElement;
    const text = "A".repeat(75);
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(api.updateAgentSession).toHaveBeenCalledWith("untitled", {
        title: "A".repeat(60),
      }),
    );
  });

  it("shows the setup hint and disables the composer when no provider is configured", async () => {
    vi.mocked(api.fetchAgentStatus).mockResolvedValue({
      configured: false,
      provider: null,
      model: null,
    });

    render(<AgentPanel onClose={() => {}} />);

    expect(await screen.findByTestId("agent-not-configured")).toBeTruthy();
    expect(
      (screen.getByTestId("agent-composer") as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("link", { name: "docs/agent.md" }).getAttribute("href"),
    ).toBe("/docs/agent.md");
  });
});
