/**
 * Seeing a run (docs/plans/odyssey-observability.md §2, §3).
 *
 * These assert the two things the old screen could not say: what is running
 * under the current milestone — including which subagents and on what — and
 * what the runner has been doing, from rows it already writes.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MilestoneRecord, OdysseyJournalEntry, OdysseyView, Snapshot } from "@thingmaker/contracts";

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

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection, type AgentNode } from "./projection";
import { RunHistory, RunMonitor, UsageWindows } from "./components/OdysseyActivity";

const SESSION = "sess-1";

function milestone(overrides: Partial<MilestoneRecord> & { id: string; title: string; position: number }): MilestoneRecord {
  return { odysseyId: "o1", detail: "", state: "planned", checkKind: "manual", steps: [], ...overrides };
}

const view: OdysseyView = {
  goal: {
    id: "o1",
    workspaceId: "w1",
    title: "Ship it",
    brief: "",
    state: "running",
    stopCondition: "goal_complete",
    onUsageReset: "notify_only",
    onReport: "continue",
    onPlanChange: "review",
    orchestrator: "codex",
    deadTurnMinutes: 30,
    maxContinuations: 10,
    continuationsUsed: 2,
    tokensUsed: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  milestones: [
    milestone({ id: "m1", title: "Audit", position: 0, state: "verified" }),
    milestone({ id: "m2", title: "Deterministic simulation core", position: 1, state: "active" }),
    milestone({ id: "m3", title: "Later", position: 2 }),
  ],
  journal: [],
};

function agent(overrides: Partial<AgentNode> & { id: string; name: string }): AgentNode {
  return {
    status: "working",
    outcome: null,
    generation: 1,
    task: "",
    parentId: null,
    parentName: null,
    harness: "codex",
    model: null,
    createdAtUnixMs: 0,
    generationStartedAtUnixMs: Date.now() - 41_000,
    generationFinishedAtUnixMs: null,
    updatedSequence: "1",
    ...overrides,
  };
}

/** Seeds a session whose projection says what the runtime reported. */
function seed(shape: (projection: ReturnType<typeof emptyProjection>) => void) {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const projection = emptyProjection();
  projection.attachment = "attached";
  projection.process = "ready";
  shape(projection);
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: "kw-1" } as unknown as Snapshot,
    projection,
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: Date.now() - 134_000,
    lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { [SESSION]: session }, odyssey: { [SESSION]: view } });
}

afterEach(cleanup);
beforeEach(() => useStore.setState({ sessions: {}, odyssey: {} }));

