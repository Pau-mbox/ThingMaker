/**
 * The Providers page: one row per provider with its state and the one thing
 * to do, the rest behind (?) — and keeping provider programs current, with
 * the provider's own update.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo, ProviderVersion } from "@thingmaker/contracts";

const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { SignInPanel } from "./components/SignInPanel";
import { useStore } from "./store";

afterEach(cleanup);

const behind: ProviderVersion = {
  provider: "claude",
  installed: "0.84.0",
  latest: "0.89.1",
  updateAvailable: true,
  canUpdate: true,
  how: "npm package @agentclientprotocol/claude-agent-acp in /prefix",
};
const resolved = (provider: "claude" | "codex" | "gemini", program: string) => ({ provider, program, prefixArgs: [], source: "discovered" as const });
const claude = (loggedIn: boolean): ProviderInfo => ({ provider: "claude", label: "Claude Code", resolved: resolved("claude", "/opt/claude-agent-acp"), auth: { provider: "claude", loggedIn, ...(loggedIn ? { plan: "Max", account: "someone@example.com" } : {}) } });
const codex: ProviderInfo = { provider: "codex", label: "Codex", resolved: resolved("codex", "/opt/codex"), auth: { provider: "codex", loggedIn: true, plan: "plus" } };
const gemini: ProviderInfo = { provider: "gemini", label: "Gemini", resolved: resolved("gemini", "/opt/agy"), auth: { provider: "gemini", loggedIn: true } };

function seed(providers: ProviderInfo[], versions: Partial<Record<string, ProviderVersion>>) {
  useStore.setState({
    providers,
    providerVersions: versions,
    providerUpdate: { running: null, results: {} },
    usage: { codex: { fetchedAtUnixMs: 1, allowed: true, limitReached: false, primary: { usedPercent: 10, windowSeconds: 18_000 }, secondary: { usedPercent: 80, windowSeconds: 604_800 } } },
    signIn: null,
    loadProviderVersions: vi.fn(async () => undefined),
  } as never);
}
const row = (name: string) => screen.getByText(name, { selector: "strong" }).closest("li") as HTMLElement;

describe("the Providers page", () => {
  beforeEach(() => invoke.mockReset());

  it("says each provider's state in a word, with one thing to do", () => {
    seed([claude(false), codex, gemini], {});
    render(<SignInPanel />);
    expect(within(row("Claude Code")).getByText("Not signed in")).toBeTruthy();
    expect(within(row("Claude Code")).getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(within(row("Codex")).getByText("Ready · plus")).toBeTruthy();
    expect(within(row("Codex")).getByText("90%")).toBeTruthy();
    expect(within(row("Codex")).getByText("20%")).toBeTruthy();
    expect(within(row("Gemini")).queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(screen.queryByText("/opt/codex")).toBeNull();
  });

  it("keeps the program and the account behind (?)", () => {
    seed([claude(true)], {});
    render(<SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code details" }));
    expect(screen.getByText("/opt/claude-agent-acp")).toBeTruthy();
    expect(screen.getByText("someone@example.com · Max")).toBeTruthy();
  });

  it("says a newer release is out and offers it, here and in one line at the top", () => {
    seed([claude(true)], { claude: behind });
    render(<SignInPanel />);
    expect(screen.getByRole("button", { name: "Update to 0.89.1" })).toBeTruthy();
    expect(screen.getByText(/An update:/).textContent).toContain("Claude Code 0.89.1");
    fireEvent.click(screen.getByRole("button", { name: "Claude Code details" }));
    expect(screen.getByText("0.84.0 · 0.89.1 is out")).toBeTruthy();
  });

  it("runs the provider's own update and says what changed for open sessions", async () => {
    seed([claude(true)], { claude: behind });
    invoke.mockResolvedValueOnce({ output: "changed 3 packages", version: { ...behind, installed: "0.89.1", updateAvailable: false } });
    render(<SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.89.1" }));
    await vi.waitFor(() => expect(screen.getByText(/Updated from 0\.84\.0 to 0\.89\.1/)).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("provider_update", { provider: "claude" });
    expect(screen.getByText(/Sessions already open keep the version they started with/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Update to/ })).toBeNull();
  });

  it("says a program that ships inside an app updates with it, with no button", () => {
    seed([codex], { codex: { provider: "codex", installed: "0.162.0-alpha.17.2", updateAvailable: false, canUpdate: false, how: "updates with ChatGPT" } });
    render(<SignInPanel />);
    expect(screen.queryByRole("button", { name: /Update/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Codex details" }));
    expect(screen.getByText("0.162.0-alpha.17.2 · updates with ChatGPT")).toBeTruthy();
  });

  it("shows why an update failed", async () => {
    seed([claude(true)], { claude: behind });
    invoke.mockRejectedValueOnce({ code: "IO", message: "npm ERR! network", retry: "user_action" });
    render(<SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.89.1" }));
    await vi.waitFor(() => expect(screen.getByText("npm ERR! network")).toBeTruthy());
  });
});
