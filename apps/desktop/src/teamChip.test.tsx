/**
 * The composer's team chip: a menu of the saved teams, each with who is on
 * it when pointed at, and a way to the Teams view. Picking a team sets its
 * helpers at once; a lead on another provider waits for the next message.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Combo, ProviderModel, Snapshot, TeamPreset, WorkerSlot } from "@thingmaker/contracts";

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
import { TeamChip } from "./components/TeamEditor";

const model = (id: string, name: string, efforts: string[]): ProviderModel => ({ id, name, needsCredits: false, efforts, inputImage: true, isDefault: false });
const catalogs = {
  claude: [model("opus", "Opus 5.5", ["low", "high", "xhigh"]), model("sonnet", "Sonnet 5.5", ["low", "high"])],
  codex: [model("gpt-6-luna", "GPT-6 Luna", ["low", "max"]), model("gpt-6.1-sol", "GPT-6.1 Sol", ["low", "high"])],
  gemini: [],
};
const artist: WorkerSlot = { name: "Luna Artist", provider: "codex", model: "gpt-6-luna", effort: "max", capabilities: ["image", "ui"], note: "Image generation", prompt: "Flat pastel art, no gradients" };
const reviewer: WorkerSlot = { name: "Art Reviewer", provider: "claude", model: "sonnet", effort: "high", capabilities: ["review"] };
const studio: TeamPreset = { id: "p1", name: "Art Fixer", orchestrator: { provider: "claude", model: "opus", effort: "high" }, combo: { workers: [artist, reviewer], nativeSubagents: false }, updatedAt: 1 };
const codexLed: TeamPreset = { id: "p2", name: "Codex crew", orchestrator: { provider: "codex", model: "gpt-6.1-sol" }, combo: { workers: [reviewer], nativeSubagents: false }, updatedAt: 1 };

const options = [
  { id: "model", name: "Model", type: "select", currentValue: "sonnet", options: [{ value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }] },
  { id: "effort", name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];

function live(): LiveSession {
  const handle = { id: "s1", attachmentGeneration: "1" };
  const snapshot = { handle, agentSessionId: "agent-s1", provider: "claude", toolCalls: {}, foreground: "idle", configOptions: options } as unknown as Snapshot;
  return { handle, workspaceId: "w1", snapshot, projection: emptyProjection(), inFlightRequestId: null, steerInFlight: false, attention: "none", openedAt: 0, turnStartedAt: null, lastEventAt: null, usage: EMPTY_SESSION_USAGE };
}

const saveTeam = vi.fn(async (_session: string, combo: Combo) => {
  useStore.setState({ teams: { s1: combo } });
});
const setConfigOption = vi.fn(async () => undefined);
const setView = vi.fn();

beforeEach(() => {
  saveTeam.mockClear();
  setConfigOption.mockClear();
  setView.mockClear();
  useStore.setState({
    sessions: { s1: live() },
    teams: { s1: { workers: [{ name: "Quick Sonnet", provider: "claude", model: "sonnet", capabilities: ["fast"] }], nativeSubagents: false } },
    teamPresets: [studio, codexLed],
    jobs: {},
    pendingProvider: {},
    providerModels: catalogs,
    loadProviderModels: vi.fn(async () => undefined),
    saveTeam,
    setConfigOption,
    setView,
  } as never);
});
afterEach(cleanup);

describe("team chip", () => {
  it("opens a menu of the saved teams instead of an editor", () => {
    render(<TeamChip disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /team: Quick Sonnet/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: /This session's own team/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemradio", { name: /Art Fixer/ }).textContent).toContain("Opus 5.5 leads · 2 helpers");
    expect(screen.queryByText("Saved team")).toBeNull();
  });

  it("shows who is on a team when it is pointed at", () => {
    render(<TeamChip disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /team: / }));
    fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: /Art Fixer/ }));
    const card = screen.getByRole("note", { name: "Who is on Art Fixer" });
    expect(card.textContent).toContain("Opus 5.5");
    expect(card.textContent).toContain("Luna Artist");
    expect(card.textContent).toContain("Artist");
    expect(card.textContent).toContain("GPT-6 Luna · max");
    expect(card.textContent).toContain("Image generation");
    expect(card.textContent).toContain("Flat pastel art");
    expect(card.textContent).toContain("Reviewer");
  });

  it("picks a team: its helpers at once, its lead's model and effort in place", async () => {
    render(<TeamChip disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /team: / }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Art Fixer/ }));
    await vi.waitFor(() => expect(setConfigOption).toHaveBeenCalledTimes(2));
    expect(saveTeam).toHaveBeenCalledWith("s1", studio.combo);
    expect(setConfigOption).toHaveBeenCalledWith("s1", "model", "opus");
    expect(setConfigOption).toHaveBeenCalledWith("s1", "effort", "high");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /team: Art Fixer/ })).toBeTruthy();
  });

  it("leaves a lead on another provider for the next message", async () => {
    render(<TeamChip disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /team: / }));
    fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: /Codex crew/ }));
    expect(screen.getByRole("note").textContent).toContain("Led by Codex");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex crew/ }));
    await vi.waitFor(() => expect(useStore.getState().pendingProvider.s1).toEqual({ provider: "codex", model: "gpt-6.1-sol" }));
    expect(setConfigOption).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /team: Codex crew/ })).toBeTruthy();
  });

  it("goes to Teams to make or change one", () => {
    render(<TeamChip disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /team: / }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Go to Teams…" }));
    expect(setView).toHaveBeenCalledWith({ kind: "teams" });
  });
});
