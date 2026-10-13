/**
 * Keeping provider programs current: the Providers panel says when one has
 * fallen behind and runs the provider's own update.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderVersion } from "@thingmaker/contracts";

const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { VersionRow } from "./components/SignInPanel";
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

describe("provider versions", () => {
  beforeEach(() => {
    invoke.mockReset();
    useStore.setState({ providerVersions: { claude: behind }, providerUpdate: { running: null, results: {} } });
  });

  it("says a newer release is out and offers it", () => {
    render(<VersionRow provider="claude" />);
    expect(screen.getByText("0.84.0")).toBeTruthy();
    expect(screen.getByText("0.89.1 is out")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update to 0.89.1" })).toBeTruthy();
  });

  it("runs the provider's own update and says what changed for open sessions", async () => {
    invoke.mockResolvedValueOnce({ output: "changed 3 packages", version: { ...behind, installed: "0.89.1", updateAvailable: false } });
    render(<VersionRow provider="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.89.1" }));
    await vi.waitFor(() => expect(screen.getByText(/Updated from 0\.84\.0 to 0\.89\.1/)).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("provider_update", { provider: "claude" });
    expect(screen.getByText(/Sessions already open keep the version they started with/)).toBeTruthy();
    expect(screen.getByText("up to date")).toBeTruthy();
  });

  it("says a program that ships inside an app updates with it, with no button", () => {
    useStore.setState({ providerVersions: { codex: { provider: "codex", installed: "0.162.0-alpha.17.2", updateAvailable: false, canUpdate: false, how: "updates with ChatGPT" } } });
    render(<VersionRow provider="codex" />);
    expect(screen.getByText("updates with ChatGPT")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows why an update failed", async () => {
    invoke.mockRejectedValueOnce({ code: "IO", message: "npm ERR! network", retry: "user_action" });
    render(<VersionRow provider="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Update to 0.89.1" }));
    await vi.waitFor(() => expect(screen.getByText("npm ERR! network")).toBeTruthy());
  });
});
