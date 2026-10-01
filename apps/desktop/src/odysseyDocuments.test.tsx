/**
 * The documents a run has to read, listed and readable from the Super Thing tab.
 *
 * Three sources — the plan document, what amendments pointed at, the agent's
 * own notes — were each reachable only from somewhere else. These tests pin
 * what is listed, in what order, without repeats, and that each kind opens
 * through the right command.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AmendmentRecord, OdysseyView, Snapshot, WorkspaceNotes } from "@thingmaker/contracts";

vi.mock("./ipc", () => ({
  api: {
    fileRead: vi.fn(async (_workspaceId: string, relative: string) => ({
      relativePath: relative,
      content: relative.endsWith("STATE.md") ? "# State\n\nMilestone 6 in flight." : "# Mare Nostrum\n\n## 4. Goods\nTen goods.",
      contentHash: "h",
      bytes: 40,
      totalLines: 4,
      offsetLine: 0,
      returnedLines: 4,
      truncated: false,
      binary: false,
      editable: true,
    })),
    odysseyPlanDocument: vi.fn(async () => "# Stored plan\n\nFrom the goal."),
    odysseyAmendDocument: vi.fn(async () => "# Ship library\n\nOne per class."),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { EMPTY_SESSION_USAGE, useStore, type LiveSession } from "./store";
import { emptyProjection } from "./projection";
import { documentEntries } from "./odysseyDocuments";
import { DocumentsCard } from "./components/OdysseyDocuments";
import { api as mockedApi } from "./ipc";

type Mocks = { [K in keyof typeof mockedApi]: ReturnType<typeof vi.fn> };
const api = mockedApi as unknown as Mocks;

const SESSION = "sess-1";
const NOW = 1_700_000_000_000;

const goal: OdysseyView["goal"] = {
  id: "o1",
  workspaceId: "w1",
  title: "Mare Nostrum",
  brief: "",
  state: "running",
  stopCondition: "goal_complete",
  onUsageReset: "continue_automatically",
  onReport: "continue",
  onPlanChange: "review",
  orchestrator: "codex",
  deadTurnMinutes: 60,
  maxContinuations: 40,
  continuationsUsed: 11,
  tokensUsed: 0,
  planSource: "Mare_Nostrum_Orchestrator_GDD.md",
  planDocumentBytes: 54_435,
  planPath: "docs/Mare_Nostrum_Orchestrator_GDD.md",
  createdAt: 0,
  updatedAt: 0,
};

const amendment = (overrides: Partial<AmendmentRecord> & { id: string; at: number }): AmendmentRecord => ({
  odysseyId: "o1",
  note: "fold this in",
  refs: [],
  state: "told",
  tellCount: 1,
  ...overrides,
});

const amendments: AmendmentRecord[] = [
  // Newest first, as the store holds them; the list must still read oldest first.
  amendment({ id: "a3", at: NOW - 1_000, refs: [{ path: "docs/Mare_Nostrum_Orchestrator_GDD.md", kind: "file", detail: "54435 bytes" }] }),
  amendment({ id: "a2", at: NOW - 3_000, state: "discarded", refs: [{ path: "docs/dropped.md", kind: "file", detail: "1 bytes" }] }),
  amendment({
    id: "a1",
    at: NOW - 5_000,
    state: "applied",
    documentSource: "ship-library.md",
    documentBytes: 12_288,
    refs: [
      { path: "Assets/Art/Ships", kind: "directory", detail: "48 files" },
      { path: "Docs/SHIP-CANON.md", kind: "file", detail: "9000 bytes" },
    ],
  }),
];

const notes: WorkspaceNotes = {
  state: { path: "docs/super-thing/STATE.md", bytes: 900, modifiedAtUnixMs: NOW - 5 * 60_000 },
  agentNotes: [{ path: "docs/super-thing/agents/economy.md", bytes: 300, modifiedAtUnixMs: NOW - 90 * 60_000 }],
};

describe("what a run has to read", () => {
  it("lists the plan, then what amendments added oldest first, then the notes", () => {
    const entries = documentEntries({ goal, amendments, notes, now: NOW });
    expect(entries.map((entry) => [entry.group, entry.label])).toEqual([
      ["plan", "Mare_Nostrum_Orchestrator_GDD.md"],
      ["added", "ship-library.md"],
      ["added", "Ships"],
      ["added", "SHIP-CANON.md"],
      ["notes", "STATE.md"],
      ["notes", "economy.md"],
    ]);
  });

  it("does not list a discarded amendment's files, nor the plan document twice", () => {
    const entries = documentEntries({ goal, amendments, notes, now: NOW });
    expect(entries.some((entry) => entry.label === "dropped.md")).toBe(false);
    expect(entries.filter((entry) => entry.meta.includes("Mare_Nostrum_Orchestrator_GDD.md"))).toHaveLength(1);
  });

  it("knows a folder cannot be opened and a Markdown file is rendered", () => {
    const entries = documentEntries({ goal, amendments, notes, now: NOW });
    expect(entries.find((entry) => entry.label === "Ships")).toMatchObject({ source: null, meta: "Assets/Art/Ships · 48 files · added " + new Date(NOW - 5_000).toLocaleDateString([], { day: "numeric", month: "short" }) });
    expect(entries.find((entry) => entry.label === "SHIP-CANON.md")).toMatchObject({ source: { kind: "file", path: "Docs/SHIP-CANON.md" }, markdown: true });
    expect(entries.find((entry) => entry.label === "ship-library.md")).toMatchObject({ source: { kind: "amendment", amendmentId: "a1" } });
    expect(entries.find((entry) => entry.label === "STATE.md")?.meta).toBe("docs/super-thing/STATE.md · updated 5m ago");
  });

  it("falls back to the stored copy for a goal planned before plans had a path", () => {
    const { planPath: _path, ...older } = goal;
    const entries = documentEntries({ goal: older, amendments: [], notes: null, now: NOW });
    expect(entries).toEqual([expect.objectContaining({ group: "plan", label: "Mare_Nostrum_Orchestrator_GDD.md", meta: "stored with the goal · 53 KB", source: { kind: "stored_plan", goalId: "o1" } })]);
  });

  it("lists nothing for a goal typed in by hand with no amendments and no notes", () => {
    const { planPath: _path, planSource: _source, planDocumentBytes: _bytes, ...bare } = goal;
    expect(documentEntries({ goal: bare, amendments: [], notes: { agentNotes: [] }, now: NOW })).toEqual([]);
  });
});

function seed() {
  const handle = { id: SESSION, attachmentGeneration: "1" };
  const session: LiveSession = {
    handle,
    workspaceId: "w1",
    snapshot: { handle, agentSessionId: "kw-1" } as unknown as Snapshot,
    projection: emptyProjection(),
    inFlightRequestId: null,
    steerInFlight: false,
    attention: "none",
    openedAt: 0,
    turnStartedAt: null,
    lastEventAt: null,
    usage: EMPTY_SESSION_USAGE,
  };
  useStore.setState({ sessions: { [SESSION]: session }, odysseyAmendments: { [SESSION]: amendments }, odysseyNotes: { [SESSION]: notes } });
}

const view: OdysseyView = { goal, milestones: [], journal: [] };

describe("the documents card", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    seed();
  });
  afterEach(cleanup);

  it("groups what there is to read and offers to open every file", () => {
    render(<DocumentsCard sessionId={SESSION} view={view} />);
    const card = within(screen.getByRole("region", { name: "Documents" }));
    expect(card.getByText("Plan")).toBeTruthy();
    expect(card.getByText("Added along the way")).toBeTruthy();
    expect(card.getByText("The agent's notes")).toBeTruthy();
    expect(card.getByText("6 items")).toBeTruthy();
    // Five files open; the folder is listed but has nothing to open.
    expect(card.getAllByRole("button", { name: "View" })).toHaveLength(5);
    expect(card.getByText("Ships")).toBeTruthy();
  });

  it("opens the plan document from the workspace and renders it", async () => {
    render(<DocumentsCard sessionId={SESSION} view={view} />);
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0] as HTMLElement);

    expect(api.fileRead).toHaveBeenCalledWith("w1", "docs/Mare_Nostrum_Orchestrator_GDD.md", 0, 20_000);
    const dialog = await screen.findByRole("dialog", { name: "Mare_Nostrum_Orchestrator_GDD.md" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "4. Goods" })).toBeTruthy());
    // Raw text is a click away, and back.
    fireEvent.click(within(dialog).getByRole("button", { name: "raw text" }));
    expect(within(dialog).getByText(/## 4\. Goods/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a document that lives outside the workspace from the amendment that quoted it", async () => {
    render(<DocumentsCard sessionId={SESSION} view={view} />);
    const row = screen.getByText("ship-library.md").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "View" }));

    expect(api.odysseyAmendDocument).toHaveBeenCalledWith("a1");
    const dialog = await screen.findByRole("dialog", { name: "ship-library.md" });
    await waitFor(() => expect(within(dialog).getByText(/One per class/)).toBeTruthy());
    expect(within(dialog).getByText(/outside the workspace/)).toBeTruthy();
  });

  it("opens the agent's handoff note", async () => {
    render(<DocumentsCard sessionId={SESSION} view={view} />);
    const row = screen.getByText("STATE.md").closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "View" }));
    expect(api.fileRead).toHaveBeenCalledWith("w1", "docs/super-thing/STATE.md", 0, 20_000);
    const dialog = await screen.findByRole("dialog", { name: "STATE.md" });
    await waitFor(() => expect(within(dialog).getByText(/Milestone 6 in flight/)).toBeTruthy());
  });

  it("shows the stored copy, and says so, when the workspace file cannot be read", async () => {
    api.fileRead.mockRejectedValueOnce({ code: "IO", message: "no such file" });
    render(<DocumentsCard sessionId={SESSION} view={view} />);
    fireEvent.click(screen.getAllByRole("button", { name: "View" })[0] as HTMLElement);

    const dialog = await screen.findByRole("dialog", { name: "Mare_Nostrum_Orchestrator_GDD.md" });
    await waitFor(() => expect(within(dialog).getByText(/From the goal/)).toBeTruthy());
    expect(api.odysseyPlanDocument).toHaveBeenCalledWith("o1");
    expect(within(dialog).getByText(/copy stored with the goal/)).toBeTruthy();
  });

  it("is absent when there is nothing to read", () => {
    const { planPath: _path, planSource: _source, planDocumentBytes: _bytes, ...bare } = goal;
    useStore.setState({ odysseyAmendments: { [SESSION]: [] }, odysseyNotes: { [SESSION]: { agentNotes: [] } } });
    const { container } = render(<DocumentsCard sessionId={SESSION} view={{ ...view, goal: bare }} />);
    expect(container.querySelector(".odyssey-documents")).toBeNull();
  });
});
