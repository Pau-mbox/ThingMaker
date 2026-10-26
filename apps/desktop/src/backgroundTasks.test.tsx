/**
 * Background tasks: a command an agent left running outlives the turn that
 * started it, and nothing in the transcript says it is still going. The
 * session bar's icon does: a green dot while one runs, a grey one when all
 * have ended, none when there have been none; and it opens a window listing
 * them, the side transcript's too, with each one's output on request.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask, EventEnvelope } from "@thingmaker/contracts";

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

import { applyEvent, emptyProjection } from "./projection";
import { api } from "./ipc";
import { useStore, type LiveSession } from "./store";
import { BackgroundTasksButton } from "./components/BackgroundTasks";

const initial = useStore.getState();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.setState(initial, true);
});

const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: "bapnhs6hh",
  toolCallId: "toolu_1",
  command: "pnpm app --restart",
  description: "Build and install the app",
  outputPath: "/private/tmp/claude-501/p/s/tasks/bapnhs6hh.output",
  state: "running",
  startedAtUnixMs: Date.now() - 65_000,
  ...overrides,
});

function session(id: string, tasks: BackgroundTask[]): LiveSession {
  const projection = emptyProjection();
  for (const entry of tasks) projection.background.set(entry.taskId, entry);
  return { handle: { id, attachmentGeneration: "1" }, workspaceId: "w1", snapshot: { provider: "claude" }, projection } as unknown as LiveSession;
}

const envelope = (sequence: number, payload: EventEnvelope["payload"]): EventEnvelope => ({ apiVersion: 1, session: { id: "s1", attachmentGeneration: "1" }, sequence: String(sequence), payload }) as unknown as EventEnvelope;

describe("background tasks in the projection", () => {
  it("keeps each task whole, its end replacing its start", () => {
    const projection = emptyProjection();
    applyEvent(projection, envelope(1, { type: "background_task", ...task() }));
    applyEvent(projection, envelope(2, { type: "background_task", ...task({ state: "completed", exitCode: 0, ending: "[exited with code 0]", endedAtUnixMs: Date.now() }) }));
    expect(projection.background.size).toBe(1);
    expect(projection.background.get("bapnhs6hh")).toMatchObject({ state: "completed", exitCode: 0, command: "pnpm app --restart" });
  });
});

describe("the background tasks icon", () => {
  it("has no dot when there have been none", () => {
    useStore.setState({ sessions: { s1: session("s1", []) } });
    const { container } = render(<BackgroundTasksButton sessionId="s1" />);
    expect(container.querySelector(".badge-dot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
    expect(screen.getByText(/No background tasks in this session yet/)).toBeTruthy();
  });

  it("has a green dot while one runs, and lists it", () => {
    useStore.setState({ sessions: { s1: session("s1", [task(), task({ taskId: "old", command: "pnpm test", state: "completed", exitCode: 0, startedAtUnixMs: Date.now() - 600_000, endedAtUnixMs: Date.now() - 500_000 })]) } });
    const { container } = render(<BackgroundTasksButton sessionId="s1" />);
    expect(container.querySelector(".badge-dot-running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Background tasks: 1 running" }));
    const rows = screen.getAllByRole("listitem");
    // Newest first.
    expect(rows[0]!.textContent).toContain("pnpm app --restart");
    expect(rows[0]!.textContent).toMatch(/Running for 1m \d+s/);
    expect(rows[1]!.textContent).toContain("pnpm test");
    expect(rows[1]!.textContent).toContain("Finished");
  });

  it("has a grey dot once all have ended, and says how one failed", () => {
    useStore.setState({ sessions: { s1: session("s1", [task({ state: "failed", exitCode: 2, endedAtUnixMs: Date.now() })]) } });
    const { container } = render(<BackgroundTasksButton sessionId="s1" />);
    expect(container.querySelector(".badge-dot-ended")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Background tasks: all ended" }));
    expect(screen.getByRole("listitem").textContent).toContain("Failed (exit 2)");
  });

  it("lists the side transcript's tasks too, marked as its", () => {
    useStore.setState({ sessions: { s1: session("s1", []), side: session("side", [task({ taskId: "fromside", command: "npm run dev" })]) }, sides: { s1: "side" } });
    const { container } = render(<BackgroundTasksButton sessionId="s1" />);
    expect(container.querySelector(".badge-dot-running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Background tasks: 1 running" }));
    expect(screen.getByRole("listitem").textContent).toContain("Side Transcript");
  });

  it("shows a task's output, read from the session that ran it", async () => {
    useStore.setState({ sessions: { s1: session("s1", [task({ state: "completed", exitCode: 0, endedAtUnixMs: Date.now() })]) } });
    const read = vi.spyOn(api, "sessionBackgroundOutput").mockResolvedValue({ text: "Installed ThingMaker.app\n\n[exited with code 0]\n", bytes: 41 });
    render(<BackgroundTasksButton sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Background tasks: all ended" }));
    fireEvent.click(screen.getByText("pnpm app --restart"));
    await waitFor(() => expect(screen.getByText(/Installed ThingMaker.app/)).toBeTruthy());
    expect(read).toHaveBeenCalledWith({ id: "s1", attachmentGeneration: "1" }, "bapnhs6hh");
  });
});
