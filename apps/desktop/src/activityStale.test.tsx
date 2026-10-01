/**
 * The activity strip after the work it is describing has died.
 *
 * A subagent killed or lost with its provider never reports that it stopped,
 * so the strip claimed "Working in the background · 196m · 1 child process"
 * for a process that had exited hours earlier. It cannot know the work is
 * gone — but it does know the session has said nothing, and that is what it
 * should say.
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
import { ActivityBar } from "./components/ActivityBar";

const SESSION = "sess-1";

/** A session with one working subagent, last heard from `silentMs` ago. */
function seed(silentMs: number, foreground: "idle" | "running" = "idle") {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  projection.foreground = foreground;
  projection.inspector.agents.set("c1", {
    id: "c1",
    name: "android-build",
    status: "working",
    outcome: null,
    generation: 1,
    task: "Own Android build + emulator verification now.",
    parentId: null,
    parentName: null,
    harness: "claude-code",
    model: null,
    createdAtUnixMs: Date.now() - silentMs,
    generationStartedAtUnixMs: Date.now() - silentMs,
    generationFinishedAtUnixMs: null,
    updatedSequence: "1",
  });
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: "kw-1" } as unknown as Snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: foreground === "running" ? Date.now() - silentMs : null,
    lastEventAt: Date.now() - silentMs,
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { [SESSION]: session } });
}

beforeEach(() => useStore.setState({ sessions: {} }));
afterEach(cleanup);

describe("work the session has gone quiet about", () => {
  it("reports it as running while the session is still talking", () => {
    seed(30_000);
    render(<ActivityBar onOpenAgents={() => undefined} sessionId={SESSION} />);
    expect(screen.getByText("Working in the background")).toBeTruthy();
    expect(screen.getByText(/1 background agent/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("says what it actually knows once the session has gone silent", () => {
    seed(196 * 60_000);
    render(<ActivityBar onOpenAgents={() => undefined} sessionId={SESSION} />);

    expect(screen.getByText("Reported running, but silent")).toBeTruthy();
    expect(screen.getByText(/nothing has been reported for 196m/)).toBeTruthy();
    // Not "it is dead" — we do not know that, only that we have heard nothing.
    expect(screen.getByText(/probably ended without saying so/)).toBeTruthy();
  });

  it("offers a way out, and taking it empties the strip", () => {
    seed(196 * 60_000);
    const { container } = render(<ActivityBar onOpenAgents={() => undefined} sessionId={SESSION} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    // Nothing left to report, so the strip is gone entirely.
    expect(container.firstChild).toBeNull();
    const agent = useStore.getState().sessions[SESSION]?.projection.inspector.agents.get("c1");
    expect(agent?.status).toBe("idle");
    // Cleared, not claimed successful: nobody told us how it went.
    expect(agent?.outcome).toBeNull();
  });

  it("never calls a live foreground turn stale, however quiet it is", () => {
    seed(196 * 60_000, "running");
    render(<ActivityBar onOpenAgents={() => undefined} sessionId={SESSION} />);
    expect(screen.queryByText("Reported running, but silent")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });
});
