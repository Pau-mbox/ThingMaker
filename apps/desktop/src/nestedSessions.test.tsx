/**
 * Nested sessions in a session's view: the fork says where it is nested and
 * can stop reporting back; the parent shows what is waiting to go with its
 * next message.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@thingmaker/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { NestedBanner, NestedReportsStrip } from "./components/NestedSessions";

function live(id: string): LiveSession {
  const handle = { id, attachmentGeneration: "1" };
  const snapshot = { handle, agentSessionId: `agent-${id}`, provider: "claude", toolCalls: {}, foreground: "idle" } as unknown as Snapshot;
  return { handle, workspaceId: "w1", snapshot, projection: emptyProjection(), inFlightRequestId: null, steerInFlight: false, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE };
}

const setReporting = vi.fn(async () => undefined);
const selectSession = vi.fn();

beforeEach(() => {
  setReporting.mockClear();
  selectSession.mockClear();
  useStore.setState({
    sessions: { main: live("main"), fork: live("fork") },
    records: {
      w1: [
        { id: "r-main", workspaceId: "w1", agentSessionId: "agent-main", titleOverlay: "Login work", origin: "desktop", archiveState: "active", pinned: false, provider: "claude", createdAt: 0 },
        { id: "r-fork", workspaceId: "w1", agentSessionId: "agent-fork", titleOverlay: "Login work (fork)", origin: "fork", parentSessionId: "r-main", archiveState: "active", pinned: false, provider: "claude", createdAt: 0 },
      ],
    },
    nestedReports: { "agent-main": [{ forkAgentSessionId: "agent-fork", title: "Login work (fork)", text: "The race is fixed.", atUnixMs: 1 }] },
    reporting: {},
    setReporting,
    selectSession,
  } as never);
});
afterEach(cleanup);

describe("nested sessions", () => {
  it("a fork says where it is nested, opens it, and can stop reporting back", () => {
    render(<NestedBanner sessionId="fork" />);
    fireEvent.click(screen.getByRole("button", { name: "Login work" }));
    expect(selectSession).toHaveBeenCalledWith("main");
    const box = screen.getByRole("checkbox", { name: "Reports back" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(setReporting).toHaveBeenCalledWith("w1", "agent-fork", false);
  });

  it("a session that is not a fork has no banner", () => {
    render(<NestedBanner sessionId="main" />);
    expect(screen.queryByText("Nested in")).toBeNull();
  });

  it("the parent shows what its forks reported, going with its next message", () => {
    render(<NestedReportsStrip sessionId="main" />);
    expect(screen.getByText("“Login work (fork)” reported back")).toBeTruthy();
    expect(screen.getByText(/goes with your next message, as context/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("The race is fixed.")).toBeTruthy();
    render(<NestedReportsStrip sessionId="fork" />);
    expect(screen.getAllByText(/reported back/)).toHaveLength(1);
  });
});
