/**
 * The composer's model menu: model, effort and Fast mode behind one chip,
 * every switch going out as `session/set_config_option`.
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
  {
    id: "model",
    name: "Model",
    type: "select",
    currentValue: "sol",
    options: [
      { value: "default", name: "Default", description: "Recommended set of models" },
      { value: "sol", name: "GPT-6.1 Sol" },
      { value: "luna", name: "GPT-6 Luna" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Effort",
    type: "select",
    currentValue: "high",
    options: [
      { value: "default", name: "Default" },
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
  { id: "fast", name: "Fast mode", type: "select", currentValue: "off", options: [{ value: "on", name: "On" }, { value: "off", name: "Off" }] },
  { id: "mode", name: "Mode", type: "select", currentValue: "acceptEdits", options: [{ value: "acceptEdits", name: "Accept edits" }] },
];

const setConfigOption = vi.fn(async () => undefined);

beforeEach(() => {
  setConfigOption.mockClear();
  useStore.setState({ setConfigOption } as never);
});
afterEach(cleanup);

describe("model menu", () => {
  it("shows model and effort on one chip, and leaves the mode chip apart", () => {
    render(<ConfigPickers configOptions={OPTIONS} disabled={false} sessionId="s1" />);
    const chip = screen.getByRole("button", { name: /GPT-6.1 Sol/ });
    expect(chip.textContent).toContain("High");
    expect(screen.getByText(/mode: Accept edits/)).toBeTruthy();
    expect(screen.queryByText(/Fast mode/)).toBeNull();
  });

  it("toggles Fast mode and steps the effort, with no reset button", () => {
    render(<ConfigPickers configOptions={OPTIONS} disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /GPT-6.1 Sol/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fast mode" }));
    expect(setConfigOption).toHaveBeenLastCalledWith("s1", "fast", "on");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Reasoning effort" }), { key: "ArrowLeft" });
    expect(setConfigOption).toHaveBeenLastCalledWith("s1", "reasoning_effort", "medium");
    expect(screen.queryByRole("button", { name: "Reset effort" })).toBeNull();
  });

  it("opens the model list from the menu and switches model", () => {
    render(<ConfigPickers configOptions={OPTIONS} disabled={false} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: /GPT-6.1 Sol/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /GPT-6.1 Sol/ })[1]!);
    expect(screen.getByText("Select model")).toBeTruthy();
    expect(screen.getByRole("option", { name: /GPT-6.1 Sol/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: /GPT-6 Luna/ }));
    expect(setConfigOption).toHaveBeenLastCalledWith("s1", "model", "luna");
  });
});
