/**
 * Switching provider from the model menu: a hand-off to a new session on the
 * other provider, unless the session runs a saved team preset.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("invoke is not available in tests");
  }),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { useStore } from "./store";
import { ConfigPickers } from "./components/ConfigPickers";

const OPTIONS = [
  { id: "model", name: "Model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }] },
  { id: "agent", name: "Agent", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "reviewer", name: "Reviewer" }] },
];
const team = { workers: [{ name: "Luna-Max", provider: "codex", model: "gpt-6-luna" }], nativeSubagents: false };
const handOff = vi.fn(async () => undefined);
const signedIn = (provider: string, loggedIn = true) => ({ provider, label: provider, resolved: { program: provider }, auth: { loggedIn } });

function seed({ preset = false, foreground = "idle", codexSignedIn = true } = {}) {
  useStore.setState({
    sessions: { s1: { snapshot: { provider: "claude" }, projection: { foreground } } },
    teams: { s1: team },
    teamPresets: preset ? [{ id: "p", name: "Game team", orchestrator: { provider: "claude" }, combo: team, updatedAt: 0 }] : [],
    providers: [signedIn("claude"), signedIn("codex", codexSignedIn), signedIn("gemini")],
    handOff,
  } as never);
}

function openModels() {
  render(<ConfigPickers configOptions={OPTIONS} disabled={false} sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: /Opus 5.5/ }));
}

beforeEach(() => handOff.mockClear());
afterEach(cleanup);

describe("switching provider from the model menu", () => {
  it("hides the adapter's agent picker", () => {
    seed();
    render(<ConfigPickers configOptions={OPTIONS} disabled={false} sessionId="s1" />);
    expect(screen.queryByText("Agent")).toBeNull();
  });

  it("hands the work off to a new session on the other provider", () => {
    seed();
    openModels();
    expect(screen.getByRole("button", { name: "Claude Code" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(handOff).toHaveBeenCalledWith("s1", "codex");
    expect(screen.queryByRole("dialog", { name: "Model and effort" })).toBeNull();
  });

  it("keeps a session on a saved team preset with the preset's lead", () => {
    seed({ preset: true });
    openModels();
    const codex = screen.getByRole("button", { name: "Codex" }) as HTMLButtonElement;
    expect(codex.disabled).toBe(true);
    expect(codex.title).toContain("Game team");
  });

  it("waits for a running turn, and offers only signed-in providers", () => {
    seed({ foreground: "running" });
    openModels();
    expect((screen.getByRole("button", { name: "Gemini" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    seed({ codexSignedIn: false });
    openModels();
    expect((screen.getByRole("button", { name: "Codex" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Gemini" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
