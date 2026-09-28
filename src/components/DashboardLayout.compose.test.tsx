import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryRouter,
  Route,
  Routes,
  useOutletContext,
} from "react-router-dom";
import DashboardLayout from "@/components/DashboardLayout";

vi.mock("@/hooks/useReducedAnimations", () => ({
  useReducedAnimations: () => true,
}));
vi.mock("@/components/TopNav", () => ({ default: () => null }));
vi.mock("@/components/Breadcrumbs", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/components/Toaster", () => ({ default: () => null }));
vi.mock("@/webmcp/registerTools", () => ({ WebMcpTools: () => null }));
vi.mock("@/lib/branding", () => ({
  useBranding: () => ({ webmcpEnabled: false }),
}));
vi.mock("@/components/AgentPanel", () => ({ default: () => null }));
vi.mock("@/components/ComposeFab", () => ({
  default: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Compose</button>
  ),
}));
// A stand-in composer that shows which draft surface it was opened on.
vi.mock("@/pages/ComposeModal", () => ({
  default: ({
    contextKey,
    onClose,
    onContextKeyChange,
  }: {
    contextKey: string;
    onClose: () => void;
    onContextKeyChange: (key: string, carry: { files: File[] }) => void;
  }) => (
    <div data-testid="composer" data-context={contextKey}>
      <button onClick={onClose}>Close composer</button>
      <button onClick={() => onContextKeyChange("draft:moved", { files: [] })}>
        Move
      </button>
    </div>
  ),
}));

function Page() {
  const { onCompose } = useOutletContext<{
    onCompose: (prefill?: { to?: string }, contextKey?: string) => void;
  }>();
  return (
    <>
      <button onClick={() => onCompose({ to: "a@example.test" })}>
        Prefilled
      </button>
      <button onClick={() => onCompose(undefined, "jmap:x")}>Open draft</button>
    </>
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

describe("DashboardLayout composer surfaces", () => {
  it("gives a prefilled message its own draft, never the shared compose slot", () => {
    renderLayout();
    fireEvent.click(screen.getByText("Compose"));
    expect(screen.getByTestId("composer").dataset.context).toBe("compose");
    fireEvent.click(screen.getByText("Close composer"));
    expect(screen.queryByTestId("composer")).toBeNull();

    fireEvent.click(screen.getByText("Prefilled"));
    const first = screen.getByTestId("composer").dataset.context!;
    expect(first).toMatch(/^draft:/);
    fireEvent.click(screen.getByText("Close composer"));
    fireEvent.click(screen.getByText("Prefilled"));
    expect(screen.getByTestId("composer").dataset.context).not.toBe(first);
  });

  it("follows a draft that moved to a surface of its own", () => {
    renderLayout();
    fireEvent.click(screen.getByText("Open draft"));
    expect(screen.getByTestId("composer").dataset.context).toBe("jmap:x");
    fireEvent.click(screen.getByText("Move"));
    expect(screen.getByTestId("composer").dataset.context).toBe("draft:moved");
  });
});
