/**
 * Dropping a Markdown document onto the goal form.
 *
 * The point of the feature is that an existing roadmap can seed a goal, and
 * the point of these tests is *who reads it*: Big Thing stores the document and
 * hands it to the session's model, which proposes the milestones. Nothing is
 * parsed here, nothing is created until the button is pressed, and nothing
 * runs until the goal is started.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OdysseyView, Snapshot } from "@thingmaker/contracts";

type DropPayload = { type: "enter" | "over" | "leave" | "drop"; paths?: string[] };
type DropHandler = (event: { payload: DropPayload }) => void;

const PLAN = `# Ship onboarding v2

Design and implement onboarding, verified end to end.

- [x] Audit existing flow
- [ ] Define acceptance tests, verified by \`pnpm test\`
- [ ] Build the screens
`;

vi.mock("@tauri-apps/api/core", () => {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const draft = {
    goal: {
      id: "o1",
      workspaceId: "w1",
      sessionId: "kw-1",
      title: "Ship onboarding v2",
      brief: "",
      state: "draft",
      stopCondition: "goal_complete",
      onUsageReset: "notify_only",
      orchestrator: "codex",
      maxContinuations: 10,
      continuationsUsed: 0,
      tokensUsed: 0,
      planSource: "onboarding.md",
      planDocumentBytes: 180,
      createdAt: 0,
      updatedAt: 0,
    },
    milestones: [],
    journal: [],
  };
  return {
    invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "odyssey_read_plan") return PLAN;
      if (command === "odyssey_create") return draft;
      if (command === "odyssey_plan_document") return PLAN;
      if (command === "session_submit") return { outcome: { outcome: "accepted" } };
      if (command === "odyssey_journal_append") return {};
      if (command === "odyssey_view") return draft;
      throw new Error(`unexpected command ${command}`);
    }),
    Channel: class {
      onmessage: ((event: unknown) => void) | null = null;
    },
    __calls: calls,
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => {
  const handlers: DropHandler[] = [];
  return {
    getCurrentWebview: () => ({
      onDragDropEvent: async (handler: DropHandler) => {
        handlers.push(handler);
        return () => undefined;
      },
    }),
    __handlers: handlers,
  };
});

import * as core from "@tauri-apps/api/core";
import * as webview from "@tauri-apps/api/webview";
import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { OdysseyPane } from "./components/OdysseyPane";

const calls = (core as unknown as { __calls: { command: string; args: Record<string, unknown> }[] }).__calls;
const handlers = (webview as unknown as { __handlers: DropHandler[] }).__handlers;
const SESSION = "sess-1";

function seed(odyssey: OdysseyView | null = null) {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  const snapshot = { handle, agentSessionId: "kw-1" } as unknown as Snapshot;
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { [SESSION]: session }, odyssey: { [SESSION]: odyssey }, odysseyRuntime: {}, error: null });
}

/** Waits for the pane's drag-drop listener to be registered, then drops. */
async function drop(paths: string[]) {
  await waitFor(() => expect(handlers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const handler of handlers) handler({ payload: { type: "drop", paths } });
  });
}

const commands = () => calls.map((entry) => entry.command);

describe("dropping a Markdown plan on the goal form", () => {
  beforeEach(() => {
    calls.length = 0;
    handlers.length = 0;
    seed();
  });
  afterEach(cleanup);

  it("invites a drop before anything is dropped", () => {
    render(<OdysseyPane sessionId={SESSION} />);
    expect(screen.getByText(/Drop a Markdown roadmap/)).toBeTruthy();
    expect(screen.getByText(/the agent will turn it into milestones/)).toBeTruthy();
  });

  it("describes the document it was given, and does not read it for milestones", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/Users/someone/plans/onboarding.md"]);

    expect(calls.filter((entry) => entry.command === "odyssey_read_plan")).toHaveLength(1);
    expect(screen.getByText("onboarding.md")).toBeTruthy();
    // Measured, not parsed: a size and a shape, never a milestone list.
    expect(screen.getByText(/lines · 1 headings/)).toBeTruthy();
    expect(screen.getByText(/the agent will propose the milestones/)).toBeTruthy();
    expect(screen.queryByText("Build the screens")).toBeNull();
    expect(screen.queryByText("Audit existing flow")).toBeNull();
  });

  it("suggests the document's heading as the goal name, and nothing else", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/plans/onboarding.md"]);

    expect(screen.getByLabelText<HTMLInputElement>("Goal title").value).toBe("Ship onboarding v2");
    // The brief is the user's to write: the document's prose is the agent's
    // to read, not ours to summarise.
    expect(screen.getByLabelText<HTMLTextAreaElement>("Goal brief").value).toBe("");
  });

  it("creates nothing on its own, and says what the button will do", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/plans/onboarding.md"]);

    expect(commands()).not.toContain("odyssey_create");
    expect(screen.getByRole("button", { name: "Create goal and ask the agent to plan it" })).toBeTruthy();
  });

  it("hands the document to the model when the goal is created", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/plans/onboarding.md"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create goal and ask the agent to plan it" }));
    });

    const created = calls.find((entry) => entry.command === "odyssey_create");
    const request = created?.args.request as Record<string, unknown>;
    expect(request.planSource).toBe("onboarding.md");
    expect(request.planDocument).toBe(PLAN);
    // Kit's id, which the native side resolves to the desktop session row the
    // goal's foreign key points at. Sending it as `sessionId` failed that key.
    expect(request.agentSessionId).toBe("kw-1");
    expect(request.sessionId).toBeUndefined();
    // And the engine is asked for the planning turn at once; it builds the
    // prompt from the stored document and submits it.
    const asked = calls.find((entry) => entry.command === "bigthing_request_plan");
    expect(asked?.args.goalId).toBeTruthy();
    expect(commands()).not.toContain("session_submit");
  });

  it("lets the document be removed without touching the record", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/plans/onboarding.md"]);
    fireEvent.click(screen.getByRole("button", { name: "remove" }));

    expect(screen.getByText(/Drop a Markdown roadmap/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create goal" })).toBeTruthy();
    expect(commands()).not.toContain("odyssey_create");
  });

  it("owns the drop while it is showing, so the composer does not also take it", () => {
    // A drop listener is webview-wide; the transcript's own handler bails on
    // the Big Thing tab, and this is the assertion that keeps that true.
    const here = dirname(fileURLToPath(import.meta.url));
    const panel = readFileSync(resolve(here, "components/SessionPanel.tsx"), "utf8");
    expect(panel).toContain('state.sessionTab === "odyssey"');
  });

  it("refuses a file that is not a document, and does not try to read it", async () => {
    render(<OdysseyPane sessionId={SESSION} />);
    await drop(["/Users/someone/Downloads/archive.zip"]);

    expect(commands()).not.toContain("odyssey_read_plan");
    await waitFor(() => expect(useStore.getState().error?.message).toContain("Markdown or text file"));
  });

  it("refuses a document too large to hand to a model in one turn", async () => {
    // Rendered first: the form reads the workspace's earlier goals on mount,
    // and the one-shot answer below is for the document read, not for that.
    render(<OdysseyPane sessionId={SESSION} />);
    const invoke = core.invoke as unknown as { mockImplementationOnce: (fn: () => Promise<string>) => void };
    invoke.mockImplementationOnce(async () => "x".repeat(70 * 1024));
    await drop(["/plans/huge.md"]);

    await waitFor(() => expect(useStore.getState().error?.message).toContain("has to be under 64 KB"));
    expect(screen.getByText(/Drop a Markdown roadmap/)).toBeTruthy();
  });
});
