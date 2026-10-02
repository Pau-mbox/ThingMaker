/**
 * MCP servers in Integrations: one click from the catalog to a reviewed
 * install, a pasted config read through the host, a test start, and the
 * installed servers by provider — with secret values never on screen.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: Record<string, unknown> }[] = [];
const overview = {
  servers: [{ name: "context7", provider: "claude", scope: "user", kind: "stdio", summary: "npx -y @upstash/context7-mcp", envKeys: ["API_KEY"], headerKeys: [], enabled: true, source: "/h/.claude.json" }],
  providers: [
    { provider: "claude", available: true },
    { provider: "codex", available: true },
    { provider: "gemini", available: false, problem: "not installed" },
  ],
  folder: "/work/app",
};
const catalog = [
  { id: "playwright", title: "Playwright", description: "Drive a real browser.", homepage: "https://x", spec: { name: "playwright", transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {} } }, needs: "node", secrets: [] },
  { id: "filesystem", title: "Filesystem", description: "Files in one folder.", homepage: "https://x", spec: { name: "filesystem", transport: { type: "stdio", command: "npx", args: ["-y", "fs", "{folder}"], env: {} } }, needs: "node", secrets: [] },
];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "mcp_overview") return overview;
    if (command === "mcp_catalog") return catalog;
    if (command === "runtime_env_list") return { names: [], available: true, backend: "keychain" };
    if (command === "mcp_parse") return [{ name: "fetch", transport: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: {} } }];
    if (command === "mcp_test") return { server: "pw", version: "1.0", tools: ["browser_navigate", "browser_click"] };
    if (command === "mcp_install") return [{ provider: "claude", ok: true, message: "Added" }, { provider: "codex", ok: true, message: "Added" }];
    return null;
  }),
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

import { McpSection } from "./components/McpSection";

afterEach(() => {
  cleanup();
  calls.length = 0;
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("MCP servers in Integrations", () => {
  it("installs a catalog server for every provider that is set up, after a test start", async () => {
    render(<McpSection workspaceId="w1" />);
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Install…" })[0] as HTMLElement);
    expect((screen.getByLabelText("Server command") as HTMLInputElement).value).toBe("npx -y @playwright/mcp@latest");
    expect((screen.getByRole("checkbox", { name: /Antigravity/ }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Test it" }));
    });
    expect(screen.getByText(/2 tools/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install for 2 providers" }));
    });
    const install = calls.find((entry) => entry.command === "mcp_install");
    expect(install?.args.request).toEqual({
      workspaceId: "w1",
      spec: { name: "playwright", transport: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {} } },
      providers: ["claude", "codex"],
      scope: "user",
    });
    expect(await screen.findByText(/Installed playwright/)).toBeTruthy();
  });

  it("fills the workspace folder into a catalog entry that needs one", async () => {
    render(<McpSection workspaceId="w1" />);
    await settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Install…" })[1] as HTMLElement);
    expect((screen.getByLabelText("Server command") as HTMLInputElement).value).toBe("npx -y fs /work/app");
  });

  it("reads a pasted config through the host, and warns about a secret not stored yet", async () => {
    render(<McpSection workspaceId="w1" />);
    await settle();
    fireEvent.change(screen.getByLabelText("Paste an MCP config or command"), { target: { value: "uvx mcp-server-fetch" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Read it" }));
    });
    expect((screen.getByLabelText("Server name") as HTMLInputElement).value).toBe("fetch");
    fireEvent.click(screen.getByRole("button", { name: "+ add a variable" }));
    fireEvent.change(screen.getAllByLabelText("Key")[0] as HTMLElement, { target: { value: "TOKEN" } });
    fireEvent.change(screen.getAllByLabelText("Value")[0] as HTMLElement, { target: { value: "${TOKEN}" } });
    expect(screen.getByText(/Not in the runtime environment yet: TOKEN/)).toBeTruthy();
  });

  it("lists what each provider has, with variable names and no values", async () => {
    render(<McpSection workspaceId="w1" />);
    await settle();
    expect(screen.getAllByText("context7").length).toBeGreaterThan(0);
    expect(screen.getByText("uses API_KEY")).toBeTruthy();
    expect(screen.getByText("every project")).toBeTruthy();
  });
});
