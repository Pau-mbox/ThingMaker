/**
 * The team as an org chart: roles read from tags, suggested models from the
 * catalogs, and the chart's own editing — add a helper by role and model,
 * change who leads, give a helper another role.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Combo, OrchestratorChoice, ProviderModel } from "@thingmaker/contracts";

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
import { TeamChart } from "./components/TeamChart";
import { roleOf, starterCombo, starterLead, suggestModel, withRole } from "./teamRoles";

const model = (id: string, name: string, efforts: string[], extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name, needsCredits: false, efforts, inputImage: true, isDefault: false, ...extra });
const catalogs = {
  claude: [model("opus", "Opus 5.5", ["low", "medium", "high", "xhigh", "max"], { isDefault: true }), model("sonnet", "Sonnet 5.5", ["low", "medium", "high"]), model("haiku", "Haiku 5.5", ["low", "high"])],
  codex: [model("gpt-6.1-sol", "GPT-6.1 Sol", ["low", "medium", "high", "xhigh"], { isDefault: true }), model("gpt-6-astra", "GPT-6 Astra", ["low", "high"])],
  gemini: [model("gemini-3.1-pro", "Gemini 3.1 Pro", ["low", "high"])],
};
const providers = [
  { provider: "claude", label: "Claude Code", resolved: { program: "claude" }, auth: { loggedIn: true } },
  { provider: "codex", label: "Codex", resolved: { program: "codex" }, auth: { loggedIn: true } },
  { provider: "gemini", label: "Gemini", resolved: { program: "agy" }, auth: { loggedIn: false } },
];

describe("roles", () => {
  it("are read from a helper's tags, and a custom set stays custom", () => {
    expect(roleOf({ capabilities: ["image", "ui"] })).toBe("artist");
    expect(roleOf({ capabilities: ["review"] })).toBe("reviewer");
    expect(roleOf({ capabilities: ["image", "ui", "code"] })).toBe("artist");
    expect(roleOf({ capabilities: [] })).toBeNull();
  });

  it("suggest a model that fits, a review on another provider than the lead", () => {
    const usable = ["claude", "codex"] as const;
    expect(suggestModel("artist", catalogs, usable, "claude").model?.id).toBe("gpt-6-astra");
    expect(suggestModel("quick", catalogs, usable, "claude").model?.id).toBe("haiku");
    expect(suggestModel("reviewer", catalogs, usable, "claude").provider).toBe("codex");
    expect(suggestModel("reviewer", catalogs, usable, "codex").model?.id).toBe("opus");
    expect(suggestModel("coder", catalogs, usable, "claude").model?.id).toBe("sonnet");
  });

  it("start a team on Opus with the helpers the shape names", () => {
    const usable = ["claude", "codex"] as const;
    expect(starterLead(catalogs, usable)).toEqual({ provider: "claude", model: "opus", effort: "high" });
    const combo = starterCombo("coders", catalogs, usable, "claude", { coder: "Coder", artist: "Artist", reviewer: "Reviewer", researcher: "Researcher", quick: "Quick helper" });
    expect(combo.workers.map((worker) => worker.name)).toEqual(["Coder", "Coder-2", "Coder-3"]);
  });

  it("keep a note the person wrote when the role changes", () => {
    const worker = { name: "Astra", provider: "codex" as const, capabilities: ["image", "ui"], note: "All the icons" };
    expect(withRole(worker, "reviewer")).toMatchObject({ capabilities: ["review"], note: "All the icons" });
    expect(withRole({ ...worker, note: "Images, icons and UI art" }, "reviewer").note).toBe("Checks another worker's result before it counts as done");
  });
});

describe("the team chart", () => {
  let orchestrator: OrchestratorChoice;
  let combo: Combo;
  const onChange = vi.fn((next: OrchestratorChoice, nextCombo: Combo) => {
    orchestrator = next;
    combo = nextCombo;
  });
  const draw = () => render(<TeamChart combo={combo} onChange={onChange} orchestrator={orchestrator} />);

  beforeEach(() => {
    orchestrator = { provider: "claude", model: "opus", effort: "xhigh" };
    combo = { workers: [{ name: "Sonnet", provider: "claude", model: "sonnet", effort: "high", capabilities: ["research"], note: "Reads docs and code, and answers questions" }], nativeSubagents: false };
    onChange.mockClear();
    useStore.setState({ providerModels: catalogs, providers, quotas: {}, loadProviderModels: vi.fn(async () => []) } as never);
  });
  afterEach(cleanup);

  it("reads the team back in a sentence", () => {
    draw();
    expect(screen.getByText(/researches/)).toBeTruthy();
    expect(screen.getByText("Leads")).toBeTruthy();
  });

  it("adds a helper by what it does and the model picked for it", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Add a helper/ }));
    const picker = screen.getByRole("region", { name: "Add a helper" });
    fireEvent.click(within(picker).getByRole("button", { name: /Artist/ }));
    const astra = within(picker).getByRole("button", { name: /GPT-6 Astra/ });
    expect(astra.textContent).toContain("suggested");
    expect((within(picker).getByRole("button", { name: /Gemini 3.1 Pro/ }) as HTMLButtonElement).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(astra);
    expect(combo.workers[1]).toMatchObject({ name: "Artist", provider: "codex", model: "gpt-6-astra", capabilities: ["image", "ui"], note: "Images, icons and UI art" });
  });

  it("changes who leads from the same picker, without Gemini", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Leads/ }));
    fireEvent.click(screen.getByRole("button", { name: /Opus 5.5 · Claude Code/ }));
    const picker = screen.getByRole("region", { name: "Who leads this team" });
    expect(within(picker).queryByText("Gemini")).toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /GPT-6.1 Sol/ }));
    expect(orchestrator).toEqual({ provider: "codex", model: "gpt-6.1-sol", effort: "xhigh" });
  });

  it("gives a helper another role, and removes it", () => {
    draw();
    fireEvent.click(screen.getByRole("button", { name: /Sonnet 5.5/ }));
    const editor = screen.getByRole("region", { name: "Sonnet" });
    fireEvent.click(within(editor).getByRole("button", { name: /Reviewer/ }));
    expect(combo.workers[0]?.capabilities).toEqual(["review"]);
    fireEvent.click(within(editor).getByRole("button", { name: "Remove helper" }));
    expect(combo.workers).toEqual([]);
  });
});