describe("the run monitor", () => {
  it("is absent when nothing is running, rather than an empty panel", () => {
    seed(() => undefined);
    const { container } = render(<RunMonitor sessionId={SESSION} view={view} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the milestone this turn is for, and how long it has been going", () => {
    seed((projection) => {
      projection.foreground = "running";
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);
    expect(screen.getByText("Milestone 2/3 · Deterministic simulation core")).toBeTruthy();
    expect(screen.getByText("2m 14s")).toBeTruthy();
  });

  it("names the model each working subagent is on", () => {
    // Subagents are delegated to another harness on another account, so the
    // session's own model picker no longer says what they are running.
    seed((projection) => {
      projection.foreground = "running";
      projection.inspector.agents.set("a1", agent({ id: "a1", name: "verifier", model: "opus", harness: "acp.claude" }));
      projection.inspector.agents.set("a2", agent({ id: "a2", name: "worker", model: null, harness: "acp.claude" }));
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);

    expect(screen.getByText("acp.claude · opus")).toBeTruthy();
    expect(screen.getByText("acp.claude · default")).toBeTruthy();
  });

  it("lists the subagents that are working and what each was asked to do", () => {
    seed((projection) => {
      projection.foreground = "running";
      projection.inspector.agents.set("a1", agent({ id: "a1", name: "verifier", task: "confirm the seeded RNG is stable" }));
      projection.inspector.agents.set("a2", agent({ id: "a2", name: "doc-reader", status: "starting", task: "extract the assembly rules" }));
      projection.inspector.agents.set("a3", agent({ id: "a3", name: "finished-one", status: "idle", outcome: "success" }));
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);

    expect(screen.getByText("verifier")).toBeTruthy();
    expect(screen.getByText("confirm the seeded RNG is stable")).toBeTruthy();
    expect(screen.getByText("doc-reader")).toBeTruthy();
    // Only the ones actually working: a finished agent is not activity.
    expect(screen.queryByText("finished-one")).toBeNull();
  });

  it("stays visible for background work after the foreground turn settles", () => {
    seed((projection) => {
      projection.foreground = "idle";
      projection.inspector.agents.set("a1", agent({ id: "a1", name: "verifier", task: "check it" }));
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);
    expect(screen.getByText("verifier")).toBeTruthy();
  });

  it("shows the running tool calls, not the finished ones", () => {
    seed((projection) => {
      projection.foreground = "running";
      projection.toolCalls.set("t1", { toolCallId: "t1", title: "cargo test -p sim", status: "in_progress" } as never);
      projection.toolCalls.set("t2", { toolCallId: "t2", title: "git status", status: "completed" } as never);
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);
    expect(screen.getByText("cargo test -p sim")).toBeTruthy();
    expect(screen.queryByText("git status")).toBeNull();
  });

  it("shows the agent's latest line, marking a thought as one", () => {
    seed((projection) => {
      projection.foreground = "running";
      projection.cards.push({
        kind: "message",
        key: "c1",
        message: { key: "c1", role: "agent", messageId: "1", blocks: [{ type: "text", text: "first\nChecking whether the tick order is stable" }], contentUnknown: false },
      } as never);
      projection.cards.push({
        kind: "message",
        key: "c2",
        message: { key: "c2", role: "thought", messageId: "2", blocks: [{ type: "text", text: "the seed must be fixed" }], contentUnknown: false },
      } as never);
    });
    render(<RunMonitor sessionId={SESSION} view={view} />);
    expect(screen.getByText(/thinking: the seed must be fixed/)).toBeTruthy();
  });
});

function entry(overrides: Partial<OdysseyJournalEntry> & { id: string; kind: OdysseyJournalEntry["kind"]; summary: string }): OdysseyJournalEntry {
  return { odysseyId: "o1", at: Date.parse("2026-09-12T14:22:00Z"), ...overrides };
}

describe("the run history", () => {
  it("renders the rows the runner wrote, newest first as given", () => {
    render(
      <RunHistory
        journal={[
          entry({ id: "j1", kind: "continuation", summary: "Continued milestone 2 of 3" }),
          entry({ id: "j2", kind: "check", summary: "cargo test exited 1" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("Continued milestone 2 of 3")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("continued")).toBeTruthy();
  });

  it("hides checkpoints by default and offers them by name", () => {
    render(
      <RunHistory
        journal={[
          entry({ id: "j1", kind: "continuation", summary: "Continued milestone 2 of 3" }),
          entry({ id: "j2", kind: "checkpoint", summary: "10 files · +79 −1" }),
          entry({ id: "j3", kind: "checkpoint", summary: "9 files · +77 −1" }),
        ]}
      />,
    );
    expect(screen.queryByText("10 files · +79 −1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "show 2 checkpoints" }));
    expect(screen.getByText("10 files · +79 −1")).toBeTruthy();
    // And back again: the toggle must not vanish once they are shown.
    fireEvent.click(screen.getByRole("button", { name: "hide checkpoints" }));
    expect(screen.queryByText("10 files · +79 −1")).toBeNull();
    expect(screen.getByRole("button", { name: "show 2 checkpoints" })).toBeTruthy();
  });

  it("keeps a row's detail behind a disclosure, and only when there is one", () => {
    render(
      <RunHistory
        journal={[
          entry({ id: "j1", kind: "continuation", summary: "Continued milestone 2 of 3", detail: "Continue. Milestone 2/3: Deterministic simulation core." }),
          entry({ id: "j2", kind: "state", summary: "Run started" }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText(/Continue. Milestone 2\/3/)).toBeTruthy();
    expect(rows[0]?.querySelector("details")).toBeTruthy();
    expect(rows[1]?.querySelector("details")).toBeNull();
  });

  it("lists the paths a checkpoint changed, and hides the guard's fingerprint", () => {
    render(
      <RunHistory
        journal={[
          entry({ id: "j1", kind: "checkpoint", summary: "2 files changed · +12 −3", detail: "3f2a|active|\nAssets/Economy.cs\nDocs/M6.md" }),
          entry({ id: "j2", kind: "checkpoint", summary: "nothing changed since the last checkpoint", detail: "3f2a|active|" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "show 2 checkpoints" }));
    const rows = screen.getAllByRole("listitem").filter((row) => row.classList.contains("odyssey-history-row"));
    expect(within(rows[0] as HTMLElement).getByText("Assets/Economy.cs")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Docs/M6.md")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByText(/3f2a/)).toBeNull();
    // A checkpoint that changed nothing has nothing to disclose.
    expect(rows[1]?.querySelector("details")).toBeNull();
  });

  it("says so when there is nothing recorded", () => {
    render(<RunHistory journal={[]} />);
    expect(screen.getByText("Nothing recorded yet.")).toBeTruthy();
  });

  it("renders an unknown kind rather than dropping the row", () => {
    render(<RunHistory journal={[entry({ id: "j1", kind: "future_kind" as never, summary: "something new" })]} />);
    expect(screen.getByText("something new")).toBeTruthy();
    expect(screen.getByText("future_kind")).toBeTruthy();
  });
});

/**
 * The numbers the usage wait is decided from. The card could say "usage is
 * spent" while showing none of them, so there was no way to tell whether
 * Big Thing was reading what the provider's own meter showed.
 */
describe("the usage readout", () => {
  const at = Date.parse("2026-09-12T16:00:00Z");

  it("shows what is left in each window, and when it comes back", () => {
    render(
      <UsageWindows
        usage={{
          fetchedAtUnixMs: at - 120_000,
          allowed: true,
          limitReached: true,
          primary: { usedPercent: 100, windowSeconds: 18_000, resetAtUnix: Math.floor(at / 1000) + 3_600 },
          secondary: { usedPercent: 84, windowSeconds: 604_800, resetAtUnix: Math.floor(at / 1000) + 7 * 86_400 },
        }}
      />,
    );

    expect(screen.getByText("0% left")).toBeTruthy();
    expect(screen.getByText("16% left")).toBeTruthy();
    expect(screen.getByText("5h")).toBeTruthy();
    expect(screen.getByText("7d")).toBeTruthy();
    // And the provider's own words, when it said them.
    expect(screen.getByText(/the provider reported the limit was reached/)).toBeTruthy();
  });

  it("says how old the sample is, and offers a fresh one", () => {
    render(<UsageWindows usage={{ fetchedAtUnixMs: Date.now() - 125_000, allowed: true, limitReached: false, primary: { usedPercent: 10, windowSeconds: 18_000 } }} />);
    expect(screen.getByText(/sampled 2m 5s ago/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "check now" })).toBeTruthy();
  });

  it("admits when nothing has been sampled rather than showing a confident zero", () => {
    render(<UsageWindows usage={null} />);
    expect(screen.getByText(/Usage has not been sampled/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "check now" })).toBeTruthy();
  });

  it("omits a reset it was not given", () => {
    render(<UsageWindows usage={{ fetchedAtUnixMs: Date.now(), allowed: true, limitReached: false, primary: { usedPercent: 100, windowSeconds: 18_000 } }} />);
    expect(screen.queryByText(/resets/)).toBeNull();
  });
});
