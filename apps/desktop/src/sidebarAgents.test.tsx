/**
 * A session the sidebar would otherwise never show
 * (docs/plans/odyssey-second-orchestrator.md §2.2).
 *
 * Every non-live row in this list comes from Kit — its `session/list`, or a
 * listing of its session store. A session another agent wrote is in neither.
 * That is how a live goal ended up on a Claude session with no row, no
 * "move to…" and no way back: the desktop had created a state it could not
 * show, which is worse than any single bug in it.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: async () => () => undefined }) }));

import { Sidebar } from "./components/Sidebar";
import { useStore } from "./store";
import type { SessionRecord, WorkspaceRecord } from "@thingmaker/contracts";

afterEach(cleanup);

const workspace: WorkspaceRecord = {
  id: "w1",
  environmentId: "e1",
  canonicalRoot: "/Users/p/P3",
  displayPath: "/Users/p/P3",
  workspaceHash: "w-hash",
  trustState: "trusted_local",
  createdAt: 0,
};

function record(overrides: Partial<SessionRecord> & { agentSessionId: string }): SessionRecord {
  return {
    id: `row-${overrides.agentSessionId}`,
    workspaceId: "w1",
    origin: "desktop",
    archiveState: "active",
    pinned: false,
    provider: "codex",
    createdAt: 0,
    ...overrides,
  };
}

function seed(records: SessionRecord[]) {
  useStore.setState({
    workspaces: [workspace],
    inspections: { w1: { record: workspace, trustStale: false } as never },
    sessions: {},
    sessionOrder: [],
    records: { w1: records },
    showHidden: false,
  });
}

describe("the session list comes from the desktop's own records", () => {
  it("lists every provider's sessions, each tagged with the provider it spends", () => {
    seed([
      record({ agentSessionId: "9e08bad3-0015-4de2-9591-53bf1e167ef4", provider: "claude" }),
      record({ agentSessionId: "019a0b0c-1111-7222-8333-944455556666", provider: "codex" }),
    ]);
    render(<Sidebar />);
    expect(screen.getByText(/Session 9e08bad3/i)).toBeTruthy();
    expect(screen.getByText(/Session 019a0b0c/i)).toBeTruthy();
    expect(screen.getByTitle("Runs on Claude Code")).toBeTruthy();
    expect(screen.getByTitle("Runs on Codex")).toBeTruthy();
  });

  it("names a closed session by the title it kept, and a rename over that", () => {
    seed([
      record({ agentSessionId: "a863adcb-c16c-4a8d-9c87-d1bfbf6ee562", provider: "claude", autoTitle: "Game loading screen with chibi animation" }),
      record({ agentSessionId: "ff5cd57a-4ebf-4396-a4ba-c7af7a453b49", provider: "claude", autoTitle: "First chapter plot review", titleOverlay: "Chapter 1" }),
      // Looked for, and the provider had none: the short id is all there is.
      record({ agentSessionId: "2ce87303-2136-4193-8017-aa127291767f", provider: "claude", autoTitle: "" }),
    ]);
    render(<Sidebar />);
    expect(screen.getByText("Game loading screen with chibi animation")).toBeTruthy();
    expect(screen.getByText("Chapter 1")).toBeTruthy();
    expect(screen.queryByText("First chapter plot review")).toBeNull();
    expect(screen.getByText(/Session 2ce87303/i)).toBeTruthy();
  });

  it("keeps a kept title when a session's title event arrives", () => {
    seed([record({ agentSessionId: "a863adcb-c16c-4a8d-9c87-d1bfbf6ee562", provider: "claude" })]);
    useStore.getState().noteSessionTitle({ agentSessionId: "a863adcb-c16c-4a8d-9c87-d1bfbf6ee562", title: "IAP system investigation" });
    render(<Sidebar />);
    expect(screen.getByText("IAP system investigation")).toBeTruthy();
  });

  it("uses the rename overlay over the derived title", () => {
    seed([record({ agentSessionId: "b220f825-b257-41f9-b650-def339b83253", titleOverlay: "Season 2 planning" })]);
    render(<Sidebar />);
    expect(screen.getByText("Season 2 planning")).toBeTruthy();
    expect(screen.queryByText(/Session b220f825/)).toBeNull();
  });

  it("leaves a tombstoned row out", () => {
    seed([record({ agentSessionId: "0ff8c852-5379-4b8f-886c-eac51c9a6c7d", provider: "claude", archiveState: "unavailable" })]);
    render(<Sidebar />);
    expect(screen.queryByText(/0ff8c852/)).toBeNull();
  });
});

describe("workers under their orchestrator", () => {
  it("fold finished workers away behind a count, and show them on request", async () => {
    const { fireEvent } = await import("@testing-library/react");
    localStorage.removeItem("thingmaker.sidebar.openTeams");
    seed([
      record({ agentSessionId: "o-1", titleOverlay: "Orchestrator run" }),
      record({ agentSessionId: "w-1", titleOverlay: "luna · first job", parentSessionId: "row-o-1" }),
      record({ agentSessionId: "w-2", titleOverlay: "luna · second job", parentSessionId: "row-o-1" }),
    ]);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: /2 workers/ }));
    expect(screen.queryByText("luna · first job")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "show 2 finished" }));
    expect(screen.getByText("luna · first job")).toBeTruthy();
    expect(screen.getByText("luna · second job")).toBeTruthy();
  });
});

describe("the sidebar's layout outlives a restart", () => {
  it("keeps a folded workspace folded when the sidebar comes back", () => {
    localStorage.clear();
    seed([record({ agentSessionId: "5f1e2d3c-0000-4000-8000-000000000001", provider: "claude" })]);
    const first = render(<Sidebar />);
    expect(screen.getByText(/Session 5f1e2d3c/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText(/Session 5f1e2d3c/i)).toBeNull();
    first.unmount();
    render(<Sidebar />);
    expect(screen.queryByText(/Session 5f1e2d3c/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText(/Session 5f1e2d3c/i)).toBeTruthy();
    localStorage.clear();
  });
});
